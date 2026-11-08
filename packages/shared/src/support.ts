import { z } from 'zod';

const version = z.literal('1');
const id = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });
const revision = z.number().int().min(1);
const nonnegative = z.number().int().nonnegative();
const sessionStatus = z.enum(['active', 'waiting_help', 'stopped', 'completed']);
export const supportStatusSchema = z.enum(['open', 'assigned', 'in_progress', 'acknowledged']);
const base = { schemaVersion: version, requestId: id, sessionId: id, eventId: id, revision, createdAt: timestamp };
const assigned = { assignedTo: id, assignedAt: timestamp };
const started = { startedBy: id, startedAt: timestamp };
const acknowledged = { acknowledgedBy: id, acknowledgedAt: timestamp };
export const supportRequestSchema = z.union([
    z.object({ ...base, kind: z.literal('help'), status: z.literal('open') }).strict(),
    z.object({ ...base, kind: z.literal('help'), status: z.literal('assigned'), ...assigned }).strict(),
    z.object({ ...base, kind: z.literal('help'), status: z.literal('in_progress'), ...assigned, ...started }).strict(),
    z.object({ ...base, kind: z.literal('help'), status: z.literal('acknowledged'), ...assigned, ...started, ...acknowledged }).strict(),
    z.object({ ...base, kind: z.literal('stop'), status: z.literal('open') }).strict(),
    z.object({ ...base, kind: z.literal('stop'), status: z.literal('acknowledged'), ...acknowledged }).strict()
]);
export type SupportRequest = z.infer<typeof supportRequestSchema>;
export type SupportStatus = z.infer<typeof supportStatusSchema>;
export const supportTransitions = {
    help: { open: ['assigned'], assigned: ['in_progress'], in_progress: ['acknowledged'], acknowledged: [] },
    stop: { open: ['acknowledged'], assigned: [], in_progress: [], acknowledged: [] }
} as const;
export function canTransitionSupport(kind: SupportRequest['kind'], from: SupportStatus, to: SupportStatus): boolean {
    const targets: readonly SupportStatus[] = supportTransitions[kind][from];
    return targets.includes(to);
}
export const supportOperationRequestSchema = z.object({}).strict();
export const supportClaimResponseSchema = z.object({ schemaVersion: version, status: z.literal('assigned'), ...assigned, revision }).strict();
export const supportStartResponseSchema = z.object({ schemaVersion: version, status: z.literal('in_progress'), startedAt: timestamp }).strict();
export const supportAcknowledgeResponseSchema = z.object({ schemaVersion: version, status: z.literal('acknowledged'), acknowledgedAt: timestamp }).strict();
export const supportResumeRequestSchema = z.object({ clientRequestId: id.max(100), expectedSessionRevision: nonnegative }).strict();
const sessionProgress = { status: sessionStatus, stepIndex: nonnegative, revision: nonnegative };
export const supportResumeResponseSchema = z.object({ schemaVersion: version, sessionId: id, ...sessionProgress }).strict();
export const supportRequestListResponseSchema = z.object({ requests: z.array(supportRequestSchema) }).strict();
export const supportRequestStatusQuerySchema = z.object({ status: supportStatusSchema.optional() }).strict();
export const learnerSupportSchema = z.object({ requestId: id, status: supportStatusSchema, revision }).strict();
export const supportSessionEventResponseSchema = z.object({ schemaVersion: version, ...sessionProgress, support: learnerSupportSchema.optional() }).strict();
export const learnerSupportSessionStateSchema = z.object({ schemaVersion: version, sessionId: id, releaseId: id, ...sessionProgress, support: learnerSupportSchema.optional() }).strict();
export type LearnerSupport = z.infer<typeof learnerSupportSchema>;
export type LearnerSupportSessionState = z.infer<typeof learnerSupportSessionStateSchema>;
const recordText = { observedDifficulty: z.string().max(2000), assistanceGiven: z.string().max(2000), improvementSuggestion: z.string().max(2000) };
export const supportRecordSchema = z.object({
    schemaVersion: version, recordId: id, supportRequestId: id, learnerId: id, taskId: id, releaseId: id, stepId: id, sessionId: id,
    ...recordText, createdBy: id, updatedBy: id, createdAt: timestamp, updatedAt: timestamp, revision
}).strict();
export type SupportRecord = z.infer<typeof supportRecordSchema>;
export const supportRecordSaveRequestSchema = z.object({ expectedRevision: nonnegative, ...recordText }).strict();
export const supportWsAuthSchema = z.object({ type: z.literal('auth'), idToken: id }).strict();
export const staffSupportNotificationSchema = z.discriminatedUnion('type', [
    z.object({ schemaVersion: version, type: z.literal('support.snapshot'), requests: z.array(supportRequestSchema) }).strict(),
    z.object({ schemaVersion: version, type: z.literal('support.updated'), request: supportRequestSchema }).strict()
]);
export const learnerSupportNotificationSchema = z.discriminatedUnion('type', [
    z.object({ schemaVersion: version, type: z.literal('session.support.snapshot'), payload: learnerSupportSessionStateSchema }).strict(),
    z.object({ schemaVersion: version, type: z.literal('session.support.updated'), payload: learnerSupportSessionStateSchema }).strict()
]);
