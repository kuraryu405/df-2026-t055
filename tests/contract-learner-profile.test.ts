import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
    learnerProfileDetailSchema as detailSchema,
    learnerProfileSummarySchema as summarySchema,
    learnerProfileListResponseSchema as listSchema,
    learnerProfileCreateRequestSchema as createSchema,
    learnerProfileUpdateRequestSchema as updateSchema,
    toLearnerProfileSummary,
    type ApiError,
} from '../packages/shared/src/index.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(
    `../packages/shared/fixtures/learner-profile/${name}.json`, import.meta.url), 'utf8'));
const privateKeys = ['disabilityInfo', 'learnerWishes', 'staffObservations', 'staffSuggestions', 'confirmedGuidance'];

test('API例で参照する正常fixtureを実スキーマで直接parseできる', () => {
    detailSchema.parse(fixture('detail-valid'));
    listSchema.parse(fixture('list-valid'));
    createSchema.parse(fixture('create-valid'));
    updateSchema.parse(fixture('update-delete-disability-info'));
    // ApiError is an existing type, so validate its JSON shape locally without changing the export.
    const errorSchema = z.object({ error: z.object({
        code: z.string(), message: z.string(), requestId: z.string(),
    }).strict() }).strict();
    const error: ApiError = errorSchema.parse(fixture('error-revision-conflict'));
    assert.equal(error.error.code, 'REVISION_CONFLICT');
});

test('一覧の実キーと純粋な変換結果は私的な情報を含まない', () => {
    const rawList = fixture('list-valid');
    for (const item of rawList.items) {
        assert.deepEqual(Object.keys(item).sort(), ['schemaVersion', 'learnerId', 'displayName', 'preferences', 'revision'].sort());
        for (const key of privateKeys) assert.equal(Object.hasOwn(item, key), false);
    }
    const detail = detailSchema.parse(fixture('detail-valid'));
    const before = structuredClone(detail);
    const summary = toLearnerProfileSummary(detail);
    summarySchema.parse(summary);
    assert.deepEqual(summary, rawList.items[0]);
    for (const key of privateKeys) assert.equal(Object.hasOwn(summary, key), false);
    assert.deepEqual(detail, before);
    summary.preferences.audioGuidance = true;
    assert.deepEqual(detail, before);
});

test('異常fixtureを拒否し、未確認値は省略で表す', () => {
    assert.equal(createSchema.safeParse(fixture('invalid-unconfirmed-null')).success, false);
    assert.equal(listSchema.safeParse(fixture('invalid-list-with-disability-info')).success, false);
    assert.deepEqual(createSchema.parse({ displayName: '  架空例  ', preferences: {} }), { displayName: '架空例', preferences: {} });
    assert.deepEqual(createSchema.parse({ displayName: '架空例' }), { displayName: '架空例' });
    const minimal = { ...fixture('detail-valid') };
    for (const key of privateKeys) delete minimal[key];
    minimal.preferences = {};
    detailSchema.parse(minimal);
});

test('表示設定・各分類・表示名の境界を検査する', () => {
    const valid = fixture('create-valid');
    for (const sentenceLength of [0, 41, 1.5])
        assert.equal(createSchema.safeParse({ ...valid, preferences: { sentenceLength } }).success, false);
    for (const sentenceLength of [1, 40]) createSchema.parse({ ...valid, preferences: { sentenceLength } });
    createSchema.parse({ ...valid, preferences: { splitHints: 'あ'.repeat(200), displayMode: 'photo_text', audioGuidance: true } });
    for (const preferences of [{ splitHints: 'あ'.repeat(201) }, { displayMode: 'text' }, { audioGuidance: 'false' }])
        assert.equal(createSchema.safeParse({ ...valid, preferences }).success, false);
    for (const key of privateKeys.slice(1)) {
        for (const value of [Array(21).fill('項目'), ['あ'.repeat(501)], [''], ['   '], [null], null])
            assert.equal(createSchema.safeParse({ ...valid, [key]: value }).success, false, key);
        createSchema.parse({ ...valid, [key]: Array(20).fill('あ'.repeat(500)) });
    }
    for (const displayName of ['', '   ', 'あ'.repeat(101)])
        assert.equal(createSchema.safeParse({ ...valid, displayName }).success, false);
    createSchema.parse({ displayName: 'あ'.repeat(100) });
});

test('revision・schemaVersion・ISO日時とすべてのobjectの未知キーを検査する', () => {
    const detail = fixture('detail-valid');
    for (const revision of [-1, 0, 1.5]) {
        assert.equal(detailSchema.safeParse({ ...detail, revision }).success, false);
        assert.equal(summarySchema.safeParse({ ...fixture('list-valid').items[0], revision }).success, false);
    }
    for (const expectedRevision of [-1, 1.5])
        assert.equal(updateSchema.safeParse({ expectedRevision }).success, false);
    updateSchema.parse({ expectedRevision: 0 });
    assert.equal(updateSchema.safeParse({}).success, false);
    for (const patch of [{ schemaVersion: '2' }, { createdAt: 'today' }, { learnerId: '' }])
        assert.equal(detailSchema.safeParse({ ...detail, ...patch }).success, false);
    for (const [schema, value] of [
        [detailSchema, detail], [summarySchema, fixture('list-valid').items[0]],
        [listSchema, fixture('list-valid')], [createSchema, fixture('create-valid')],
        [updateSchema, { expectedRevision: 1 }],
    ] as const) assert.equal(schema.safeParse({ ...value, unknown: true }).success, false);
    for (const key of ['orgId', 'learnerId', 'enteredBy', 'updatedBy', 'revision', 'createdAt', 'schemaVersion']) {
        assert.equal(createSchema.safeParse({ displayName: '架空例', [key]: detail[key] }).success, false);
        assert.equal(updateSchema.safeParse({ expectedRevision: 1, [key]: detail[key] }).success, false);
    }
    assert.equal(createSchema.safeParse({ displayName: '架空例', preferences: { unknown: true } }).success, false);
    assert.equal(detailSchema.safeParse({ ...detail, disabilityInfo: { ...detail.disabilityInfo, unknown: true } }).success, false);
});

test('更新のdisabilityInfo:nullだけが削除要求であり、部分objectや他のnullは拒否する', () => {
    assert.equal(updateSchema.parse(fixture('update-delete-disability-info')).disabilityInfo, null);
    assert.equal(Object.hasOwn(updateSchema.parse({ expectedRevision: 1 }), 'disabilityInfo'), false);
    const valid = fixture('create-valid');
    updateSchema.parse({ ...valid, expectedRevision: 1 });
    assert.equal(createSchema.safeParse({ ...valid, disabilityInfo: null }).success, false);
    assert.equal(detailSchema.safeParse({ ...fixture('detail-valid'), disabilityInfo: null }).success, false);
    for (const key of ['displayName', 'preferences', ...privateKeys.slice(1)])
        assert.equal(updateSchema.safeParse({ expectedRevision: 1, [key]: null }).success, false);
    for (const key of Object.keys(valid.preferences))
        assert.equal(updateSchema.safeParse({ expectedRevision: 1, preferences: { [key]: null } }).success, false);
    for (const key of ['detail', 'source', 'confirmedAt']) {
        const partial = { ...valid.disabilityInfo };
        delete partial[key];
        assert.equal(updateSchema.safeParse({ expectedRevision: 1, disabilityInfo: partial }).success, false);
    }
    for (const patch of [{ detail: 'あ'.repeat(501) }, { source: 'あ'.repeat(201) }, { confirmedAt: '2026-11-08' }])
        assert.equal(updateSchema.safeParse({ expectedRevision: 1, disabilityInfo: { ...valid.disabilityInfo, ...patch } }).success, false);
});


test('障害情報のdetail・sourceはtrim後の空文字と上限超過を拒否する', () => {
    const valid = fixture('create-valid');
    for (const [key, limit] of [['detail', 500], ['source', 200]] as const) {
        for (const value of ['', '   ', 'あ'.repeat(limit + 1)]) {
            const disabilityInfo = { ...valid.disabilityInfo, [key]: value };
            assert.equal(createSchema.safeParse({ ...valid, disabilityInfo }).success, false, key);
            assert.equal(updateSchema.safeParse({ expectedRevision: 1, disabilityInfo }).success, false, key);
            assert.equal(detailSchema.safeParse({ ...fixture('detail-valid'), disabilityInfo }).success, false, key);
        }
        for (const value of [' あ ', `  ${'あ'.repeat(limit)}  `]) {
            const disabilityInfo = { ...valid.disabilityInfo, [key]: value };
            assert.equal(createSchema.parse({ ...valid, disabilityInfo }).disabilityInfo?.[key], value.trim());
            assert.equal(updateSchema.parse({ expectedRevision: 1, disabilityInfo }).disabilityInfo?.[key], value.trim());
            assert.equal(detailSchema.parse({ ...fixture('detail-valid'), disabilityInfo }).disabilityInfo?.[key], value.trim());
        }
    }
});
