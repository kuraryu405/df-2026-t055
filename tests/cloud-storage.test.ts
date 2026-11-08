import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudStorage, configuredStorage, type CloudStorageClient } from '../apps/api/src/cloud-storage.ts';
import { LocalStorage, MemoryRepository, seed, doc } from '../apps/api/src/adapters.ts';
import { FakeTtsAdapter } from '../apps/api/src/tts.ts';
import { createApp } from '../apps/api/src/app.ts';

class FakeCloudStorage implements CloudStorageClient {
    objects = new Map<string, { generation: string; bytes: Buffer }>();
    sequence = 9007199254740993n;
    opens = 0;
    async put(bucket: string, path: string, bytes: Buffer, options: { ifGenerationMatch: '0' }) {
        assert.equal(bucket, 'private-test'); assert.deepEqual(options, { ifGenerationMatch: '0' });
        if (this.objects.has(path)) throw Error('PRECONDITION_FAILED');
        const generation = String(this.sequence++);
        this.objects.set(path, { generation, bytes: Buffer.from(bytes) });
        return generation;
    }
    read(path: string, generation: string) {
        const object = this.objects.get(path);
        if (!object || object.generation !== generation) throw Error('PRECONDITION_FAILED');
        return object.bytes;
    }
    async open(bucket: string, path: string, options: { ifGenerationMatch: string }) {
        assert.equal(bucket, 'private-test'); this.opens++;
        return new Response(new Uint8Array(this.read(path, options.ifGenerationMatch))).body!;
    }
    async copy(bucket: string, from: string, to: string, options: { ifSourceGenerationMatch: string; ifGenerationMatch: '0' }) {
        return this.put(bucket, to, this.read(from, options.ifSourceGenerationMatch), { ifGenerationMatch: options.ifGenerationMatch });
    }
}
const source = 'source/demo/task/video.mp4', draft = 'draft/demo/draft/image.jpg', approved = 'approved/demo/release/image.jpg';
test('explicit cloud selection fails closed; local stays default', () => {
    assert.ok(configuredStorage({}) instanceof LocalStorage);
    assert.throws(() => configuredStorage({ STORAGE_BACKEND: 'cloud' }), /CLIENT_NOT_CONFIGURED/);
    assert.throws(() => configuredStorage({ STORAGE_BACKEND: 'bad' }), /INVALID_STORAGE_BACKEND/);
    assert.throws(() => configuredStorage({ STORAGE_BACKEND: 'cloud' }, new FakeCloudStorage()), /BUCKET_REQUIRED/);
});
test('private paths, exact generations, atomic no-overwrite and streaming share the Storage port', async () => {
    const client = new FakeCloudStorage(), storage = new CloudStorage(client, 'private-test');
    const generation = await storage.put(source, Buffer.from('video'));
    assert.equal(generation, '9007199254740993');
    assert.equal(storage.privateUri(source), 'gs://private-test/' + source);
    const dg = await storage.put(draft, Buffer.from('image'));
    const ag = await storage.copy(draft, approved, dg);
    assert.equal((await storage.get(approved, ag)).toString(), 'image');
    assert.equal(await new Response(await storage.open(source, generation)).text(), 'video');
    await assert.rejects(storage.put(approved, Buffer.from('replace')), /PRECONDITION/);
    await assert.rejects(storage.copy(draft, approved, dg), /PRECONDITION/);
    for (const operation of [() => storage.open(source, '1'), () => storage.get(source, '1'), () => storage.copy(source, 'draft/demo/draft/copy.jpg', '1')])
        await assert.rejects(operation(), /PRECONDITION/);
    await assert.rejects(storage.get(source), /GENERATION_REQUIRED/);
    for (const path of ['outside/demo/task/a', 'source/demo/a', '/'+source, 'draft/demo/draft/../a', 'draft/demo/draft/%2e%2e', 'approved/demo/release/a?token=x', 'source/demo/task/a\\b']) {
        await assert.rejects(storage.put(path, Buffer.from('x')), /INVALID_STORAGE_PATH/);
        await assert.rejects(storage.open(path, generation), /INVALID_STORAGE_PATH/);
        await assert.rejects(storage.copy(source, path, generation), /INVALID_STORAGE_PATH/);
        assert.throws(() => storage.privateUri(path), /INVALID_STORAGE_PATH/);
    }
    await assert.rejects(storage.copy(source, 'draft/other/draft/image.jpg', generation), /ORG_MISMATCH/);
    const races = await Promise.allSettled([storage.copy(draft, 'approved/demo/release/race.jpg', dg), storage.copy(draft, 'approved/demo/release/race.jpg', dg)]);
    assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
});
test('API authenticates and checks roles before opening pinned private streams', async () => {
    const client = new FakeCloudStorage(), storage = new CloudStorage(client, 'private-test');
    const db = new MemoryRepository(); seed(db);
    const generation = await storage.put(draft, Buffer.from('private image'));
    await db.put('assets', doc('demo', { id: 'image', kind: 'image', visibility: 'staff', objectPath: draft, generation, mimeType: 'image/jpeg' }));
    const app = createApp({ db, storage }).app;
    const fetch = (token?: string) => app.fetch(new Request('http://localhost/api/v1/assets/image', { headers: token ? { authorization: `Bearer ${token}` } : {} }));
    for (const [token, status] of [[undefined, 401], ['learner-a', 403], ['newcomer', 403], ['other-staff', 403]] as const)
        assert.equal((await fetch(token)).status, status);
    assert.equal(client.opens, 0);
    const response = await fetch('staff');
    assert.equal(response.status, 200); assert.equal(await response.text(), 'private image');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const ag = await storage.copy(draft, approved, generation);
    await db.put('assets', doc('demo', { id: 'image', kind: 'image', visibility: 'approved', releaseId: 'release', objectPath: approved, generation: ag, mimeType: 'image/jpeg' }));
    await db.put('releases', doc('demo', { id: 'release', learnerId: 'a', learnerSteps: [{ imageAssetId: 'image' }] }));
    await db.put('assignments', doc('demo', { learnerId: 'a', releaseId: 'release' }));
    assert.equal(await (await fetch('learner-a')).text(), 'private image');
    assert.equal((await fetch('learner-b')).status, 403);
    client.objects.set(approved, { generation: '99', bytes: Buffer.from('replacement') });
    const stale = await fetch('learner-a');
    assert.equal(stale.status, 500); assert.doesNotMatch(await stale.text(), /replacement|objectPath|gs:\/\//);
});

test('approval and manual draft copy persist the generations returned by cloud storage', async () => {
    const client = new FakeCloudStorage(), storage = new CloudStorage(client, 'private-test');
    const db = new MemoryRepository(); seed(db);
    const generation = await storage.put(draft, Buffer.from('image'));
    const app = createApp({ db, storage, tts: new FakeTtsAdapter() }).app;
    const request = (path: string, body: unknown) => app.fetch(new Request(`http://localhost/api/v1${path}`, { method: 'POST', headers: { authorization: 'Bearer staff', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    await db.put('tasks', doc('demo', { id: 'task', videoAssetId: 'video' }));
    await db.put('assets', doc('demo', { id: 'video', kind: 'video', durationMs: 1000 }));
    await db.put('assets', doc('demo', { id: 'image', kind: 'image', draftId: 'draft', sourceVideoId: 'video', frameMs: 500, objectPath: draft, generation, mimeType: 'image/jpeg' }));
    await db.put('drafts', doc('demo', { id: 'draft', learnerId: 'a', taskId: 'task', revision: 1, status: 'editing', audioGuidance: true,
        editedSteps: [{ stepId: 's1', text: '折る', imageAssetId: 'image', imageAltText: 'タオル', visibleCaution: '', sourceStartMs: 0, sourceEndMs: 1000, frameMs: 500, verifiedObservation: '', verifiedSpeech: '', coaching: '', completionCheck: '' }],
        aiProposal: { reviewFlags: [], steps: [] }, reviewChecks: { presentationConfirmed: true, flagResolution: '', steps: { s1: { videoVerified: true, photoTextVerified: true } } } }));
    const response = await request('/drafts/draft/approve', { expectedRevision: 1, approvalRequestId: 'cloud-approval' });
    assert.equal(response.status, 200, await response.clone().text());
    const release = db.all('releases')[0];
    for (const asset of db.all('assets').filter(a => a.releaseId === release.id)) {
        assert.equal(asset.generation, client.objects.get(asset.objectPath)!.generation);
        assert.ok(asset.objectPath.startsWith(`approved/demo/${release.id}/`));
    }
    const copied = await request(`/releases/${release.id}/drafts`, { clientRequestId: 'cloud-copy' });
    assert.equal(copied.status, 201, await copied.clone().text());
    const copy = db.all('drafts').find(d => d.id !== 'draft')!;
    const image = db.get('assets', copy.editedSteps[0].imageAssetId)!;
    assert.ok(image.objectPath.startsWith(`draft/demo/${copy.id}/`));
    assert.equal((await storage.get(image.objectPath, image.generation)).toString(), 'image');
    assert.deepEqual(db.get('releases', release.id), release);
});
