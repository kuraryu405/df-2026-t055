import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorage, MemoryRepository, doc, seed } from '../apps/api/src/adapters.ts';
import { createWorker } from '../apps/generator/src/worker.ts';
import type { VideoModel } from '../apps/generator/src/model.ts';

const proposal = {
    schemaVersion: '1', reviewFlags: [], steps: [{
        stepId: 's1', startMs: 0, frameMs: 200, endMs: 500,
        observationCandidate: '合成動画の候補', speechCandidate: '確認します',
        instructionDraft: '確認します', coachingDraft: '', completionCheckDraft: '', reviewFlags: []
    }]
};
const validModel: VideoModel = { generate: async () => structuredClone(proposal) };
let root: string;
let video: Buffer;
before(async () => {
    root = await mkdtemp(join(tmpdir(), 't055-worker-'));
    const path = join(root, 'fixture.mp4');
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', path]);
    video = await readFile(path);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function harness(model: VideoModel, bytes = video) {
    const db = new MemoryRepository();
    seed(db);
    const storage = new LocalStorage(join(root, crypto.randomUUID()));
    await storage.put('source/video.mp4', bytes);
    db.put('assets', doc('demo', { id: 'video', kind: 'video', objectPath: 'source/video.mp4', durationMs: 10000 }));
    db.put('tasks', doc('demo', { id: 'task', title: '合成動画', videoAssetId: 'video' }));
    db.put('drafts', doc('demo', { id: 'draft', taskId: 'task', learnerId: 'a', status: 'generating', revision: 0, editedSteps: [] }));
    db.put('generationJobs', doc('demo', { id: 'job', taskId: 'task', draftId: 'draft', status: 'queued', attempt: 0, budgetUsed: 1 }));
    return { db, storage, run: () => createWorker(db, storage, model, 30)('job') };
}
function assertFailed(db: MemoryRepository, errorCode: string) {
    const job = db.get('generationJobs', 'job')!;
    assert.equal(job.status, 'failed');
    assert.equal(job.errorCode, errorCode);
    assert.equal(job.attempt, 1);
    assert.equal(job.budgetUsed, 1);
    const draft = db.get('drafts', 'draft')!;
    assert.equal(draft.status, 'failed');
    assert.equal(draft.revision, 0);
    assert.deepEqual(draft.editedSteps, []);
    assert.equal(draft.aiProposal, undefined);
    assert.deepEqual(db.all('assets').map(a => a.id), ['video']);
}

for (const [reason, output] of [
    ['形式不正', {}],
    ['時刻の逆転', { ...proposal, steps: [{ ...proposal.steps[0], startMs: 400 }] }]
] as const) {
    test(`不正なAI出力をMODEL_OUTPUT_INVALIDとして保存する (${reason})`, async () => {
        const h = await harness({ generate: async () => output });
        await h.run();
        assertFailed(h.db, 'MODEL_OUTPUT_INVALID');
    });
}
test('モデルの例外をMODEL_CALL_FAILEDとして保存する', async () => {
    const h = await harness({ generate: async () => { throw Error('provider unavailable'); } });
    await h.run();
    assertFailed(h.db, 'MODEL_CALL_FAILED');
});
test('壊れた動画をFRAME_EXTRACTION_FAILEDとして保存する', async () => {
    const h = await harness(validModel, Buffer.from('not a video'));
    await h.run();
    assertFailed(h.db, 'FRAME_EXTRACTION_FAILED');
});
test('一枚保存した後の切り出し失敗でも資産メタデータは保存しない', async t => {
    const output = { ...proposal, steps: [...proposal.steps, { ...proposal.steps[0], stepId: 's2', startMs: 2000, frameMs: 2200, endMs: 2500 }] };
    const h = await harness({ generate: async () => output });
    const put = t.mock.method(h.storage, 'put');
    await h.run();
    assert.equal(put.mock.callCount(), 1);
    assert.ok((await h.storage.get(put.mock.calls[0].arguments[0])).length > 0);
    assertFailed(h.db, 'FRAME_EXTRACTION_FAILED');
});
test('Storageの失敗はGENERATION_FAILEDとして保存する', async t => {
    const h = await harness(validModel);
    t.mock.method(h.storage, 'put', async () => { throw Error('storage unavailable'); });
    await h.run();
    assertFailed(h.db, 'GENERATION_FAILED');
});
test('モデルの時間切れをMODEL_TIMEOUTとして保存し中断する', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal: AbortSignal | undefined;
    let called!: () => void;
    const ready = new Promise<void>(resolve => { called = resolve; });
    const h = await harness({ generate: async (_, s) => {
        signal = s;
        called();
        return new Promise((_, reject) => s!.addEventListener('abort', () => reject(Error('aborted'))));
    } });
    const running = h.run();
    await ready;
    t.mock.timers.tick(120000);
    await running;
    assert.equal(signal?.aborted, true);
    assertFailed(h.db, 'MODEL_TIMEOUT');
});
test('ジョブの時間切れをJOB_TIMEOUTとして保存する', async t => {
    const h = await harness({ generate: async () => {
        const timestamp = Date.now();
        t.mock.method(Date, 'now', () => timestamp + 230001);
        return proposal;
    } });
    await h.run();
    assertFailed(h.db, 'JOB_TIMEOUT');
});
test('正常な生成は成功して下書きを編集可能にする', async () => {
    const h = await harness(validModel);
    await h.run();
    const job = h.db.get('generationJobs', 'job')!;
    assert.equal(job.status, 'succeeded');
    assert.equal(job.errorCode, undefined);
    assert.equal(job.attempt, 1);
    assert.equal(job.budgetUsed, 1);
    assert.equal(h.db.get('drafts', 'draft')!.status, 'editing');
    assert.equal(h.db.all('assets').filter(a => a.kind === 'image').length, 1);
});
