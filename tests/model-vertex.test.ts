import assert from 'node:assert/strict';
import test from 'node:test';
import { AI_CANDIDATE_SCHEMA, configuredModel, FakeModel, VertexVideoModel, type ModelInput } from '../apps/generator/src/model.ts';

const input: ModelInput = {
    videoUri: 'source/example/task/video.mp4', title: 'タオル包装', completionCriteria: '袋口が閉じている',
    preferences: { sentenceLength: 20, splitHints: '一つずつ', audioGuidance: false }, durationMs: 120000
};

test('Vertex request copies only allowed input fields, including nested preferences', async () => {
    const forbidden = { displayName: '架空', disabilityInfo: {}, diagnosis: '架空', supportInputs: [], profile: {} };
    const contaminated = { ...input, ...forbidden, preferences: { ...input.preferences, ...forbidden } };
    let called = false;
    const model = new VertexVideoModel('example-private-bucket', async request => {
        called = true;
        assert.deepEqual(request, {
            videoUri: 'gs://example-private-bucket/source/example/task/video.mp4', mimeType: 'video/mp4',
            title: input.title, completionCriteria: input.completionCriteria, preferences: input.preferences,
            durationMs: input.durationMs, responseSchema: AI_CANDIDATE_SCHEMA
        });
        for (const key of Object.keys(forbidden)) assert.equal(JSON.stringify(request).includes(key), false);
        return {};
    });
    await model.generate(contaminated);
    assert.equal(called, true);
});

test('model provider requires explicit vertex selection', () => {
    assert.ok(configuredModel({}) instanceof FakeModel);
    assert.ok(configuredModel({ MODEL_PROVIDER: 'other' }) instanceof FakeModel);
    assert.ok(configuredModel({ MODEL_PROVIDER: 'vertex' }) instanceof VertexVideoModel);
});

test('injected transport returns its value unchanged and receives cancellation signal', async () => {
    const controller = new AbortController();
    const result = { candidate: 'transport result' };
    const model = new VertexVideoModel('example-private-bucket', async (_request, signal) => {
        assert.equal(signal, controller.signal);
        return result;
    });
    assert.equal(await model.generate(input, controller.signal), result);
});

test('vertex fails explicitly with missing configuration and never falls back to Fake', async () => {
    const model = configuredModel({ MODEL_PROVIDER: 'vertex', VIDEO_BUCKET: 'example-private-bucket' });
    await assert.rejects(model.generate(input), /VERTEX_MODEL_NOT_CONFIGURED/);
});

test('invalid storage locations and already cancelled calls never reach transport', async () => {
    const transport = async () => { assert.fail('transport must not run'); };
    await assert.rejects(new VertexVideoModel('', transport).generate(input), /INVALID_VIDEO_BUCKET/);
    for (const videoUri of ['', '/video.mp4', 'gs://other/video.mp4', '../video.mp4']) {
        await assert.rejects(new VertexVideoModel('example-private-bucket', transport).generate({ ...input, videoUri }), /INVALID_VIDEO_OBJECT_PATH/);
    }
    await assert.rejects(new VertexVideoModel('example-private-bucket', transport).generate(input, AbortSignal.abort()), { name: 'AbortError' });
});

test('transport failures propagate without fallback', async () => {
    const error = Error('TRANSPORT_FAILED');
    const model = new VertexVideoModel('example-private-bucket', async () => { throw error; });
    await assert.rejects(model.generate(input), e => e === error);
});
