import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed } from '../apps/api/src/adapters.ts';
import { learnerProfileDetailSchema, learnerProfileListResponseSchema } from '../packages/shared/src/learner-profile.ts';

function harness() {
    const db = new MemoryRepository();
    seed(db);
    const { app } = createApp({ db });
    async function request(path: string, method = 'GET', body?: unknown, token = 'staff') {
        const response = await app.fetch(new Request(`http://localhost/api/v1${path}`, {
            method,
            headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }));
        return { status: response.status, data: await response.json() as any, headers: response.headers };
    }
    return { db, request };
}
const privateKeys = ['disabilityInfo', 'learnerWishes', 'staffObservations', 'staffSuggestions', 'confirmedGuidance'];

test('最小プロフィールを登録し、詳細・一覧と旧seedを契約形で取得できる', async () => {
    const h = harness();
    const created = await h.request('/learners', 'POST', { displayName: '架空のCさん' });
    assert.equal(created.status, 201);
    const detail = learnerProfileDetailSchema.parse(created.data);
    assert.equal(detail.revision, 1);
    assert.deepEqual(detail.preferences, {});
    assert.equal(Object.hasOwn(created.data, 'disabilityInfo'), false);
    assert.equal(detail.orgId, 'demo');
    assert.equal(detail.enteredBy, 'staff');
    assert.equal(detail.updatedBy, 'staff');
    assert.equal(h.db.get('learners', detail.learnerId)?.id, detail.learnerId);
    const fetched = await h.request(`/learners/${detail.learnerId}`);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.data, detail);
    const listed = await h.request('/learners');
    assert.equal(listed.status, 200);
    const { items } = learnerProfileListResponseSchema.parse(listed.data);
    assert.equal(items.length, 3);
    assert.deepEqual(items.find(l => l.learnerId === detail.learnerId), {
        schemaVersion: '1', learnerId: detail.learnerId, displayName: detail.displayName, preferences: {}, revision: 1
    });
    for (const id of ['a', 'b']) {
        const seeded = await h.request(`/learners/${id}`, 'GET', undefined, 'staff');
        assert.equal(seeded.status, 200);
        assert.equal(seeded.data.updatedBy, 'staff');
        assert.equal(seeded.data.revision, 1);
    }
    assert.equal(fetched.headers.get('cache-control'), 'no-store');
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    assert.equal(created.headers.get('cache-control'), 'no-store');
});

test('障害情報と4分類は詳細に保存し、一覧にキーを出さない', async () => {
    const h = harness();
    const input = {
        displayName: '架空のDさん', preferences: { audioGuidance: false },
        disabilityInfo: { detail: '架空の支援情報', source: '架空の本人確認', confirmedAt: '2026-11-08T00:00:00Z' },
        learnerWishes: ['写真を使いたい'], staffObservations: ['写真を確認した'],
        staffSuggestions: ['写真で試す'], confirmedGuidance: ['写真を用意する']
    };
    const created = await h.request('/learners', 'POST', input);
    assert.equal(created.status, 201);
    const fetched = await h.request(`/learners/${created.data.learnerId}`);
    assert.equal(fetched.status, 200);
    for (const key of privateKeys) {
        assert.deepEqual(created.data[key], input[key as keyof typeof input]);
        assert.deepEqual(fetched.data[key], created.data[key]);
    }
    const listed = await h.request('/learners');
    assert.equal(listed.status, 200);
    for (const item of learnerProfileListResponseSchema.parse(listed.data).items)
        for (const key of privateKeys)
            assert.equal(Object.hasOwn(item, key), false);
});

test('認証・職員権限・所属と対象の存在を検査する', async () => {
    const h = harness();
    for (const token of ['learner-a', 'newcomer', '']) {
        const expected = token ? 403 : 401;
        assert.equal((await h.request('/learners', 'POST', { displayName: '架空' }, token)).status, expected);
        assert.equal((await h.request('/learners', 'GET', undefined, token)).status, expected);
        assert.equal((await h.request('/learners/a', 'GET', undefined, token)).status, expected);
    }
    const other = await h.request('/learners', 'GET', undefined, 'other-staff');
    assert.equal(other.status, 200);
    assert.deepEqual(other.data, { items: [] });
    assert.equal((await h.request('/learners/a', 'GET', undefined, 'other-staff')).status, 403);
    assert.equal((await h.request('/learners/missing')).status, 404);
    const created = await h.request('/learners', 'POST', { displayName: '別組織の架空プロフィール' }, 'other-staff');
    assert.equal(created.status, 201);
    assert.equal(created.data.orgId, 'other');
    assert.equal(created.data.enteredBy, 'other-staff');
    assert.equal(created.data.updatedBy, 'other-staff');
    assert.equal((await h.request('/learners')).data.items.length, 2);
});

test('未知キー・null・表示名欠落を拒否して保存しない', async () => {
    const h = harness();
    for (const body of [{ displayName: '架空', orgId: 'other' }, { displayName: '架空', preferences: null }, {}])
        assert.equal((await h.request('/learners', 'POST', body)).status, 422);
    assert.equal(h.db.all('learners').length, 2);
});

test('revision付き更新は指定項目を置き換え、詳細と保存済みの識別情報を保つ', async () => {
    const h = harness();
    const before = h.db.get('learners', 'a')!;
    const updated = await h.request('/learners/a', 'PATCH', {
        expectedRevision: 1, displayName: '架空の更新名', preferences: { audioGuidance: false },
        learnerWishes: [], staffObservations: ['架空の観察'],
        staffSuggestions: ['架空の提案'], confirmedGuidance: ['架空の確認済み配慮']
    });
    assert.equal(updated.status, 200);
    const detail = learnerProfileDetailSchema.parse(updated.data);
    assert.equal(detail.displayName, '架空の更新名');
    assert.deepEqual(detail.preferences, { audioGuidance: false });
    assert.equal(detail.revision, 2);
    assert.equal(detail.updatedBy, 'staff');
    assert.deepEqual(detail.learnerWishes, []);
    assert.deepEqual(detail.staffObservations, ['架空の観察']);
    assert.deepEqual(detail.staffSuggestions, ['架空の提案']);
    assert.deepEqual(detail.confirmedGuidance, ['架空の確認済み配慮']);
    for (const key of ['id', 'orgId', 'enteredBy', 'createdAt'])
        assert.equal(h.db.get('learners', 'a')![key], before[key]);
    const fetched = await h.request('/learners/a');
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.data, detail);
    const renamed = await h.request('/learners/a', 'PATCH', { expectedRevision: 2, displayName: '架空の再更新名' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.revision, 3);
    assert.deepEqual(renamed.data.preferences, detail.preferences);
    assert.deepEqual(renamed.data.staffObservations, detail.staffObservations);
});

test('古いrevisionと同じrevisionの再送は409で保存値を変えない', async () => {
    const h = harness();
    const stale = await h.request('/learners/a', 'PATCH', { expectedRevision: 0, displayName: '架空の古い更新' });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error.code, 'REVISION_CONFLICT');
    const body = { expectedRevision: 1, displayName: '架空の更新名' };
    assert.equal((await h.request('/learners/a', 'PATCH', body)).status, 200);
    const saved = h.db.get('learners', 'a');
    const repeated = await h.request('/learners/a', 'PATCH', body);
    assert.equal(repeated.status, 409);
    assert.equal(repeated.data.error.code, 'REVISION_CONFLICT');
    assert.deepEqual(h.db.get('learners', 'a'), saved);
});

test('障害情報は省略で保持、完全なオブジェクトで置換、nullでキーごと削除する', async () => {
    const h = harness();
    const disabilityInfo = { detail: '架空の支援情報', source: '架空の本人確認', confirmedAt: '2026-11-08T00:00:00Z' };
    const created = await h.request('/learners', 'POST', { displayName: '架空', disabilityInfo });
    assert.equal(created.status, 201);
    const path = `/learners/${created.data.learnerId}`;
    const kept = await h.request(path, 'PATCH', { expectedRevision: 1, displayName: '架空の更新名' });
    assert.equal(kept.status, 200);
    assert.deepEqual(kept.data.disabilityInfo, disabilityInfo);
    const replacement = { ...disabilityInfo, detail: '架空の見直し後の情報' };
    const replaced = await h.request(path, 'PATCH', { expectedRevision: 2, disabilityInfo: replacement });
    assert.equal(replaced.status, 200);
    assert.deepEqual(replaced.data.disabilityInfo, replacement);
    const saved = h.db.get('learners', created.data.learnerId);
    assert.equal((await h.request(path, 'PATCH', { expectedRevision: 3, disabilityInfo: { detail: '架空' } })).status, 422);
    assert.deepEqual(h.db.get('learners', created.data.learnerId), saved);
    const removed = await h.request(path, 'PATCH', { expectedRevision: 3, disabilityInfo: null });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.revision, 4);
    assert.equal(Object.hasOwn(removed.data, 'disabilityInfo'), false);
    assert.equal(Object.hasOwn(h.db.get('learners', created.data.learnerId)!, 'disabilityInfo'), false);
    const fetched = await h.request(path);
    assert.equal(fetched.status, 200);
    assert.equal(Object.hasOwn(fetched.data, 'disabilityInfo'), false);
});

test('更新の未知キー・対象外null・expectedRevision欠落は422で保存しない', async () => {
    const h = harness();
    const before = h.db.get('learners', 'a');
    for (const body of [
        { expectedRevision: 1, displayName: null }, { displayName: '架空' },
        { expectedRevision: 1, orgId: 'other' }, { expectedRevision: 1, preferences: null },
        { expectedRevision: 1, preferences: { audioGuidance: null } },
        { expectedRevision: 1, preferences: { unknown: true } }
    ]) {
        assert.equal((await h.request('/learners/a', 'PATCH', body)).status, 422);
        assert.deepEqual(h.db.get('learners', 'a'), before);
    }
});

test('プロフィール更新は職員のみで所属・対象の存在を検査する', async () => {
    const h = harness();
    const before = h.db.all('learners');
    for (const token of ['learner-a', 'newcomer', 'other-staff', ''])
        assert.equal((await h.request('/learners/a', 'PATCH', { expectedRevision: 1, displayName: '架空' }, token)).status, token ? 403 : 401);
    assert.equal((await h.request('/learners/missing', 'PATCH', { expectedRevision: 1, displayName: '架空' })).status, 404);
    assert.deepEqual(h.db.all('learners'), before);
});
