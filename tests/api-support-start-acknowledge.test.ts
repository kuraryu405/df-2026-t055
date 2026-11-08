import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, doc, type Storage } from '../apps/api/src/adapters.ts';
import { FakeTtsAdapter } from '../apps/api/src/tts.ts';
import { supportRecordSchema, supportRequestListResponseSchema, supportClaimResponseSchema, supportStartResponseSchema, supportAcknowledgeResponseSchema } from '../packages/shared/src/support.ts';

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

const recordText = { observedDifficulty: '紙が戻る', assistanceGiven: '端を押さえた', improvementSuggestion: '押さえる位置を示す' };

test('記録は開始後に初回0で保存し、競合・再送で上書きせず完了後も同じ1件を更新する', async () => {
    const h = await harness();
    const q = await h.support();
    const path = `/support-requests/${q.id}/record`;
    const save = (expectedRevision: number, token = 'staff', status = 200) => h.request(path, 'PUT', { expectedRevision, ...recordText }, token, status);
    await h.request(path, 'GET', undefined, 'staff', 404);
    await save(0, 'staff', 409);
    await h.claim(q.id);
    await save(0, 'staff', 409);
    await h.request(`/support-requests/${q.id}/start`, 'POST', {});
    const attempts = await Promise.all(['staff', 'staff-2'].map(token => h.request(path, 'PUT', { expectedRevision: 0, ...recordText }, token, [200, 409])));
    assert.equal(attempts.filter(a => a.error?.code === 'REVISION_CONFLICT').length, 1);
    const first = supportRecordSchema.parse(attempts.find(a => !a.error));
    assert.equal(first.revision, 1);
    assert.equal(first.supportRequestId, q.id);
    assert.equal(first.sessionId, q.sessionId);
    assert.equal(first.learnerId, 'a');
    assert.equal(first.taskId, 'task');
    assert.equal(first.stepId, 's1');
    assert.equal(first.releaseId, h.db.get('sessions', q.sessionId)!.releaseId);
    for (const key of Object.keys(recordText) as (keyof typeof recordText)[]) assert.equal(first[key], recordText[key]);
    await save(0, 'staff', 409);
    assert.deepEqual(await h.request(path), first);
    await h.request(`/support-requests/${q.id}/acknowledge`, 'POST', {});
    const second = supportRecordSchema.parse(await h.request(path, 'PUT', { expectedRevision: 1, ...recordText, assistanceGiven: '一緒に押さえた' }, 'staff-2'));
    assert.equal(second.assistanceGiven, '一緒に押さえた');
    assert.equal(second.recordId, first.recordId);
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.createdBy, first.createdBy);
    assert.equal(second.updatedBy, 'staff-2');
    assert.equal(second.revision, 2);
    await save(1, 'staff', 409);
    assert.deepEqual(await h.request(path), second);
    assert.equal(h.db.all('supportRecords').length, 1);
});

test('記録なしで開始・完了・本人再開でき、セッション完了後にも後入力できる', async () => {
    const h = await harness();
    const q = await h.support();
    await h.claim(q.id);
    await h.request(`/support-requests/${q.id}/start`, 'POST', {});
    await h.request(`/support-requests/${q.id}/acknowledge`, 'POST', {});
    assert.equal(h.db.all('supportRecords').length, 0);
    const event = (type: string, expectedRevision: number) => h.request(`/me/sessions/${q.sessionId}/events`, 'POST', { clientEventId: type, expectedRevision, type }, 'learner-a');
    const resumed = await event('resume', 1);
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.stepIndex, 0);
    assert.equal((await event('complete', 2)).status, 'completed');
    await h.request(`/support-requests/${q.id}/record`, 'PUT', { expectedRevision: 0, ...recordText });
    assert.equal(h.db.get('sessions', q.sessionId)!.status, 'completed');
});

test('記録APIは認証・所属・職員権限・入力を検査し、対象IDの注入とstop記録を拒否する', async () => {
    const h = await harness();
    const q = await h.support();
    await h.claim(q.id);
    await h.request(`/support-requests/${q.id}/start`, 'POST', {});
    const path = `/support-requests/${q.id}/record`;
    const body = { expectedRevision: 0, ...recordText };
    await h.request(path, 'PUT', body);
    const before = h.db.all('supportRecords');
    for (const method of ['GET', 'PUT']) {
        for (const token of ['learner-a', 'learner-b', 'newcomer', 'other-staff', 'unknown'])
            await h.request(path, method, method === 'PUT' ? body : undefined, token, token === 'unknown' ? 401 : 403);
        await h.request('/support-requests/missing/record', method, method === 'PUT' ? body : undefined, 'staff', 404);
    }
    for (const invalid of [undefined, null, [], {}, { ...body, expectedRevision: -1 }, { ...body, expectedRevision: 0.5 }, { ...body, observedDifficulty: 'a'.repeat(2001) }, { ...body, assistanceGiven: null }, { ...body, improvementSuggestion: 1 }, ...['learnerId', 'taskId', 'releaseId', 'stepId', 'sessionId', 'recordId', 'supportRequestId', 'createdBy'].map(key => ({ ...body, [key]: 'injected' }))])
        await h.request(path, 'PUT', invalid, 'staff', 422);
    const stop = await h.support('stop');
    await h.request(`/support-requests/${stop.id}/acknowledge`, 'POST', {});
    await h.request(`/support-requests/${stop.id}/record`, 'PUT', body, 'staff', 409);
    assert.deepEqual(h.db.all('supportRecords'), before);
});

test('同じ工程の再呼出しは別記録となり、後入力の対象は呼出し時の版・工程を保つ', async () => {
    const h = await harness();
    const q = await h.support();
    await h.claim(q.id);
    await h.request(`/support-requests/${q.id}/start`, 'POST', {});
    await h.request(`/support-requests/${q.id}/acknowledge`, 'POST', {});
    const event = (type: string, expectedRevision: number) => h.request(`/me/sessions/${q.sessionId}/events`, 'POST', { clientEventId: crypto.randomUUID(), expectedRevision, type }, 'learner-a');
    await event('resume', 1);
    await event('help', 2);
    const next = h.db.all('supportRequests').find(r => r.id !== q.id)!;
    await h.claim(next.id);
    await h.request(`/support-requests/${next.id}/start`, 'POST', {});
    const sessionBefore = h.db.get('sessions', q.sessionId);
    const releaseBefore = h.db.get('releases', sessionBefore!.releaseId);
    for (const request of [q, next]) {
        const saved = supportRecordSchema.parse(await h.request(`/support-requests/${request.id}/record`, 'PUT', { expectedRevision: 0, ...recordText }));
        assert.equal(saved.stepId, 's1');
        assert.equal(saved.releaseId, sessionBefore!.releaseId);
    }
    assert.equal(h.db.all('supportRecords').length, 2);
    assert.deepEqual(h.db.get('sessions', q.sessionId), sessionBefore);
    assert.deepEqual(h.db.get('releases', sessionBefore!.releaseId), releaseBefore);
});

const resumeBody = { clientRequestId: 'resume-key', expectedSessionRevision: 1 };
const staffResume = (h: Awaited<ReturnType<typeof harness>>, q: { id: string }, body = resumeBody, token = 'staff', status = 200) =>
    h.request(`/support-requests/${q.id}/resume`, 'POST', body, token, status);
const learnerEvent = (h: Awaited<ReturnType<typeof harness>>, sessionId: string, type: string, expectedRevision: number, status = 200, clientEventId: string = crypto.randomUUID()) =>
    h.request(`/me/sessions/${sessionId}/events`, 'POST', { clientEventId, expectedRevision, type }, 'learner-a', status);
async function beginSupport(h: Awaited<ReturnType<typeof harness>>) {
    const q = await h.support();
    await h.claim(q.id);
    await h.request(`/support-requests/${q.id}/start`, 'POST', {});
    return q;
}

test('本人再開は対象helpの完了を待ち、再呼出しを古い完了で解除しない', async () => {
    const h = await harness();
    const q = await h.support();
    const original = h.db.get('sessions', q.sessionId)!;
    assert.equal(original.activeSupportRequestId, q.id);
    for (const operation of ['claim', 'start', 'acknowledge']) {
        await learnerEvent(h, q.sessionId, 'resume', 1, 409);
        await h.request(`/support-requests/${q.id}/${operation}`, 'POST', {});
    }
    await learnerEvent(h, q.sessionId, 'resume', 1, 200, 'learner-resume');
    const resumed = h.db.get('sessions', q.sessionId)!;
    assert.equal(resumed.activeSupportRequestId, undefined);
    assert.equal(resumed.releaseId, original.releaseId);
    assert.equal(resumed.stepIndex, original.stepIndex);
    await learnerEvent(h, q.sessionId, 'resume', 1, 200, 'learner-resume');
    assert.equal(h.db.get('sessions', q.sessionId)!.revision, 2);
    await learnerEvent(h, q.sessionId, 'help', 2);
    const current = h.db.get('sessions', q.sessionId)!;
    assert.notEqual(current.activeSupportRequestId, q.id);
    await learnerEvent(h, q.sessionId, 'resume', 3, 409);
    await staffResume(h, q, { ...resumeBody, expectedSessionRevision: 3 }, 'staff', 409);
    assert.deepEqual(h.db.get('sessions', q.sessionId), current);
});

test('職員再開は完了・イベント・更新を原子的に保存し、再送は元の結果を返す', async () => {
    for (const acknowledgeFirst of [false, true]) {
        const h = await harness();
        const q = await beginSupport(h);
        const original = h.db.get('sessions', q.sessionId)!;
        const release = h.db.get('releases', original.releaseId);
        if (acknowledgeFirst)
            await h.request(`/support-requests/${q.id}/acknowledge`, 'POST', {});
        const result = await staffResume(h, q);
        assert.deepEqual(result, { schemaVersion: '1', sessionId: q.sessionId, status: 'active', stepIndex: original.stepIndex, revision: 2 });
        const completed = h.db.get('supportRequests', q.id)!;
        assert.equal(completed.status, 'acknowledged');
        assert.equal(completed.revision, 4);
        assert.equal(completed.acknowledgedBy, 'staff');
        const stored = h.db.get('sessions', q.sessionId)!;
        assert.equal(stored.activeSupportRequestId, undefined);
        assert.equal(stored.releaseId, original.releaseId);
        assert.equal(stored.stepIndex, original.stepIndex);
        assert.deepEqual(h.db.get('releases', original.releaseId), release);
        assert.equal(h.db.all('supportRecords').length, 0);
        const events = h.db.all('sessionEvents');
        const event = events.find(e => e.supportRequestId === q.id)!;
        assert.equal(event.type, 'resume');
        assert.equal(event.createdBy, 'staff');
        assert.equal(event.stepId, 's1');
        assert.deepEqual(await staffResume(h, q), result);
        await learnerEvent(h, q.sessionId, 'help', 2);
        assert.deepEqual(await staffResume(h, q), result);
        assert.equal(h.db.get('sessions', q.sessionId)!.status, 'waiting_help');
        assert.equal(h.db.all('sessionEvents').length, events.length + 1);
        assert.deepEqual(h.db.get('supportRequests', q.id), completed);
        await staffResume(h, q, { ...resumeBody, expectedSessionRevision: 3 }, 'staff', 409);
    }
});

test('職員再開は認証・担当・所属・入力・revision・stop・終端を検査し失敗時は保存しない', async () => {
    const h = await harness();
    const q = await h.support();
    await staffResume(h, q, resumeBody, 'staff', 409);
    await h.claim(q.id);
    await staffResume(h, q, resumeBody, 'staff', 409);
    await h.request(`/support-requests/${q.id}/start`, 'POST', {});
    const before = ['sessions', 'supportRequests', 'sessionEvents'].map(c => h.db.all(c));
    for (const token of ['staff-2', 'other-staff', 'learner-a', 'learner-b', 'newcomer', 'unknown'])
        await staffResume(h, q, resumeBody, token, token === 'unknown' ? 401 : 403);
    await staffResume(h, { id: 'missing' }, resumeBody, 'staff', 404);
    for (const body of [undefined, null, [], {}, { ...resumeBody, clientRequestId: '' }, { ...resumeBody, expectedSessionRevision: -1 },
        { ...resumeBody, expectedSessionRevision: 0.5 }, { ...resumeBody, assignedTo: 'staff' }])
        await h.request(`/support-requests/${q.id}/resume`, 'POST', body, 'staff', 422);
    await staffResume(h, q, { ...resumeBody, expectedSessionRevision: 0 }, 'staff', 409);
    assert.deepEqual(['sessions', 'supportRequests', 'sessionEvents'].map(c => h.db.all(c)), before);
    const stop = await h.support('stop');
    await staffResume(h, stop, resumeBody, 'staff', 409);
    for (const status of ['completed', 'stopped']) {
        h.db.put('sessions', { ...h.db.get('sessions', q.sessionId)!, status });
        await staffResume(h, q, resumeBody, 'staff', 409);
        assert.equal(h.db.get('supportRequests', q.id)!.status, 'in_progress');
    }
});

test('停止と職員再開はどちらの順序でも停止が残り、保存済み再開の再送も409', async () => {
    for (const stopFirst of [true, false]) {
        const h = await harness();
        const q = await beginSupport(h);
        const stop = () => learnerEvent(h, q.sessionId, 'stop', 0);
        const resume = () => staffResume(h, q, resumeBody, 'staff', stopFirst ? 409 : 200);
        await Promise.all(stopFirst ? [stop(), resume()] : [resume(), stop()]);
        assert.equal(h.db.get('sessions', q.sessionId)!.status, 'stopped');
        await staffResume(h, q, resumeBody, 'staff', 409);
        await learnerEvent(h, q.sessionId, 'resume', 1, 409);
        assert.equal(h.db.all('sessionEvents').filter(e => e.type === 'resume').length, stopFirst ? 0 : 1);
        assert.equal(h.db.get('supportRequests', q.id)!.status, stopFirst ? 'in_progress' : 'acknowledged');
    }
});

test('再開保存が途中で失敗すると対応完了・イベント・セッションを全てロールバックする', async () => {
    const h = await harness();
    const q = await beginSupport(h);
    const collections = ['supportRequests', 'sessionEvents', 'sessions'];
    const before = collections.map(c => h.db.all(c));
    const put = h.db.put.bind(h.db);
    h.db.put = (collection, value) => {
        if (collection === 'sessions') throw new Error('synthetic write failure');
        put(collection, value);
    };
    await staffResume(h, q, resumeBody, 'staff', 500);
    assert.deepEqual(collections.map(c => h.db.all(c)), before);
    h.db.put = put;
    await staffResume(h, q);
});

test('並行した職員再送は一度だけ再開し、先頭以外の工程と固定版も保持する', async () => {
    const h = await harness();
    const q = await beginSupport(h);
    const s = h.db.get('sessions', q.sessionId)!;
    const r = h.db.get('releases', s.releaseId)!;
    h.db.put('releases', { ...r, learnerSteps: [...r.learnerSteps, { ...r.learnerSteps[0], stepId: 's2' }] });
    h.db.put('sessions', { ...s, stepIndex: 1 });
    const fixed = h.db.get('releases', s.releaseId);
    const [first, second] = await Promise.all([staffResume(h, q), staffResume(h, q)]);
    assert.deepEqual(first, second);
    assert.equal(first.stepIndex, 1);
    assert.equal(h.db.get('sessions', s.id)!.releaseId, s.releaseId);
    assert.deepEqual(h.db.get('releases', s.releaseId), fixed);
    const events = h.db.all('sessionEvents').filter(e => e.type === 'resume');
    assert.equal(events.length, 1);
    assert.equal(events[0].stepId, 's2');
    await staffResume(h, q, { ...resumeBody, clientRequestId: 'different' }, 'staff', 409);
});
