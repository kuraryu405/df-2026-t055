import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import * as c from '../packages/shared/src/index.ts';

const root = new URL('../packages/shared/fixtures/support/', import.meta.url);
const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`${name}.json`, root), 'utf8'));
const examples = readFileSync(new URL('../packages/shared/api-examples/support.md', import.meta.url), 'utf8');
const requests = ['help-open', 'help-assigned', 'help-in-progress', 'help-acknowledged', 'stop-open', 'stop-acknowledged'];
const valid: Record<string, z.ZodType> = {
    ...Object.fromEntries(requests.map(s => [`request-${s}`, c.supportRequestSchema])),
    'operation-claim-response': c.supportClaimResponseSchema,
    'operation-start-response': c.supportStartResponseSchema,
    'operation-acknowledge-response': c.supportAcknowledgeResponseSchema,
    'operation-resume-request': c.supportResumeRequestSchema,
    'operation-resume-response': c.supportResumeResponseSchema,
    'record-save-request': c.supportRecordSaveRequestSchema,
    'record-valid': c.supportRecordSchema,
    'learner-session-support': c.learnerSupportSessionStateSchema,
    'ws-staff-snapshot': c.staffSupportNotificationSchema,
    'ws-staff-update': c.staffSupportNotificationSchema,
    'ws-learner-snapshot': c.learnerSupportNotificationSchema,
    'ws-learner-update': c.learnerSupportNotificationSchema,
    'ws-auth': c.supportWsAuthSchema
};
for (const [name, schema] of Object.entries(valid)) {
    test(`support fixture: ${name}`, () => {
        assert.deepEqual(schema.parse(fixture(name)), fixture(name));
        assert.ok(examples.includes(`../fixtures/support/${name}.json`));
    });
}
test('staff snapshot contains unique request IDs', () => {
    const snapshot = c.staffSupportNotificationSchema.parse(fixture('ws-staff-snapshot'));
    assert.ok(snapshot.type === 'support.snapshot');
    assert.equal(new Set(snapshot.requests.map(request => request.requestId)).size, snapshot.requests.length);
});
test('all fixtures are accounted for and referenced', () => {
    const invalid = ['invalid-request-assigned-without-assignee', 'invalid-request-stop-with-assignee', 'invalid-learner-notification-with-record', 'error-claim-conflict'];
    assert.deepEqual(readdirSync(root).sort(), [...Object.keys(valid), ...invalid].map(n => `${n}.json`).sort());
    for (const n of invalid) assert.ok(examples.includes(`${n}.json`));
    assert.equal(c.supportRequestSchema.safeParse(fixture(invalid[0])).success, false);
    assert.equal(c.supportRequestSchema.safeParse(fixture(invalid[1])).success, false);
    assert.equal(c.learnerSupportNotificationSchema.safeParse(fixture(invalid[2])).success, false);
});
test('every request state requires its fields and rejects fields belonging to other states', () => {
    const fields = ['assignedTo', 'assignedAt', 'startedBy', 'startedAt', 'acknowledgedBy', 'acknowledgedAt'];
    for (const state of requests) {
        const q = fixture(`request-${state}`);
        for (const key of Object.keys(q)) {
            const missing = { ...q }; delete missing[key];
            assert.equal(c.supportRequestSchema.safeParse(missing).success, false, `${state} missing ${key}`);
        }
        for (const key of fields.filter(k => !(k in q))) {
            assert.equal(c.supportRequestSchema.safeParse({ ...q, [key]: key.endsWith('At') ? q.createdAt : 'demo-other' }).success, false, `${state} forbids ${key}`);
        }
        for (const [key, value] of Object.entries(q)) {
            assert.equal(c.supportRequestSchema.safeParse({ ...q, [key]: null }).success, false);
            if (typeof value === 'string') assert.equal(c.supportRequestSchema.safeParse({ ...q, [key]: '' }).success, false);
        }
        for (const revision of [0, -1, 1.5]) assert.equal(c.supportRequestSchema.safeParse({ ...q, revision }).success, false);
        assert.equal(c.supportRequestSchema.safeParse({ ...q, createdAt: 'yesterday' }).success, false);
        assert.equal(c.supportRequestSchema.safeParse({ ...q, memo: 'private' }).success, false);
    }
    for (const status of ['assigned', 'in_progress']) assert.equal(c.supportRequestSchema.safeParse({ ...fixture('request-stop-open'), status }).success, false);
});
test('all support transitions including skips, terminal states and self transitions', () => {
    const allowed = new Set(['help:open:assigned', 'help:assigned:in_progress', 'help:in_progress:acknowledged', 'stop:open:acknowledged']);
    for (const kind of ['help', 'stop'] as const) for (const from of c.supportStatusSchema.options) for (const to of c.supportStatusSchema.options) {
        assert.equal(c.canTransitionSupport(kind, from, to), allowed.has(`${kind}:${from}:${to}`));
    }
});
test('operation bodies accept only empty objects; response shapes preserve the API table', () => {
    assert.deepEqual(c.supportOperationRequestSchema.parse({}), {});
    for (const key of ['clientRequestId', 'idempotencyKey', 'assignedTo', 'assignedAt', 'expectedRevision']) {
        assert.equal(c.supportOperationRequestSchema.safeParse({ [key]: 'invented' }).success, false);
    }
    for (const value of [null, [], '']) assert.equal(c.supportOperationRequestSchema.safeParse(value).success, false);
    for (const name of ['claim', 'start', 'acknowledge']) {
        const value = fixture(`operation-${name}-response`);
        const schema = valid[`operation-${name}-response`];
        for (const key of Object.keys(value)) { const v = { ...value }; delete v[key]; assert.equal(schema.safeParse(v).success, false); }
        assert.equal(schema.safeParse({ ...value, clientRequestId: 'extra' }).success, false);
    }
    assert.deepEqual(Object.keys(fixture('operation-start-response')).sort(), ['schemaVersion', 'status', 'startedAt'].sort());
    assert.deepEqual(Object.keys(fixture('operation-acknowledge-response')).sort(), ['schemaVersion', 'status', 'acknowledgedAt'].sort());
    for (const revision of [0, -1, 1.5]) assert.equal(c.supportClaimResponseSchema.safeParse({ ...fixture('operation-claim-response'), revision }).success, false);
    for (const clientRequestId of ['', 'a'.repeat(101)]) assert.equal(c.supportResumeRequestSchema.safeParse({ clientRequestId, expectedSessionRevision: 0 }).success, false);
    for (const clientRequestId of ['a', 'a'.repeat(100)]) assert.ok(c.supportResumeRequestSchema.safeParse({ clientRequestId, expectedSessionRevision: 0 }).success);
    for (const expectedSessionRevision of [-1, 0.5]) assert.equal(c.supportResumeRequestSchema.safeParse({ clientRequestId: 'a', expectedSessionRevision }).success, false);
    assert.equal(c.supportResumeRequestSchema.safeParse({ ...fixture('operation-resume-request'), assignedTo: 'other' }).success, false);
    assert.deepEqual(c.supportRequestListResponseSchema.parse({ requests: requests.map(n => fixture(`request-${n}`)) }).requests.length, 6);
    for (const status of c.supportStatusSchema.options) assert.ok(c.supportRequestStatusQuerySchema.safeParse({ status }).success);
    assert.ok(c.supportRequestStatusQuerySchema.safeParse({}).success);
    for (const value of [{ status: 'all' }, { status: ['open'] }, { unknown: 'open' }]) assert.equal(c.supportRequestStatusQuerySchema.safeParse(value).success, false);
});
test('records allow later entry with strict text, revision and identity boundaries', () => {
    const save = fixture('record-save-request');
    assert.equal(c.supportRecordSaveRequestSchema.parse(save).expectedRevision, 0);
    const record = fixture('record-valid');
    for (const [schema, base] of [[c.supportRecordSaveRequestSchema, save], [c.supportRecordSchema, record]] as const) {
        for (const key of ['observedDifficulty', 'assistanceGiven', 'improvementSuggestion']) {
            for (const value of ['', 'a'.repeat(2000)]) assert.ok(schema.safeParse({ ...base, [key]: value }).success);
            for (const value of [null, 'a'.repeat(2001)]) assert.equal(schema.safeParse({ ...base, [key]: value }).success, false);
        }
        for (const key of Object.keys(base)) { const missing = { ...base }; delete missing[key]; assert.equal(schema.safeParse(missing).success, false); assert.equal(schema.safeParse({ ...base, [key]: null }).success, false); }
        assert.equal(schema.safeParse({ ...base, unknown: '' }).success, false);
    }
    for (const expectedRevision of [-1, 0.1]) assert.equal(c.supportRecordSaveRequestSchema.safeParse({ ...save, expectedRevision }).success, false);
    for (const revision of [0, -1, 0.1]) assert.equal(c.supportRecordSchema.safeParse({ ...record, revision }).success, false);
    assert.equal(c.supportRecordSaveRequestSchema.safeParse({ ...save, learnerId: 'spoof' }).success, false);
});
test('learner allowlists reject staff information at every nesting level and both notification types', () => {
    const state = fixture('learner-session-support');
    const keys = (v: object) => Object.keys(v).sort();
    assert.deepEqual(keys(c.learnerSupportSchema.parse(state.support)), ['requestId', 'revision', 'status']);
    assert.deepEqual(keys(c.learnerSupportSessionStateSchema.parse(state)), ['releaseId', 'revision', 'schemaVersion', 'sessionId', 'status', 'stepIndex', 'support']);
    for (const name of ['ws-learner-snapshot', 'ws-learner-update']) {
        const n = fixture(name);
        assert.deepEqual(keys(c.learnerSupportNotificationSchema.parse(n)), ['payload', 'schemaVersion', 'type']);
        for (const key of ['staffMemo', 'supportRecord', 'profile', 'assignedTo', 'startedBy', 'acknowledgedBy', 'steps', 'draftId']) {
            for (const value of [{ ...n, [key]: 'private' }, { ...n, payload: { ...state, [key]: 'private' } }, { ...n, payload: { ...state, support: { ...state.support, [key]: 'private' } } }]) {
                assert.equal(c.learnerSupportNotificationSchema.safeParse(value).success, false, `${name}: ${key}`);
            }
        }
    }
    for (const status of ['active', 'waiting_help', 'stopped', 'completed']) assert.ok(c.learnerSupportSessionStateSchema.safeParse({ ...state, status }).success);
    const { support, ...withoutSupport } = state;
    assert.ok(c.learnerSupportSessionStateSchema.safeParse(withoutSupport).success);
    const { sessionId, releaseId, ...event } = state;
    assert.ok(c.supportSessionEventResponseSchema.safeParse(event).success);
    for (const key of ['stepIndex', 'revision']) for (const value of [-1, 0.5]) assert.equal(c.learnerSupportSessionStateSchema.safeParse({ ...state, [key]: value }).success, false);
    assert.equal(c.learnerSupportSchema.safeParse({ ...support, revision: 0 }).success, false);
    for (const name of ['ws-staff-snapshot', 'ws-staff-update']) {
        const n = fixture(name);
        for (const key of ['supportRecord', 'staffMemo']) assert.equal(c.staffSupportNotificationSchema.safeParse({ ...n, [key]: 'private' }).success, false);
    }
    assert.equal(c.supportWsAuthSchema.safeParse({ type: 'auth', idToken: '' }).success, false);
    assert.equal(c.supportWsAuthSchema.safeParse({ ...fixture('ws-auth'), token: 'extra' }).success, false);
});
test('existing event contract, version and ApiError remain unchanged', () => {
    assert.equal(c.schemaVersion, '1');
    for (const type of ['next', 'back', 'help', 'resume', 'stop', 'complete']) assert.ok(c.eventSchema.safeParse({ clientEventId: 'demo', expectedRevision: 0, type }).success);
    assert.equal(c.eventSchema.safeParse({ clientEventId: 'demo', expectedRevision: 0, type: 'claim' }).success, false);
    assert.equal(c.eventSchema.safeParse({ clientEventId: 'demo', expectedRevision: 0, type: 'help', requestId: 'new' }).success, false);
    for (const [name, schema] of Object.entries(valid)) {
        const value = fixture(name);
        if ('schemaVersion' in value) for (const schemaVersion of ['2', 1, null]) assert.equal(schema.safeParse({ ...value, schemaVersion }).success, false);
    }
    const error: c.ApiError = fixture('error-claim-conflict');
    assert.deepEqual(Object.keys(error), ['error']);
    assert.deepEqual(Object.keys(error.error).sort(), ['code', 'message', 'requestId']);
    for (const v of Object.values(error.error)) assert.equal(typeof v, 'string');
});
