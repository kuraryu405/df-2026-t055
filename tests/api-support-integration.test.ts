import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnerSessionSchema } from '../packages/shared/src/index.ts';
import { supportHarness } from './helpers/support-harness.ts';

test('staff context identifies the original learner, task and help step without exposing private text', async () => {
    const h = await supportHarness(), staff = h.api();
    const profile = h.db.get('learners', 'a')!;
    h.db.put('learners', { ...profile, disabilityInfo: { detail: 'PRIVATE_DIAGNOSIS' }, staffObservations: ['PRIVATE_NOTE'] });
    const q = (await staff('/support-requests')).requests[0];
    assert.deepEqual(q.context, { learnerId: 'a', displayName: profile.displayName, taskId: 'task', taskTitle: 'タオル包装',
        releaseId: h.releaseId, stepId: 's0', stepIndex: 0, sessionRevision: 1, sessionStatus: 'waiting_help', actions: ['claim'] });
    assert.doesNotMatch(JSON.stringify(q), /PRIVATE/);
    for (const token of ['learner-a', 'newcomer']) assert.equal((await h.request('/support-requests', 'GET', undefined, token)).status, 403);
    assert.deepEqual((await h.api('other-staff')('/support-requests')).requests, []);
});

test('context actions follow assignment, and only the owner can offer staff resume', async () => {
    const h = await supportHarness(), staff = h.api(), second = h.api('staff-2'), path = `/support-requests/${h.requestId}`;
    await staff(`${path}/claim`, 'POST', {});
    assert.deepEqual((await staff('/support-requests')).requests[0].context.actions, ['start']);
    assert.deepEqual((await second('/support-requests')).requests[0].context.actions, []);
    await staff(`${path}/start`, 'POST', {});
    assert.deepEqual((await staff('/support-requests')).requests[0].context.actions, ['acknowledge', 'resume', 'record']);
    assert.deepEqual((await second('/support-requests')).requests[0].context.actions, ['record']);
    await staff(`${path}/acknowledge`, 'POST', {});
    assert.deepEqual((await staff('/support-requests?status=acknowledged')).requests[0].context.actions, ['resume', 'record']);
    await staff(`${path}/resume`, 'POST', { clientRequestId: 'resume', expectedSessionRevision: 1 });
    const completed = (await staff('/support-requests?status=acknowledged')).requests[0];
    assert.deepEqual(completed.context.actions, ['record']);
    assert.equal(completed.context.sessionRevision, 2);
    assert.equal(completed.context.stepId, 's0');
});

test('HTTP returns the same learner support allowlist through open, assigned, started and complete', async () => {
    const h = await supportHarness(), staff = h.api(), learner = h.api('learner-a'), path = `/support-requests/${h.requestId}`;
    let revision = 1;
    for (const [operation, status] of [[undefined, 'open'], ['claim', 'assigned'], ['start', 'in_progress'], ['acknowledge', 'acknowledged']] as const) {
        if (operation) { await staff(`${path}/${operation}`, 'POST', {}); revision++; }
        const session = learnerSessionSchema.parse(await learner(`/me/sessions/${h.sessionId}`));
        assert.deepEqual(session.support, { requestId: h.requestId, status, revision });
        assert.deepEqual(Object.keys(session.support!).sort(), ['requestId', 'revision', 'status']);
        assert.doesNotMatch(JSON.stringify(session), /context|taskTitle|assignedTo|staffGuide/);
    }
    const result = await learner(`/me/sessions/${h.sessionId}/events`, 'POST', { clientEventId: 'resume', expectedRevision: 1, type: 'resume' });
    assert.equal(result.status, 'active'); assert.ok(!('support' in result));
    const fresh = await learner(`/me/sessions/${h.sessionId}`);
    assert.equal(fresh.releaseId, h.releaseId); assert.equal(fresh.stepIndex, 0); assert.ok(!('support' in fresh));
});

test('HTTP help response contains a real request ID; stopped sessions cannot acquire a resume action', async () => {
    const h = await supportHarness(), learner = h.api('learner-a'), staff = h.api(), path = `/support-requests/${h.requestId}`;
    const retry = await learner(`/me/sessions/${h.sessionId}/events`, 'POST', { clientEventId: 'help', expectedRevision: 0, type: 'help' });
    assert.deepEqual(retry.support, { requestId: h.requestId, status: 'open', revision: 1 });
    await staff(`${path}/claim`, 'POST', {}); await staff(`${path}/start`, 'POST', {});
    await learner(`/me/sessions/${h.sessionId}/events`, 'POST', { clientEventId: 'stop', expectedRevision: 0, type: 'stop' });
    const requests = (await staff('/support-requests')).requests;
    assert.deepEqual(requests.find((q: any) => q.requestId === h.requestId).context.actions, ['acknowledge', 'record']);
    assert.deepEqual(requests.find((q: any) => q.kind === 'stop').context.actions, ['acknowledge']);
    assert.equal((await h.request(`${path}/resume`, 'POST', { clientRequestId: 'late', expectedSessionRevision: 2 })).status, 409);
    const stopped = await learner(`/me/sessions/${h.sessionId}`);
    assert.equal(stopped.status, 'stopped'); assert.ok(!('support' in stopped));
});
