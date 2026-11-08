import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTtsAdapter } from '../apps/api/src/tts.ts';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, type Storage } from '../apps/api/src/adapters.ts';
import { createWorker } from '../apps/generator/src/worker.ts';
import { FakeModel } from '../apps/generator/src/model.ts';
class TestStorage implements Storage {
    data = new Map<string, Buffer>();
    async put(p: string, b: Buffer) {
        this.data.set(p, Buffer.from(b));
    }
    async get(p: string) {
        const b = this.data.get(p);
        if (!b)
            throw Error('NOT_FOUND');
        return Buffer.from(b);
    }
    async open(p: string) {
        return new Response(new Uint8Array(await this.get(p))).body!;
    }
    async copy(a: string, b: string) {
        await this.put(b, await this.get(a));
    }
}
let video: Buffer;
before(async () => {
    const dir = await mkdtemp(join(tmpdir(), 't055-test-'));
    try {
        const p = join(dir, 'fixture.mp4');
        await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', p]);
        video = await readFile(p);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
async function harness() {
    const db = new MemoryRepository();
    seed(db);
    const storage = new TestStorage();
    const run = createWorker(db, storage, new FakeModel(), 30);
    const { app } = createApp({ db, storage, tts: new FakeTtsAdapter(), globalLimit: 30 });
    const base = 'http://localhost/api/v1';
    async function request(path: string, method = 'GET', body?: unknown, token = 'staff') {
        const r = await app.fetch(new Request(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) }));
        const bytes = Buffer.from(await r.arrayBuffer());
        let data: any;
        try {
            data = JSON.parse(bytes.toString());
        }
        catch {
            data = bytes;
        }
        return { status: r.status, data, headers: r.headers };
    }
    async function ok(path: string, method = 'GET', body?: unknown, token = 'staff') {
        const r = await request(path, method, body, token);
        assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
        return r.data;
    }
    async function task() {
        const { taskId } = await ok('/tasks', 'POST', { title: 'タオル折り' });
        const form = new FormData();
        form.append('video', new Blob([new Uint8Array(video)], { type: 'video/mp4' }), 'fixture.mp4');
        const { assetId } = await ok(`/tasks/${taskId}/video`, 'POST', form);
        return { taskId, assetId };
    }
    async function generate(taskId: string, learnerId = 'a') {
        const g = await ok(`/tasks/${taskId}/generations`, 'POST', { learnerId });
        await run(g.jobId);
        return { ...g, draft: (await ok(`/drafts/${g.draftId}`)).draft };
    }
    async function approve(draft: any, key = 'approval-one') {
        const reviewChecks = { presentationConfirmed: true, flagResolution: '全候補を動画と照合して修正した', steps: Object.fromEntries(draft.editedSteps.map((s: any) => [s.stepId, { videoVerified: true, photoTextVerified: true }])) };
        const { revision } = await ok(`/drafts/${draft.id}`, 'PATCH', { expectedRevision: draft.revision, editedSteps: draft.editedSteps, reviewChecks });
        const payload = { expectedRevision: revision, approvalRequestId: key };
        const release = await ok(`/drafts/${draft.id}/approve`, 'POST', payload);
        return { ...release, payload, revision };
    }
    return { db, ok, task, generate, approve, run };
}

test('生成時の確認済み提示設定はプロフィール変更後も固定される', async () => {
    const h = await harness();
    await h.ok('/learners/a', 'PATCH', { expectedRevision: 1, preferences: { sentenceLength: 40, splitHints: '9工程', displayMode: 'photo_only', audioGuidance: true } });
    const { taskId } = await h.task();
    const g = await h.ok(`/tasks/${taskId}/generations`, 'POST', { learnerId: 'a' });
    const initial = h.db.get('drafts', g.draftId)!;
    assert.equal(initial.displayMode, 'photo_only');
    assert.equal(initial.audioGuidance, true);
    await h.ok('/learners/a', 'PATCH', { expectedRevision: 2, preferences: { sentenceLength: 40, splitHints: '9工程', displayMode: 'photo_text', audioGuidance: false } });
    await h.run(g.jobId);
    const { draft } = await h.ok(`/drafts/${g.draftId}`);
    assert.equal(draft.status, 'editing');
    assert.equal(draft.displayMode, 'photo_only');
    assert.equal(draft.audioGuidance, true);
    await h.approve(draft);
    assert.equal(h.db.all('assets').filter(a => a.kind === 'audio').length, draft.editedSteps.length);
});

test('未確認の提示設定は写真と短文・音声なしで初期化する', async () => {
    const h = await harness();
    await h.ok('/learners/a', 'PATCH', { expectedRevision: 1, preferences: { sentenceLength: 40, splitHints: '9工程' } });
    const { taskId } = await h.task();
    const { draft } = await h.generate(taskId);
    assert.equal(draft.status, 'editing');
    assert.equal(draft.displayMode, 'photo_text');
    assert.equal(draft.audioGuidance, false);
});

test('PATCHは提示設定・採用記録・修正理由・代替テキストを保存し、省略時は保持する', async () => {
    const h = await harness();
    const { taskId } = await h.task();
    const { draft } = await h.generate(taskId);
    draft.editedSteps[0].imageAltText = 'タオルの端を両手でそろえている';
    const settings = { displayMode: 'photo_only', audioGuidance: true, appliedSupportRecordRefs: [{ recordId: 'fictional-record', revision: 2 }], correctionReason: '写真を中心に確認する' };
    const payload = { expectedRevision: draft.revision, editedSteps: draft.editedSteps, reviewChecks: draft.reviewChecks };
    const response = await h.ok(`/drafts/${draft.id}`, 'PATCH', { ...payload, ...settings });
    assert.deepEqual(response, { schemaVersion: '1', revision: 2, reviewChecks: draft.reviewChecks });
    const saved = (await h.ok(`/drafts/${draft.id}`)).draft;
    for (const [key, value] of Object.entries(settings)) assert.deepEqual(saved[key], value);
    assert.deepEqual(saved.editedSteps, draft.editedSteps);
    await h.ok(`/drafts/${draft.id}`, 'PATCH', { ...payload, expectedRevision: 2 });
    const kept = (await h.ok(`/drafts/${draft.id}`)).draft;
    for (const [key, value] of Object.entries(settings)) assert.deepEqual(kept[key], value);
    await h.ok(`/drafts/${draft.id}`, 'PATCH', { ...payload, expectedRevision: 3, displayMode: 'photo_text', audioGuidance: false, appliedSupportRecordRefs: [], correctionReason: '' });
    const cleared = (await h.ok(`/drafts/${draft.id}`)).draft;
    assert.equal(cleared.displayMode, 'photo_text');
    assert.equal(cleared.audioGuidance, false);
    assert.deepEqual(cleared.appliedSupportRecordRefs, []);
    assert.equal(cleared.correctionReason, '');
});

test('下書きの音声なし設定はプロフィールの音声ありより優先する', async () => {
    const h = await harness();
    const { taskId } = await h.task();
    const { draft } = await h.generate(taskId, 'b');
    assert.equal(draft.audioGuidance, true);
    const { revision } = await h.ok(`/drafts/${draft.id}`, 'PATCH', { expectedRevision: draft.revision, editedSteps: draft.editedSteps, reviewChecks: draft.reviewChecks, audioGuidance: false });
    assert.equal(h.db.get('learners', 'b')!.preferences.audioGuidance, true);
    await h.approve({ ...draft, revision });
    assert.equal(h.db.all('assets').filter(a => a.kind === 'audio').length, 0);
    assert.ok(h.db.all('releases')[0].learnerSteps.every((s: any) => !('audioAssetId' in s)));
});

for (const learnerId of ['a', 'b']) test(`旧下書きは旧PATCHを受理しプロフィールの音声設定で承認する (${learnerId})`, async () => {
    const h = await harness();
    const { taskId } = await h.task();
    const { draft } = await h.generate(taskId, learnerId);
    delete draft.displayMode;
    delete draft.audioGuidance;
    assert.ok(draft.editedSteps.every((s: any) => !('imageAltText' in s)));
    h.db.put('drafts', draft);
    await h.approve(draft);
    const saved = (await h.ok(`/drafts/${draft.id}`)).draft;
    assert.equal(saved.status, 'approved');
    assert.ok(!('displayMode' in saved));
    assert.ok(!('audioGuidance' in saved));
    assert.equal(h.db.all('assets').filter(a => a.kind === 'audio').length, learnerId === 'b' ? draft.editedSteps.length : 0);
});
