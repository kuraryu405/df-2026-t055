export function isManualDraft(draft: { sourceReleaseId?: string; jobId?: string }): boolean {
    return !!draft.sourceReleaseId && !draft.jobId;
}

type ReleaseSummary = { title: string; version: number };
type ReleaseApproval = { approvedBy: string; approvedAt: string };
export function releaseCopySource(summary: ReleaseSummary, approval: ReleaseApproval): string {
    return `コピー元の承認版：${summary.title} / 版 ${summary.version} / 承認者 ${approval.approvedBy} / ${new Date(approval.approvedAt).toLocaleString('ja-JP')}`;
}

export type ReleaseCopyState = { requestId?: string; sending: boolean };
export function beginReleaseCopy(state: ReleaseCopyState): string | undefined {
    if (state.sending) return;
    state.requestId ??= crypto.randomUUID();
    state.sending = true;
    return state.requestId;
}
