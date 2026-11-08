import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeSupport, type SupportConnection } from '../apps/web/src/support-ws.ts';
import { staffSupportNotificationSchema } from '../packages/shared/src/support.ts';

function environment() {
    const previous = { WebSocket: globalThis.WebSocket, location: globalThis.location, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const timers = new Map<number, () => void>(), sockets: FakeSocket[] = [], delays: number[] = [];
    let next = 0, fail = false;
    class FakeSocket {
        static OPEN = 1;
        readyState = 0; sent: string[] = [];
        onopen?: () => Promise<void>; onmessage?: (event: { data: string }) => void;
        onclose?: () => void; onerror?: () => void;
        constructor(readonly url: URL) { if (fail) throw Error('unavailable'); sockets.push(this); }
        send(value: string) { this.sent.push(value); }
        close() { this.readyState = 3; this.onclose?.(); }
        async open() { this.readyState = 1; await this.onopen?.(); }
        message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
    }
    Object.assign(globalThis, { WebSocket: FakeSocket, location: new URL('https://demo.example/me'),
        setTimeout: (fn: () => void, delay: number) => { delays.push(delay); timers.set(++next, fn); return next; },
        clearTimeout: (id: number) => { timers.delete(id); } });
    return { sockets, timers, delays, fail: (value: boolean) => { fail = value; },
        retry: () => { const [id, fn] = [...timers][0]; timers.delete(id); fn(); },
        close: () => Object.assign(globalThis, previous) };
}

test('connection failures keep HTTP fallback active; only authenticated snapshots connect, stale sockets and cleanup cannot update views', async () => {
    const env = environment(), states: SupportConnection[] = [], values: unknown[] = [];
    let unsubscribe: (() => void) | undefined;
    try {
        env.fail(true);
        unsubscribe = subscribeSupport(async () => 'private-token', undefined, value => { staffSupportNotificationSchema.parse(value); values.push(value); }, value => states.push(value));
        assert.deepEqual(states, ['connecting', 'disconnected']); assert.deepEqual(env.delays, [3000]);
        env.fail(false); env.retry();
        const first = env.sockets[0]; await first.open();
        assert.equal(first.url.protocol, 'wss:'); assert.equal(first.url.search, ''); assert.doesNotMatch(first.url.href, /private-token/);
        assert.deepEqual(JSON.parse(first.sent[0]), { type: 'auth', idToken: 'private-token' });
        assert.equal(states.at(-1), 'connecting');
        first.message({ schemaVersion: '1', type: 'support.snapshot', requests: [] }); assert.equal(states.at(-1), 'connected');
        first.message({ type: 'invalid' }); assert.equal(states.at(-1), 'disconnected');
        env.retry(); const second = env.sockets[1]; await second.open();
        first.message({ schemaVersion: '1', type: 'support.snapshot', requests: [] }); assert.equal(values.length, 1);
        second.message({ schemaVersion: '1', type: 'support.snapshot', requests: [] }); assert.equal(values.length, 2);
        unsubscribe(); unsubscribe = undefined;
        second.message({ schemaVersion: '1', type: 'support.snapshot', requests: [] }); assert.equal(values.length, 2);
        assert.equal(env.timers.size, 0);
    } finally { unsubscribe?.(); env.close(); }
});

test('closing a subscription while token retrieval is pending sends no credential and schedules no retry', async () => {
    const env = environment(); let resolve!: (token: string) => void;
    const token = new Promise<string>(done => { resolve = done; });
    try {
        const unsubscribe = subscribeSupport(() => token, 's', () => {});
        const socket = env.sockets[0], opened = socket.open();
        unsubscribe(); resolve('private-token'); await opened;
        assert.equal(socket.url.searchParams.get('sessionId'), 's');
        assert.deepEqual(socket.sent, []); assert.equal(env.timers.size, 0);
    } finally { env.close(); }
});
