import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import * as g from '../packages/shared/src/index.ts';
import type { ApiError, GenerationResponse } from '../packages/shared/src/index.ts';

const root = new URL('../packages/shared/fixtures/generation/', import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, root), 'utf8'));
const examples = readFileSync(new URL('../packages/shared/api-examples/generation.md', import.meta.url), 'utf8');
const valid: Record<string, z.ZodType> = {
    'initial-request-valid': g.initialGenerationRequestSchema,
    'improvement-request-valid': g.improvementGenerationRequestSchema,
    'generation-response-valid': g.generationCreateResponseSchema,
    'job-status-guide-valid': g.generationJobStatusSchema,
    'initial-snapshot-valid': g.initialGuideInputSnapshotSchema,
    'improvement-snapshot-valid': g.improvementGuideInputSnapshotSchema,
    'job-guide-valid': g.generationJobSchema,
    'job-correction-context-valid': g.generationJobSchema,
    'draft-correction-valid': g.draftCorrectionSchema,
    'corrections-list-valid': g.correctionsListResponseSchema,
    'correction-context-snapshot-valid': g.correctionContextInputSnapshotSchema,
    'correction-context-output-valid': g.correctionContextOutputSchema
};
const rejects = (schema: z.ZodType, value: unknown) => assert.equal(schema.safeParse(value).success, false);
for (const [name, schema] of Object.entries(valid)) {
    test(`generation fixture: ${name}`, () => {
        schema.parse(fixture(name));
        assert.ok(examples.includes(`../fixtures/generation/${name}.json`));
    });
}
test('all fixtures are covered and linked, including invalid and existing error shape', () => {
    assert.equal(readdirSync(root).length, 17);
    for (const name of readdirSync(root)) assert.ok(examples.includes(`../fixtures/generation/${name}`));
    rejects(g.improvementGenerationRequestSchema, fixture('invalid-improvement-summary-empty'));
    rejects(g.improvementGenerationRequestSchema, fixture('invalid-improvement-revision-zero'));
    rejects(g.correctionContextOutputSchema, fixture('invalid-context-output-too-long'));
    rejects(g.initialGuideInputSnapshotSchema, fixture('invalid-snapshot-with-personal-data'));
    const error: ApiError = fixture('error-generation-conflict');
    assert.deepEqual(Object.keys(error), ['error']);
    assert.deepEqual(Object.keys(error.error).sort(), ['code', 'message', 'requestId']);
    assert.ok(Object.values(error.error).every(v => typeof v === 'string' && v.length > 0));
});
test('legacy initial request, GenerationResponse and proposal remain compatible', () => {
    assert.equal(g.initialGenerationRequestSchema, g.generationRequestSchema);
    const initial = fixture('initial-request-valid');
    g.generationRequestSchema.parse(initial);
    g.guideGenerationRequestSchema.parse(initial);
    g.guideGenerationRequestSchema.parse(fixture('improvement-request-valid'));
    rejects(g.guideGenerationRequestSchema, { ...initial, sourceReleaseId: 'release' });
    rejects(g.generationRequestSchema, { ...initial, extra: true });
    const response: GenerationResponse = g.generationCreateResponseSchema.parse(fixture('generation-response-valid'));
    assert.equal(response.schemaVersion, '1');
    const proposal = JSON.parse(readFileSync(new URL('../apps/generator/fixtures/towel-a.json', import.meta.url), 'utf8'));
    assert.deepEqual(g.validateProposal(g.proposalSchema.parse(proposal), 120000), proposal);
});
test('support IDs, revisions, summaries and request keys enforce boundaries in requests and snapshots', () => {
    for (const [schema, name] of [[g.improvementGenerationRequestSchema, 'improvement-request-valid'], [g.improvementGuideInputSnapshotSchema, 'improvement-snapshot-valid']] as const) {
        const base = fixture(name), input = base.supportInputs[0];
        for (const patch of [{ recordId: '' }, { revision: 0 }, { revision: -1 }, { revision: 1.5 }, { revision: '1' }, { summary: '' }, { summary: '  ' }, { summary: 'あ'.repeat(2001) }, { rawRecord: '原文' }])
            rejects(schema, { ...base, supportInputs: [{ ...input, ...patch }] });
        rejects(schema, { ...base, supportInputs: [] });
        rejects(schema, { ...base, supportInputs: [input, input] });
        rejects(schema, { ...base, learnerId: '' });
        rejects(schema, { ...base, sourceReleaseId: '' });
        const parsed = schema.parse({ ...base, supportInputs: [{ ...input, summary: ` ${'あ'.repeat(2000)} ` }] });
        assert.equal(parsed.supportInputs[0].summary.length, 2000);
    }
    const request = fixture('improvement-request-valid');
    for (const clientRequestId of ['', 'x'.repeat(101)]) rejects(g.improvementGenerationRequestSchema, { ...request, clientRequestId });
    g.improvementGenerationRequestSchema.parse({ ...request, clientRequestId: 'x'.repeat(100) });
    const snapshot = fixture('improvement-snapshot-valid');
    for (const sourceReleaseVersion of [0, -1, 1.5]) rejects(g.improvementGuideInputSnapshotSchema, { ...snapshot, sourceReleaseVersion });
    const ref = snapshot.correctionRefs[0];
    for (const correctionRefs of [[ref, ref], [{ ...ref, correctionId: '' }], [{ ...ref, draftRevision: -1 }], [{ ...ref, draftRevision: 0.5 }], Array.from({ length: 21 }, (_, i) => ({ ...ref, correctionId: `c${i}` }))])
        rejects(g.improvementGuideInputSnapshotSchema, { ...snapshot, correctionRefs });
    g.improvementGuideInputSnapshotSchema.parse({ ...snapshot, correctionRefs: Array.from({ length: 20 }, (_, i) => ({ correctionId: `c${i}`, draftRevision: 0 })) });
});
test('context output trims and checks exact character and count limits', () => {
    const base = fixture('correction-context-output-valid');
    for (const field of ['editSummary', 'nextDraftHint']) {
        assert.equal((g.correctionContextOutputSchema.parse({ ...base, [field]: ` ${'あ'.repeat(500)} ` }) as Record<string, unknown>)[field], 'あ'.repeat(500));
        for (const value of ['', '  ', 'あ'.repeat(501)]) rejects(g.correctionContextOutputSchema, { ...base, [field]: value });
    }
    g.correctionContextOutputSchema.parse({ ...base, reviewFlags: Array(10).fill(` ${'あ'.repeat(100)} `) });
    for (const reviewFlags of [Array(11).fill('確認'), ['あ'.repeat(101)], [' '], ['']]) rejects(g.correctionContextOutputSchema, { ...base, reviewFlags });
    rejects(g.correctionContextOutputSchema, { ...base, extra: true });
});
test('draft corrections preserve all allowed fields and reject unsafe values, counts and revisions', () => {
    const base = fixture('draft-correction-valid'), change = base.changes[0];
    for (const field of ['text', 'visibleCaution', 'imageAltText', 'imageAssetId', 'sourceStartMs', 'sourceEndMs', 'frameMs', 'verifiedObservation', 'verifiedSpeech', 'coaching', 'completionCheck'])
        g.draftCorrectionChangeSchema.parse({ ...change, field, before: 0, after: 'あ'.repeat(2000) });
    for (const field of ['reason', 'profile', 'unknown']) rejects(g.draftCorrectionChangeSchema, { ...change, field });
    for (const key of ['before', 'after']) for (const value of [true, null, {}, [], Infinity, -Infinity, NaN, 'あ'.repeat(2001)]) rejects(g.draftCorrectionChangeSchema, { ...change, [key]: value });
    for (const changes of [[], Array(221).fill(change)]) rejects(g.draftCorrectionSchema, { ...base, changes });
    g.draftCorrectionSchema.parse({ ...base, changes: Array(220).fill(change), draftRevision: 0, reason: 'あ'.repeat(2000) });
    for (const draftRevision of [-1, 0.5, '0']) rejects(g.draftCorrectionSchema, { ...base, draftRevision });
    rejects(g.draftCorrectionSchema, { ...base, reason: 'あ'.repeat(2001) });
    rejects(g.draftCorrectionSchema, { ...base, createdAt: 'yesterday' });
    rejects(g.draftCorrectionSchema, { ...base, contextSummary: { ...base.contextSummary, editSummary: '' } });
    g.correctionsListResponseSchema.parse({ corrections: [] });
    rejects(g.draftCorrectionWithContextSchema, { ...base, contextJobStatus: 'editing' });
});
test('context snapshot rejects excluded fields and personal or staff data at every input boundary', () => {
    const base = fixture('correction-context-snapshot-valid'), change = base.changes[0];
    for (const field of ['text', 'imageAltText', 'visibleCaution']) g.correctionContextChangeSchema.parse({ ...change, field });
    for (const field of ['imageAssetId', 'sourceStartMs', 'sourceEndMs', 'frameMs', 'verifiedObservation', 'verifiedSpeech', 'coaching', 'completionCheck', 'reason']) rejects(g.correctionContextInputSnapshotSchema, { ...base, changes: [{ ...change, field }] });
    for (const key of ['reason', 'staffMemo', 'profile', 'displayName', 'learnerName', 'diagnosis']) {
        rejects(g.correctionContextInputSnapshotSchema, { ...base, [key]: '架空' });
        rejects(g.correctionContextInputSnapshotSchema, { ...base, changes: [{ ...change, [key]: '架空' }] });
    }
    for (const key of ['before', 'after']) for (const value of [1, false, null, {}, [], 'あ'.repeat(2001)]) rejects(g.correctionContextChangeSchema, { ...change, [key]: value });
    g.correctionContextChangeSchema.parse({ ...change, before: '', after: 'あ'.repeat(2000) });
    rejects(g.correctionContextInputSnapshotSchema, { ...base, changes: [] });
    for (const draftRevision of [-1, 0.5]) rejects(g.correctionContextInputSnapshotSchema, { ...base, draftRevision });
});
test('initial snapshot allowlist and presentation bounds reject unknown personal information', () => {
    const base = fixture('initial-snapshot-valid');
    for (const key of ['displayName', 'learnerName', 'diagnosis', 'disabilityInfo', 'profile', 'sessionEvents', 'recording', 'supportRecord', 'personalData']) {
        rejects(g.initialGuideInputSnapshotSchema, { ...base, [key]: '架空' });
        rejects(g.initialGuideInputSnapshotSchema, { ...base, preferences: { ...base.preferences, [key]: '架空' } });
        rejects(g.improvementGuideInputSnapshotSchema, { ...fixture('improvement-snapshot-valid'), [key]: '架空' });
    }
    for (const sentenceLength of [0, 41, 1.5]) rejects(g.generationPreferencesSchema, { ...base.preferences, sentenceLength });
    for (const sentenceLength of [1, 40]) g.generationPreferencesSchema.parse({ ...base.preferences, sentenceLength });
    rejects(g.generationPreferencesSchema, { ...base.preferences, splitHints: 'あ'.repeat(201) });
    rejects(g.generationPreferencesSchema, { ...base.preferences, audioGuidance: 'false' });
    for (const patch of [{ title: '' }, { durationMs: -1 }, { durationMs: 0.5 }, { completionCriteria: 'あ'.repeat(2001) }, { displayMode: 'auto' }, { confirmedGuidance: Array(21).fill('説明') }, { confirmedGuidance: [''] }, { confirmedGuidance: ['あ'.repeat(501)] }]) rejects(g.initialGuideInputSnapshotSchema, { ...base, ...patch });
    g.initialGuideInputSnapshotSchema.parse({ ...base, durationMs: 0, completionCriteria: 'あ'.repeat(2000), displayMode: 'photo_only', confirmedGuidance: Array(20).fill('あ'.repeat(500)) });
});
test('jobs pair kind with correct snapshot and validate attempts, status and versions', () => {
    const guide = fixture('job-guide-valid'), context = fixture('job-correction-context-valid');
    rejects(g.generationJobSchema, { ...guide, inputSnapshot: context.inputSnapshot });
    rejects(g.generationJobSchema, { ...context, inputSnapshot: guide.inputSnapshot });
    g.generationJobSchema.parse({ ...guide, inputSnapshot: fixture('improvement-snapshot-valid'), attempt: 3, leaseUntil: 0 });
    for (const patch of [{ attempt: 4 }, { attempt: -1 }, { attempt: 0.5 }, { status: 'editing' }, { kind: 'other' }, { schemaVersion: '2' }, { errorCode: '' }, { leaseUntil: -1 }]) rejects(g.generationJobSchema, { ...guide, ...patch });
    for (const status of ['queued', 'running', 'succeeded', 'failed']) g.generationJobSchema.parse({ ...context, status });
    rejects(g.generationJobStatusSchema, { ...fixture('job-status-guide-valid'), status: 'editing' });
    rejects(g.generationJobStatusSchema, { ...fixture('job-status-guide-valid'), errorCode: '' });
});
