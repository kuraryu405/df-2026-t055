import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
import { buildLearnerProfileUpdate, learnerProfileToForm, buildLearnerProfile, emptyLearnerForm } from '../apps/web/src/learner-form.ts';
import { learnerProfileDetailSchema } from '../packages/shared/src/learner-profile.ts';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed } from '../apps/api/src/adapters.ts';

// Run the actual component handlers with fake hooks, without a browser or added dependency.
const hookSource = `import React from '${import.meta.resolve('react')}';
let state=[], cursor=0, effects=[];
export default React;
export function begin(){cursor=0;effects=[];}
export function reset(){state=[];begin();}
export function useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v}];}
export function useRef(initial){const i=cursor++;return state[i]??=( {current:initial} );}
export function useEffect(fn,deps){const i=cursor++;if(!state[i]||deps.some((v,j)=>v!==state[i][j])){state[i]=deps;effects.push(fn);}}
export async function flush(){for(const fn of effects)fn();await new Promise(r=>setImmediate(r));}`;
const hookUrl = 'data:text/javascript;base64,' + Buffer.from(hookSource).toString('base64');
const hooks = await import(hookUrl);
let source = await readFile(new URL('../apps/web/src/staff-learners.tsx', import.meta.url), 'utf8');
source = source.replace("'react'", JSON.stringify(hookUrl))
    .replace("'../../../packages/shared/src/learner-profile.ts'", JSON.stringify(new URL('../packages/shared/src/learner-profile.ts', import.meta.url).href))
    .replace("'./learner-form.ts'", JSON.stringify(new URL('../apps/web/src/learner-form.ts', import.meta.url).href));
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { StaffLearners, ProfileValues } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
function nodes(tree: any): any[] {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (!React.isValidElement(tree)) return [];
    return [tree, ...nodes((tree.props as any).children)];
}
function text(tree: any): string {
    if (Array.isArray(tree)) return tree.map(text).join('');
    if (React.isValidElement(tree)) return text((tree.props as any).children);
    return tree == null ? '' : String(tree);
}
function button(tree: any, label: string) { return nodes(tree).find(n => n.type === 'button' && text(n) === label); }
function harness() {
    hooks.reset();
    const db = new MemoryRepository(); seed(db);
    const { app } = createApp({ db });
    let path = '/staff/learners', fail = false, posts = 0;
    const calls: {url: string; method: string; body: any}[] = [];
    const go = (value: string) => { path = value; hooks.reset(); };
    const api = async (url: string, method = 'GET', body?: unknown) => {
        calls.push({url, method, body});
        if (method === 'PATCH' && fail) throw Error('通信失敗');
        if (method === 'POST') { posts++; if (fail) throw Error('通信失敗'); }
        const response = await app.fetch(new Request('http://localhost/api/v1' + url, { method, headers: { authorization: 'Bearer staff', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
        const result = await response.json();
        if (!response.ok) throw Object.assign(Error(result.error.code), {status: response.status});
        assert.equal(response.status, method === 'POST' ? 201 : 200);
        return result;
    };
    const render = () => { hooks.begin(); return StaffLearners({ path, api, go }); };
    return { render, db, api, go, calls, get path() { return path; }, get posts() { return posts; }, setFail(value: boolean) { fail = value; } };
}

test('form payload omits unknown values, preserves false and separates wishes/observations/suggestions', () => {
    assert.deepEqual(buildLearnerProfile({ ...emptyLearnerForm, displayName: '架空C' }), { displayName: '架空C' });
    const body = buildLearnerProfile({ ...emptyLearnerForm, displayName: '架空C', learnerWishes: ['写真がよい'], staffObservations: ['写真を見た'], staffSuggestions: ['写真で試す'], audioGuidance: 'false', displayMode: 'photo_only', sentenceLength: '1' });
    assert.deepEqual(body, { displayName: '架空C', learnerWishes: ['写真がよい'], staffObservations: ['写真を見た'], staffSuggestions: ['写真で試す'], preferences: { audioGuidance: false, displayMode: 'photo_only', sentenceLength: 1 } });
    assert.equal(JSON.stringify(body).includes('null'), false);
});
test('payload rejects blank names, invalid ranges, oversized notes and incomplete disability information', () => {
    for (const patch of [{ displayName: '  ' }, { sentenceLength: '0' }, { sentenceLength: '41' }, { sentenceLength: '1.5' }, { splitHints: 'x'.repeat(201) }, { staffSuggestions: ['x'.repeat(501)] }, { disabilityDetail: '架空情報' }])
        assert.throws(() => buildLearnerProfile({ ...emptyLearnerForm, displayName: '架空C', ...patch }));
    const body = buildLearnerProfile({ ...emptyLearnerForm, displayName: '架空C', disabilityDetail: '架空情報', disabilitySource: '本人の希望', disabilityConfirmedAt: '2026-11-08T10:00' });
    assert.ok(body.disabilityInfo?.confirmedAt.endsWith('Z'));
});
test('list → labelled form → preview → correction → API create → list and detail', async () => {
    const h = harness(); let tree = h.render(); await hooks.flush(); tree = h.render();
    button(tree, '本人を登録する').props.onClick(); tree = h.render();
    for (const input of nodes(tree).filter(n => ['input', 'textarea', 'select'].includes(n.type))) {
        assert.ok(nodes(tree).some(n => n.type === 'label' && nodes(n).includes(input)));
        assert.equal(input.props.tabIndex, undefined);
    }
    const name = nodes(tree).find(n => n.type === 'input' && n.props.required);
    name.props.onChange({ target: { value: '架空C' } }); tree = h.render();
    nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); tree = h.render();
    assert.match(text(ProfileValues({ profile: nodes(tree).find(n => n.type === ProfileValues).props.profile })), /未確認/);
    assert.equal(h.posts, 0);
    button(tree, '修正へ戻る').props.onClick(); tree = h.render();
    assert.equal(nodes(tree).find(n => n.type === 'input').props.value, '架空C');
    nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); tree = h.render();
    const submit = button(tree, 'この内容で登録する').props.onClick;
    submit(); submit(); assert.equal(h.posts, 1);
    assert.equal(button(h.render(), '登録しています…').props.disabled, true);
    await new Promise(r => setImmediate(r));
    assert.equal(h.path, '/staff/learners'); tree = h.render(); await hooks.flush(); tree = h.render();
    button(tree, '架空Cの詳細').props.onClick(); tree = h.render(); await hooks.flush(); tree = h.render();
    assert.match(text(tree), /架空Cのプロフィール/);
    const saved = h.db.all('learners').find(l => l.displayName === '架空C')!;
    assert.deepEqual(saved.preferences, {}); assert.equal(Object.hasOwn(saved, 'disabilityInfo'), false);
});
test('failed send keeps preview and original input, exposes alert and permits retry', async () => {
    const h = harness(); let tree = h.render(); await hooks.flush(); tree = h.render();
    button(tree, '本人を登録する').props.onClick(); tree = h.render();
    nodes(tree).find(n => n.type === 'input').props.onChange({ target: { value: '架空失敗' } }); tree = h.render();
    nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); tree = h.render();
    h.setFail(true); button(tree, 'この内容で登録する').props.onClick(); await new Promise(r => setImmediate(r)); tree = h.render();
    assert.match(text(nodes(tree).find(n => n.props.role === 'alert')), /通信失敗/);
    assert.equal(h.path, '/staff/learners/new');
    assert.equal(button(tree, 'この内容で登録する').props.disabled, false);
    button(tree, '修正へ戻る').props.onClick(); tree = h.render();
    assert.equal(nodes(tree).find(n => n.type === 'input').props.value, '架空失敗');
});

function input(tree: any, label: string) {
    const node = nodes(tree).find(n => n.type === 'label' && text(n).startsWith(label));
    return nodes(node).find(n => ['input', 'textarea', 'select'].includes(n.type));
}
function change(tree: any, label: string, value: string) { input(tree, label).props.onChange({target: {value}}); }
function confirm(tree: any) { nodes(tree).find(n => n.type === 'form').props.onSubmit({preventDefault() {}}); }
async function settle() { await new Promise(r => setImmediate(r)); }
async function open(h: ReturnType<typeof harness>, path: string) {
    h.go(path); h.render(); await hooks.flush(); return h.render();
}
test('update builder separates retain, replace, delete and clears editable notes/preferences', () => {
    const form = { ...emptyLearnerForm, displayName: '架空', confirmedGuidance: ['確認1', '確認2'], disabilityDetail: '情報', disabilitySource: '本人', disabilityConfirmedAt: '2026-11-08T10:00' };
    const keep = buildLearnerProfileUpdate(form, 4);
    assert.equal(Object.hasOwn(keep, 'disabilityInfo'), false);
    assert.deepEqual(keep.confirmedGuidance, ['確認1', '確認2']);
    assert.deepEqual(keep.preferences, {}); assert.deepEqual(keep.learnerWishes, []);
    assert.equal(keep.expectedRevision, 4);
    assert.equal(buildLearnerProfileUpdate({...form, disabilityAction: 'delete'}, 4).disabilityInfo, null);
    assert.equal(buildLearnerProfileUpdate({...form, disabilityAction: 'replace'}, 4).disabilityInfo?.detail, '情報');
    assert.throws(() => buildLearnerProfileUpdate({...emptyLearnerForm, displayName: '架空', disabilityAction: 'replace'}, 1));
});
test('改行を含む確認済み配慮は未編集の往復で変わらない', () => {
    const saved = learnerProfileDetailSchema.parse({ schemaVersion: '1', learnerId: 'a', orgId: 'demo', displayName: 'Aさん',
        confirmedGuidance: ['一つ目\n二つ目'], preferences: {}, enteredBy: 'staff', updatedBy: 'staff', revision: 1, createdAt: '2026-11-08T00:00:00Z' });
    const form = learnerProfileToForm(saved);
    assert.deepEqual(buildLearnerProfileUpdate(form, 1).confirmedGuidance, ['一つ目\n二つ目']);
    assert.equal(form.confirmedGuidance.join('\n'), '一つ目\n二つ目');
    const edited = { ...form, confirmedGuidance: ['一つ目', '二つ目', '三つ目'] };
    assert.deepEqual(buildLearnerProfileUpdate(edited, 1).confirmedGuidance, ['一つ目', '二つ目', '三つ目']);
});
test('edit loads saved values and metadata; PATCH retain/replace/delete return to refreshed detail without altering fixed records', async () => {
    const h = harness();
    const info = {detail: '架空情報', source: '本人確認', confirmedAt: '2026-11-08T00:00:00Z'};
    await h.api('/learners/a', 'PATCH', {expectedRevision: 1, disabilityInfo: info, confirmedGuidance: ['確認済み'], preferences: {audioGuidance: false, displayMode: 'photo_only'}});
    for (const collection of ['releases', 'sessions', 'assignments', 'generationJobs'])
        await h.db.put(collection, { createdAt: '2026-11-08T00:00:00Z', id: 'fixed', orgId: 'demo', learnerId: 'a', releaseId: 'approved-fixed', displayMode: 'photo_only', revision: 1 });
    const fixed = ['releases', 'sessions', 'assignments', 'generationJobs'].map(key => structuredClone(h.db.all(key)));
    for (const action of ['keep', 'replace', 'delete']) {
        let tree = await open(h, '/staff/learners/a');
        button(tree, 'プロフィールを編集する').props.onClick(); h.render(); await hooks.flush(); tree = h.render();
        assert.match(text(tree), /登録者：staff／更新者：staff／revision：/);
        assert.equal(input(tree, '確認済みの配慮').props.value, '確認済み');
        assert.equal(input(tree, '音声ガイド').props.value, 'false');
        for (const n of nodes(tree).filter(n => ['input', 'textarea', 'select'].includes(n.type))) {
            assert.ok(nodes(tree).some(label => label.type === 'label' && nodes(label).includes(n)));
            assert.equal(n.props.tabIndex, undefined);
        }
        change(tree, '障害情報の変更', action); tree = h.render();
        if (action === 'replace') { assert.equal(input(tree, '詳細').props.value, '架空情報'); change(tree, '詳細', '架空置換'); tree = h.render(); }
        change(tree, '表示名', '架空更新'); tree = h.render();
        const before = h.calls.filter(c => c.method === 'PATCH').length;
        confirm(tree); tree = h.render();
        assert.equal(h.calls.filter(c => c.method === 'PATCH').length, before);
        if (action === 'delete') assert.match(text(ProfileValues({profile: nodes(tree).filter(n => n.type === ProfileValues).at(-1).props.profile})), /削除する/);
        button(tree, 'この内容で更新する').props.onClick(); await settle();
        assert.equal(h.path, '/staff/learners/a'); h.render(); await hooks.flush(); tree = h.render();
        const displayed = nodes(tree).find(n => n.type === ProfileValues).props.profile;
        assert.equal(displayed.displayName, '架空更新');
        assert.equal(displayed.disabilityInfo?.detail, action === 'delete' ? undefined : action === 'replace' ? '架空置換' : '架空情報');
    }
    assert.deepEqual(['releases', 'sessions', 'assignments', 'generationJobs'].map(key => h.db.all(key)), fixed);
});
test('409 retains input, refresh shows latest separately, retry uses latest revision; send failure retains preview', async () => {
    const h = harness(); let tree = await open(h, '/staff/learners/a/edit');
    change(tree, '表示名', '自分の入力'); tree = h.render(); confirm(tree); tree = h.render();
    await h.api('/learners/a', 'PATCH', {expectedRevision: 1, displayName: '他職員の更新'});
    button(tree, 'この内容で更新する').props.onClick(); await settle(); tree = h.render();
    assert.match(text(nodes(tree).find(n => n.props.role === 'alert')), /REVISION_CONFLICT/);
    assert.equal(button(tree, 'この内容で更新する').props.disabled, true);
    button(tree, '最新値を取得').props.onClick(); await settle(); tree = h.render();
    assert.equal(input(tree, '表示名').props.value, '自分の入力');
    assert.equal(nodes(tree).find(n => n.type === ProfileValues).props.profile.displayName, '他職員の更新');
    confirm(tree); tree = h.render(); h.setFail(true);
    button(tree, 'この内容で更新する').props.onClick(); await settle(); tree = h.render();
    assert.match(text(nodes(tree).find(n => n.props.role === 'alert')), /通信失敗/);
    h.setFail(false); button(tree, 'この内容で更新する').props.onClick(); await settle();
    assert.equal(h.calls.filter(c => c.method === 'PATCH').at(-1)!.body.expectedRevision, 2);
    assert.equal(h.db.get('learners', 'a')!.displayName, '自分の入力');
});
test('switching learner discards previous input and preview; load failure offers list navigation', async () => {
    const main = await readFile(new URL('../apps/web/src/main.tsx', import.meta.url), 'utf8');
    assert.match(main, /<StaffLearners key=\{path\}/);
    const h = harness(); let tree = await open(h, '/staff/learners/a/edit');
    change(tree, '表示名', '残してはいけない入力'); tree = h.render(); confirm(tree); tree = h.render();
    tree = await open(h, '/staff/learners/b/edit');
    assert.equal(input(tree, '表示名').props.value, h.db.get('learners', 'b')!.displayName);
    assert.equal(button(tree, 'この内容で更新する'), undefined);
    assert.doesNotMatch(text(tree), /残してはいけない入力/);
    tree = await open(h, '/staff/learners/missing/edit');
    assert.ok(nodes(tree).find(n => n.props.role === 'alert'));
    button(tree, '本人一覧へ戻る').props.onClick(); assert.equal(h.path, '/staff/learners');
});
