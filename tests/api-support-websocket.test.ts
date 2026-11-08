import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, DemoAuth, seed, doc } from '../apps/api/src/adapters.ts';
import { learnerSupportNotificationSchema, staffSupportNotificationSchema } from '../packages/shared/src/support.ts';

async function harness(t: any, verify?: DemoAuth['verify']) {
    const db = new MemoryRepository(); seed(db);
    db.put('sessions', doc('demo', { id: 's', learnerId: 'a', releaseId: 'r', status: 'waiting_help', stepIndex: 2, revision: 1, activeSupportRequestId: 'q', staffMemo: 'PRIVATE' }));
    db.put('supportRequests', doc('demo', { id: 'q', sessionId: 's', eventId: 'e', kind: 'help', status: 'open', revision: 1, staffMemo: 'PRIVATE', profile: 'PRIVATE' }));
    const { app } = createApp({ db, ...(verify ? { auth: { verify } } : {}) });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const sockets: ReturnType<typeof connect>[] = [];
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
    const port = (server.address() as any).port;
    async function open(query = '', origin = 'http://localhost:5173') {
        const socket = connect(port, '127.0.0.1'); sockets.push(socket);
        let buffer = Buffer.alloc(0), upgraded = false;
        const queue: any[] = [], waiters: ((v: any) => void)[] = [];
        const deliver = (value: any) => { if (waiters.length) waiters.shift()!(value); else queue.push(value); };
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            if (!upgraded) {
                const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
                const headers = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 4); upgraded = true;
                deliver({ headers });
            }
            while (buffer.length >= 2) {
                let length = buffer[1] & 127, offset = 2;
                if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
                if (buffer.length < offset + length) return;
                const data = buffer.subarray(offset, offset + length), opcode = buffer[0] & 15;
                buffer = buffer.subarray(offset + length);
                deliver(opcode === 8 ? { close: data.readUInt16BE() } : JSON.parse(data.toString()));
            }
        });
        const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise<any>(resolve => waiters.push(resolve));
        const send = (value: unknown, opcode = 1, fin = true) => {
            const data = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
            const header = Buffer.from([ (fin ? 128 : 0) | opcode, 128 | data.length, 1, 2, 3, 4 ]);
            socket.write(Buffer.concat([header, Buffer.from(data.map((b, i) => b ^ header[2 + i % 4]))]));
        };
        socket.write(`GET /api/v1/ws${query} HTTP/1.1\r\nHost: localhost:${port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
        const headers = (await next()).headers;
        return { next, send, headers, socket, queue, auth: (idToken: string) => send({ type: 'auth', idToken }) };
    }
    async function post(path: string, body = {}, token = 'staff') {
        return app.fetch(new Request(`http://localhost/api/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    }
    return { db, open, post };
}

test('WebSocket: Origin・URLトークン・購読指定の検査', { timeout: 10000 }, async t => {
    const h = await harness(t);
    for (const [query, origin] of [['', 'https://evil.invalid'], ['?idToken=secret', 'http://localhost:5173'], ['?orgId=demo', 'http://localhost:5173'], ['?sessionId=s&sessionId=s', 'http://localhost:5173']]) {
        const ws = await h.open(query, origin); assert.match(ws.headers, /403/); assert.ok(!ws.headers.includes('secret'));
    }
});

test('WebSocket: 未認証接続を5秒で切断し、認証失敗・新人・別本人・別orgセッションを拒否', { timeout: 12000 }, async t => {
    const h = await harness(t);
    const idle = await h.open(); const start = Date.now();
    assert.equal((await idle.next()).close, 1008);
    assert.ok(Date.now() - start >= 4800 && Date.now() - start < 6500);
    for (const [token, query] of [['missing', ''], ['newcomer', ''], ['learner-b', '?sessionId=s'], ['other-staff', '?sessionId=s'], ['learner-a', ''], ['staff', '?sessionId=s']]) {
        const ws = await h.open(query); ws.auth(token); assert.equal((await ws.next()).close, 1008);
    }
});

test('WebSocket: 期限切れと期限到来で切断、検証例外を応答へ漏らさない', { timeout: 10000 }, async t => {
    const h = await harness(t, async token => {
        if (token === 'throw') throw Error('secret');
        return { uid: 'staff', orgId: 'demo', role: 'staff', expiresAt: Date.now() + (token === 'expired' ? -1 : 200) };
    });
    for (const token of ['expired', 'throw']) { const ws = await h.open(); ws.auth(token); assert.deepEqual(await ws.next(), { close: 1008 }); }
    const ws = await h.open(); ws.auth('valid'); assert.equal((await ws.next()).type, 'support.snapshot'); assert.equal((await ws.next()).close, 1008);
});

test('WebSocket: 保存後にrevisionと本人専用DTOを配信し、再接続は最新値・別org一覧は空', { timeout: 10000 }, async t => {
    const h = await harness(t);
    const staff = await h.open(); staff.auth('staff');
    assert.equal(staffSupportNotificationSchema.parse(await staff.next()).type, 'support.snapshot');
    const other = await h.open(); other.auth('other-staff'); assert.deepEqual((await other.next()).requests, []);
    h.db.put('sessions', doc('demo', { id: 's-b', learnerId: 'b', releaseId: 'r-b', status: 'active', stepIndex: 0, revision: 0 }));
    const unrelated = await h.open('?sessionId=s-b'); unrelated.auth('learner-b'); await unrelated.next();
    const learner = await h.open('?sessionId=s'); learner.auth('learner-a');
    const initial = learnerSupportNotificationSchema.parse(await learner.next());
    assert.equal(initial.payload.support?.revision, 1);
    assert.ok(!JSON.stringify(initial).includes('PRIVATE'));
    assert.deepEqual(Object.keys(initial.payload).sort(), ['releaseId', 'revision', 'schemaVersion', 'sessionId', 'status', 'stepIndex', 'support']);
    assert.equal((await h.post('/support-requests/q/claim', {}, 'other-staff')).status, 403);
    assert.equal((await h.post('/support-requests/q/claim')).status, 200);
    const saved = h.db.get('supportRequests', 'q')!;
    assert.equal((await staff.next()).requests[0].revision, saved.revision);
    assert.equal((await learner.next()).payload.support.revision, saved.revision);
    assert.deepEqual(other.queue, []); assert.deepEqual(unrelated.queue, []);
    assert.equal((await h.post('/support-requests/q/start')).status, 200);
    await staff.next(); await learner.next();
    // A resume needs only the pinned release's step references, never record/profile content.
    h.db.put('releases', doc('demo', { id: 'r', learnerSteps: [{stepId:'a'}, {stepId:'b'}, {stepId:'c'}] }));
    assert.equal((await h.post('/support-requests/q/resume', { clientRequestId: 'resume', expectedSessionRevision: 1 })).status, 200);
    const resumed = (await learner.next()).payload;
    assert.equal(resumed.status, 'active'); assert.equal(resumed.revision, 2); assert.equal(resumed.stepIndex, 2); assert.equal(resumed.releaseId, 'r');
    assert.ok(!('support' in resumed));
    const reconnected = await h.open('?sessionId=s'); reconnected.auth('learner-a');
    assert.deepEqual((await reconnected.next()).payload, resumed);
    assert.equal((await h.post('/me/sessions/s/events', { clientEventId: 'stop', expectedRevision: 0, type: 'stop' }, 'learner-a')).status, 200);
    assert.equal((await learner.next()).payload.status, 'stopped');
    assert.equal((await h.post('/support-requests/q/resume', { clientRequestId: 'again', expectedSessionRevision: 3 })).status, 409);
});

test('WebSocket: 分割authを受け、二回目のメッセージと不正JSONを拒否', { timeout: 10000 }, async t => {
    const h = await harness(t);
    const ws = await h.open(); ws.send('{"type":"auth",', 1, false); ws.send('"idToken":"staff"}', 0);
    assert.equal((await ws.next()).type, 'support.snapshot');
    ws.auth('other-staff'); assert.equal((await ws.next()).close, 1008);
    const invalid = await h.open(); invalid.send('not json'); assert.equal((await invalid.next()).close, 1008);
});


test('WebSocket: 保存失敗では通知せず、再認証後も保存前の状態を返す', { timeout: 10000 }, async t => {
    const h = await harness(t);
    const ws = await h.open(); ws.auth('staff'); await ws.next();
    const put = h.db.put.bind(h.db);
    h.db.put = (collection, value) => {
        put(collection, value);
        if (collection === 'supportRequests') throw Error('save failed');
    };
    assert.equal((await h.post('/support-requests/q/claim')).status, 500);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(ws.queue, []);
    assert.equal(h.db.get('supportRequests', 'q')!.revision, 1);
    const retry = await h.open(); retry.auth('staff'); assert.equal((await retry.next()).requests[0].status, 'open');
});

test('WebSocket: マスクなし・バイナリ・巨大フレームを拒否', { timeout: 10000 }, async t => {
    const h = await harness(t);
    for (const bytes of [Buffer.from([0x81, 2, 123, 125]), Buffer.from([0x82, 0x80]), Buffer.from([0x81, 0xff])]) {
        const ws = await h.open(); ws.socket.write(bytes); assert.ok((await ws.next()).close);
    }
});
