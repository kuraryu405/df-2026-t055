import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, doc, type Storage } from '../apps/api/src/adapters.ts';
import { FakeTtsAdapter } from '../apps/api/src/tts.ts';

async function harness() {
    const db = new MemoryRepository();
    seed(db);
    const data = new Map<string, Buffer>();
    const storage: Storage = {
        async put(path, bytes) { data.set(path, Buffer.from(bytes)); },
        async get(path) { return Buffer.from(data.get(path)!); },
        async open(path) { return new Response(new Uint8Array(await this.get(path))).body!; },
        async copy(from, to) { await this.put(to, await this.get(from)); }
    };
    const tts = new FakeTtsAdapter();
    const { app } = createApp({ db, storage, tts });
    const step = { stepId: 's1', sourceStartMs: 0, sourceEndMs: 1000, frameMs: 500,
        imageAssetId: 'image', text: 'タオルを折ります', visibleCaution: '端を見ます',
        verifiedObservation: '両端が見える', verifiedSpeech: '端をそろえて', coaching: 'ゆっくり待つ', completionCheck: '端がそろう' };
    const draft = doc('demo', { id: 'draft', taskId: 'task', learnerId: 'a', status: 'editing', revision: 1,
        audioGuidance: true, editedSteps: [step], aiProposal: { reviewFlags: [], steps: [] },
        reviewChecks: { presentationConfirmed: true, flagResolution: '', steps: { s1: { videoVerified: true, photoTextVerified: true } } } });
    db.put('tasks', doc('demo', { id: 'task', videoAssetId: 'video' }));
    db.put('assets', doc('demo', { id: 'video', kind: 'video', durationMs: 1000, objectPath: 'source/video.mp4', mimeType: 'video/mp4' }));
    db.put('assets', doc('demo', { id: 'image', kind: 'image', draftId: 'draft', sourceVideoId: 'video', frameMs: 500, objectPath: 'draft/image.jpg', mimeType: 'image/jpeg' }));
    db.put('drafts', draft);
    await storage.put('draft/image.jpg', Buffer.from('synthetic original image'));
    await storage.put('source/video.mp4', Buffer.from('synthetic video'));
    async function request(path: string, method = 'GET', body?: unknown, token = 'staff') {
        return app.fetch(new Request(`http://localhost/api/v1${path}`, {
            method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }));
    }
    async function approve(id: string) {
        db.put('drafts', { ...draft, id });
        db.put('assets', { ...db.get('assets', 'image')!, draftId: id });
        const response = await request(`/drafts/${id}/approve`, 'POST', { expectedRevision: 1, approvalRequestId: id });
        assert.equal(response.status, 200);
        const { releaseId } = await response.json();
        return db.get('releases', releaseId)!;
    }
    return { db, request, approve };
}

for (const kind of ['image', 'audio'] as const) test(`新人は読んだ承認版の${kind}と対応する原動画だけ取得できる`, async () => {
    const h = await harness();
    const first = await h.approve('first');
    const second = await h.approve('second');
    const assetId = first.learnerSteps[0][`${kind}AssetId`];
    const otherAssetId = second.learnerSteps[0][`${kind}AssetId`];
    const getAsset = (id: string, token = 'newcomer') => h.request(`/assets/${id}`, 'GET', undefined, token);
    for (const id of [assetId, 'video', 'image']) {
        const response = await getAsset(id);
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error.code, 'ASSET_FORBIDDEN');
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await h.request(`/handover/releases/${first.id}/read`, 'POST', {}, 'newcomer')).status, 200);
    for (const id of [assetId, 'video']) {
        const response = await getAsset(id);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.ok((await response.arrayBuffer()).byteLength > 0);
    }
    for (const id of [otherAssetId, 'image']) assert.equal((await getAsset(id)).status, 403);

    // 別の新人の既読記録では許可しない。
    h.db.put('members', doc('demo', { id: 'unread-newcomer', uid: 'unread-newcomer', role: 'newcomer' }));
    for (const id of [assetId, 'video']) assert.equal((await getAsset(id, 'unread-newcomer')).status, 403);
});

test('本人は割当版の画像を取得でき、割当変更後にセッション未固定の旧版は取得できない', async () => {
    const h = await harness();
    const first = await h.approve('first');
    const second = await h.approve('second');
    const assign = (releaseId: string) => h.request('/assignments/a/task', 'PUT', { releaseId });
    const getImage = (r: typeof first) => h.request(`/assets/${r.learnerSteps[0].imageAssetId}`, 'GET', undefined, 'learner-a');
    assert.equal((await assign(first.id)).status, 200);
    assert.equal((await getImage(first)).status, 200);
    assert.equal((await getImage(second)).status, 403);
    assert.equal((await assign(second.id)).status, 200);
    assert.equal(h.db.all('sessions').length, 0);
    assert.equal((await getImage(first)).status, 403);
    assert.equal((await getImage(second)).status, 200);
});
