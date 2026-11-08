import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
import { buildLearnerProfile, emptyLearnerForm } from '../apps/web/src/learner-form.ts';
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
    const go = (value: string) => { path = value; hooks.reset(); };
    const api = async (url: string, method = 'GET', body?: unknown) => {
        if (method === 'POST') { posts++; if (fail) throw Error('通信失敗'); }
        const response = await app.fetch(new Request('http://localhost/api/v1' + url, { method, headers: { authorization: 'Bearer staff', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
        const result = await response.json();
        assert.equal(response.status, method === 'POST' ? 201 : 200);
        return result;
    };
    const render = () => { hooks.begin(); return StaffLearners({ path, api, go }); };
    return { render, db, get path() { return path; }, get posts() { return posts; }, setFail(value: boolean) { fail = value; } };
}

test('form payload omits unknown values, preserves false and separates wishes/observations/suggestions', () => {
    assert.deepEqual(buildLearnerProfile({ ...emptyLearnerForm, displayName: '架空C' }), { displayName: '架空C' });
    const body = buildLearnerProfile({ ...emptyLearnerForm, displayName: '架空C', learnerWishes: '写真がよい', staffObservations: '写真を見た', staffSuggestions: '写真で試す', audioGuidance: 'false', displayMode: 'photo_only', sentenceLength: '1' });
    assert.deepEqual(body, { displayName: '架空C', learnerWishes: ['写真がよい'], staffObservations: ['写真を見た'], staffSuggestions: ['写真で試す'], preferences: { audioGuidance: false, displayMode: 'photo_only', sentenceLength: 1 } });
    assert.equal(JSON.stringify(body).includes('null'), false);
});
test('payload rejects blank names, invalid ranges, oversized notes and incomplete disability information', () => {
    for (const patch of [{ displayName: '  ' }, { sentenceLength: '0' }, { sentenceLength: '41' }, { sentenceLength: '1.5' }, { splitHints: 'x'.repeat(201) }, { staffSuggestions: 'x'.repeat(501) }, { disabilityDetail: '架空情報' }])
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
