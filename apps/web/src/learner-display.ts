import type { FixedLearnerSessionDTO, LearnerSessionDTO } from '../../../packages/shared/src/index.ts';

export type LearnerDisplaySession = FixedLearnerSessionDTO | LearnerSessionDTO;

export function learnerStepPresentation(session: LearnerDisplaySession) {
    const step = session.steps[session.stepIndex];
    const caption = !('displayMode' in session) || session.displayMode === 'photo_text'
        ? session.steps[session.stepIndex] : undefined;
    return {
        imageAssetId: step.imageAssetId,
        imageAltText: 'imageAltText' in step ? step.imageAltText : step.text,
        text: caption?.text,
        visibleCaution: caption?.visibleCaution,
        audioAssetId: step.audioAssetId
    };
}
