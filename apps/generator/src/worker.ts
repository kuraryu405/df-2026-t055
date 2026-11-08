import { doc, now, type Repository, type Storage, type Doc } from '../../api/src/adapters.ts';
import { media } from '../../api/src/media.ts';
import type { EditedStep } from '../../../packages/shared/src/index.ts';
import { validateProposal, type VideoModel } from './model.ts';
export function createWorker(db: Repository, storage: Storage, model: VideoModel, globalLimit: number) {
    return async function run(jobId: string) {
        let token = '';
        let job = await db.get('generationJobs', jobId);
        if (!job)
            throw Error('JOB_NOT_FOUND');
        if (['succeeded', 'failed'].includes(job.status))
            return;
        const claimed = await db.transaction(async () => {
            job = (await db.get('generationJobs', jobId))!;
            if (['succeeded', 'failed'].includes(job.status) || job.status === 'running' && job.leaseUntil > Date.now())
                return false;
            const jobs = await db.all('generationJobs');
            if (job.attempt >= 3 || job.attempt > 0 && (jobs.reduce((n, j) => n + j.budgetUsed, 0) >= globalLimit || jobs.filter(j => j.taskId === job!.taskId).reduce((n, j) => n + j.budgetUsed, 0) >= 10)) {
                await db.put('generationJobs', { ...job, status: 'failed', errorCode: 'ATTEMPT_LIMIT' });
                const d = (await db.get('drafts', job.draftId))!;
                await db.put('drafts', { ...d, status: 'failed' });
                return false;
            }
            token = crypto.randomUUID();
            job = {
                ...job, status: 'running', attempt: job.attempt + 1, budgetUsed: job.budgetUsed + (job.attempt > 0 ? 1 : 0), leaseUntil: Date.now() + 250000, leaseToken: token
            };
            await db.put('generationJobs', job);
            return true;
        });
        if (!claimed)
            return;
        const started = Date.now();
        let errorCode = 'GENERATION_FAILED';
        try {
            const d = (await db.get('drafts', job.draftId))!, t = (await db.get('tasks', job.taskId))!, v = (await db.get('assets', t.videoAssetId))!, l = (await db.get('learners', d.learnerId))!;
            const controller = new AbortController();
            let timeout: ReturnType<typeof setTimeout> | undefined;
            errorCode = 'MODEL_CALL_FAILED';
            const output = await Promise.race([model.generate({
                    videoUri: v.objectPath, title: t.title, completionCriteria: '帯紙の向き、袋口、テープを見本と比較する', preferences: { sentenceLength: l.preferences.sentenceLength, splitHints: l.preferences.splitHints, audioGuidance: false }, durationMs: v.durationMs
                }, controller.signal), new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => {
                        errorCode = 'MODEL_TIMEOUT';
                        controller.abort();
                        reject(Error('MODEL_TIMEOUT'));
                    }, 120000);
                })]).finally(() => clearTimeout(timeout));
            errorCode = 'MODEL_OUTPUT_INVALID';
            const proposal = validateProposal(output, v.durationMs);
            errorCode = 'GENERATION_FAILED';
            const editedSteps: EditedStep[] = [];
            const assets: Doc[] = [];
            const video = await storage.get(v.objectPath);
            for (const s of proposal.steps) {
                if (Date.now() - started > 230000) {
                    errorCode = 'JOB_TIMEOUT';
                    throw Error('JOB_TIMEOUT');
                }
                errorCode = 'FRAME_EXTRACTION_FAILED';
                const { image } = await media(video, s.frameMs);
                if (!image?.length)
                    throw Error('FRAME_EXTRACTION_FAILED');
                errorCode = 'GENERATION_FAILED';
                const a = doc(d.orgId, {
                    kind: 'image', objectPath: `draft/${d.orgId}/${d.id}/${crypto.randomUUID()}.jpg`, generation: 1, mimeType: 'image/jpeg', sourceVideoId: v.id, frameMs: s.frameMs, draftId: d.id, visibility: 'staff'
                });
                await storage.put(a.objectPath, image);
                assets.push(a);
                editedSteps.push({
                    stepId: s.stepId, text: s.instructionDraft, visibleCaution: '', imageAssetId: a.id, sourceStartMs: s.startMs, sourceEndMs: s.endMs, frameMs: s.frameMs, verifiedObservation: s.observationCandidate, verifiedSpeech: s.speechCandidate, coaching: s.coachingDraft, completionCheck: s.completionCheckDraft
                });
            }
            await db.transaction(async () => {
                const current = (await db.get('generationJobs', jobId))!;
                if (current.leaseToken !== token || current.status !== 'running')
                    return;
                for (const a of assets)
                    await db.put('assets', a);
                await db.put('drafts', {
                    ...d, status: 'editing', revision: 1, aiProposal: proposal, editedSteps, reviewChecks: { presentationConfirmed: false, flagResolution: '', steps: Object.fromEntries(editedSteps.map(s => [s.stepId, { videoVerified: false, photoTextVerified: false }])) }
                });
                await db.put('generationJobs', {
                    ...current, status: 'succeeded', finishedAt: now(), durationMs: Date.now() - started
                });
            });
        }
        catch {
            await db.transaction(async () => {
                const current = (await db.get('generationJobs', jobId))!;
                if (current.leaseToken !== token || current.status !== 'running')
                    return;
                await db.put('generationJobs', {
                    ...current, status: 'failed', errorCode, finishedAt: now(), durationMs: Date.now() - started
                });
                const d = (await db.get('drafts', current.draftId))!;
                await db.put('drafts', { ...d, status: 'failed' });
            });
        }
    };
}
