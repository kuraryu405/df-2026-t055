import { draftUpdateResponseSchema, type EditedStep, type ReviewChecks } from '../../../packages/shared/src/index.ts';

export function missingDraftChecks(steps: EditedStep[], checks: ReviewChecks, flagsRequired: boolean) {
    const missing: string[] = [];
    if (!checks.presentationConfirmed) missing.push('本人への提示内容確認');
    steps.forEach((s, i) => {
        if (!checks.steps[s.stepId]?.videoVerified) missing.push(`工程 ${i + 1}：動画照合`);
        if (!checks.steps[s.stepId]?.photoTextVerified) missing.push(`工程 ${i + 1}：写真・説明確認`);
    });
    if (flagsRequired && !checks.flagResolution.trim()) missing.push('確認が必要な点への対応記録');
    return missing;
}
export function draftPreviewMode(mode?: 'photo_only' | 'photo_text') {
    return mode ?? 'photo_text';
}
export function savedDraftReview(result: unknown) {
    const { revision, reviewChecks } = draftUpdateResponseSchema.parse(result);
    return { revision, reviewChecks };
}
