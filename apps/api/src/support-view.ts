import type { Repository, Doc } from './adapters.ts';
import type { Member } from '../../../packages/shared/src/index.ts';
import { learnerSupportSchema, supportRequestSchema } from '../../../packages/shared/src/support.ts';

export function supportRequestDto(q: Doc) {
    return supportRequestSchema.parse({
        schemaVersion: '1', requestId: q.id, sessionId: q.sessionId, eventId: q.eventId,
        kind: q.kind, status: q.status, revision: q.revision, createdAt: q.createdAt,
        ...(q.kind === 'help' && q.status !== 'open' ? { assignedTo: q.assignedTo, assignedAt: q.assignedAt } : {}),
        ...(q.kind === 'help' && ['in_progress', 'acknowledged'].includes(q.status) ? { startedBy: q.startedBy, startedAt: q.startedAt } : {}),
        ...(q.status === 'acknowledged' ? { acknowledgedBy: q.acknowledgedBy, acknowledgedAt: q.acknowledgedAt } : {})
    });
}

// Both HTTP and WebSocket use the same learner allowlist.
export async function sessionSupportSummary(db: Repository, session: Doc) {
    if (session.status !== 'waiting_help' || !session.activeSupportRequestId) return undefined;
    const q = await db.get('supportRequests', session.activeSupportRequestId);
    if (!q || q.orgId !== session.orgId || q.sessionId !== session.id || q.kind !== 'help')
        throw Error('INVALID_SUPPORT_REFERENCE');
    return learnerSupportSchema.parse({ requestId: q.id, status: q.status, revision: q.revision });
}

// Context is staff-only and contains no profile detail, coaching, or support-record text.
export async function staffSupportView(db: Repository, q: Doc, member: Member) {
    if (member.role !== 'staff' || q.orgId !== member.orgId) throw Error('SUPPORT_FORBIDDEN');
    const request = supportRequestDto(q);
    const session = await db.get('sessions', q.sessionId);
    if (!session || session.orgId !== member.orgId) throw Error('SUPPORT_FORBIDDEN');
    const release = await db.get('releases', session.releaseId);
    // Old incomplete demo records remain readable without invented target information.
    if (!release) return request;
    if (release.orgId !== member.orgId || release.learnerId !== session.learnerId) throw Error('SUPPORT_FORBIDDEN');
    const [learner, task, event] = await Promise.all([
        db.get('learners', session.learnerId), db.get('tasks', release.taskId), db.get('sessionEvents', q.eventId)
    ]);
    if ([learner, task, event].some(value => value && value.orgId !== member.orgId)) throw Error('SUPPORT_FORBIDDEN');
    const stepId = q.stepId ?? event?.stepId;
    const stepIndex = release.learnerSteps?.findIndex((step: { stepId: string }) => step.stepId === stepId) ?? -1;
    if (!learner?.displayName || !task?.title || stepIndex < 0) return request;
    const actions: ('claim' | 'start' | 'acknowledge' | 'resume' | 'record')[] = [];
    if (q.kind === 'stop') {
        if (q.status === 'open') actions.push('acknowledge');
    } else {
        if (q.status === 'open') actions.push('claim');
        if (q.assignedTo === member.uid) {
            if (q.status === 'assigned') actions.push('start');
            if (q.status === 'in_progress') actions.push('acknowledge');
            if (['in_progress', 'acknowledged'].includes(q.status) && session.status === 'waiting_help' && session.activeSupportRequestId === q.id)
                actions.push('resume');
        }
        if (['in_progress', 'acknowledged'].includes(q.status)) actions.push('record');
    }
    return supportRequestSchema.parse({ ...request, context: {
        learnerId: session.learnerId, displayName: learner.displayName, taskId: task.id, taskTitle: task.title,
        releaseId: release.id, stepId, stepIndex, sessionRevision: session.revision, sessionStatus: session.status, actions
    } });
}
