import { learnerProfileCreateRequestSchema } from '../../../packages/shared/src/learner-profile.ts';

export const emptyLearnerForm = {
    displayName: '', learnerWishes: '', staffObservations: '', staffSuggestions: '',
    displayMode: '', sentenceLength: '', audioGuidance: '', splitHints: '',
    disabilityDetail: '', disabilitySource: '', disabilityConfirmedAt: '',
};
export type LearnerForm = typeof emptyLearnerForm;
export function buildLearnerProfile(form: LearnerForm) {
    const body: Record<string, unknown> = { displayName: form.displayName };
    for (const key of ['learnerWishes', 'staffObservations', 'staffSuggestions'] as const) {
        const notes = form[key].split('\n').map(line => line.trim()).filter(Boolean);
        if (notes.length) body[key] = notes;
    }
    const preferences: Record<string, unknown> = {};
    if (form.displayMode) preferences.displayMode = form.displayMode;
    if (form.sentenceLength) preferences.sentenceLength = Number(form.sentenceLength);
    if (form.audioGuidance) preferences.audioGuidance = form.audioGuidance === 'true';
    if (form.splitHints.trim()) preferences.splitHints = form.splitHints.trim();
    if (Object.keys(preferences).length) body.preferences = preferences;
    if (form.disabilityDetail || form.disabilitySource || form.disabilityConfirmedAt) {
        const date = new Date(form.disabilityConfirmedAt);
        body.disabilityInfo = { detail: form.disabilityDetail, source: form.disabilitySource,
            confirmedAt: Number.isNaN(date.getTime()) ? '' : date.toISOString() };
    }
    const result = learnerProfileCreateRequestSchema.safeParse(body);
    if (!result.success) {
        const labels: Record<string, string> = { displayName: '表示名（1〜100文字）', learnerWishes: '本人希望（1件500文字、20件まで）', staffObservations: '職員による観察（1件500文字、20件まで）', staffSuggestions: '職員による提案（1件500文字、20件まで）', sentenceLength: '短文の長さ（1〜40の整数）', splitHints: '表示のヒント（200文字以内）', disabilityInfo: '障害に関する情報（詳細・出典・有効な確認日時のすべてが必要）' };
        throw Error('入力を確認してください：' + [...new Set(result.error.issues.map(issue => labels[String(issue.path[0] === 'preferences' ? issue.path[1] : issue.path[0])] ?? '希望する表示・音声ガイド'))].join('、'));
    }
    return result.data;
}
