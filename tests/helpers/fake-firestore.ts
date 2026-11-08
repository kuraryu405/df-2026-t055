import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Doc } from '../../apps/api/src/adapters.ts';
import type { FirestoreClient, FirestoreReference, FirestoreQuery, FirestoreTransaction, FirestoreSnapshot, FirestoreQuerySnapshot } from '../../apps/api/src/firestore-repository.ts';
class Reference implements FirestoreReference {
    constructor(readonly path: string, private read: () => FirestoreSnapshot) {}
    async get() { return this.read(); }
}
class Query implements FirestoreQuery {
    constructor(private read: () => FirestoreQuerySnapshot) {}
    async get() { return this.read(); }
}
// Optimistic fake: snapshot isolation, query conflicts (including inserts), atomic commit.
// This intentionally checks ordering; it is not evidence of SDK/emulator compatibility.
export class FakeFirestore implements FirestoreClient {
    data = new Map<string, Doc>();
    version = 0;
    attempts = 0;
    retries = 0;
    forceRetries = 0;
    failCommit = false;
    active = new AsyncLocalStorage<boolean>();
    collection(name: string) {
        return {
            doc: (id: string) => new Reference(`${name}/${id}`, () => ({ id, data: () => structuredClone(this.data.get(`${name}/${id}`)) })),
            where: (field: 'orgId', operator: '==', orgId: string) => {
                assert.equal(field, 'orgId'); assert.equal(operator, '==');
                return new Query(() => ({ docs: [...this.data].filter(([path, d]) => path.startsWith(`${name}/`) && d.orgId === orgId).map(([, d]) => ({ id: d.id, data: () => structuredClone(d) })) }));
            }
        };
    }
    async runTransaction<T>(fn: (tx: FirestoreTransaction) => Promise<T>): Promise<T> {
        for (let attempt = 0; attempt < 20; attempt++) {
            this.attempts++;
            const version = this.version;
            const writes = new Map<string, Doc>();
            let writing = false;
            const tx = {
                get: async (target: Reference | Query) => {
                    assert.equal(writing, false, 'SDK read after write');
                    const value = await target.get();
                    if (version !== this.version) throw new Conflict();
                    return value;
                },
                set: (ref: Reference, value: Doc) => { writing = true; writes.set(ref.path, structuredClone(value)); }
            } as FirestoreTransaction;
            try {
                const result = await this.active.run(true, () => fn(tx));
                if (version !== this.version) throw new Conflict();
                if (this.forceRetries > 0) { this.forceRetries--; throw new Conflict(); }
                if (this.failCommit) throw Error('COMMIT_FAILED');
                for (const [path, value] of writes) this.data.set(path, value);
                if (writes.size) this.version++;
                return result;
            } catch (error) {
                if (!(error instanceof Conflict)) throw error;
                this.retries++;
            }
        }
        throw Error('RETRY_LIMIT');
    }
    assertOutsideTransaction() { assert.equal(this.active.getStore(), undefined, 'external I/O in retry callback'); }
}
class Conflict extends Error {}
