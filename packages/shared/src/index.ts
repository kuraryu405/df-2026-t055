import { z } from 'zod';
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
    stepId: z.string().min(1), text: z.string().trim().min(1).max(40), visibleCaution: candidate, imageAssetId: z.string(), sourceStartMs: time, sourceEndMs: time, frameMs: time, verifiedObservation: candidate, verifiedSpeech: candidate, coaching: candidate, completionCheck: candidate
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
export const generationRequestSchema = z.object({ learnerId: z.string().min(1) }).strict();
export const approvalRequestSchema = z.object({ expectedRevision: z.number().int().nonnegative(), approvalRequestId: z.string().min(1).max(100) }).strict();
export const draftPatchSchema = z.object({ expectedRevision: z.number().int().nonnegative(), editedSteps: z.array(editedStepSchema).min(1).max(20), reviewChecks: checksSchema }).strict();
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
export * from './support.ts';
