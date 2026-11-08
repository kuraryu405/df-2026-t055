import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTtsAdapter, configuredTts, VertexTtsAdapter, type TtsAdapter } from '../apps/api/src/tts.ts';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, doc, type Storage, type Repository } from '../apps/api/src/adapters.ts';
import { createWorker } from '../apps/generator/src/worker.ts';
import { FakeModel, type VideoModel } from '../apps/generator/src/model.ts';
import { hold, readSafety, delivered, flushSafety, type Store } from '../apps/web/src/safety.ts';
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
async function harness(limit = 30, model: VideoModel = new FakeModel(), asyncAdapter = false, tts: TtsAdapter = new FakeTtsAdapter()) {
    const db = new MemoryRepository();
    seed(db);
    const storage = new TestStorage();
    const repository: Repository = asyncAdapter ? {
        all: async (c) => db.all(c), get: async (c, id) => db.get(c, id), put: async (c, d) => db.put(c, d), transaction: fn => db.transaction(fn)
    } : db;
    const run = createWorker(repository, storage, model, limit);
    const { app } = createApp({
        db: repository, storage, tts, globalLimit: limit, internalToken: 'test-internal', runJob: run
    });
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
    async function assign(taskId: string, releaseId: string, learnerId = 'a') {
        return ok(`/assignments/${learnerId}/${taskId}`, 'PUT', { releaseId });
    }
    async function session(taskId: string, token = 'learner-a') {
        return ok('/me/sessions', 'POST', { taskId, clientRequestId: crypto.randomUUID() }, token);
    }
    return {
        app, db, storage, run, request, ok, task, generate, approve, assign, session, close: async () => {
        }
    };
}
test('本人・新人の下書き境界、本人の原動画／下書き画像拒否と別本人・別組織の拒否', async () => {
    const h = await harness();
    try {
        const { taskId, assetId } = await h.task();
        const { draft } = await h.generate(taskId);
        assert.equal((await h.request(`/drafts/${draft.id}`, 'GET', undefined, 'learner-a')).status, 403);
        assert.equal((await h.request(`/drafts/${draft.id}`, 'GET', undefined, 'newcomer')).status, 403);
        assert.equal((await h.request(`/assets/${assetId}`, 'GET', undefined, 'learner-a')).status, 403);
        assert.equal((await h.request(`/assets/${draft.editedSteps[0].imageAssetId}`, 'GET', undefined, 'learner-a')).status, 403);
        const r = await h.approve(draft);
        await h.assign(taskId, r.releaseId);
        const s = await h.session(taskId);
        assert.equal((await h.request(`/me/sessions/${s.sessionId}`, 'GET', undefined, 'learner-b')).status, 403);
        assert.equal((await h.request(`/assets/${s.steps[0].imageAssetId}`, 'GET', undefined, 'learner-b')).status, 403);
        assert.equal((await h.request(`/handover/releases/${r.releaseId}`, 'GET', undefined, 'learner-a')).status, 403);
        assert.equal((await h.request(`/handover/releases/${r.releaseId}`, 'GET', undefined, 'other-staff')).status, 403);
        assert.equal((await h.request(`/assets/${s.steps[0].imageAssetId}`, 'GET', undefined, 'other-staff')).status, 403);
        assert.equal((await h.request(`/assignments/b/${taskId}`, 'PUT', { releaseId: r.releaseId })).status, 403);
        assert.equal((await h.request(`/me/sessions/${s.sessionId}`, 'GET', undefined, 'learner-a')).headers.get('cache-control'), 'no-store');
        const json = JSON.stringify(s);
        for (const forbidden of ['staffGuide', 'draftId', 'sourceDraftId', 'objectPath', 'aiProposal', 'coaching'])
            assert.ok(!json.includes(forbidden));
        assert.deepEqual(Object.keys(s.steps[0]).sort(), ['imageAssetId', 'order', 'stepId', 'text', 'visibleCaution']);
        assert.equal((await h.request(`/assets/${s.steps[0].imageAssetId}`, 'GET', undefined, 'learner-a')).status, 200);
    }
    finally {
        await h.close();
    }
});
test('承認は確認必須・二重送信は1版だけ・古いrevisionは409・承認版更新APIなし', async () => {
    const h = await harness();
    try {
        const { taskId } = await h.task();
        const { draft } = await h.generate(taskId);
        assert.equal((await h.request(`/drafts/${draft.id}/approve`, 'POST', { expectedRevision: 1, approvalRequestId: 'unchecked' })).status, 422);
        const r = await h.approve(draft);
        const both = await Promise.all([h.ok(`/drafts/${draft.id}/approve`, 'POST', r.payload), h.ok(`/drafts/${draft.id}/approve`, 'POST', r.payload)]);
        assert.equal(both[0].releaseId, r.releaseId);
        assert.equal(both[1].releaseId, r.releaseId);
        assert.equal(h.db.all('releases').length, 1);
        assert.equal((await h.request(`/drafts/${draft.id}/approve`, 'POST', { expectedRevision: 1, approvalRequestId: 'different' })).status, 409);
        assert.equal((await h.request(`/drafts/${draft.id}`, 'PATCH', { expectedRevision: 1, editedSteps: draft.editedSteps, reviewChecks: draft.reviewChecks })).status, 409);
        assert.equal((await h.request(`/releases/${r.releaseId}`, 'PATCH', { text: '書換' })).status, 404);
        const rdoc = h.db.get('releases', r.releaseId)!;
        assert.ok(rdoc.contentHash);
        assert.notEqual(rdoc.learnerSteps[0].imageAssetId, draft.editedSteps[0].imageAssetId);
    }
    finally {
        await h.close();
    }
});
test('同時承認も同一冪等キーなら1版・別キーなら409', async () => {
    const h = await harness();
    try {
        const { taskId } = await h.task();
        const { draft } = await h.generate(taskId);
        const reviewChecks = { presentationConfirmed: true, flagResolution: '確認済み', steps: Object.fromEntries(draft.editedSteps.map((s: any) => [s.stepId, { videoVerified: true, photoTextVerified: true }])) };
        const { revision } = await h.ok(`/drafts/${draft.id}`, 'PATCH', { expectedRevision: 1, editedSteps: draft.editedSteps, reviewChecks });
        const payload = { expectedRevision: revision, approvalRequestId: 'same' };
        const results = await Promise.all([h.request(`/drafts/${draft.id}/approve`, 'POST', payload), h.request(`/drafts/${draft.id}/approve`, 'POST', payload), h.request(`/drafts/${draft.id}/approve`, 'POST', { ...payload, approvalRequestId: 'other' })]);
        assert.equal(results[0].status, 200);
        assert.equal(results[1].status, 200);
        assert.equal(results[2].status, 409);
        assert.equal(results[0].data.releaseId, results[1].data.releaseId);
        assert.equal(h.db.all('releases').length, 1);
    }
    finally {
        await h.close();
    }
});
test('再生成と新版の割当で本人の固定セッションは変化しない・A9工程 B11工程', async () => {
    const h = await harness();
    try {
        const { taskId } = await h.task();
        const first = await h.generate(taskId);
        assert.equal(first.draft.editedSteps.length, 9);
        const r = await h.approve(first.draft);
        await h.assign(taskId, r.releaseId);
        const s = await h.session(taskId);
        const before = await h.ok('/me/assignments', 'GET', undefined, 'learner-a');
        const second = await h.generate(taskId);
        assert.deepEqual(await h.ok('/me/assignments', 'GET', undefined, 'learner-a'), before);
        assert.deepEqual(await h.ok(`/me/sessions/${s.sessionId}`, 'GET', undefined, 'learner-a'), s);
        second.draft.editedSteps[0].text = '新しい説明';
        const newer = await h.approve(second.draft, 'approval-two');
        await h.assign(taskId, newer.releaseId);
        assert.deepEqual(await h.ok(`/me/sessions/${s.sessionId}`, 'GET', undefined, 'learner-a'), s);
        const newSession = await h.session(taskId);
        assert.equal(newSession.steps[0].text, '新しい説明');
        assert.equal((await h.request(`/assets/${s.steps[0].imageAssetId}`, 'GET', undefined, 'learner-a')).status, 200);
        const b = await h.generate(taskId, 'b');
        assert.equal(b.draft.editedSteps.length, 11);
    }
    finally {
        await h.close();
    }
});
test('stopが競合に勝ち、next/resume再送でも再開しない・complete後もstop記録', async () => {
    const h = await harness();
    try {
        const { taskId } = await h.task();
        const { draft } = await h.generate(taskId);
        const r = await h.approve(draft);
        await h.assign(taskId, r.releaseId);
        const s = await h.session(taskId);
        const next = { clientEventId: 'next', expectedRevision: 0, type: 'next' };
        assert.equal((await h.request(`/me/sessions/${s.sessionId}/events`, 'POST', next, 'learner-a')).status, 200);
        await h.ok(`/me/sessions/${s.sessionId}/events`, 'POST', { clientEventId: 'stop', expectedRevision: 0, type: 'stop' }, 'learner-a');
        for (const type of ['next', 'resume'])
            assert.equal((await h.request(`/me/sessions/${s.sessionId}/events`, 'POST', { clientEventId: type, expectedRevision: 0, type }, 'learner-a')).status, 409);
        const stopped = await h.ok(`/me/sessions/${s.sessionId}`, 'GET', undefined, 'learner-a');
        assert.equal(stopped.status, 'stopped');
        await h.ok(`/me/sessions/${s.sessionId}/events`, 'POST', { clientEventId: 'stop', expectedRevision: 0, type: 'stop' }, 'learner-a');
        assert.equal(h.db.all('sessionEvents').filter(e => e.type === 'stop').length, 1);
        const fresh = await h.session(taskId);
        for (let i = 0; i < fresh.steps.length - 1; i++)
            await h.ok(`/me/sessions/${fresh.sessionId}/events`, 'POST', { clientEventId: `n${i}`, expectedRevision: i, type: 'next' }, 'learner-a');
        await h.ok(`/me/sessions/${fresh.sessionId}/events`, 'POST', { clientEventId: 'complete', expectedRevision: 8, type: 'complete' }, 'learner-a');
        const late = await h.ok(`/me/sessions/${fresh.sessionId}/events`, 'POST', { clientEventId: 'late-stop', expectedRevision: 0, type: 'stop' }, 'learner-a');
        assert.equal(late.status, 'stopped');
        assert.equal(h.db.all('supportRequests').filter(q => q.kind === 'stop').length, 2);
        const concurrent = await h.session(taskId);
        await Promise.all([h.request(`/me/sessions/${concurrent.sessionId}/events`, 'POST', { clientEventId: 'concurrent-next', expectedRevision: 0, type: 'next' }, 'learner-a'), h.request(`/me/sessions/${concurrent.sessionId}/events`, 'POST', { clientEventId: 'concurrent-stop', expectedRevision: 0, type: 'stop' }, 'learner-a')]);
        assert.equal((await h.ok(`/me/sessions/${concurrent.sessionId}`, 'GET', undefined, 'learner-a')).status, 'stopped');
    }
    finally {
        await h.close();
    }
});
test('手伝っては進行を止め、職員の対応後に本人が同じ工程で続ける', async () => {
    const h = await harness();
    try {
        const { taskId } = await h.task();
        const { draft } = await h.generate(taskId);
        const r = await h.approve(draft);
        await h.assign(taskId, r.releaseId);
        const s = await h.session(taskId);
        await h.ok(`/me/sessions/${s.sessionId}/events`, 'POST', { clientEventId: 'help', expectedRevision: 0, type: 'help' }, 'learner-a');
        assert.equal((await h.request(`/me/sessions/${s.sessionId}/events`, 'POST', { clientEventId: 'resume', expectedRevision: 1, type: 'resume' }, 'learner-a')).status, 409);
        const q = (await h.ok('/support-requests')).requests[0];
        await h.ok(`/support-requests/${q.id}/acknowledge`, 'POST', {});
        const resumed = await h.ok(`/me/sessions/${s.sessionId}/events`, 'POST', { clientEventId: 'resume', expectedRevision: 1, type: 'resume' }, 'learner-a');
        assert.equal(resumed.status, 'active');
        assert.equal(resumed.stepIndex, 0);
    }
    finally {
        await h.close();
    }
});
for (const [name, model] of [['例外', { generate: async () => {
                throw Error('private raw model output');
            } }], ['JSONスキーマ違反', { generate: async () => ({ schemaVersion: '1', steps: [], status: 'approved' }) }]] as [
    string,
    VideoModel
][])
    test(`生成失敗(${name})は本人向けデータを作らずジョブを終端にする`, async () => {
        const h = await harness(30, model);
        try {
            const { taskId } = await h.task();
            const { jobId, draft } = await h.generate(taskId);
            assert.equal(draft.status, 'failed');
            assert.equal(h.db.get('generationJobs', jobId)!.status, 'failed');
            assert.equal(h.db.all('releases').length, 0);
            assert.equal(h.db.all('assignments').length, 0);
            assert.deepEqual((await h.ok('/me/assignments', 'GET', undefined, 'learner-a')).assignments, []);
            assert.equal((await h.request('/me/sessions', 'POST', { taskId, clientRequestId: 'never' }, 'learner-a')).status, 403);
            await h.run(jobId);
            assert.equal(h.db.get('generationJobs', jobId)!.attempt, 1);
        }
        finally {
            await h.close();
        }
    });
test('全体上限後は他作業も生成拒否・承認版閲覧継続', async () => {
    const h = await harness(1);
    try {
        const { taskId } = await h.task();
        const { draft } = await h.generate(taskId);
        const r = await h.approve(draft);
        await h.assign(taskId, r.releaseId);
        const second = await h.task();
        for (const t of [taskId, second.taskId])
            assert.equal((await h.request(`/tasks/${t}/generations`, 'POST', { learnerId: 'a' })).status, 409);
        const s = await h.session(taskId);
        assert.equal(s.steps.length, 9);
        assert.equal((await h.request(`/assets/${s.steps[0].imageAssetId}`, 'GET', undefined, 'learner-a')).status, 200);
    }
    finally {
        await h.close();
    }
});
test('1作業10回上限・リース回復は試行3回以内に終端・成功再配送は呼出しなし', async () => {
    let calls = 0;
    const fake = new FakeModel();
    const h = await harness(30, { generate: async (input) => {
            calls++;
            return fake.generate(input);
        } });
    try {
        const { taskId } = await h.task();
        const success = await h.generate(taskId);
        await h.run(success.jobId);
        assert.equal(calls, 1);
        for (let i = 0; i < 9; i++)
            await h.ok(`/tasks/${taskId}/generations`, 'POST', { learnerId: 'a' });
        assert.equal((await h.request(`/tasks/${taskId}/generations`, 'POST', { learnerId: 'a' })).status, 409);
        const interrupted = h.db.all('generationJobs').find(j => j.status === 'queued')!;
        h.db.put('generationJobs', {
            ...interrupted, status: 'running', attempt: 3, leaseUntil: 0
        });
        await h.run(interrupted.id);
        assert.equal(h.db.get('generationJobs', interrupted.id)!.status, 'failed');
        assert.equal(h.db.get('drafts', interrupted.draftId)!.status, 'failed');
        assert.equal(calls, 1);
    }
    finally {
        await h.close();
    }
});
test('期限切れリースは回復し成功、現行リースは二重実行しない', async () => {
    const h = await harness();
    try {
        const { taskId } = await h.task();
        const g = await h.ok(`/tasks/${taskId}/generations`, 'POST', { learnerId: 'a' });
        const j = h.db.get('generationJobs', g.jobId)!;
        h.db.put('generationJobs', {
            ...j, status: 'running', attempt: 1, leaseUntil: Date.now() + 10000
        });
        await h.run(j.id);
        assert.equal(h.db.get('generationJobs', j.id)!.attempt, 1);
        h.db.put('generationJobs', {
            ...j, status: 'running', attempt: 1, leaseUntil: 0
        });
        await h.run(j.id);
        assert.equal(h.db.get('generationJobs', j.id)!.status, 'succeeded');
        assert.equal(h.db.get('generationJobs', j.id)!.attempt, 2);
        assert.equal(h.db.get('generationJobs', j.id)!.budgetUsed, 2);
    }
    finally {
        await h.close();
    }
});
test('端末の停止は送信前に永続化し、再読み込み・送信成功後も解除しない', () => {
    const data = new Map<string, string>();
    const store: Store = { getItem: k => data.get(k) ?? null, setItem: (k, v) => {
            data.set(k, v);
        }, removeItem: k => {
            data.delete(k);
        } };
    hold(store, 'session', { type: 'stop', expectedRevision: 0, clientEventId: 'stop' });
    const reloaded = readSafety(store, 'session');
    assert.equal(reloaded.stopped, true);
    assert.equal(reloaded.pending.length, 1);
    delivered(store, 'session', 'stop');
    assert.equal(readSafety(store, 'session').stopped, true);
    assert.equal(readSafety(store, 'session').pending.length, 0);
});
test('Origin・JSON・内部エンドポイント・動画実体の検査', async () => {
    const h = await harness();
    try {
        const { taskId } = await h.ok('/tasks', 'POST', { title: 'test' });
        const form = new FormData();
        form.append('video', new Blob(['fake mp4']), 'fake.mp4');
        assert.equal((await h.request(`/tasks/${taskId}/video`, 'POST', form)).status, 422);
        assert.equal((await h.request('/internal/generate', 'POST', { jobId: 'x' }, 'staff')).status, 403);
        assert.equal((await h.request('/tasks', 'POST', { title: 'bad', diagnosis: 'never collect' })).status, 422);
        assert.equal(h.db.all('tasks').length, 1);
    }
    finally {
        await h.close();
    }
});
test('非同期Repositoryでも完走し、並行更新・セッション開始をトランザクションで保護する', async () => {
    const h = await harness(30, new FakeModel(), true);
    try {
        const { taskId } = await h.task();
        const { draft } = await h.generate(taskId);
        const update = { expectedRevision: 1, editedSteps: draft.editedSteps, reviewChecks: draft.reviewChecks };
        const results = await Promise.all([h.request(`/drafts/${draft.id}`, 'PATCH', update), h.request(`/drafts/${draft.id}`, 'PATCH', update)]);
        assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
        const fresh = (await h.ok(`/drafts/${draft.id}`)).draft;
        const r = await h.approve(fresh);
        await h.assign(taskId, r.releaseId);
        const payload = { taskId, clientRequestId: 'same-start' };
        const sessions = await Promise.all([h.ok('/me/sessions', 'POST', payload, 'learner-a'), h.ok('/me/sessions', 'POST', payload, 'learner-a')]);
        assert.equal(sessions[0].sessionId, sessions[1].sessionId);
        assert.equal(h.db.all('sessions').length, 1);
        assert.equal((await h.ok(`/me/sessions/${sessions[0].sessionId}`, 'GET', undefined, 'learner-a')).steps.length, 9);
        await assert.rejects(h.db.transaction(async () => {
            h.db.put('releases', doc('demo', { id: 'rolled-back' }));
            throw Error('rollback');
        }));
        assert.equal(h.db.get('releases', 'rolled-back'), undefined);
    }
    finally {
        await h.close();
    }
});
test('Originと不正JSONを拒否し、内部呼出しだけがworkerを実行できる', async () => {
    const h = await harness();
    try {
        const badOrigin = await h.app.fetch(new Request('http://localhost/api/v1/tasks', { method: 'POST', headers: { authorization: 'Bearer staff', 'content-type': 'application/json', origin: 'https://attacker.invalid' }, body: JSON.stringify({ title: 'x' }) }));
        assert.equal(badOrigin.status, 403);
        const malformed = await h.app.fetch(new Request('http://localhost/api/v1/tasks', { method: 'POST', headers: { authorization: 'Bearer staff', 'content-type': 'application/json' }, body: '{' }));
        assert.equal(malformed.status, 422);
        assert.ok((await malformed.json()).error.requestId);
        const { taskId } = await h.task();
        const g = await h.ok(`/tasks/${taskId}/generations`, 'POST', { learnerId: 'a' });
        assert.equal((await h.request('/internal/generate', 'POST', { jobId: g.jobId }, 'newcomer')).status, 403);
        await h.ok('/internal/generate', 'POST', { jobId: g.jobId }, 'test-internal');
        assert.equal(h.db.get('generationJobs', g.jobId)!.status, 'succeeded');
    }
    finally {
        await h.close();
    }
});
test('Gemini入力は許可フィールドだけ・候補の時刻違反は画像や承認版を作らない', async () => {
    let captured: any;
    const fake = new FakeModel();
    const h = await harness(30, { generate: async (input) => {
            captured = input;
            const p = await fake.generate(input);
            p.steps[0].frameMs = input.durationMs + 1;
            return p;
        } });
    try {
        const { taskId } = await h.task();
        const { draft } = await h.generate(taskId);
        assert.deepEqual(Object.keys(captured).sort(), ['completionCriteria', 'durationMs', 'preferences', 'title', 'videoUri']);
        assert.deepEqual(Object.keys(captured.preferences).sort(), ['audioGuidance', 'sentenceLength', 'splitHints']);
        for (const forbidden of ['displayName', 'diagnosis', 'sessionEvents', 'learnerId'])
            assert.ok(!JSON.stringify(captured).includes(forbidden));
        assert.equal(draft.status, 'failed');
        assert.equal(h.db.all('assets').filter(a => a.kind === 'image').length, 0);
        assert.equal(h.db.all('releases').length, 0);
    }
    finally {
        await h.close();
    }
});
test('端末の送信待ちstopは通信断後に再送でき、helpとnextの競合も同じイベントIDで回復する', async () => {
    const h = await harness();
    const data = new Map<string, string>();
    const store: Store = { getItem: k => data.get(k) ?? null, setItem: (k, v) => {
            data.set(k, v);
        }, removeItem: k => {
            data.delete(k);
        } };
    try {
        const { taskId } = await h.task();
        const { draft } = await h.generate(taskId);
        const r = await h.approve(draft);
        await h.assign(taskId, r.releaseId);
        const s = await h.session(taskId);
        const send = async (event: any) => {
            const result = await h.request(`/me/sessions/${s.sessionId}/events`, 'POST', event, 'learner-a');
            if (result.status >= 300)
                throw { status: result.status };
        };
        const load = () => h.ok(`/me/sessions/${s.sessionId}`, 'GET', undefined, 'learner-a');
        await send({ clientEventId: 'in-flight-next', expectedRevision: 0, type: 'next' });
        hold(store, 'key', { clientEventId: 'help', expectedRevision: 0, type: 'help' });
        hold(store, 'key', { clientEventId: 'help-again', expectedRevision: 0, type: 'help' });
        assert.equal(await flushSafety(store, 'key', { send, load }), true);
        assert.equal((await load()).status, 'waiting_help');
        assert.equal(h.db.all('sessionEvents').filter(e => e.type === 'help').length, 1);
        hold(store, 'key', { clientEventId: 'stop-offline', expectedRevision: 0, type: 'stop' });
        assert.equal(await flushSafety(store, 'key', { send: async () => {
                throw Error('offline');
            }, load }), false);
        assert.equal(readSafety(store, 'key').stopped, true);
        assert.equal(readSafety(store, 'key').pending.length, 1);
        assert.equal(await flushSafety(store, 'key', { send, load }), true);
        assert.equal((await load()).status, 'stopped');
        assert.equal(readSafety(store, 'key').stopped, true);
        assert.equal(readSafety(store, 'key').pending.length, 0);
    }
    finally {
        await h.close();
    }
});

test('音声ありの承認は確認済み短文だけを渡し、版専用音声を配信・固定する', async () => {
    const inputs: string[] = [];
    const fake = new FakeTtsAdapter();
    const h = await harness(30, new FakeModel(), false, { synthesize: async text => {
        inputs.push(text);
        return fake.synthesize(text);
    } });
    const { taskId } = await h.task();
    const { draft } = await h.generate(taskId, 'b');
    assert.deepEqual(inputs, []);
    assert.equal((await h.request(`/drafts/${draft.id}/approve`, 'POST', { expectedRevision: draft.revision, approvalRequestId: 'unreviewed' })).status, 422);
    assert.deepEqual(inputs, []);
    draft.editedSteps.forEach((s: any, i: number) => { s.text = `確認した短文 ${i + 1}`; });
    const r = await h.approve(draft);
    assert.deepEqual(inputs, draft.editedSteps.map((s: any) => s.text));
    await h.assign(taskId, r.releaseId, 'b');
    const session = await h.session(taskId, 'learner-b');
    const audio = h.db.all('assets').filter(a => a.kind === 'audio');
    assert.equal(audio.length, session.steps.length);
    for (const step of session.steps) {
        const a = audio.find(a => a.id === step.audioAssetId)!;
        assert.ok(a);
        assert.equal(a.visibility, 'approved');
        assert.equal(a.releaseId, r.releaseId);
        assert.deepEqual(Object.keys(step).sort(), ['audioAssetId', 'imageAssetId', 'order', 'stepId', 'text', 'visibleCaution']);
        const response = await h.request(`/assets/${a.id}`, 'GET', undefined, 'learner-b');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'audio/wav');
        assert.equal(response.data.subarray(0, 4).toString(), 'RIFF');
        assert.equal((await h.request(`/assets/${a.id}`, 'GET', undefined, 'learner-a')).status, 403);
    }
    const privateAudio = doc('demo', { kind: 'audio', visibility: 'staff', objectPath: 'draft/private.wav', mimeType: 'audio/wav' });
    h.db.put('assets', privateAudio);
    assert.equal((await h.request(`/assets/${privateAudio.id}`, 'GET', undefined, 'learner-b')).status, 403);
    const unlisted = doc('demo', { kind: 'audio', visibility: 'approved', releaseId: r.releaseId, objectPath: 'unlisted.wav' });
    h.db.put('assets', unlisted);
    assert.equal((await h.request(`/assets/${unlisted.id}`, 'GET', undefined, 'learner-b')).status, 403);
    const before = audio.map(a => Buffer.from(h.storage.data.get(a.objectPath)!));
    const next = await h.generate(taskId, 'b');
    assert.equal(inputs.length, session.steps.length);
    next.draft.editedSteps[0].text = '新しい短文';
    const newer = await h.approve(next.draft, 'new-audio');
    await h.assign(taskId, newer.releaseId, 'b');
    assert.deepEqual(await h.ok(`/me/sessions/${session.sessionId}`, 'GET', undefined, 'learner-b'), session);
    for (const [i, a] of audio.entries()) {
        assert.deepEqual(h.storage.data.get(a.objectPath), before[i]);
        assert.equal((await h.request(`/assets/${a.id}`, 'GET', undefined, 'learner-b')).status, 200);
    }
    await h.ok(`/drafts/${next.draft.id}/approve`, 'POST', newer.payload);
    assert.equal(inputs.length, session.steps.length * 2);
});

test('音声なしはTTSを呼ばずDTOにも含めない・プロフィールをbooleanで更新できる', async () => {
    const h = await harness(30, new FakeModel(), false, { synthesize: async () => { throw Error('must not be called'); } });
    await h.ok('/learners/a', 'PATCH', { expectedRevision: 1, preferences: { sentenceLength: 40, splitHints: '9工程', audioGuidance: true } });
    assert.equal(h.db.get('learners', 'a')!.preferences.audioGuidance, true);
    await h.ok('/learners/a', 'PATCH', { expectedRevision: 2, preferences: { sentenceLength: 40, splitHints: '9工程', audioGuidance: false } });
    const { taskId } = await h.task();
    const { draft } = await h.generate(taskId);
    const r = await h.approve(draft);
    await h.assign(taskId, r.releaseId);
    const s = await h.session(taskId);
    assert.equal(h.db.all('assets').filter(a => a.kind === 'audio').length, 0);
    assert.ok(s.steps.every((step: any) => !('audioAssetId' in step)));
});

test('TTS途中失敗は承認版も音声メタデータも公開せず、再試行できる', async () => {
    let calls = 0, failing = true;
    const fake = new FakeTtsAdapter();
    const h = await harness(30, new FakeModel(), false, { synthesize: async text => {
        if (++calls === 2 && failing) throw Error('secret provider detail');
        return fake.synthesize(text);
    } });
    const { taskId } = await h.task();
    const { draft } = await h.generate(taskId, 'b');
    const reviewChecks = { presentationConfirmed: true, flagResolution: '確認済み', steps: Object.fromEntries(draft.editedSteps.map((s: any) => [s.stepId, { videoVerified: true, photoTextVerified: true }])) };
    const { revision } = await h.ok(`/drafts/${draft.id}`, 'PATCH', { expectedRevision: draft.revision, editedSteps: draft.editedSteps, reviewChecks });
    const payload = { expectedRevision: revision, approvalRequestId: 'retry-tts' };
    const result = await h.request(`/drafts/${draft.id}/approve`, 'POST', payload);
    assert.equal(result.status, 502);
    assert.equal(result.data.error.code, 'TTS_GENERATION_FAILED');
    assert.ok(!JSON.stringify(result.data).includes('secret'));
    assert.equal(h.db.all('releases').length, 0);
    assert.equal(h.db.all('assets').filter(a => a.visibility === 'approved').length, 0);
    assert.equal(h.db.get('drafts', draft.id)!.status, 'editing');
    failing = false;
    await h.ok(`/drafts/${draft.id}/approve`, 'POST', payload);
    assert.equal(h.db.all('releases').length, 1);
});

test('Fake WAVは短文長に応じた長さ・Vertexは明示選択のみで未接続なら失敗', async () => {
    const fake = new FakeTtsAdapter();
    const short = await fake.synthesize('短文');
    const long = await fake.synthesize('長い短文を読み上げます');
    assert.ok(long.durationMs > short.durationMs);
    assert.ok(long.bytes.length > short.bytes.length);
    assert.ok(configuredTts({}) instanceof FakeTtsAdapter);
    const vertex = configuredTts({ TTS_PROVIDER: 'vertex' }) as VertexTtsAdapter;
    assert.equal(vertex.model, 'gemini-2.5-flash-tts');
    assert.equal((configuredTts({ TTS_PROVIDER: 'vertex', TTS_MODEL: 'chosen' }) as VertexTtsAdapter).model, 'chosen');
    await assert.rejects(vertex.synthesize('確認済み'), /VERTEX_TTS_NOT_CONFIGURED/);
});
