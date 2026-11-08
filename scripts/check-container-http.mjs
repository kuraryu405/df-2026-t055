// HTTP-only local smoke check: uses seeded demo accounts and a synthetic MP4.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [api, generator, fixture] = process.argv.slice(2);
assert.ok(api && generator && fixture, 'usage: node scripts/check-container-http.mjs API_URL GENERATOR_URL FIXTURE.mp4');
const token = process.env.INTERNAL_TOKEN;
assert.ok(token, 'INTERNAL_TOKEN is required');
async function request(base, path, { method = 'GET', body, auth = 'staff' } = {}) {
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(60000),
    headers: { authorization: `Bearer ${auth}`, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) })
  });
  return response;
}
async function json(path, options) {
  const r = await request(api, '/api/v1' + path, options);
  assert.ok(r.ok, `${path}: HTTP ${r.status}`);
  return r.json();
}
const home = await fetch(api);
assert.equal(home.status, 200);
assert.match(home.headers.get('content-type'), /text\/html/);
const html = await home.text();
const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
assert.ok(asset, 'built Web entry asset');
assert.equal((await fetch(api + asset)).status, 200);
for (const path of ['/staff', '/me', '/handover']) {
  assert.equal(await (await fetch(api + path)).text(), html);
}
assert.equal((await request(api, '/api/v1/tasks', { auth: 'invalid' })).status, 401);
const { taskId } = await json('/tasks', { method: 'POST', body: { title: 'container synthetic fixture' } });
const form = new FormData();
form.append('video', new Blob([await readFile(fixture)], { type: 'video/mp4' }), 'fixture.mp4');
await json(`/tasks/${taskId}/video`, { method: 'POST', body: form });
const { jobId, draftId } = await json(`/tasks/${taskId}/generations`, { method: 'POST', body: { learnerId: 'a' } });
assert.equal((await request(generator, '/api/v1/internal/generate', { method: 'POST', auth: 'invalid', body: { jobId } })).status, 403);
const generated = await request(generator, '/api/v1/internal/generate', { method: 'POST', auth: token, body: { jobId } });
assert.equal(generated.status, 200);
const job = await json(`/jobs/${jobId}`);
assert.equal(job.status, 'succeeded', `job state/error: ${JSON.stringify(job)}`);
const { draft } = await json(`/drafts/${draftId}`);
assert.equal(draft.status, 'editing');
assert.ok(draft.editedSteps.length > 0);
for (const step of draft.editedSteps) {
  assert.ok(step.imageAssetId);
  const image = await request(api, `/api/v1/assets/${step.imageAssetId}`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type'), /image\/jpeg/);
  assert.ok((await image.arrayBuffer()).byteLength > 0);
}
assert.equal((await request(api, `/api/v1/drafts/${draftId}`, { auth: 'learner-a' })).status, 403);
console.log('PASS: same-origin Web/API, auth rejection, generator HTTP, succeeded job, candidate JPEGs, draft boundary');
