import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doc, MemoryRepository, seed, type Repository, type Storage } from '../apps/api/src/adapters.ts';
import { configuredRepository, FirestoreRepository } from '../apps/api/src/firestore-repository.ts';
import { FakeFirestore } from './helpers/fake-firestore.ts';
import { createApp } from '../apps/api/src/app.ts';
import { createWorker } from '../apps/generator/src/worker.ts';
import { FakeTtsAdapter } from '../apps/api/src/tts.ts';

test('configuration keeps memory default and fails closed without an explicit SDK binding', () => {
    assert.ok(configuredRepository({}) instanceof MemoryRepository);
    assert.throws(() => configuredRepository({ REPOSITORY_BACKEND: 'firestore' }), /FIRESTORE_CLIENT_NOT_CONFIGURED/);
    assert.throws(() => configuredRepository({ REPOSITORY_BACKEND: 'oops' }), /INVALID_REPOSITORY_BACKEND/);
});
for (const backend of ['memory', 'firestore']) {
    test(`${backend}: shared port supports rollback, private writes and nested transactions`, async () => {
        const db: Repository = backend === 'memory' ? new MemoryRepository() : new FirestoreRepository(new FakeFirestore(), 'demo');
        await db.put('items', doc('demo', { id: 'one', revision: 0 }));
        await assert.rejects(db.transaction(async () => {
            await db.put('items', doc('demo', { id: 'two' }));
            await db.transaction(async () => {
                assert.equal((await db.get('items', 'two'))!.id, 'two');
                assert.equal((await db.all('items')).length, 2);
            });
            throw Error('ROLLBACK');
        }), /ROLLBACK/);
        assert.equal(await db.get('items', 'two'), undefined);
    });
}
test('two instances retry revision conflicts, deduplicate query keys and increase revisions monotonically', async () => {
    const client = new FakeFirestore();
    const a = new FirestoreRepository(client, 'demo'), b = new FirestoreRepository(client, 'demo');
    await a.put('items', doc('demo', { id: 'one', revision: 0 }));
    const update = (db: Repository, expected: number) => db.transaction(async () => {
        const current = (await db.get('items', 'one'))!;
        if (current.revision !== expected) throw Error('REVISION_CONFLICT');
        await db.put('items', { ...current, revision: expected + 1 });
    });
    const results = await Promise.allSettled([update(a, 0), update(b, 0)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.match((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.message, /REVISION_CONFLICT/);
    await update(b, 1);
    assert.equal((await a.get('items', 'one'))!.revision, 2);
    const insert = (db: Repository) => db.transaction(async () => {
        const prior = (await db.all('events')).find(d => d.key === 'same');
        if (prior) return prior.id;
        const event = doc('demo', { key: 'same' });
        await db.put('events', event);
        return event.id;
    });
    const ids = await Promise.all([insert(a), insert(b)]);
    assert.equal(ids[0], ids[1]); assert.equal(await insert(a), ids[0]);
    assert.equal((await a.all('events')).length, 1);
    assert.ok(client.retries > 0);
});
test('tenant checks cover queries, reads, creates and overwrite races; binary and malformed metadata rejected', async () => {
    const client = new FakeFirestore();
    const a = new FirestoreRepository(client, 'demo'), b = new FirestoreRepository(client, 'other');
    await b.put('items', doc('other', { id: 'foreign' }));
    assert.deepEqual(await a.all('items'), []);
    await assert.rejects(a.get('items', 'foreign'), /ORG_FORBIDDEN/);
    await assert.rejects(a.put('items', doc('other', { id: 'new' })), /ORG_FORBIDDEN/);
    await assert.rejects(a.put('items', doc('demo', { id: 'foreign' })), /ORG_FORBIDDEN/);
    await assert.rejects(a.put('items', doc('demo', { bytes: Buffer.from('image') })), /INVALID_FIRESTORE_METADATA/);
    await assert.rejects(a.put('items', doc('demo', { createdAt: '' })), /INVALID_FIRESTORE_DOCUMENT/);
    await assert.rejects(a.get('items', '../x'), /INVALID_DOCUMENT_PATH/);
    client.failCommit = true;
    await assert.rejects(a.transaction(async () => {
        await a.put('items', doc('demo', { id: 'first' }));
        await a.put('items', doc('demo', { id: 'second' }));
    }), /COMMIT_FAILED/);
    assert.deepEqual(await a.all('items'), []);
});

async function harness() {
    const client = new FakeFirestore(), db = new FirestoreRepository(client, 'demo');
    const memory = new MemoryRepository(); seed(memory);
    for (const c of ['members', 'learners']) for (const d of memory.all(c).filter(d => d.orgId === 'demo')) await db.put(c, d);
    let io = 0, spoken = 0;
    const storage: Storage = {
        async get() { client.assertOutsideTransaction(); io++; return Buffer.from('synthetic'); },
        async put() { client.assertOutsideTransaction(); io++; },
        async copy() { client.assertOutsideTransaction(); io++; },
        async open() { client.assertOutsideTransaction(); return new Response('synthetic').body!; }
    };
    const tts = new FakeTtsAdapter();
    const app = createApp({ db, storage, tts: { async synthesize(text) { client.assertOutsideTransaction(); spoken++; return tts.synthesize(text); } } }).app;
    const request = (path: string, body: unknown) => app.fetch(new Request(`http://localhost/api/v1${path}`, { method: 'POST', headers: { authorization: 'Bearer staff', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { client, db, storage, request, counts: () => ({ io, spoken }) };
}
test('API approval and manual copy retry only metadata, preserve approval idempotency and source', async () => {
    const h = await harness();
    await h.db.put('tasks', doc('demo', { id: 'task', videoAssetId: 'video' }));
    await h.db.put('assets', doc('demo', { id: 'video', kind: 'video', durationMs: 1000 }));
    await h.db.put('assets', doc('demo', { id: 'image', kind: 'image', draftId: 'draft', sourceVideoId: 'video', frameMs: 500, objectPath: 'image', mimeType: 'image/jpeg' }));
    await h.db.put('drafts', doc('demo', { id: 'draft', learnerId: 'a', taskId: 'task', revision: 1, status: 'editing', audioGuidance: true,
        editedSteps: [{ stepId: 's1', text: '折る', imageAssetId: 'image', imageAltText: 'タオル', visibleCaution: '', sourceStartMs: 0, sourceEndMs: 1000, frameMs: 500, verifiedObservation: '', verifiedSpeech: '', coaching: '', completionCheck: '' }],
        aiProposal: { reviewFlags: [], steps: [] }, reviewChecks: { presentationConfirmed: true, flagResolution: '', steps: { s1: { videoVerified: true, photoTextVerified: true } } } }));
    h.client.forceRetries = 2;
    const approve = () => h.request('/drafts/draft/approve', { expectedRevision: 1, approvalRequestId: 'same-key' });
    const result = await approve(); assert.equal(result.status, 200, await result.clone().text());
    assert.deepEqual(h.counts(), { io: 2, spoken: 1 });
    assert.deepEqual(await (await approve()).json(), await result.json());
    assert.deepEqual(h.counts(), { io: 2, spoken: 1 });
    const release = (await h.db.all('releases'))[0];
    h.client.forceRetries = 2;
    const copy = () => h.request(`/releases/${release.id}/drafts`, { clientRequestId: 'copy-key' });
    const copied = await copy(); assert.equal(copied.status, 201, await copied.clone().text());
    assert.deepEqual(await (await copy()).json(), await copied.json());
    assert.deepEqual(h.counts(), { io: 3, spoken: 1 });
    assert.deepEqual(await h.db.get('releases', release.id), release);
    assert.equal((await h.db.all('drafts')).length, 2);
});
test('generator shares the port; lease/failed result retry without repeating model I/O', async () => {
    const h = await harness();
    await h.db.put('tasks', doc('demo', { id: 'task', videoAssetId: 'video' }));
    await h.db.put('assets', doc('demo', { id: 'video', objectPath: 'video', durationMs: 1000 }));
    await h.db.put('drafts', doc('demo', { id: 'draft', learnerId: 'a' }));
    await h.db.put('generationJobs', doc('demo', { id: 'job', draftId: 'draft', taskId: 'task', status: 'queued', attempt: 0, budgetUsed: 1 }));
    let calls = 0;
    const run = createWorker(h.db, h.storage, { async generate() {
        h.client.assertOutsideTransaction(); calls++; h.client.forceRetries = 2; throw Error('synthetic model failure');
    } }, 30);
    h.client.forceRetries = 2;
    await run('job'); await run('job');
    assert.equal(calls, 1);
    assert.equal((await h.db.get('generationJobs', 'job'))!.status, 'failed');
    assert.equal((await h.db.get('generationJobs', 'job'))!.attempt, 1);
    assert.equal((await h.db.get('drafts', 'draft'))!.status, 'failed');
});
test('two API instances preserve stop over concurrent progress and deduplicate its resend', async () => {
    const h = await harness();
    const other = new FirestoreRepository(h.client, 'demo');
    const apps = [createApp({ db: h.db }).app, createApp({ db: other }).app];
    await h.db.put('releases', doc('demo', { id: 'release', learnerId: 'a', learnerSteps: [{ stepId: 's1' }, { stepId: 's2' }] }));
    await h.db.put('sessions', doc('demo', { id: 'session', learnerId: 'a', releaseId: 'release', status: 'active', revision: 0, stepIndex: 0 }));
    const event = (index: number, type: string) => apps[index].fetch(new Request('http://localhost/api/v1/me/sessions/session/events', {
        method: 'POST', headers: { authorization: 'Bearer learner-a', 'content-type': 'application/json' },
        body: JSON.stringify({ clientEventId: type, type, expectedRevision: 0 })
    }));
    const results = await Promise.all([event(0, 'next'), event(1, 'stop')]);
    assert.equal(results[1].status, 200);
    assert.ok([200, 409].includes(results[0].status));
    const stopped = await h.db.get('sessions', 'session');
    assert.equal(stopped!.status, 'stopped'); assert.equal(stopped!.releaseId, 'release');
    assert.equal((await event(0, 'stop')).status, 200);
    assert.equal((await event(0, 'next')).status, 409);
    assert.deepEqual(await h.db.get('sessions', 'session'), stopped);
    assert.equal((await h.db.all('sessionEvents')).filter(e => e.type === 'stop').length, 1);
});
