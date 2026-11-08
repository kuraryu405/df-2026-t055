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
