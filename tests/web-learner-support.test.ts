import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { componentHarness, nodes, text, button, tick } from './helpers/component-harness.ts';
import { readSafety, readSessionStart, safetyKey } from '../apps/web/src/safety.ts';

const initialSession = () => ({ schemaVersion: '1', sessionId: 's', releaseId: 'fixed', displayMode: 'photo_text', audioGuidance: false,
    status: 'active', stepIndex: 0, revision: 0, steps: [0, 1].map(index => ({ stepId: `s${index}`, order: index, imageAssetId: `image${index}`, imageAltText: `写真${index}`, text: `工程${index}`, visibleCaution: '' })) });
function storage(data = new Map<string, string>()) {
    return { get length() { return data.size; }, key: (index: number) => [...data.keys()][index], getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
async function page(api: (...args: any[]) => Promise<any>, path = '/me/sessions/s', store = storage()) {
    const key = `learnerPage${crypto.randomUUID()}`, previousStorage = globalThis.localStorage;
    const state: any = { api, path, navigated: [], receive: undefined, closes: 0 };
    (globalThis as any)[key] = state; Object.assign(globalThis, { localStorage: store });
    const file = new URL('../apps/web/src/main.tsx', import.meta.url), main = await readFile(file, 'utf8');
    const learner = main.slice(main.indexOf('function Learner('), main.indexOf('\ncreateRoot('));
    const source = `import React,{useState,useEffect,useRef} from 'react';
import {learnerControlPath} from './learner-controls.ts';
import {learnerStepPresentation} from './learner-display.ts';
import {learnerSupportNotificationSchema} from '../../../packages/shared/src/support.ts';
import {hold,readSafety,flushSafety,safetyKey,clearWaiting,readSessionStart,beginSessionStart,holdStartIntent,startKey} from './safety.ts';
const environment=globalThis[${JSON.stringify(key)}],api=(...args)=>environment.api(...args),account='learner-a',getToken=async()=>account,Asset=()=>null;
const go=path=>environment.navigated.push(path);
const subscribeSupport=(_token,_id,receive,status)=>{environment.receive=receive;status?.('disconnected');return()=>environment.closes++};
export ${learner}`;
    const { module, hooks } = await componentHarness(file, {}, source);
    const render = () => { hooks.begin(); return module.Learner({ uid: 'learner-a', path: state.path, action: async (operation: () => Promise<void>) => { try { await operation(); } catch (error) { state.error = error; } } }); };
    const settle = async () => { render(); await hooks.flush(); await tick(); return render(); };
    await settle();
    return { state, store, render, settle,
        click: async (label: string) => { const node = button(render(), label); assert.ok(node, label); assert.ok(!node.props.disabled, label); node.props.onClick(); await tick(); return settle(); },
        notify: async (payload: unknown) => { state.receive({ schemaVersion: '1', type: 'session.support.snapshot', payload }); await tick(); return settle(); },
        close: () => { hooks.unmount(); delete (globalThis as any)[key]; Object.assign(globalThis, { localStorage: previousStorage }); } };
}
const pictures = (tree: any) => nodes(tree).filter(node => typeof node.type === 'function' && node.type.name === 'Asset');

test('learner applies support revisions, ignores old notifications and resumes only a saved later transition', async () => {
    let server: any = initialSession();
    const api = async (_path: string, method = 'GET', body?: any) => {
        if (method === 'POST') {
            server = { ...server, status: body.type === 'help' ? 'waiting_help' : 'active', revision: server.revision + 1 };
            if (body.type === 'help') server.support = { requestId: 'q', status: 'open', revision: 1 };
        }
        return structuredClone(server);
    };
    const p = await page(api);
    try {
        let tree = await p.click('手伝って'); tree = await p.settle();
        assert.equal(pictures(tree).length, 0); assert.ok(button(tree, 'つづける').props.disabled);
        const payload = (status: string, revision: number) => ({ schemaVersion: '1', sessionId: 's', releaseId: 'fixed', status: 'waiting_help', stepIndex: 0, revision: 1, support: { requestId: 'q', status, revision } });
        tree = await p.notify(payload('assigned', 2)); assert.match(text(tree), /担当の職員が決まりました/);
        tree = await p.notify(payload('open', 1)); assert.match(text(tree), /担当の職員が決まりました/);
        tree = await p.notify(payload('in_progress', 3)); assert.match(text(tree), /職員が手伝っています/);
        tree = await p.notify(payload('acknowledged', 4)); assert.equal(button(tree, 'つづける').props.disabled, false);
        assert.match(text(tree), /つづけるを押すと、同じ工程に戻ります/);
        assert.doesNotMatch(text(tree), /職員の応答を待っています/);
        tree = await p.notify({ schemaVersion: '1', sessionId: 's', releaseId: 'fixed', status: 'active', stepIndex: 0, revision: 1 });
        assert.equal(pictures(tree).length, 0);
        server = { ...server, status: 'active', revision: 2 }; delete server.support;
        tree = await p.notify({ schemaVersion: '1', sessionId: 's', releaseId: 'fixed', status: 'active', stepIndex: 0, revision: 2 });
        assert.equal(pictures(tree)[0].props.id, 'image0'); assert.match(text(tree), /1 \/ 2/);
        assert.ok(p.state.closes > 0);
    } finally { p.close(); }
});

test('delayed next responses and resume notifications cannot revive an offline stopped screen, including reload', async () => {
    let resolveNext!: () => void;
    const gate = new Promise<void>(resolve => { resolveNext = resolve; }), server = initialSession();
    const api = async (_path: string, method = 'GET', body?: any) => {
        if (body?.type === 'next') { await gate; return { ...server, revision: 1, stepIndex: 1 }; }
        if (body?.type === 'stop') throw Error('offline');
        return structuredClone(server);
    };
    const store = storage(); let p = await page(api, '/me/sessions/s', store);
    try {
        await p.click('つぎへ'); let tree = await p.click('やめる');
        assert.match(text(tree), /作業をやめました/); assert.equal(pictures(tree).length, 0);
        const id = readSafety(store, safetyKey('learner-a', 's')).pending[0].clientEventId;
        resolveNext(); tree = await p.settle(); assert.equal(pictures(tree).length, 0); assert.equal(button(tree, 'つぎへ'), undefined);
        p.close(); p = await page(api, '/me/sessions/s', store);
        tree = p.render(); assert.match(text(tree), /作業をやめました/); assert.equal(pictures(tree).length, 0);
        assert.equal(readSafety(store, safetyKey('learner-a', 's')).pending[0].clientEventId, id);
        assert.equal(p.state.receive, undefined);
    } finally { p.close(); }
});

test('stop pressed during start remains immediate and is recovered with the same request after reload', async () => {
    const store = storage(), starts: any[] = [], never = new Promise(() => {});
    let p = await page(async (path, _method, body) => {
        if (path === '/me/assignments') return { assignments: [{ taskId: 'task', title: 'タオル' }] };
        starts.push(body); return never;
    }, '/me', store);
    await p.click('はじめる'); let tree = await p.click('やめる');
    assert.match(text(tree), /作業をやめました/); assert.equal(pictures(tree).length, 0);
    const pending = readSessionStart(store, 'learner-a')!;
    assert.equal(pending.clientRequestId, starts[0].clientRequestId); assert.equal(pending.intent!.type, 'stop');
    p.close();
    p = await page(async (path, _method, body) => {
        if (path === '/me/assignments') return { assignments: [] };
        starts.push(body); return initialSession();
    }, '/me', store);
    try {
        assert.equal(starts[1].clientRequestId, starts[0].clientRequestId);
        assert.deepEqual(p.state.navigated, ['/me/sessions/s']);
        const safety = readSafety(store, safetyKey('learner-a', 's'));
        assert.equal(safety.stopped, true); assert.equal(safety.pending[0].clientEventId, pending.intent!.clientEventId);
        assert.equal(readSessionStart(store, 'learner-a'), undefined);
    } finally { p.close(); }
});
