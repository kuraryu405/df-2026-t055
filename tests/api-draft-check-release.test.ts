import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, doc, type Storage } from '../apps/api/src/adapters.ts';
import type { EditedStep, ReviewChecks } from '../packages/shared/src/index.ts';

function harness() {
    const db = new MemoryRepository();
    seed(db);
    const storage: Storage = {
        async put() {}, async get() { return Buffer.from('synthetic image'); },
        async open() { return new Response('synthetic image').body!; }, async copy() {}
    };
    const { app } = createApp({ db, storage });
    db.put('assets', doc('demo', { id: 'video', kind: 'video', durationMs: 1000 }));
    db.put('tasks', doc('demo', { id: 'task', videoAssetId: 'video' }));
    const steps: EditedStep[] = ['one', 'two', 'three'].map(stepId => {
        db.put('assets', doc('demo', { id: stepId, kind: 'image', draftId: 'draft', sourceVideoId: 'video', frameMs: 500, objectPath: stepId }));
        return { stepId, text: 'タオルを折る', imageAssetId: stepId, imageAltText: 'タオル', visibleCaution: '', sourceStartMs: 0, sourceEndMs: 1000, frameMs: 500, verifiedObservation: '', verifiedSpeech: '', coaching: '', completionCheck: '' };
    });
    const checks: ReviewChecks = { presentationConfirmed: true, flagResolution: '確認済み', steps: Object.fromEntries(steps.map(s => [s.stepId, { videoVerified: true, photoTextVerified: true }])) };
    db.put('drafts', doc('demo', { id: 'draft', taskId: 'task', learnerId: 'a', status: 'editing', revision: 1, editedSteps: steps, reviewChecks: checks, displayMode: 'photo_text', audioGuidance: false, aiProposal: { steps: [], reviewFlags: [] } }));
    async function request(path: string, method: string, body: unknown) {
        const response = await app.fetch(new Request(`http://localhost/api/v1${path}`, { method, headers: { authorization: 'Bearer staff', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
        return { status: response.status, data: await response.json() as any };
    }
    async function patch(editedSteps = steps, reviewChecks = checks, options = {}) {
        const result = await request('/drafts/draft', 'PATCH', { expectedRevision: db.get('drafts', 'draft')!.revision, editedSteps, reviewChecks, ...options });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.deepEqual(result.data.reviewChecks, db.get('drafts', 'draft')!.reviewChecks);
        return result.data;
    }
    return { db, steps, checks, patch, request };
}

test('text の変更は true の要求より解除を優先し、再確認後に承認できる。古い revision は409', async () => {
    const h = harness();
    const steps = structuredClone(h.steps);
    steps[0].text = '赤い線にあわせる';
    const result = await h.patch(steps);
    assert.deepEqual(result.reviewChecks, { ...h.checks, presentationConfirmed: false, steps: { ...h.checks.steps, one: { videoVerified: true, photoTextVerified: false } } });
    assert.equal((await h.request('/drafts/draft/approve', 'POST', { expectedRevision: result.revision, approvalRequestId: 'approve' })).status, 422);
    const saved = h.db.get('drafts', 'draft');
    assert.equal((await h.request('/drafts/draft', 'PATCH', { expectedRevision: 1, editedSteps: steps, reviewChecks: h.checks })).status, 409);
    assert.deepEqual(h.db.get('drafts', 'draft'), saved);
    const rechecked = await h.patch(steps);
    assert.deepEqual(rechecked.reviewChecks, h.checks);
    assert.equal((await h.request('/drafts/draft/approve', 'POST', { expectedRevision: rechecked.revision, approvalRequestId: 'approve' })).status, 200);
});

for (const field of ['imageAssetId', 'visibleCaution', 'imageAltText', 'coaching', 'verifiedObservation', 'verifiedSpeech', 'completionCheck'] as const) {
    test(`${field} の変更で写真・説明と提示確認を解除する`, async () => {
        const h = harness();
        const steps = structuredClone(h.steps);
        steps[0][field] = field === 'imageAssetId' ? 'two' : '変更';
        const { reviewChecks } = await h.patch(steps);
        assert.deepEqual(reviewChecks, { ...h.checks, presentationConfirmed: false, steps: { ...h.checks.steps, one: { videoVerified: true, photoTextVerified: false } } });
    });
}

for (const field of ['sourceStartMs', 'sourceEndMs', 'frameMs'] as const) {
    test(`${field} の変更で動画照合も解除する`, async () => {
        const h = harness();
        const steps = structuredClone(h.steps);
        const index = field === 'sourceStartMs' ? 2 : 0;
        steps[index][field] += field === 'sourceEndMs' ? -1 : 1;
        if (field === 'frameMs') {
            h.db.put('assets', doc('demo', { ...h.db.get('assets', 'one')!, frameMs: 501 }));
        }
        const { reviewChecks } = await h.patch(steps);
        assert.deepEqual(reviewChecks, { ...h.checks, presentationConfirmed: false, steps: { ...h.checks.steps, [steps[index].stepId]: { videoVerified: false, photoTextVerified: false } } });
    });
}

test('並替えは位置が変わった工程だけを解除する', async () => {
    const h = harness();
    const { reviewChecks } = await h.patch([h.steps[1], h.steps[0], h.steps[2]]);
    assert.deepEqual(reviewChecks, { ...h.checks, presentationConfirmed: false, steps: { one: { videoVerified: false, photoTextVerified: false }, two: { videoVerified: false, photoTextVerified: false }, three: h.checks.steps.three } });
});

test('追加工程は両方解除し、削除工程のチェックは保存しない', async () => {
    const h = harness();
    const added = { ...h.steps[0], stepId: 'new' };
    const checks = { ...h.checks, steps: { ...h.checks.steps, new: { videoVerified: true, photoTextVerified: true } } };
    const result = await h.patch([...h.steps, added], checks);
    assert.deepEqual(result.reviewChecks, { ...checks, presentationConfirmed: false, steps: { ...h.checks.steps, new: { videoVerified: false, photoTextVerified: false } } });
    const removed = await h.patch(h.steps, checks);
    assert.deepEqual(removed.reviewChecks, { ...h.checks, presentationConfirmed: false });
});

for (const options of [{ displayMode: 'photo_only' }, { audioGuidance: true }]) {
    test(`${JSON.stringify(options)} の変更は提示確認だけを解除する`, async () => {
        const h = harness();
        assert.deepEqual((await h.patch(h.steps, h.checks, options)).reviewChecks, { ...h.checks, presentationConfirmed: false });
        assert.deepEqual((await h.patch(h.steps, h.checks, options)).reviewChecks, h.checks);
    });
}

test('内容変更なしなら要求のチェック値と flagResolution をそのまま保存する', async () => {
    const h = harness();
    const checks = { presentationConfirmed: true, flagResolution: '更新した対応記録', steps: { one: { videoVerified: false, photoTextVerified: true }, two: { videoVerified: true, photoTextVerified: false } } };
    assert.deepEqual((await h.patch(h.steps, checks)).reviewChecks, checks);
    assert.deepEqual((await h.patch()).reviewChecks, h.checks);
});

test('旧下書きの提示設定の既定値を明示しても解除しない', async () => {
    const h = harness();
    const draft = h.db.get('drafts', 'draft')!;
    delete draft.displayMode;
    delete draft.audioGuidance;
    h.db.put('drafts', draft);
    assert.deepEqual((await h.patch(h.steps, h.checks, { displayMode: 'photo_text', audioGuidance: false })).reviewChecks, h.checks);
});
