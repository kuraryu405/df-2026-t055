import { learnerProfileCreateRequestSchema, learnerProfileUpdateRequestSchema, type LearnerProfileDetail } from '../../../packages/shared/src/learner-profile.ts';

export const noteKeys = ['learnerWishes', 'staffObservations', 'staffSuggestions', 'confirmedGuidance'] as const;
export type NoteKey = (typeof noteKeys)[number];

export const emptyLearnerForm = {
    confirmedGuidance: [] as string[], disabilityAction: 'keep', displayName: '', learnerWishes: [] as string[], staffObservations: [] as string[], staffSuggestions: [] as string[],
    displayMode: '', sentenceLength: '', audioGuidance: '', splitHints: '',
    disabilityDetail: '', disabilitySource: '', disabilityConfirmedAt: '',
};
export type LearnerForm = typeof emptyLearnerForm;
export function buildLearnerProfile(form: LearnerForm) {
    const body: Record<string, unknown> = { displayName: form.displayName };
    for (const key of noteKeys) {
        const notes = form[key].map(line => line.trim()).filter(Boolean);
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
        const labels: Record<string, string> = { displayName: '表示名（1〜100文字）', learnerWishes: '本人希望（1件500文字、20件まで）', staffObservations: '職員による観察（1件500文字、20件まで）', confirmedGuidance: '確認済みの配慮（1件500文字、20件まで）', staffSuggestions: '職員による提案（1件500文字、20件まで）', sentenceLength: '短文の長さ（1〜40の整数）', splitHints: '表示のヒント（200文字以内）', disabilityInfo: '障害に関する情報（詳細・出典・有効な確認日時のすべてが必要）' };
        throw Error('入力を確認してください：' + [...new Set(result.error.issues.map(issue => labels[String(issue.path[0] === 'preferences' ? issue.path[1] : issue.path[0])] ?? '希望する表示・音声ガイド'))].join('、'));
    }
    return result.data;
}

export function learnerProfileToForm(profile: LearnerProfileDetail): LearnerForm {
    const form = { ...emptyLearnerForm, displayName: profile.displayName };
    for (const key of noteKeys)
        form[key] = profile[key] ? [...profile[key]] : [];
    const p = profile.preferences;
    form.displayMode = p.displayMode ?? '';
    form.sentenceLength = p.sentenceLength === undefined ? '' : String(p.sentenceLength);
    form.audioGuidance = p.audioGuidance === undefined ? '' : String(p.audioGuidance);
    form.splitHints = p.splitHints ?? '';
    if (profile.disabilityInfo) {
        form.disabilityDetail = profile.disabilityInfo.detail;
        form.disabilitySource = profile.disabilityInfo.source;
        const date = new Date(profile.disabilityInfo.confirmedAt);
        form.disabilityConfirmedAt = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
    }
    return form;
}
export function buildLearnerProfileUpdate(form: LearnerForm, expectedRevision: number) {
    if (form.disabilityAction === 'replace' && !form.disabilityDetail.trim()) throw Error('障害に関する情報の詳細・出典・確認日時を入力してください');
    const body = buildLearnerProfile(form.disabilityAction === 'replace' ? form : {
        ...form, disabilityDetail: '', disabilitySource: '', disabilityConfirmedAt: '',
    });
    return learnerProfileUpdateRequestSchema.parse({ ...body, expectedRevision,
        preferences: body.preferences ?? {},
        ...Object.fromEntries(noteKeys.map(key => [key, body[key as keyof typeof body] ?? []])),
        ...(form.disabilityAction === 'delete' ? { disabilityInfo: null } : {}),
    });
}
