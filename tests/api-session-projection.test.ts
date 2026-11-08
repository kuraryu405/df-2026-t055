import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, doc, type Storage } from '../apps/api/src/adapters.ts';
import { FakeTtsAdapter } from '../apps/api/src/tts.ts';
import { learnerSessionSchema } from '../packages/shared/src/index.ts';

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
        editedSteps: [step], aiProposal: { reviewFlags: [], steps: [] },
        reviewChecks: { presentationConfirmed: true, flagResolution: '', steps: { s1: { videoVerified: true, photoTextVerified: true } } } });
    db.put('tasks', doc('demo', { id: 'task', videoAssetId: 'video' }));
    db.put('assets', doc('demo', { id: 'video', kind: 'video', durationMs: 1000 }));
    db.put('assets', doc('demo', { id: 'image', kind: 'image', draftId: 'draft', sourceVideoId: 'video', frameMs: 500, objectPath: 'draft/image.jpg', mimeType: 'image/jpeg' }));
    db.put('drafts', draft);
    await storage.put('draft/image.jpg', Buffer.from('synthetic original image'));
    async function request(path: string, method = 'GET', body?: unknown, token = 'staff') {
        const response = await app.fetch(new Request(`http://localhost/api/v1${path}`, {
            method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }));
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    }
    const approve = (approvalRequestId = 'first') => request('/drafts/draft/approve', 'POST', { expectedRevision: 1, approvalRequestId });
    const assign = (releaseId: string) => request('/assignments/a/task', 'PUT', { releaseId });
    const start = (clientRequestId = 'start') => request('/me/sessions', 'POST', { taskId: 'task', clientRequestId }, 'learner-a');
    const load = (sessionId: string) => request(`/me/sessions/${sessionId}`, 'GET', undefined, 'learner-a');
    return { db, draft, request, approve, assign, start, load };
}

for (const audioGuidance of [false, true]) test(`写真のみの固定版を本人契約へ投影する（音声${audioGuidance}）`, async () => {
    const h = await harness();
    h.db.put('drafts', { ...h.draft, displayMode: 'photo_only', audioGuidance,
        editedSteps: [{ ...h.draft.editedSteps[0], imageAltText: '両端を合わせたタオル' }] });
    const { releaseId } = await h.approve();
    await h.assign(releaseId);
    const session = await h.start();
    learnerSessionSchema.parse(session);
    assert.equal(session.displayMode, 'photo_only');
    assert.equal(session.audioGuidance, audioGuidance);
    assert.deepEqual(Object.keys(session.steps[0]).sort(), [
        ...(audioGuidance ? ['audioAssetId'] : []), 'imageAltText', 'imageAssetId', 'order', 'stepId'
    ]);
    assert.equal(session.steps[0].imageAltText, '両端を合わせたタオル');
    if (audioGuidance) assert.ok(session.steps[0].audioAssetId);
    assert.deepEqual(await h.load(session.sessionId), session);
});

test('保存済み旧版は写真と短文・音声なし・工程文の代替テキストで返す', async () => {
    const h = await harness();
    const { releaseId } = await h.approve();
    const release = h.db.get('releases', releaseId)!;
    delete release.schemaVersion;
    delete release.appliedSupportRecordRefs;
    delete release.displayMode;
    delete release.audioGuidance;
    for (const step of release.learnerSteps) {
        delete step.imageAltText;
        step.audioAssetId = 'synthetic-stale-audio';
    }
    h.db.put('releases', release);
    await h.assign(releaseId);
    const session = await h.start();
    learnerSessionSchema.parse(session);
    assert.equal(session.displayMode, 'photo_text');
    assert.equal(session.audioGuidance, false);
    assert.equal(session.steps[0].text, h.draft.editedSteps[0].text);
    assert.equal(session.steps[0].imageAltText, session.steps[0].text);
    assert.equal(session.steps[0].visibleCaution, h.draft.editedSteps[0].visibleCaution);
    assert.ok(!('audioAssetId' in session.steps[0]));
    assert.deepEqual(await h.load(session.sessionId), session);
});

test('再生成・プロフィール変更・新版の割当後も開始済みセッションの表示方式と工程を保つ', async () => {
    const h = await harness();
    h.db.put('drafts', { ...h.draft, displayMode: 'photo_only', audioGuidance: false });
    const first = await h.approve();
    await h.assign(first.releaseId);
    const session = await h.start();
    const assignments = await h.request('/me/assignments', 'GET', undefined, 'learner-a');
    h.db.put('learners', { ...h.db.get('learners', 'a')!, preferences: { displayMode: 'photo_text', audioGuidance: true } });
    h.db.put('drafts', { ...h.draft, displayMode: 'photo_text', audioGuidance: true,
        editedSteps: [{ ...h.draft.editedSteps[0], text: '新しい工程です' }] });
    assert.deepEqual(await h.load(session.sessionId), session);
    assert.deepEqual(await h.request('/me/assignments', 'GET', undefined, 'learner-a'), assignments);
    const next = await h.approve('second');
    await h.assign(next.releaseId);
    assert.deepEqual(await h.load(session.sessionId), session);
    assert.deepEqual(await h.start(), session);
    const fresh = await h.start('next-start');
    learnerSessionSchema.parse(fresh);
    assert.equal(fresh.releaseId, next.releaseId);
    assert.equal(fresh.displayMode, 'photo_text');
    assert.equal(fresh.steps[0].text, '新しい工程です');
    assert.equal(fresh.audioGuidance, true);
});
