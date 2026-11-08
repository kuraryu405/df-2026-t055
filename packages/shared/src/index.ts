import { z } from 'zod';
import { generationRequestSchema } from './generation.ts';
export * from './generation.ts';
export const schemaVersion = '1' as const;
const time = z.number().int().nonnegative();
const candidate = z.string().max(200);
const flags = z.array(z.string().max(100)).max(10);
export const proposalSchema = z.object({ schemaVersion: z.literal('1'), steps: z.array(z.object({
        stepId: z.string().min(1), startMs: time, endMs: time, frameMs: time, observationCandidate: candidate, speechCandidate: candidate, instructionDraft: z.string().trim().min(1).max(40), coachingDraft: candidate, completionCheckDraft: candidate, reviewFlags: flags
    }).strict()).min(1).max(20), reviewFlags: flags }).strict();
export type Proposal = z.infer<typeof proposalSchema>;
export function validateProposal(value: unknown, durationMs: number): Proposal {
    const p = proposalSchema.parse(value);
    const ids = new Set();
    let previous = -1;
    for (const s of p.steps) {
        if (ids.has(s.stepId) || s.startMs < previous || s.startMs > s.frameMs || s.frameMs > s.endMs || s.endMs > durationMs || (!s.speechCandidate && !s.reviewFlags.length))
            throw Error('INVALID_PROPOSAL');
        ids.add(s.stepId);
        previous = s.startMs;
    }
    return p;
}
export const editedStepSchema = z.object({
    stepId: z.string().min(1), text: z.string().trim().min(1).max(40), visibleCaution: candidate, imageAssetId: z.string(), imageAltText: candidate.optional(), sourceStartMs: time, sourceEndMs: time, frameMs: time, verifiedObservation: candidate, verifiedSpeech: candidate, coaching: candidate, completionCheck: candidate
}).strict();
export type EditedStep = z.infer<typeof editedStepSchema>;
export const checksSchema = z.object({ presentationConfirmed: z.boolean(), flagResolution: z.string().max(2000), steps: z.record(z.string(), z.object({ videoVerified: z.boolean(), photoTextVerified: z.boolean() }).strict()) }).strict();
export type ReviewChecks = z.infer<typeof checksSchema>;
export type Role = 'staff' | 'learner' | 'newcomer';
export type Member = {
    uid: string;
    orgId: string;
    role: Role;
    learnerId?: string;
};
export type SessionStatus = 'active' | 'waiting_help' | 'stopped' | 'completed';
export const eventSchema = z.object({ clientEventId: z.string().min(1).max(100), expectedRevision: z.number().int().nonnegative(), type: z.enum(['next', 'back', 'help', 'resume', 'stop', 'complete']) }).strict();
export type LearnerStep = {
    stepId: string;
    order: number;
    imageAssetId: string;
    audioAssetId?: string;
    text: string;
    visibleCaution: string;
};
export type LearnerSessionDTO = {
    schemaVersion: '1';
    sessionId: string;
    releaseId: string;
    steps: LearnerStep[];
    status: SessionStatus;
    stepIndex: number;
    revision: number;
};
// stop is accepted even after complete; stopped itself can never resume.
export const transitions = {
    queued: ['running'], running: ['succeeded', 'failed'], active: ['waiting_help', 'stopped', 'completed'], waiting_help: ['active', 'stopped'], stopped: [], completed: ['stopped']
} as const;
export const approvalRequestSchema = z.object({ expectedRevision: z.number().int().nonnegative(), approvalRequestId: z.string().min(1).max(100) }).strict();
export const displayModeSchema = z.enum(['photo_only', 'photo_text']);
export type DisplayMode = z.infer<typeof displayModeSchema>;
export const supportRecordRefSchema = z.object({ recordId: z.string().min(1), revision: z.number().int().min(1) }).strict();
export type SupportRecordRef = z.infer<typeof supportRecordRefSchema>;
export const draftPatchSchema = z.object({ expectedRevision: z.number().int().nonnegative(), editedSteps: z.array(editedStepSchema).min(1).max(20), reviewChecks: checksSchema, displayMode: displayModeSchema.optional(), audioGuidance: z.boolean().optional(), appliedSupportRecordRefs: z.array(supportRecordRefSchema).optional(), correctionReason: z.string().max(2000).optional() }).strict();
export const sessionStartSchema = z.object({ taskId: z.string().min(1), clientRequestId: z.string().min(1).max(100) }).strict();
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type DraftPatch = z.infer<typeof draftPatchSchema>;
export type SessionStart = z.infer<typeof sessionStartSchema>;
export type SessionEvent = z.infer<typeof eventSchema>;
export type ApiError = {
    error: {
        code: string;
        message: string;
        requestId: string;
    };
};
export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type DraftStatus = 'generating' | 'editing' | 'approved' | 'failed';
export type GenerationResponse = {
    schemaVersion: '1';
    jobId: string;
    draftId: string;
};
export type ApprovalResponse = {
    schemaVersion: '1';
    releaseId: string;
    version: number;
};

export * from './learner-profile.ts';

// Work-guide wire contracts. Existing application DTOs above remain source-compatible.
const versionSchema = z.literal(schemaVersion);
const identifier = z.string().min(1);
const revisionSchema = z.number().int().nonnegative();
const requestIdSchema = z.string().min(1).max(100);
export const apiErrorSchema = z.object({ error: z.object({
    code: z.string(), message: z.string(), requestId: z.string()
}).strict() }).strict();
export const draftUpdateResponseSchema = z.object({
    schemaVersion: versionSchema, revision: revisionSchema, reviewChecks: checksSchema
}).strict();
export type DraftUpdateResponse = z.infer<typeof draftUpdateResponseSchema>;
const draftBase = {
    schemaVersion: versionSchema, draftId: identifier, taskId: identifier, learnerId: identifier,
    revision: revisionSchema, editedSteps: z.array(editedStepSchema).max(20),
    displayMode: displayModeSchema.default('photo_text'), audioGuidance: z.boolean().default(false),
    reviewChecks: checksSchema, appliedSupportRecordRefs: z.array(supportRecordRefSchema), updatedBy: identifier
};
export const aiDraftSchema = z.object({ ...draftBase,
    status: z.enum(['generating', 'editing', 'approved', 'failed']),
    jobId: identifier, aiProposal: proposalSchema.optional()
}).strict();
export const manualDraftSchema = z.object({ ...draftBase,
    status: z.enum(['editing', 'approved']), sourceReleaseId: identifier
}).strict();
// The required jobId/sourceReleaseId distinguishes origins without adding a wire discriminator.
export const draftDetailSchema = z.union([aiDraftSchema, manualDraftSchema]);
export type AIDraft = z.infer<typeof aiDraftSchema>;
export type ManualDraft = z.infer<typeof manualDraftSchema>;
export type DraftDetail = z.infer<typeof draftDetailSchema>;
export const approvalResponseSchema = z.object({
    schemaVersion: versionSchema, releaseId: identifier, version: z.number().int().min(1)
}).strict();
export const staffGuideStepSchema = z.object({
    stepId: identifier, sourceStartMs: time, sourceEndMs: time,
    verifiedObservation: candidate, verifiedSpeech: candidate, coaching: candidate, completionCheck: candidate
}).strict().refine(s => s.sourceStartMs <= s.sourceEndMs, { message: 'start must precede end', path: ['sourceEndMs'] });
export type StaffGuideStep = z.infer<typeof staffGuideStepSchema>;
export const releaseLearnerStepSchema = z.object({
    stepId: identifier, order: z.number().int().min(1), imageAssetId: identifier,
    imageAltText: z.string().trim().min(1).max(200), audioAssetId: identifier.optional(),
    text: z.string().trim().min(1).max(40), visibleCaution: candidate
}).strict();
export type ReleaseLearnerStep = z.infer<typeof releaseLearnerStepSchema>;
export const releaseSchema = z.object({
    schemaVersion: versionSchema, releaseId: identifier, taskId: identifier, learnerId: identifier,
    sourceDraftId: identifier, sourceRevision: revisionSchema, sourceReleaseId: identifier.optional(),
    appliedSupportRecordRefs: z.array(supportRecordRefSchema), version: z.number().int().min(1),
    displayMode: displayModeSchema, audioGuidance: z.boolean(),
    learnerSteps: z.array(releaseLearnerStepSchema).min(1).max(20),
    staffGuide: z.array(staffGuideStepSchema).min(1).max(20),
    approvedBy: identifier, approvedAt: z.iso.datetime({ offset: true }), contentHash: identifier
}).strict();
export type Release = z.output<typeof releaseSchema>;
// Read-only migration boundary; new releases must pass releaseSchema directly.
export const releaseReadSchema = releaseSchema.extend({
    displayMode: displayModeSchema.default('photo_text'), audioGuidance: z.boolean().default(false),
    learnerSteps: z.array(releaseLearnerStepSchema.extend({ imageAltText: candidate.optional() })
        .transform(s => ({ ...s, imageAltText: s.imageAltText ?? s.text }))).min(1).max(20)
}).transform(value => releaseSchema.parse(value));
export type ReleaseReadInput = z.input<typeof releaseReadSchema>;
export function normalizeRelease(value: unknown): Release { return releaseReadSchema.parse(value); }
export const releaseCopyRequestSchema = z.object({ clientRequestId: requestIdSchema }).strict();
export const releaseCopyResponseSchema = z.object({
    schemaVersion: versionSchema, draftId: identifier, status: z.literal('editing'), revision: revisionSchema
}).strict();
export type ReleaseCopyRequest = z.infer<typeof releaseCopyRequestSchema>;
export type ReleaseCopyResponse = z.infer<typeof releaseCopyResponseSchema>;
export const learnerAssignmentSchema = z.object({
    schemaVersion: versionSchema, taskId: identifier, title: z.string().min(1), releaseId: identifier
}).strict();
export const learnerAssignmentsResponseSchema = z.object({ assignments: z.array(learnerAssignmentSchema) }).strict();
export type LearnerAssignmentDTO = z.infer<typeof learnerAssignmentSchema>;
export type LearnerAssignmentsResponse = z.infer<typeof learnerAssignmentsResponseSchema>;
export const photoTextSessionStepSchema = releaseLearnerStepSchema;
export const photoOnlySessionStepSchema = releaseLearnerStepSchema.omit({ text: true, visibleCaution: true });
// 支援待ちの間だけ付く支援概要（仕様: GET /me/sessions/{id} は support:{requestId,status,revision} を返す）
export const supportSummarySchema = z.object({
    requestId: identifier, status: z.enum(['open', 'assigned', 'in_progress', 'acknowledged']), revision: revisionSchema
}).strict();
export type SupportSummary = z.infer<typeof supportSummarySchema>;
const sessionBase = {
    schemaVersion: versionSchema, sessionId: identifier, releaseId: identifier,
    status: z.enum(['active', 'waiting_help', 'stopped', 'completed']),
    stepIndex: revisionSchema, revision: revisionSchema, audioGuidance: z.boolean(),
    support: supportSummarySchema.optional()
};
export const learnerSessionSchema = z.discriminatedUnion('displayMode', [
    z.object({ ...sessionBase, displayMode: z.literal('photo_text'), steps: z.array(photoTextSessionStepSchema).min(1).max(20) }).strict(),
    z.object({ ...sessionBase, displayMode: z.literal('photo_only'), steps: z.array(photoOnlySessionStepSchema).min(1).max(20) }).strict()
]);
export type FixedLearnerSessionDTO = z.output<typeof learnerSessionSchema>;
const legacyLearnerSessionSchema = z.object({
    ...sessionBase,
    audioGuidance: z.never().optional(),
    steps: z.array(releaseLearnerStepSchema.omit({ imageAltText: true })).min(1).max(20)
}).strict();
export function normalizeLearnerSessionDTO(value: unknown): FixedLearnerSessionDTO {
    if (typeof value === 'object' && value !== null && 'displayMode' in value)
        return learnerSessionSchema.parse(value);
    const legacy = legacyLearnerSessionSchema.parse(value);
    return learnerSessionSchema.parse({ ...legacy, displayMode: 'photo_text', audioGuidance: false,
        steps: legacy.steps.map(s => ({ ...s, imageAltText: s.text })) });
}
// Explicit allowlist projection; never spread a staff release into a learner response.
export function projectReleaseToSessionSteps(release: Release) {
    const parsed = releaseSchema.parse(release);
    return parsed.learnerSteps.map(s => {
        const photo = { stepId: s.stepId, order: s.order, imageAssetId: s.imageAssetId,
            imageAltText: s.imageAltText, ...(s.audioAssetId === undefined ? {} : { audioAssetId: s.audioAssetId }) };
        return parsed.displayMode === 'photo_only' ? photoOnlySessionStepSchema.parse(photo)
            : photoTextSessionStepSchema.parse({ ...photo, text: s.text, visibleCaution: s.visibleCaution });
    });
}
export * from './support.ts';
