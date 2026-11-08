import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, doc, type Storage } from '../apps/api/src/adapters.ts';
import { FakeTtsAdapter } from '../apps/api/src/tts.ts';
import { supportRequestListResponseSchema, supportClaimResponseSchema, supportStartResponseSchema, supportAcknowledgeResponseSchema } from '../packages/shared/src/support.ts';

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
    db.put('members', doc('demo', { id: 'staff-2', uid: 'staff-2', role: 'staff' }));
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
    async function request(path: string, method = 'GET', body?: unknown, token = 'staff', status: number | number[] = 200) {
        const response = await app.fetch(new Request(`http://localhost/api/v1${path}`, {
            method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }));
        assert.ok((Array.isArray(status) ? status : [status]).includes(response.status), await response.clone().text());
        return response.json();
    }
    const approve = (approvalRequestId = 'first') => request('/drafts/draft/approve', 'POST', { expectedRevision: 1, approvalRequestId });
    const assign = (releaseId: string) => request('/assignments/a/task', 'PUT', { releaseId });
    const start = (clientRequestId = 'start') => request('/me/sessions', 'POST', { taskId: 'task', clientRequestId }, 'learner-a');
    const load = (sessionId: string) => request(`/me/sessions/${sessionId}`, 'GET', undefined, 'learner-a');
    await assign((await approve()).releaseId);
    async function support(kind = 'help') {
        const session = await start(crypto.randomUUID());
        const response = await request(`/me/sessions/${session.sessionId}/events`, 'POST', {
            clientEventId: crypto.randomUUID(), expectedRevision: session.revision, type: kind
        }, 'learner-a');
        assert.deepEqual(Object.keys(response).sort(), ['revision', 'schemaVersion', 'status', 'stepIndex']);
        return db.all('supportRequests').find(q => q.sessionId === session.sessionId)!;
    }
    const list = async (query = '', token = 'staff') => supportRequestListResponseSchema.parse(await request(`/support-requests${query}`, 'GET', undefined, token)).requests;
    const claim = (requestId: string, token = 'staff', status: number | number[] = 200, body: unknown = {}) => request(`/support-requests/${requestId}/claim`, 'POST', body, token, status);
    return { db, request, support, list, claim };
}

test('helpは担当・開始・完了の順で契約応答と一覧revisionを更新し、再送は保存値を保つ', async () => {
    const h = await harness();
    const q = await h.support();
    const operate = (operation: string) => h.request(`/support-requests/${q.id}/${operation}`, 'POST', {});
    assert.equal(supportClaimResponseSchema.parse(await operate('claim')).revision, 2);
    assert.equal((await h.list())[0].status, 'assigned');
    const started = supportStartResponseSchema.parse(await operate('start'));
    assert.deepEqual(await operate('start'), started);
    const progressing = (await h.list())[0];
    assert.equal(progressing.status, 'in_progress');
    assert.equal(progressing.revision, 3);
    assert.ok('startedAt' in progressing);
    assert.equal(progressing.startedAt, started.startedAt);
    assert.equal(progressing.startedBy, 'staff');
    const acknowledged = supportAcknowledgeResponseSchema.parse(await operate('acknowledge'));
    assert.deepEqual(await operate('acknowledge'), acknowledged);
    assert.deepEqual(await h.list(), []);
    const completed = (await h.list('?status=acknowledged'))[0];
    assert.equal(completed.status, 'acknowledged');
    assert.equal(completed.revision, 4);
    assert.ok('acknowledgedAt' in completed);
    assert.equal(completed.acknowledgedAt, acknowledged.acknowledgedAt);
    assert.equal(completed.acknowledgedBy, 'staff');
    await h.request(`/support-requests/${q.id}/start`, 'POST', {}, 'staff', 409);
    assert.deepEqual((await h.list('?status=acknowledged'))[0], completed);
});

test('helpの順序違いと担当外操作を拒否し、保存しない', async () => {
    const h = await harness();
    const q = await h.support();
    async function reject(operation: string, token: string, status: number) {
        const before = h.db.get('supportRequests', q.id);
        await h.request(`/support-requests/${q.id}/${operation}`, 'POST', {}, token, status);
        assert.deepEqual(h.db.get('supportRequests', q.id), before);
    }
    await reject('start', 'staff', 409);
    await reject('acknowledge', 'staff', 409);
    await h.claim(q.id);
    await reject('acknowledge', 'staff', 409);
    for (const operation of ['start', 'acknowledge'])
        await reject(operation, 'staff-2', 403);
    await h.request(`/support-requests/${q.id}/start`, 'POST', {});
    await reject('acknowledge', 'staff-2', 403);
});

test('stopは担当・開始なしで同じ所属の職員が確認し、再送は時刻を保つ', async () => {
    const h = await harness();
    const q = await h.support('stop');
    await h.request(`/support-requests/${q.id}/start`, 'POST', {}, 'staff', 409);
    const result = supportAcknowledgeResponseSchema.parse(await h.request(`/support-requests/${q.id}/acknowledge`, 'POST', {}, 'staff-2'));
    assert.deepEqual(await h.request(`/support-requests/${q.id}/acknowledge`, 'POST', {}, 'staff-2'), result);
    await h.request(`/support-requests/${q.id}/acknowledge`, 'POST', {}, 'staff', 409);
    const stored = h.db.get('supportRequests', q.id)!;
    const listed = (await h.list('?status=acknowledged'))[0];
    assert.equal(listed.status, 'acknowledged');
    assert.equal(listed.revision, 2);
    assert.equal(stored.acknowledgedBy, 'staff-2');
    for (const field of ['assignedTo', 'assignedAt', 'startedBy', 'startedAt']) {
        assert.ok(!(field in stored));
        assert.ok(!(field in listed));
    }
});

test('開始・確認は認証・職員・所属・空objectを検査する', async () => {
    const h = await harness();
    const q = await h.support();
    for (const operation of ['start', 'acknowledge']) {
        const path = `/support-requests/${q.id}/${operation}`;
        for (const token of ['learner-a', 'learner-b', 'newcomer', 'other-staff'])
            await h.request(path, 'POST', {}, token, 403);
        await h.request(path, 'POST', {}, 'unknown', 401);
        for (const body of [undefined, null, [], 'bad', { assignedTo: 'staff' }, { clientRequestId: 'key' }])
            await h.request(path, 'POST', body, 'staff', 422);
        await h.request(`/support-requests/missing/${operation}`, 'POST', {}, 'staff', 404);
        const response = await h.request(path, 'POST', {}, 'staff', 409);
        assert.ok(response.error);
    }
    assert.equal(h.db.get('supportRequests', q.id)!.revision, 1);
});
