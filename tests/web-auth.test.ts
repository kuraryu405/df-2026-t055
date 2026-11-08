import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeSupport } from '../apps/web/src/support-ws.ts';

test('web socket fetches a fresh token for each connection and cancels pending authentication on cleanup', async t => {
    const previousSocket = globalThis.WebSocket;
    const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const connections: FakeSocket[] = [];
    class FakeSocket {
        static OPEN = 1;
        readyState = 1;
        messages: string[] = [];
        onopen: () => Promise<void> = async () => {};
        onclose: () => void = () => {};
        onmessage: any;
        onerror: any;
        constructor(public url: URL) { connections.push(this); }
        send(value: string) { this.messages.push(value); }
        close() { this.readyState = 3; this.onclose(); }
    }
    t.mock.timers.enable({ apis: ['setTimeout'] });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('https://demo.invalid/me') });
    globalThis.WebSocket = FakeSocket as any;
    let stop: (() => void) | undefined;
    try {
        let calls = 0;
        stop = subscribeSupport(async () => 'token-' + ++calls, 'session', () => {});
        await connections[0].onopen();
        assert.deepEqual(JSON.parse(connections[0].messages[0]), { type: 'auth', idToken: 'token-1' });
        assert.equal(connections[0].url.href, 'wss://demo.invalid/api/v1/ws?sessionId=session');
        connections[0].close(); t.mock.timers.tick(3000);
        await connections[1].onopen();
        assert.equal(JSON.parse(connections[1].messages[0]).idToken, 'token-2');
        stop();
        let resolveToken!: (token: string) => void;
        stop = subscribeSupport(() => new Promise(resolve => { resolveToken = resolve; }), undefined, () => {});
        const pending = connections[2].onopen();
        stop(); resolveToken('private'); await pending;
        assert.deepEqual(connections[2].messages, []);
        t.mock.timers.tick(3000); assert.equal(connections.length, 3);
    } finally {
        stop?.();
        globalThis.WebSocket = previousSocket;
        if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
        else Reflect.deleteProperty(globalThis, 'location');
    }
});
