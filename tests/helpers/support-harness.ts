import assert from 'node:assert/strict';
import { createApp } from '../../apps/api/src/app.ts';
import { MemoryRepository, seed, doc, type Storage } from '../../apps/api/src/adapters.ts';
import { FakeTtsAdapter } from '../../apps/api/src/tts.ts';

export async function supportHarness() {
    const db = new MemoryRepository(); seed(db);
    const bytes = new Map<string, Buffer>();
    const storage: Storage = {
        async put(path, value) { bytes.set(path, value); },
        async get(path) { return bytes.get(path)!; },
        async open(path) { return new Response(new Uint8Array(await this.get(path))).body!; },
        async copy(from, to) { await this.put(to, await this.get(from)); }
    };
    const { app } = createApp({ db, storage, tts: new FakeTtsAdapter() });
    const steps = [0, 1].map(index => ({ stepId: `s${index}`, sourceStartMs: index * 1000, sourceEndMs: (index + 1) * 1000,
        frameMs: index * 1000 + 500, imageAssetId: `image${index}`, imageAltText: `架空の手元${index}`, text: `タオルの工程${index}`,
        visibleCaution: '端を見る', verifiedObservation: '端が見える', verifiedSpeech: '端をそろえる', coaching: '待つ', completionCheck: '端がそろう' }));
    db.put('tasks', doc('demo', { id: 'task', title: 'タオル包装', videoAssetId: 'video' }));
    db.put('assets', doc('demo', { id: 'video', kind: 'video', durationMs: 2000 }));
    for (let index = 0; index < 2; index++) {
        db.put('assets', doc('demo', { id: `image${index}`, kind: 'image', draftId: 'draft', sourceVideoId: 'video', frameMs: index * 1000 + 500,
            objectPath: `draft/${index}.jpg`, mimeType: 'image/jpeg' }));
        await storage.put(`draft/${index}.jpg`, Buffer.from('synthetic image'));
    }
    db.put('drafts', doc('demo', { id: 'draft', taskId: 'task', learnerId: 'a', status: 'editing', revision: 1,
        editedSteps: steps, displayMode: 'photo_text', audioGuidance: false, aiProposal: { steps: [], reviewFlags: [] },
        reviewChecks: { presentationConfirmed: true, flagResolution: '', steps: { s0: { videoVerified: true, photoTextVerified: true }, s1: { videoVerified: true, photoTextVerified: true } } } }));
    async function request(path: string, method = 'GET', body?: unknown, token = 'staff') {
        return app.fetch(new Request(`http://localhost/api/v1${path}`, { method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    }
    const api = (token = 'staff') => async (path: string, method = 'GET', body?: unknown) => {
        const response = await request(path, method, body, token), value = await response.json();
        if (!response.ok) throw Object.assign(Error(value.error.message), { status: response.status, code: value.error.code });
        return value;
    };
    const staff = api(), learner = api('learner-a');
    const release = await staff('/drafts/draft/approve', 'POST', { expectedRevision: 1, approvalRequestId: 'approved' });
    await staff('/assignments/a/task', 'PUT', { releaseId: release.releaseId });
    const session = await learner('/me/sessions', 'POST', { taskId: 'task', clientRequestId: 'start' });
    await learner(`/me/sessions/${session.sessionId}/events`, 'POST', { clientEventId: 'help', expectedRevision: 0, type: 'help' });
    const requestId = db.all('supportRequests')[0].id;
    assert.ok(requestId);
    return { app, db, api, request, sessionId: session.sessionId, requestId, releaseId: release.releaseId };
}
