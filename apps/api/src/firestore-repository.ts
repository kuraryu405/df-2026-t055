import { AsyncLocalStorage } from 'node:async_hooks';
import { MemoryRepository, type Doc, type Repository } from './adapters.ts';

// SDK binding is deliberately separate: Native mode, no credentials or SDK required here.
export interface FirestoreSnapshot {
    id: string;
    data(): Record<string, unknown> | undefined;
}
export interface FirestoreQuerySnapshot { docs: FirestoreSnapshot[] }
export interface FirestoreReference { get(): Promise<FirestoreSnapshot> }
export interface FirestoreQuery { get(): Promise<FirestoreQuerySnapshot> }
export interface FirestoreCollection {
    doc(id: string): FirestoreReference;
    where(field: 'orgId', operator: '==', value: string): FirestoreQuery;
}
export interface FirestoreTransaction {
    get(ref: FirestoreReference): Promise<FirestoreSnapshot>;
    get(query: FirestoreQuery): Promise<FirestoreQuerySnapshot>;
    set(ref: FirestoreReference, value: Doc): unknown;
}
export interface FirestoreClient {
    collection(name: string): FirestoreCollection;
    runTransaction<T>(fn: (transaction: FirestoreTransaction) => Promise<T>): Promise<T>;
}
type Context = { transaction: FirestoreTransaction; writes: Map<string, Map<string, Doc>> };
function segment(value: string) {
    if (!value || value.includes('/') || value === '.' || value === '..')
        throw Error('INVALID_DOCUMENT_PATH');
    return value;
}
// Only JSON metadata is stored; omit optional undefined fields as in JSON responses.
function metadata(value: unknown): any {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(metadata);
    if (value && Object.getPrototypeOf(value) === Object.prototype)
        return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, metadata(v)]));
    throw Error('INVALID_FIRESTORE_METADATA');
}
export class FirestoreRepository implements Repository {
    private context = new AsyncLocalStorage<Context>();
    // One trusted tenant per repository; API still checks the authenticated member's orgId.
    constructor(private client: FirestoreClient, readonly orgId: string) { segment(orgId); }
    private collection(name: string) { return this.client.collection(segment(name)); }
    private decode(snapshot: FirestoreSnapshot): Doc | undefined {
        const data = snapshot.data();
        if (!data) return undefined;
        if (data.orgId !== this.orgId) throw Error('ORG_FORBIDDEN');
        if (data.id !== snapshot.id || typeof data.createdAt !== 'string' || !data.createdAt)
            throw Error('INVALID_FIRESTORE_DOCUMENT');
        return structuredClone(data) as Doc;
    }
    async get(collection: string, id: string): Promise<Doc | undefined> {
        const ref = this.collection(collection).doc(segment(id));
        const context = this.context.getStore();
        const pending = context?.writes.get(collection)?.get(id);
        if (pending) return structuredClone(pending);
        return this.decode(await (context ? context.transaction.get(ref) : ref.get()));
    }
    async all(collection: string): Promise<Doc[]> {
        const query = this.collection(collection).where('orgId', '==', this.orgId);
        const context = this.context.getStore();
        const snapshot = await (context ? context.transaction.get(query) : query.get());
        const values = new Map(snapshot.docs.map(s => [s.id, this.decode(s)!]));
        for (const [id, value] of context?.writes.get(collection) ?? []) values.set(id, value);
        return [...values.values()].map(value => structuredClone(value));
    }
    async put(collection: string, value: Doc): Promise<void> {
        this.collection(collection).doc(segment(value.id));
        if (value.orgId !== this.orgId) throw Error('ORG_FORBIDDEN');
        if (typeof value.createdAt !== 'string' || !value.createdAt) throw Error('INVALID_FIRESTORE_DOCUMENT');
        const clean = metadata(value) as Doc;
        if (!this.context.getStore()) return this.transaction(() => this.put(collection, clean));
        // Read even for blind writes: another tenant's existing ID must never be overwritten.
        await this.get(collection, value.id);
        const writes = this.context.getStore()!.writes;
        if (!writes.has(collection)) writes.set(collection, new Map());
        writes.get(collection)!.set(value.id, clean);
    }
    async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
        if (this.context.getStore()) return fn();
        // All SDK reads precede SDK writes. Only the callback is retried by the client.
        // Callers must prepare Storage/TTS/model I/O outside this callback.
        // https://cloud.google.com/firestore/native/docs/manage-data/transactions
        return this.client.runTransaction(async transaction => {
            const context: Context = { transaction, writes: new Map() };
            const result = await this.context.run(context, fn);
            for (const [collection, values] of context.writes)
                for (const value of values.values()) transaction.set(this.collection(collection).doc(value.id), value);
            return result;
        });
    }
}
export function configuredRepository(env: NodeJS.ProcessEnv = process.env, client?: FirestoreClient): Repository {
    const backend = env.REPOSITORY_BACKEND ?? 'memory';
    if (backend === 'memory') return new MemoryRepository();
    if (backend !== 'firestore') throw Error('INVALID_REPOSITORY_BACKEND');
    if (!client) throw Error('FIRESTORE_CLIENT_NOT_CONFIGURED: SDK binding is not installed; inject a FirestoreClient');
    if (!env.FIRESTORE_ORG_ID) throw Error('FIRESTORE_ORG_ID_REQUIRED');
    return new FirestoreRepository(client, env.FIRESTORE_ORG_ID);
}
