import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, doc, type Storage } from '../apps/api/src/adapters.ts';
import { FakeTtsAdapter } from '../apps/api/src/tts.ts';
import { draftDetailSchema, releaseCopyResponseSchema, releaseSchema } from '../packages/shared/src/index.ts';

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
    async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', token = 'staff') {
        return app.fetch(new Request(`http://localhost/api/v1${path}`, {
            method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }));
    }
    const approve = (expectedRevision = 1) => request('/drafts/draft/approve', { expectedRevision, approvalRequestId: 'same-request' });
    return { db, storage, draft, spoken, request, approve };
}

async function copied() {
    const h = await harness();
    h.draft.displayMode = 'photo_only';
    h.draft.audioGuidance = true;
    h.draft.appliedSupportRecordRefs = [{ recordId: 'synthetic-record', revision: 1 }];
    h.db.put('drafts', h.draft);
    assert.equal((await h.approve()).status, 200);
    const source = h.db.all('releases')[0];
    const copy = () => h.request(`/releases/${source.id}/drafts`, { clientRequestId: 'copy-request' });
    return { ...h, source, copy };
}

test('承認版のコピーは手作業契約を満たし、再送・同時要求でも重複せず画像を独立させる', async () => {
    const h = await copied();
    const before = structuredClone(h.source);
    const responses = await Promise.all([h.copy(), h.copy()]);
    assert.deepEqual(responses.map(r => r.status), [201, 201]);
    const result = releaseCopyResponseSchema.parse(await responses[0].json());
    assert.deepEqual(await responses[1].json(), result);
    assert.deepEqual(await (await h.copy()).json(), result);
    const detail = await (await h.request(`/drafts/${result.draftId}`)).json();
    const d = draftDetailSchema.parse(detail.draft);
    assert.ok('sourceReleaseId' in d);
    assert.equal(d.sourceReleaseId, h.source.id);
    assert.equal(d.revision, 0);
    assert.equal(d.status, 'editing');
    assert.equal(d.displayMode, 'photo_only');
    assert.equal(d.audioGuidance, true);
    assert.deepEqual(d.appliedSupportRecordRefs, h.source.appliedSupportRecordRefs);
    assert.deepEqual(d.reviewChecks, { presentationConfirmed: false, flagResolution: '', steps: { s1: { videoVerified: false, photoTextVerified: false } } });
    const stored = h.db.get('drafts', result.draftId)!;
    assert.equal('jobId' in stored, false);
    assert.equal('aiProposal' in stored, false);
    assert.equal(h.db.all('generationJobs').length, 0);
    assert.equal(h.db.all('drafts').length, 2);
    assert.deepEqual(h.db.get('releases', h.source.id), before);
    const image = h.db.get('assets', d.editedSteps[0].imageAssetId)!;
    const original = h.db.get('assets', h.source.learnerSteps[0].imageAssetId)!;
    assert.notEqual(image.id, original.id);
    assert.notEqual(image.objectPath, original.objectPath);
    assert.equal(image.frameMs, original.frameMs);
    assert.equal(image.sourceVideoId, original.sourceVideoId);
    const bytes = await h.storage.get(original.objectPath);
    assert.deepEqual(Buffer.from(await (await h.request(`/assets/${image.id}`)).arrayBuffer()), bytes);
    await h.storage.put(image.objectPath, Buffer.from('synthetic edit'));
    assert.deepEqual(await h.storage.get(original.objectPath), bytes);
});

test('手作業の編集は再確認を要求し、承認版にコピー元を残す', async () => {
    const h = await copied();
    const { draftId } = await (await h.copy()).json();
    const d = (await (await h.request(`/drafts/${draftId}`)).json()).draft;
    const checks = { presentationConfirmed: true, flagResolution: '', steps: { s1: { videoVerified: true, photoTextVerified: true } } };
    const editedSteps = [{ ...d.editedSteps[0], text: '赤い線にあわせます' }];
    const patch = (revision: number) => h.request(`/drafts/${draftId}`, { expectedRevision: revision, editedSteps, reviewChecks: checks }, 'PATCH');
    const first = await patch(0);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).reviewChecks.presentationConfirmed, false);
    const approve = (revision: number) => h.request(`/drafts/${draftId}/approve`, { expectedRevision: revision, approvalRequestId: 'manual-approval' });
    assert.equal((await approve(1)).status, 422);
    assert.equal((await patch(1)).status, 200);
    const response = await approve(2);
    assert.equal(response.status, 200);
    const { releaseId } = await response.json();
    const { id, orgId, createdAt, approvalRequestId, ...contract } = h.db.get('releases', releaseId)!;
    const release = releaseSchema.parse(contract);
    assert.equal(release.sourceReleaseId, h.source.id);
    assert.equal(release.learnerSteps[0].text, editedSteps[0].text);
    assert.notEqual(release.learnerSteps[0].audioAssetId, h.source.learnerSteps[0].audioAssetId);
    assert.deepEqual(h.spoken, ['タオルを折ります', '赤い線にあわせます']);
});

for (const reason of ['refs', 'task', 'learner', 'org']) test(`手作業の承認は不正な継承を拒否する (${reason})`, async () => {
    const h = await copied();
    const { draftId } = await (await h.copy()).json();
    const d = h.db.get('drafts', draftId)!;
    d.reviewChecks = h.draft.reviewChecks;
    if (reason === 'refs') d.appliedSupportRecordRefs.push({ recordId: 'added-record', revision: 1 });
    else h.db.put('releases', { ...h.source, [reason === 'org' ? 'orgId' : `${reason}Id`]: 'other' });
    h.db.put('drafts', d);
    const response = await h.request(`/drafts/${draftId}/approve`, { expectedRevision: 0, approvalRequestId: 'reject' });
    assert.equal(response.status, reason === 'org' ? 403 : 422);
    assert.equal(h.db.all('releases').length, 1);
    assert.equal(h.db.get('drafts', draftId)!.status, 'editing');
});

test('コピーは職員・同じ所属・存在する版に限定する', async () => {
    const h = await copied();
    for (const [token, releaseId, status] of [['other-staff', h.source.id, 403], ['learner-a', h.source.id, 403], ['newcomer', h.source.id, 403], ['staff', 'missing', 404]] as const) {
        assert.equal((await h.request(`/releases/${releaseId}/drafts`, { clientRequestId: 'denied' }, 'POST', token)).status, status);
    }
    assert.equal(h.db.all('drafts').length, 1);
});
