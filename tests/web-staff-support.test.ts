import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportHarness } from './helpers/support-harness.ts';
import { componentHarness, nodes, text, button, tick } from './helpers/component-harness.ts';

async function page(api: ReturnType<Awaited<ReturnType<typeof supportHarness>>['api']>, token = 'staff') {
    const key = `supportPage${crypto.randomUUID()}`;
    let receive: (value: unknown) => void, status: (value: string) => void, closed = 0;
    (globalThis as any)[key] = (_getToken: unknown, _session: unknown, next: typeof receive, connection: typeof status) => {
        receive = next; status = connection; connection('disconnected'); return () => { closed++; };
    };
    const mock = 'data:text/javascript;base64,' + Buffer.from(`export const subscribeSupport=(...args)=>globalThis[${JSON.stringify(key)}](...args);`).toString('base64');
    const { module, hooks } = await componentHarness(new URL('../apps/web/src/staff-support.tsx', import.meta.url), { './support-ws.ts': mock });
    const render = () => { hooks.begin(); return module.StaffSupport({ api, getToken: async () => token, go: () => {} }); };
    const settle = async () => { render(); await hooks.flush(); await tick(); return render(); };
    let tree = await settle();
    return { render, settle, initial: tree,
        click: async (label: string) => { const node = button(render(), label); assert.ok(node, label); assert.ok(!node.props.disabled, label); node.props.onClick(); await tick(); return settle(); },
        notify: async () => { receive!({ schemaVersion: '1', type: 'support.snapshot', requests: (await api('/support-requests')).requests }); await tick(); return settle(); },
        connected: async () => { status!('connected'); return settle(); },
        close: () => { hooks.unmount(); delete (globalThis as any)[key]; },
        closed: () => closed };
}

test('two staff views resolve claim competition and expose only allowed operations for help and stop', async () => {
    const h = await supportHarness(), first = await page(h.api()), second = await page(h.api('staff-2'), 'staff-2');
    try {
        assert.match(text(first.initial), /Aさん.*タオル包装.*工程 1/);
        const one = button(first.render(), '担当します'), two = button(second.render(), '担当します');
        one.props.onClick(); two.props.onClick(); await tick();
        let a = await first.settle(), b = await second.settle();
        assert.equal(h.db.get('supportRequests', h.requestId)!.assignedTo, 'staff');
        assert.ok(button(a, '対応を始める')); assert.equal(button(b, '対応を始める'), undefined);
        assert.match(text(b), /担当または状態が変わりました/);
        assert.equal(button(b, '対応を終えてつづける'), undefined);
        await h.api('learner-a')(`/me/sessions/${h.sessionId}/events`, 'POST', { clientEventId: 'stop', expectedRevision: 0, type: 'stop' });
        a = await first.notify();
        const stopped = nodes(a).find(node => node.type === 'section' && node.props['aria-label']?.startsWith('停止通知'));
        assert.ok(button(stopped, '停止通知を確認した'));
        assert.equal(button(stopped, '担当します'), undefined);
        assert.equal(button(stopped, '対応を始める'), undefined);
        assert.equal(button(stopped, '対応を終えてつづける'), undefined);
        assert.equal(button(stopped, '支援記録を開く'), undefined);
    } finally { first.close(); second.close(); }
});

test('record postponement, completed tab, notifications and conflict recovery retain all typed input', async () => {
    const h = await supportHarness(), p = await page(h.api());
    try {
        await p.click('担当します'); let tree = await p.click('対応を始める');
        const fields = nodes(tree).filter(node => node.type === 'textarea');
        assert.equal(fields.length, 3); assert.ok(fields.every(node => node.props.maxLength === 2000));
        fields[0].props.onChange({ target: { value: '袋の口で止まった' } });
        fields[1].props.onChange({ target: { value: '袋の口を広げる手本を示した' } });
        await p.click('後で記録する'); await p.click('対応完了のみを記録');
        tree = await p.click('対応完了・後から記録');
        tree = await p.click('支援記録を開く');
        assert.deepEqual(nodes(tree).filter(node => node.type === 'textarea').map(node => node.props.value), ['袋の口で止まった', '袋の口を広げる手本を示した', '']);
        await h.api('staff-2')(`/support-requests/${h.requestId}/record`, 'PUT', { expectedRevision: 0, observedDifficulty: '別の保存済み記録', assistanceGiven: '', improvementSuggestion: '' });
        tree = await p.click('記録を保存する');
        assert.match(text(tree), /別の保存済み記録/); assert.match(text(tree), /入力は残っています/);
        assert.equal(nodes(tree).find(node => node.type === 'textarea').props.value, '袋の口で止まった');
        tree = await p.notify(); tree = await p.connected();
        assert.equal(nodes(tree).find(node => node.type === 'textarea').props.value, '袋の口で止まった');
        await p.click('入力を残して、最新版を基に編集を続ける');
        tree = await p.click('記録を保存する'); assert.match(text(tree), /記録を保存しました/);
        const saved = await h.api()(`/support-requests/${h.requestId}/record`);
        assert.equal(saved.revision, 2); assert.equal(saved.observedDifficulty, '袋の口で止まった');
        assert.equal(saved.assistanceGiven, '袋の口を広げる手本を示した');
    } finally { p.close(); }
    assert.ok(p.closed() > 0);
});

test('record failure never blocks staff resume; a later save uses the preserved form', async () => {
    const h = await supportHarness(), api = h.api(); let fail = true;
    const p = await page(async (path, method, body) => {
        if (method === 'PUT' && path.endsWith('/record') && fail) { fail = false; throw Object.assign(Error('offline'), { status: 500 }); }
        return api(path, method, body);
    });
    try {
        await p.click('担当します'); let tree = await p.click('対応を始める');
        nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: '保存に失敗しても残す文章' } });
        tree = await p.click('記録を保存する'); assert.match(text(tree), /保存できませんでした/);
        const consent = nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox');
        assert.ok(button(tree, '対応を終えてつづける').props.disabled);
        consent.props.onChange({ target: { checked: true } });
        tree = await p.click('対応を終えてつづける');
        const resumed = await h.api('learner-a')(`/me/sessions/${h.sessionId}`);
        assert.equal(resumed.status, 'active'); assert.equal(resumed.stepIndex, 0); assert.equal(resumed.releaseId, h.releaseId);
        assert.equal(nodes(tree).find(node => node.type === 'textarea').props.value, '保存に失敗しても残す文章');
        await p.click('記録を保存する');
        assert.equal((await api(`/support-requests/${h.requestId}/record`)).observedDifficulty, '保存に失敗しても残す文章');
    } finally { p.close(); }
});

test('a successful start is not reported as a failed write when list refresh fails, and its record form still opens', async () => {
    const h = await supportHarness(), api = h.api(); let failList = false;
    const p = await page(async (path, method, body) => {
        if (path === '/support-requests' && failList) { failList = false; throw Error('read failed'); }
        const response = await api(path, method, body);
        if (path.endsWith('/start')) failList = true;
        return response;
    });
    try {
        await p.click('担当します'); const tree = await p.click('対応を始める');
        assert.equal(h.db.get('supportRequests', h.requestId)!.status, 'in_progress');
        assert.match(text(tree), /操作は保存しましたが、一覧を再取得できませんでした/);
        assert.doesNotMatch(text(tree), /操作を保存できませんでした/);
        assert.equal(nodes(tree).filter(node => node.type === 'textarea').length, 3);
    } finally { p.close(); }
});
