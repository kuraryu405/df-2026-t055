import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorage, MemoryRepository, doc, seed } from '../apps/api/src/adapters.ts';
import { media } from '../apps/api/src/media.ts';
import { createWorker } from '../apps/generator/src/worker.ts';
import type { VideoModel } from '../apps/generator/src/model.ts';
import type { EditedStep } from '../packages/shared/src/index.ts';

function proposal(times: number[]) {
    return {
        schemaVersion: '1', reviewFlags: [], steps: times.map((frameMs, i) => ({
            stepId: `s${i + 1}`, startMs: frameMs - 100, frameMs, endMs: frameMs + 100,
            observationCandidate: '合成動画の候補', speechCandidate: '確認します',
            instructionDraft: '確認します', coachingDraft: '', completionCheckDraft: '', reviewFlags: []
        }))
    };
}

let root: string;
let video: Buffer;
before(async () => {
    root = await mkdtemp(join(tmpdir(), 't055-candidate-photos-'));
    const path = join(root, 'fixture.mp4');
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', path]);
    video = await readFile(path);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function harness(model: VideoModel, durationMs = 1000) {
    const db = new MemoryRepository();
    seed(db);
    const storage = new LocalStorage(join(root, crypto.randomUUID()));
    await storage.put('source/video.mp4', video);
    db.put('assets', doc('demo', { id: 'video', kind: 'video', objectPath: 'source/video.mp4', durationMs }));
    db.put('tasks', doc('demo', { id: 'task', title: '合成動画', videoAssetId: 'video' }));
    db.put('drafts', doc('demo', { id: 'draft', taskId: 'task', learnerId: 'a', status: 'generating', revision: 0, editedSteps: [] }));
    db.put('generationJobs', doc('demo', { id: 'job', taskId: 'task', draftId: 'draft', status: 'queued', attempt: 0, budgetUsed: 1 }));
    return { db, storage, run: () => createWorker(db, storage, model, 30)('job') };
}

test('各工程が原動画の代表時刻から抽出したJPEG資産を参照する', async () => {
    const output = proposal([200, 700]);
    const h = await harness({ generate: async () => output });
    await h.run();
    assert.equal(h.db.get('generationJobs', 'job')!.status, 'succeeded');
    const draft = h.db.get('drafts', 'draft')!;
    assert.equal(draft.status, 'editing');
    assert.deepEqual(draft.aiProposal, output);
    assert.equal(draft.editedSteps.length, output.steps.length);
    const images = h.db.all('assets').filter(a => a.kind === 'image');
    assert.equal(images.length, output.steps.length);
    assert.equal(new Set(draft.editedSteps.map((s: EditedStep) => s.imageAssetId)).size, output.steps.length);
    for (const [i, candidate] of output.steps.entries()) {
        const step = draft.editedSteps[i];
        assert.equal(step.stepId, candidate.stepId);
        assert.equal(step.frameMs, candidate.frameMs);
        const asset = h.db.get('assets', step.imageAssetId)!;
        assert.equal(asset.kind, 'image');
        assert.equal(asset.sourceVideoId, h.db.get('tasks', 'task')!.videoAssetId);
        assert.equal(asset.frameMs, candidate.frameMs);
        assert.equal(asset.draftId, draft.id);
        assert.equal(asset.visibility, 'staff');
        assert.equal(asset.mimeType, 'image/jpeg');
        const bytes = await h.storage.get(asset.objectPath);
        assert.deepEqual(bytes.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
        assert.deepEqual(bytes.subarray(-2), Buffer.from([0xff, 0xd9]));
        assert.deepEqual(bytes, (await media(video, candidate.frameMs)).image);
    }
});

test('途中の切り出し失敗後にリース回復しても前の試行の候補資産が混ざらない', async t => {
    let calls = 0;
    const retryOutput = proposal([300, 800]);
    const h = await harness({ generate: async () => ++calls === 1 ? proposal([200, 2200]) : retryOutput }, 10000);
    const put = t.mock.method(h.storage, 'put');
    await h.run();
    const failed = h.db.get('generationJobs', 'job')!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'FRAME_EXTRACTION_FAILED');
    assert.equal(put.mock.callCount(), 1);
    const failedPath = put.mock.calls[0].arguments[0];
    assert.ok((await h.storage.get(failedPath)).length > 0);
    assert.deepEqual(h.db.all('assets').map(a => a.id), ['video']);
    assert.deepEqual(h.db.get('drafts', 'draft')!.editedSteps, []);

    // 終端のfailedは再配送されないため、リース切れで回復する実行中状態を再現する。
    const { errorCode, finishedAt, ...recoverable } = failed;
    h.db.put('generationJobs', { ...recoverable, status: 'running', leaseUntil: 0 });
    h.db.put('drafts', { ...h.db.get('drafts', 'draft')!, status: 'generating' });
    await h.run();

    const job = h.db.get('generationJobs', 'job')!;
    assert.equal(job.status, 'succeeded');
    assert.equal(job.attempt, 2);
    assert.equal(calls, 2);
    assert.equal(put.mock.callCount(), 3);
    const retryPaths = put.mock.calls.slice(1).map(c => c.arguments[0]);
    assert.ok(!retryPaths.includes(failedPath));
    const images = h.db.all('assets').filter(a => a.kind === 'image');
    assert.equal(images.length, 2);
    assert.deepEqual(images.map(a => a.objectPath).sort(), [...retryPaths].sort());
    const draft = h.db.get('drafts', 'draft')!;
    assert.equal(draft.status, 'editing');
    assert.deepEqual(draft.aiProposal, retryOutput);
    assert.deepEqual(draft.editedSteps.map((s: EditedStep) => s.imageAssetId).sort(), images.map(a => a.id).sort());
    for (const [i, step] of draft.editedSteps.entries()) {
        const asset = h.db.get('assets', step.imageAssetId)!;
        assert.equal(asset.sourceVideoId, 'video');
        assert.equal(asset.frameMs, retryOutput.steps[i].frameMs);
        assert.equal(step.frameMs, retryOutput.steps[i].frameMs);
        assert.equal(asset.objectPath, retryPaths[i]);
    }
});
