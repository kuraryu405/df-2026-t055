import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, doc, type Storage } from '../apps/api/src/adapters.ts';
import { FakeTtsAdapter } from '../apps/api/src/tts.ts';
import { releaseSchema } from '../packages/shared/src/index.ts';

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
    const spoken: string[] = [];
    const tts = new FakeTtsAdapter();
    const { app } = createApp({ db, storage, tts: { async synthesize(text) {
        spoken.push(text);
        return tts.synthesize(text);
    } } });
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
    async function request(path: string, body?: unknown) {
        return app.fetch(new Request(`http://localhost/api/v1${path}`, {
            method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer staff', 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }));
    }
    const approve = (expectedRevision = 1) => request('/drafts/draft/approve', { expectedRevision, approvalRequestId: 'same-request' });
    return { db, storage, draft, spoken, request, approve };
}

test('写真のみの承認版は提示設定・代替テキスト・本文・注意・教え方・採用記録を契約どおり保存する', async () => {
    const h = await harness();
    const refs = [{ recordId: 'synthetic-record', revision: 2 }];
    h.draft.displayMode = 'photo_only';
    h.draft.audioGuidance = true;
    h.draft.appliedSupportRecordRefs = refs;
    h.draft.editedSteps[0].imageAltText = '両端を合わせたタオル';
    h.db.put('drafts', h.draft);
    const response = await h.approve();
    assert.equal(response.status, 200);
    const { releaseId } = await response.json();
    const { id, orgId, createdAt, approvalRequestId, ...contract } = h.db.get('releases', releaseId)!;
    const r = releaseSchema.parse(contract);
    assert.equal(r.releaseId, releaseId);
    assert.equal(r.displayMode, 'photo_only');
    assert.equal(r.audioGuidance, true);
    assert.deepEqual(r.appliedSupportRecordRefs, refs);
    assert.equal(r.learnerSteps[0].imageAltText, '両端を合わせたタオル');
    assert.equal(r.learnerSteps[0].text, h.draft.editedSteps[0].text);
    assert.equal(r.learnerSteps[0].visibleCaution, h.draft.editedSteps[0].visibleCaution);
    const { stepId, sourceStartMs, sourceEndMs, verifiedObservation, verifiedSpeech, coaching, completionCheck } = h.draft.editedSteps[0];
    assert.deepEqual(r.staffGuide, [{ stepId, sourceStartMs, sourceEndMs, verifiedObservation, verifiedSpeech, coaching, completionCheck }]);
    assert.deepEqual(h.spoken, [r.learnerSteps[0].text]);
    assert.ok(r.learnerSteps[0].audioAssetId);
    assert.equal(r.contentHash, createHash('sha256').update(JSON.stringify({ displayMode: r.displayMode, audioGuidance: r.audioGuidance, learnerSteps: r.learnerSteps, staffGuide: r.staffGuide })).digest('hex'));
});

for (const alt of [undefined, '', '  \t ']) test(`旧下書きの設定と代替テキストを補完する (${JSON.stringify(alt)})`, async () => {
    const h = await harness();
    h.draft.editedSteps[0].imageAltText = alt;
    const learner = h.db.get('learners', 'a')!;
    h.db.put('learners', { ...learner, preferences: { ...learner.preferences, audioGuidance: true } });
    h.db.put('drafts', h.draft);
    assert.equal((await h.approve()).status, 200);
    const r = h.db.all('releases')[0];
    assert.equal(r.displayMode, 'photo_text');
    assert.equal(r.audioGuidance, true);
    assert.deepEqual(r.appliedSupportRecordRefs, []);
    assert.equal(r.learnerSteps[0].imageAltText, r.learnerSteps[0].text);
    assert.equal(h.spoken.length, 1);
});

test('下書きの音声falseをプロフィールtrueより優先する', async () => {
    const h = await harness();
    const learner = h.db.get('learners', 'a')!;
    h.db.put('learners', { ...learner, preferences: { ...learner.preferences, audioGuidance: true } });
    h.db.put('drafts', { ...h.draft, audioGuidance: false });
    assert.equal((await h.approve()).status, 200);
    assert.equal(h.db.all('releases')[0].audioGuidance, false);
    assert.deepEqual(h.spoken, []);
});

for (const concurrent of [false, true]) test(`同一承認要求は1件の版を返す (${concurrent ? '同時' : '直列'})`, async () => {
    const h = await harness();
    const responses = concurrent ? await Promise.all([h.approve(), h.approve()]) : [await h.approve(), await h.approve()];
    assert.deepEqual(responses.map(r => r.status), [200, 200]);
    assert.deepEqual(await responses[0].json(), await responses[1].json());
    assert.equal(h.db.all('releases').length, 1);
});

test('元画像を差し替えても承認版の画像は承認時のバイト列を返す', async () => {
    const h = await harness();
    const original = await h.storage.get('draft/image.jpg');
    assert.equal((await h.approve()).status, 200);
    const r = h.db.all('releases')[0];
    await h.storage.put('draft/image.jpg', Buffer.from('synthetic replacement'));
    const response = await h.request(`/assets/${r.learnerSteps[0].imageAssetId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
});

for (const reason of ['revision', 'review', 'contract']) test(`承認拒否で版や承認資産を保存しない (${reason})`, async () => {
    const h = await harness();
    if (reason === 'review') h.draft.reviewChecks.presentationConfirmed = false;
    if (reason === 'contract') h.draft.appliedSupportRecordRefs = [{ recordId: 'invalid', revision: 0 }];
    h.db.put('drafts', h.draft);
    const response = await h.approve(reason === 'revision' ? 0 : 1);
    assert.equal(response.status, reason === 'revision' ? 409 : 422);
    assert.equal(h.db.all('releases').length, 0);
    assert.equal(h.db.all('assets').filter(a => a.visibility === 'approved').length, 0);
    assert.equal(h.db.get('drafts', 'draft')!.status, 'editing');
});
