import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as c from '../packages/shared/src/index.ts';
const root = new URL('../packages/shared/fixtures/work-guides/', import.meta.url);
const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`${name}.json`, root), 'utf8'));
const examples = readFileSync(new URL('../packages/shared/api-examples/work-guides.md', import.meta.url), 'utf8');
const valid = {
    'draft-ai-valid': c.draftDetailSchema, 'draft-manual-valid': c.draftDetailSchema,
    'draft-patch-valid': c.draftPatchSchema, 'draft-update-response-valid': c.draftUpdateResponseSchema,
    'release-photo-only-valid': c.releaseSchema, 'release-legacy-valid': c.releaseReadSchema,
    'session-photo-text-valid': c.learnerSessionSchema, 'session-photo-only-valid': c.learnerSessionSchema,
    'release-copy-request-valid': c.releaseCopyRequestSchema, 'release-copy-response-valid': c.releaseCopyResponseSchema,
    'error-revision-conflict': c.apiErrorSchema
};
for (const [name, schema] of Object.entries(valid)) test(`fixture and API example: ${name}`, () => {
    assert.ok(schema.parse(fixture(name)));
    assert.ok(examples.includes(`${name}.json`));
});
test('all valid fixture files are covered, including legacy session', () => {
    const files = readdirSync(root).filter(n => n.endsWith('-valid.json')).sort();
    assert.deepEqual(files, [...Object.keys(valid).filter(n => n.endsWith('-valid')), 'session-legacy-valid'].map(n => `${n}.json`).sort());
    assert.ok(c.normalizeLearnerSessionDTO(fixture('session-legacy-valid')));
    assert.ok(examples.includes('session-legacy-valid.json'));
});
test('inline JSON API examples match their actual schemas', () => {
    const schemas = [c.approvalRequestSchema, c.approvalResponseSchema, c.learnerAssignmentsResponseSchema,
        c.learnerAssignmentsResponseSchema, c.sessionStartSchema];
    const json = [...examples.matchAll(/`(\{"(?:expectedRevision|schemaVersion|assignments|taskId)"[^`]+)`/g)].map(m => JSON.parse(m[1]));
    assert.equal(json.length, schemas.length);
    json.forEach((value, i) => schemas[i].parse(value));
});
test('old releases and sessions normalize to mandatory presentation fields', () => {
    const oldRelease = fixture('release-legacy-valid');
    assert.equal(c.releaseSchema.safeParse(oldRelease).success, false);
    const release: c.Release = c.normalizeRelease(oldRelease);
    const oldSession: c.LearnerSessionDTO = fixture('session-legacy-valid');
    const session: c.FixedLearnerSessionDTO = c.normalizeLearnerSessionDTO(oldSession);
    for (const value of [release, session]) {
        assert.equal(value.displayMode, 'photo_text'); assert.equal(value.audioGuidance, false);
    }
    assert.equal(release.learnerSteps[0].imageAltText, oldRelease.learnerSteps[0].text);
    assert.equal(session.steps[0].imageAltText, oldSession.steps[0].text);
    assert.deepEqual(c.normalizeLearnerSessionDTO(fixture('session-photo-only-valid')), fixture('session-photo-only-valid'));
    assert.equal(c.learnerSessionSchema.safeParse(oldSession).success, false);
});
test('waiting session may carry the support summary required by the spec', () => {
    const s = fixture('session-photo-text-valid');
    const waiting = { ...s, status: 'waiting_help', support: { requestId: 'req-1', status: 'open', revision: 1 } };
    assert.equal(c.learnerSessionSchema.parse(waiting).support?.status, 'open');
    assert.equal(c.learnerSessionSchema.safeParse({ ...waiting, support: { requestId: 'req-1', status: 'bogus', revision: 1 } }).success, false);
    assert.equal(c.learnerSessionSchema.safeParse({ ...waiting, support: { requestId: 'req-1', status: 'open', revision: 1, learnerId: 'x' } }).success, false);
});

test('photo-only projection removes text keys while internal release retains staff content', () => {
    const release = c.releaseSchema.parse(fixture('release-photo-only-valid'));
    assert.ok(release.learnerSteps[0].text); assert.ok(release.learnerSteps[0].visibleCaution); assert.ok(release.staffGuide[0].coaching);
    const steps = c.projectReleaseToSessionSteps(release);
    const expected = ['imageAltText', 'imageAssetId', 'order', 'stepId'];
    assert.deepEqual(Object.keys(steps[0]).sort(), expected);
    assert.deepEqual(Object.keys(c.learnerSessionSchema.parse(fixture('session-photo-only-valid')).steps[0]).sort(), expected);
    assert.deepEqual(steps, fixture('session-photo-only-valid').steps);
    assert.equal(c.learnerSessionSchema.safeParse(fixture('invalid-session-photo-only-with-text')).success, false);
    const textSteps = c.projectReleaseToSessionSteps({ ...release, displayMode: 'photo_text' });
    assert.deepEqual(textSteps, release.learnerSteps);
    const withAudio = c.projectReleaseToSessionSteps({ ...release, learnerSteps: [{ ...release.learnerSteps[0], audioAssetId: 'demo-audio' }] });
    assert.equal(withAudio[0].audioAssetId, 'demo-audio');
});
test('learner contracts reject staff, draft, AI and storage fields at both levels', () => {
    for (const name of ['session-photo-text-valid', 'session-photo-only-valid']) {
        const s = fixture(name);
        for (const key of ['staffGuide', 'draftId', 'aiProposal', 'objectPath', 'staffNotes', 'supportRecords']) {
            assert.equal(c.learnerSessionSchema.safeParse({ ...s, [key]: 'private' }).success, false);
            assert.equal(c.learnerSessionSchema.safeParse({ ...s, steps: [{ ...s.steps[0], [key]: 'private' }] }).success, false);
        }
    }
    const assignment = { schemaVersion: '1', taskId: 't', title: '架空', releaseId: 'r' };
    assert.ok(c.learnerAssignmentSchema.parse(assignment));
    assert.equal(c.learnerAssignmentSchema.safeParse({ ...assignment, draftId: 'd' }).success, false);
});
test('draft origins cannot mix; AI proposal is optional and legacy settings default', () => {
    assert.equal(c.draftDetailSchema.safeParse(fixture('invalid-draft-manual-with-job')).success, false);
    const ai = fixture('draft-ai-valid'), manual = fixture('draft-manual-valid');
    const proposal = { schemaVersion: '1', steps: [{ stepId: 's', startMs: 0, endMs: 1, frameMs: 0,
        observationCandidate: '', speechCandidate: '声', instructionDraft: '工程', coachingDraft: '', completionCheckDraft: '', reviewFlags: [] }], reviewFlags: [] };
    assert.ok(c.aiDraftSchema.parse({ ...ai, status: 'generating', aiProposal: proposal }));
    assert.ok(c.aiDraftSchema.parse({ ...ai, status: 'failed' }));
    assert.equal(c.draftDetailSchema.safeParse({ ...manual, aiProposal: proposal }).success, false);
    assert.equal(c.draftDetailSchema.safeParse({ ...ai, sourceReleaseId: 'r' }).success, false);
    delete ai.jobId; assert.equal(c.draftDetailSchema.safeParse(ai).success, false);
    delete manual.displayMode; delete manual.audioGuidance;
    const normalized = c.draftDetailSchema.parse(manual);
    assert.equal(normalized.displayMode, 'photo_text'); assert.equal(normalized.audioGuidance, false);
});
test('draft patch accepts old/new payloads and enforces strict limits', () => {
    const patch = fixture('draft-patch-valid');
    const oldStep = { ...patch.editedSteps[0] }; delete oldStep.imageAltText;
    const old = { expectedRevision: 0, editedSteps: [oldStep], reviewChecks: patch.reviewChecks };
    assert.ok(c.draftPatchSchema.parse(old)); assert.ok(c.editedStepSchema.parse(oldStep));
    for (const key of Object.keys(patch)) assert.equal(c.draftPatchSchema.safeParse({ ...patch, [key]: null }).success, false, key);
    for (const change of [{ unknown: true }, { displayMode: 'invalid' }, { correctionReason: 'a'.repeat(2001) },
        { editedSteps: Array(21).fill(oldStep) }, { appliedSupportRecordRefs: [{ recordId: 'r', revision: 0 }] },
        { appliedSupportRecordRefs: [{ recordId: 'r', revision: 1.5 }] }])
        assert.equal(c.draftPatchSchema.safeParse({ ...patch, ...change }).success, false);
    assert.ok(c.draftPatchSchema.parse({ ...patch, correctionReason: 'a'.repeat(2000) }));
    assert.ok(c.editedStepSchema.parse({ ...oldStep, imageAltText: 'a'.repeat(200) }));
    assert.equal(c.editedStepSchema.safeParse({ ...oldStep, imageAltText: 'a'.repeat(201) }).success, false);
    assert.equal(c.editedStepSchema.safeParse({ ...oldStep, imageAltText: null }).success, false);
});
test('release step and staff guide enforce mandatory alt, order, text and timestamp limits', () => {
    const release = fixture('release-photo-only-valid'), step = release.learnerSteps[0], guide = release.staffGuide[0];
    for (const patch of [{ order: 0 }, { text: '' }, { text: ' \t\n　' }, { text: 'a'.repeat(41) }, { imageAltText: '' }, { imageAltText: ' \t\n　' }, { imageAltText: undefined }, { imageAltText: 'a'.repeat(201) }, { visibleCaution: 'a'.repeat(201) }])
        assert.equal(c.releaseLearnerStepSchema.safeParse({ ...step, ...patch }).success, false);
    for (const [key, max] of [['imageAltText', 200], ['text', 40]] as const) {
        for (const n of [1, max]) {
            const parsed = c.releaseLearnerStepSchema.parse({ ...step, [key]: ` ${'a'.repeat(n)}　`, visibleCaution: '' });
            assert.equal(parsed[key], 'a'.repeat(n));
            assert.equal(parsed.visibleCaution, '');
        }
    }
    for (const patch of [{ sourceStartMs: -1 }, { sourceEndMs: -1 }, { sourceStartMs: 1001 }, { sourceStartMs: 0.5 }, { coaching: 'a'.repeat(201) }])
        assert.equal(c.staffGuideStepSchema.safeParse({ ...guide, ...patch }).success, false);
    assert.ok(c.staffGuideStepSchema.parse({ ...guide, sourceStartMs: 0, sourceEndMs: 0 }));
    assert.equal(c.releaseSchema.safeParse({ ...release, approvedAt: 'yesterday' }).success, false);
});
test('copy idempotency key boundaries and response shape', () => {
    for (const n of [1, 100]) assert.ok(c.releaseCopyRequestSchema.parse({ clientRequestId: 'a'.repeat(n) }));
    for (const n of [0, 101]) assert.equal(c.releaseCopyRequestSchema.safeParse({ clientRequestId: 'a'.repeat(n) }).success, false);
    for (const value of [{ clientRequestId: null }, { clientRequestId: 'a', jobId: 'j' }, {}])
        assert.equal(c.releaseCopyRequestSchema.safeParse(value).success, false);
    const response = fixture('release-copy-response-valid');
    for (const patch of [{ status: 'generating' }, { jobId: 'j' }, { revision: -1 }, { schemaVersion: '2' }])
        assert.equal(c.releaseCopyResponseSchema.safeParse({ ...response, ...patch }).success, false);
});
test('existing generation, approval, schema version and ApiError contracts remain intact', () => {
    assert.deepEqual(c.generationRequestSchema.parse({ learnerId: 'l' }), { learnerId: 'l' });
    assert.equal(c.generationRequestSchema.safeParse({ learnerId: 'l', unknown: true }).success, false);
    const request: c.ApprovalRequest = { expectedRevision: 0, approvalRequestId: 'approval-1' };
    assert.deepEqual(c.approvalRequestSchema.parse(request), request);
    assert.equal(c.approvalRequestSchema.safeParse({ expectedRevision: 0 }).success, false);
    const response: c.ApprovalResponse = { schemaVersion: '1', releaseId: 'r', version: 1 };
    assert.deepEqual(c.approvalResponseSchema.parse(response), response);
    assert.equal(c.schemaVersion, '1');
    const error: c.ApiError = fixture('error-revision-conflict');
    assert.deepEqual(c.apiErrorSchema.parse(error), error);
    assert.deepEqual(Object.keys(error), ['error']);
    assert.deepEqual(Object.keys(error.error).sort(), ['code', 'message', 'requestId']);
    assert.equal(c.apiErrorSchema.safeParse({ ...error, schemaVersion: '1' }).success, false);
    for (const schema of [c.draftDetailSchema, c.releaseSchema, c.learnerSessionSchema]) {
        const name = schema === c.draftDetailSchema ? 'draft-ai-valid' : schema === c.releaseSchema ? 'release-photo-only-valid' : 'session-photo-text-valid';
        assert.equal(schema.safeParse({ ...fixture(name), schemaVersion: '2' }).success, false);
    }
});
