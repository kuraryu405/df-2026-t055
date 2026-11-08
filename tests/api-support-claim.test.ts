import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, doc, type Storage } from '../apps/api/src/adapters.ts';
import { FakeTtsAdapter } from '../apps/api/src/tts.ts';
import { supportRequestListResponseSchema, supportClaimResponseSchema } from '../packages/shared/src/support.ts';

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

test('一覧を契約へ投影し、既定の状態と単一statusで絞る', async () => {
    const h = await harness();
    const q = await h.support();
    assert.equal(q.revision, 1);
    assert.deepEqual(await h.list(), [{ schemaVersion: '1', requestId: q.id, sessionId: q.sessionId,
        eventId: q.eventId, createdAt: q.createdAt, kind: 'help', status: 'open', revision: 1 }]);
    await h.claim(q.id);
    const assigned = h.db.get('supportRequests', q.id)!;
    const started = { ...assigned, status: 'in_progress', startedBy: 'staff', startedAt: assigned.assignedAt, revision: 3 };
    h.db.put('supportRequests', started);
    const progressing = (await h.list())[0];
    assert.ok('startedBy' in progressing);
    assert.equal(progressing.startedBy, 'staff');
    h.db.put('supportRequests', { ...started, status: 'acknowledged', acknowledgedBy: 'staff', acknowledgedAt: assigned.assignedAt, revision: 4 });
    assert.deepEqual(await h.list(), []);
    assert.equal((await h.list('?status=acknowledged'))[0].status, 'acknowledged');
    const stop = await h.support('stop');
    await h.request(`/support-requests/${stop.id}/acknowledge`, 'POST', {});
    const stopped = (await h.list('?status=acknowledged')).find(q => q.kind === 'stop')!;
    assert.ok(!('assignedTo' in stopped) && !('startedAt' in stopped));
    for (const query of ['?status=', '?status=bad', '?status=open&status=assigned', '?status=open&status=open', '?extra=1'])
        await h.request(`/support-requests${query}`, 'GET', undefined, 'staff', 422);
});

test('担当競合は一人だけ成功し、同じ職員の再送は担当時刻とrevisionを保つ', async () => {
    const h = await harness();
    const q = await h.support();
    const results = await Promise.all(['staff', 'staff-2'].map(token => h.claim(q.id, token, [200, 409])));
    const successes = results.filter(result => !result.error);
    const failures = results.filter(result => result.error);
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    const claimed = supportClaimResponseSchema.parse(successes[0]);
    assert.ok(['staff', 'staff-2'].includes(claimed.assignedTo));
    assert.equal(claimed.revision, 2);
    assert.equal(failures[0].error.code, 'CLAIM_CONFLICT');
    assert.deepEqual(await h.claim(q.id, claimed.assignedTo), claimed);
    const listed = (await h.list())[0];
    assert.ok('assignedAt' in listed);
    assert.equal(listed.assignedAt, claimed.assignedAt);
    assert.equal(listed.status, 'assigned');
    assert.deepEqual(await h.list('?status=open'), []);
    assert.equal((await h.list('?status=assigned')).length, 1);
    for (const status of ['in_progress', 'acknowledged']) {
        h.db.put('supportRequests', { ...h.db.get('supportRequests', q.id)!, status });
        await h.claim(q.id, 'staff', 409);
    }
});

test('停止要求・不正なbody・存在しない要求を拒否する', async () => {
    const h = await harness();
    const stop = await h.support('stop');
    await h.claim(stop.id, 'staff', 409);
    const help = await h.support();
    for (const body of [null, [], 'bad', { assignedTo: 'staff-2' }, { clientRequestId: 'key' }])
        await h.claim(help.id, 'staff', 422, body);
    await h.request(`/support-requests/${help.id}/claim`, 'POST', undefined, 'staff', 422);
    await h.claim('missing', 'staff', 404);
    assert.equal(h.db.get('supportRequests', help.id)!.status, 'open');
});

test('本人・新人の一覧と担当操作を拒否し、所属で分離する', async () => {
    const h = await harness();
    const q = await h.support();
    for (const token of ['learner-a', 'learner-b', 'newcomer']) {
        await h.request('/support-requests', 'GET', undefined, token, 403);
        await h.claim(q.id, token, 403);
    }
    assert.deepEqual(await h.list('', 'other-staff'), []);
    await h.claim(q.id, 'other-staff', 403);
    await h.request('/support-requests', 'GET', undefined, 'unknown', 401);
    await h.claim(q.id, 'unknown', 401);
    assert.equal(h.db.get('supportRequests', q.id)!.status, 'open');
});
