import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hold, readSafety, flushSafety, clearWaiting, beginSessionStart, holdStartIntent,
    readSessionStart, type Store, type SafetyEvent } from '../apps/web/src/safety.ts';

function memory() {
    const data = new Map<string, string>();
    const store: Store = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
    return { data, store };
}
const help = { type: 'help', clientEventId: 'help', expectedRevision: 3 } as const;
const stop = { type: 'stop', clientEventId: 'stop', expectedRevision: 0 } as const;

test('stop immediately persists, removes queued help and keeps the same stop key across reload and retry', async () => {
    const { store } = memory();
    hold(store, 's', help); hold(store, 's', stop); hold(store, 's', { ...stop, clientEventId: 'double-tap' });
    assert.deepEqual(readSafety(store, 's').pending, [stop]);
    const sent: unknown[] = [];
    assert.equal(await flushSafety(store, 's', { send: async value => { sent.push(value); throw Error('offline'); }, load: async () => { throw Error('offline'); } }), false);
    assert.equal(readSafety(store, 's').stopped, true);
    assert.equal(readSafety(store, 's').pending[0].clientEventId, 'stop');
    assert.equal(await flushSafety(store, 's', { send: async value => { sent.push(value); return { status: 'stopped', revision: 8 }; }, load: async () => ({ status: 'stopped', revision: 8 }) }), true);
    assert.deepEqual(sent, [stop, stop]);
    assert.equal(readSafety(store, 's').stopped, true);
    assert.deepEqual(readSafety(store, 's').pending, []);
    clearWaiting(store, 's'); hold(store, 's', help);
    assert.equal(readSafety(store, 's').stopped, true); assert.deepEqual(readSafety(store, 's').pending, []);
});

test('a stop queued during a help request is sent next; concurrent flushes share one request', async () => {
    const { store } = memory(), sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const transport = { send: async (value: SafetyEvent) => {
        sent.push(value.type); if (value.type === 'help') await gate;
        return { status: value.type === 'help' ? 'waiting_help' : 'stopped', revision: 4 };
    }, load: async () => ({ status: 'active', revision: 3 }) };
    hold(store, 's', help);
    const first = flushSafety(store, 's', transport);
    hold(store, 's', stop);
    const second = flushSafety(store, 's', transport);
    assert.equal(first, second);
    release(); await first;
    assert.deepEqual(sent, ['help', 'stop']);
    assert.equal(readSafety(store, 's').stopped, true); assert.deepEqual(readSafety(store, 's').pending, []);
});

test('help conflict retries at the saved revision without changing its key or losing the wait', async () => {
    const { store } = memory(), sent: unknown[] = [];
    hold(store, 's', help);
    let first = true;
    await flushSafety(store, 's', { send: async value => {
        sent.push(value); if (first) { first = false; throw { status: 409 }; }
        return { status: 'waiting_help', revision: 6 };
    }, load: async () => ({ status: 'active', revision: 5 }) });
    assert.deepEqual(sent, [help, { ...help, expectedRevision: 5 }]);
    assert.equal(readSafety(store, 's').waiting, true);
    assert.equal(readSafety(store, 's').helpRevision, 6);
});

test('a successful help retry already resumed on the server can settle the wait, but never a local stop', async () => {
    const { store } = memory(); hold(store, 's', help);
    await flushSafety(store, 's', { send: async () => ({ status: 'active', revision: 5 }), load: async () => ({ status: 'active', revision: 5 }) });
    assert.equal(readSafety(store, 's').waiting, false);
    hold(store, 's', stop); clearWaiting(store, 's');
    assert.equal(readSafety(store, 's').stopped, true);
});

test('pending start and stop survive reload, reuse the start key and cannot be replaced with help or another task', () => {
    const { store } = memory();
    beginSessionStart(store, 'learner-a', 'task', 'start-key');
    holdStartIntent(store, 'learner-a', 'help', 'help-key');
    holdStartIntent(store, 'learner-a', 'stop', 'stop-key');
    holdStartIntent(store, 'learner-a', 'help', 'late-help-key');
    assert.deepEqual(readSessionStart(store, 'learner-a'), { taskId: 'task', clientRequestId: 'start-key', intent: { type: 'stop', clientEventId: 'stop-key' } });
    assert.equal(beginSessionStart(store, 'learner-a', 'task', 'new-key').clientRequestId, 'start-key');
    assert.throws(() => beginSessionStart(store, 'learner-a', 'other-task', 'new-key'));
    assert.equal(readSessionStart(store, 'learner-b'), undefined);
});

test('corrupt saved safety data fails closed instead of displaying procedure content', () => {
    const { store } = memory();
    for (const value of ['{', '{}', 'null']) {
        store.setItem('s', value);
        assert.deepEqual(readSafety(store, 's'), { stopped: true, waiting: false, pending: [] });
    }
});
