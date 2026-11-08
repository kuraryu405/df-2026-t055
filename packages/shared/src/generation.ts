import { z } from 'zod';

const id = z.string().min(1);
const revision = z.number().int().nonnegative();
const version = z.literal('1');
const displayMode = z.enum(['photo_only', 'photo_text']);
const status = z.enum(['queued', 'running', 'succeeded', 'failed']);
const errorCode = id.optional();
const confirmedGuidance = z.array(z.string().trim().min(1).max(500)).max(20);

export const generationRequestSchema = z.object({ learnerId: id }).strict();
export const initialGenerationRequestSchema = generationRequestSchema;
// ponytail: Free text requires staff privacy review; add automated screening if it is accepted without that review.
export const supportInputSchema = z.object({
    recordId: id, revision: z.number().int().min(1), summary: z.string().trim().min(1).max(2000)
}).strict();
const supportInputs = z.array(supportInputSchema).min(1).refine(
    inputs => new Set(inputs.map(input => input.recordId)).size === inputs.length,
    'Duplicate recordId'
);
export const improvementGenerationRequestSchema = z.object({
    learnerId: id, sourceReleaseId: id, supportInputs, clientRequestId: id.max(100)
}).strict();
// The legacy initial request has no tag; strict shapes distinguish it from improvements.
export const guideGenerationRequestSchema = z.union([initialGenerationRequestSchema, improvementGenerationRequestSchema]);
export const generationCreateResponseSchema = z.object({ schemaVersion: version, jobId: id, draftId: id }).strict();
export const generationJobStatusSchema = generationCreateResponseSchema.extend({
    kind: z.enum(['guide', 'correction_context']), status, errorCode
}).strict();
export const generationPreferencesSchema = z.object({
    sentenceLength: z.number().int().min(1).max(40), splitHints: z.string().max(200), audioGuidance: z.boolean()
}).strict();
export const initialGuideInputSnapshotSchema = z.object({
    taskId: id, learnerId: id, videoAssetId: id, title: id,
    completionCriteria: z.string().max(2000), durationMs: revision,
    preferences: generationPreferencesSchema, displayMode, confirmedGuidance
}).strict();
export const correctionRefSchema = z.object({ correctionId: id, draftRevision: revision }).strict();
export const improvementGuideInputSnapshotSchema = z.object({
    taskId: id, learnerId: id, sourceReleaseId: id, sourceReleaseVersion: z.number().int().min(1),
    supportInputs, correctionRefs: z.array(correctionRefSchema).max(20).refine(
        refs => new Set(refs.map(ref => ref.correctionId)).size === refs.length, 'Duplicate correctionId'
    ), displayMode, confirmedGuidance
}).strict();
const fields = ['text', 'visibleCaution', 'imageAltText', 'imageAssetId', 'sourceStartMs', 'sourceEndMs', 'frameMs', 'verifiedObservation', 'verifiedSpeech', 'coaching', 'completionCheck'] as const;
const value = z.union([z.string().max(2000), z.number().finite()]);
export const draftCorrectionChangeSchema = z.object({ stepId: id, field: z.enum(fields), before: value, after: value }).strict();
export const correctionContextOutputSchema = z.object({
    editSummary: z.string().trim().min(1).max(500), nextDraftHint: z.string().trim().min(1).max(500),
    reviewFlags: z.array(z.string().trim().min(1).max(100)).max(10)
}).strict();
export const draftCorrectionSchema = z.object({
    schemaVersion: version, correctionId: id, taskId: id, learnerId: id, draftId: id, draftRevision: revision,
    changes: z.array(draftCorrectionChangeSchema).min(1).max(220), reason: z.string().max(2000).optional(),
    createdBy: id, createdAt: z.iso.datetime(), contextJobId: id.optional(), contextSummary: correctionContextOutputSchema.optional()
}).strict();
export const draftCorrectionWithContextSchema = draftCorrectionSchema.extend({ contextJobStatus: status.optional() }).strict();
export const correctionsListResponseSchema = z.object({ corrections: z.array(draftCorrectionWithContextSchema) }).strict();
export const correctionContextChangeSchema = z.object({
    stepId: id, field: z.enum(['text', 'imageAltText', 'visibleCaution']),
    before: z.string().max(2000), after: z.string().max(2000)
}).strict();
export const correctionContextInputSnapshotSchema = z.object({
    correctionId: id, draftRevision: revision, title: id, changes: z.array(correctionContextChangeSchema).min(1)
}).strict();
const job = generationCreateResponseSchema.extend({
    taskId: id, status, attempt: z.number().int().min(0).max(3), modelId: id, promptVersion: id,
    errorCode, leaseUntil: revision.optional()
});
export const generationJobSchema = z.discriminatedUnion('kind', [
    job.extend({ kind: z.literal('guide'), inputSnapshot: z.union([initialGuideInputSnapshotSchema, improvementGuideInputSnapshotSchema]) }).strict(),
    job.extend({ kind: z.literal('correction_context'), inputSnapshot: correctionContextInputSnapshotSchema }).strict()
]);
