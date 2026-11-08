import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { stat } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Member } from '../../../packages/shared/src/index.ts';
export type Doc = {
    id: string;
    orgId: string;
    createdAt: string;
    [key: string]: any;
};
export type Awaitable<T> = T | Promise<T>;
export interface Repository {
    all(collection: string): Awaitable<Doc[]>;
    get(collection: string, id: string): Awaitable<Doc | undefined>;
    put(collection: string, value: Doc): Awaitable<void>;
    transaction<T>(fn: () => T | Promise<T>): Promise<T>;
}
// Transaction callbacks see private writes; commit publishes them atomically.
// An async Firestore adapter can use its own transaction context behind this port.
export class MemoryRepository implements Repository {
    private data = new Map<string, Map<string, Doc>>();
    private context = new AsyncLocalStorage<Map<string, Map<string, Doc>>>();
    private tail: Promise<unknown> = Promise.resolve();
    all(c: string) {
        const values = new Map(this.data.get(c));
        for (const [key, value] of this.context.getStore()?.get(c) ?? [])
            values.set(key, value);
        return [...values.values()].map(x => structuredClone(x));
    }
    get(c: string, key: string) {
        const x = this.context.getStore()?.get(c)?.get(key) ?? this.data.get(c)?.get(key);
        return x && structuredClone(x);
    }
    put(c: string, v: Doc) {
        const target = this.context.getStore() ?? this.data;
        if (!target.has(c))
            target.set(c, new Map());
        target.get(c)!.set(v.id, structuredClone(v));
    }
    async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
        if (this.context.getStore())
            return fn();
        const run = this.tail.then(async () => {
            const writes = new Map<string, Map<string, Doc>>();
            const value = await this.context.run(writes, fn);
            for (const [c, values] of writes) {
                if (!this.data.has(c))
                    this.data.set(c, new Map());
                for (const [key, v] of values)
                    this.data.get(c)!.set(key, v);
            }
            return value;
        });
        this.tail = run.catch(() => {
        });
        return run;
    }
}
export interface Storage {
    put(path: string, bytes: Buffer): Promise<void>;
    get(path: string): Promise<Buffer>;
    open(path: string): Promise<ReadableStream<Uint8Array>>;
    copy(from: string, to: string): Promise<void>;
}
export class LocalStorage implements Storage {
    constructor(private root = resolve('.local/assets')) {
    }
    private path(p: string) {
        if (p.includes('..') || p.startsWith('/'))
            throw Error('PATH');
        return resolve(this.root, p);
    }
    async put(p: string, b: Buffer) {
        const target = this.path(p);
        await mkdir(resolve(target, '..'), { recursive: true });
        await writeFile(target, b);
    }
    get(p: string) {
        return readFile(this.path(p));
    }
    async open(p: string) {
        const target = this.path(p);
        await stat(target);
        return Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>;
    }
    async copy(a: string, b: string) {
        await this.put(b, await this.get(a));
    }
}
export interface Auth {
    verify(token: string): Promise<(Member & { expiresAt?: number }) | undefined>;
}
export class DemoAuth implements Auth {
    constructor(private db: Repository) {
    }
    async verify(t: string) {
        const member = await this.db.get('members', t) as Member | undefined;
        // Demo credentials last one hour; production Auth supplies verified expiry in epoch milliseconds (#36).
        return member && { ...member, expiresAt: Date.now() + 60 * 60 * 1000 };
    }
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function doc(orgId: string, fields: Record<string, any>): Doc {
    return {
        id: id(), orgId, createdAt: now(), ...fields
    };
}
export function seed(db: MemoryRepository) {
    for (const [uid, role, learnerId, orgId] of [['staff', 'staff', undefined, 'demo'], ['learner-a', 'learner', 'a', 'demo'], ['learner-b', 'learner', 'b', 'demo'], ['newcomer', 'newcomer', undefined, 'demo'], ['other-staff', 'staff', undefined, 'other']] as const)
        db.put('members', doc(orgId, {
            id: uid, uid, role, learnerId
        }));
    for (const [learnerId, displayName, splitHints] of [['a', 'Aさん', '9工程'], ['b', 'Bさん', '折るを細分化した11工程']])
        db.put('learners', doc('demo', {
            id: learnerId, displayName, preferences: { sentenceLength: 40, splitHints, audioGuidance: learnerId === 'b' }, enteredBy: 'staff'
        }));
}
