import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Auth, Repository, Doc } from './adapters.ts';
import type { Member } from '../../../packages/shared/src/index.ts';
import { supportWsAuthSchema, supportRequestSchema, staffSupportNotificationSchema, learnerSupportNotificationSchema } from '../../../packages/shared/src/support.ts';

export function supportRequestDto(q: Doc) {
    return supportRequestSchema.parse({
        schemaVersion: '1', requestId: q.id, sessionId: q.sessionId, eventId: q.eventId,
        kind: q.kind, status: q.status, revision: q.revision, createdAt: q.createdAt,
        ...(q.kind === 'help' && q.status !== 'open' ? { assignedTo: q.assignedTo, assignedAt: q.assignedAt } : {}),
        ...(q.kind === 'help' && ['in_progress', 'acknowledged'].includes(q.status) ? { startedBy: q.startedBy, startedAt: q.startedAt } : {}),
        ...(q.status === 'acknowledged' ? { acknowledgedBy: q.acknowledgedBy, acknowledgedAt: q.acknowledgedAt } : {})
    });
}

// Bounded RFC 6455 transport: only the small JSON auth message is accepted from clients.
function connection(socket: Duplex, onMessage: (value: string) => void, onClose: () => void) {
    let buffer = Buffer.alloc(0), fragments: Buffer[] = [], total = 0, fragmented = false, closed = false;
    function frame(opcode: number, data: Buffer) {
        if (closed) return;
        const header = Buffer.alloc(data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10);
        header[0] = 0x80 | opcode;
        header[1] = header.length === 2 ? data.length : header.length === 4 ? 126 : 127;
        if (header.length === 4) header.writeUInt16BE(data.length, 2);
        if (header.length === 10) header.writeBigUInt64BE(BigInt(data.length), 2);
        // Slow consumers reconnect for a fresh snapshot instead of retaining unbounded data.
        if (socket.writableLength + data.length > 1024 * 1024) { close(); return; }
        socket.write(Buffer.concat([header, data]));
    }
    function close(code = 1008) {
        if (closed) return;
        const data = Buffer.alloc(2); data.writeUInt16BE(code);
        if (socket.writableLength < 1024 * 1024) socket.write(Buffer.concat([Buffer.from([0x88, 2]), data]));
        closed = true;
        onClose();
        socket.end();
        const timer = setTimeout(() => socket.destroy(), 1000);
        timer.unref();
        socket.once('close', () => clearTimeout(timer));
    }
    socket.on('error', () => socket.destroy());
    socket.once('end', () => socket.destroy());
    socket.once('close', () => { closed = true; onClose(); });
    function receive(chunk: Buffer) {
        if (closed) return;
        if (buffer.length + chunk.length > 65536) return close(1009);
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2 && !closed) {
            const fin = !!(buffer[0] & 128), opcode = buffer[0] & 15;
            let length = buffer[1] & 127, offset = 2;
            if ((buffer[0] & 112) || !(buffer[1] & 128) || ![0, 1, 8, 9, 10].includes(opcode)) return close(1002);
            if (length === 127) return close(1009);
            if (length === 126) {
                if (buffer.length < 4) return;
                length = buffer.readUInt16BE(2); offset = 4;
                if (length < 126) return close(1002);
            }
            if (opcode >= 8 && (!fin || length > 125)) return close(1002);
            if (length + total > 16384) return close(1009);
            if (buffer.length < offset + 4 + length) return;
            const mask = buffer.subarray(offset, offset + 4);
            const data = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
            buffer = buffer.subarray(offset + 4 + length);
            for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
            if (opcode === 8) return close(1000);
            if (opcode === 9) { frame(10, data); continue; }
            if (opcode === 10) continue;
            if ((opcode === 0) !== fragmented) return close(1002);
            if (fragments.length >= 128) return close(1009);
            fragments.push(data); total += length; fragmented = !fin;
            if (fin) {
                try { onMessage(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(fragments))); }
                catch { return close(); }
                fragments = []; total = 0;
            }
        }
    }
    socket.on('data', receive);
    return { receive, close, send: (value: unknown) => frame(1, Buffer.from(JSON.stringify(value))) };
}

export function supportWebSocket(db: Repository, auth: Auth) {
    type Client = { member: Member; sessionId?: string; expiresAt: number; send: (value: unknown) => void; close: () => void };
    const clients = new Set<Client>();
    async function snapshot(client: Client) {
        if (!clients.has(client)) return;
        if (client.expiresAt <= Date.now()) { client.close(); return; }
        const m = client.member;
        // Serialize reads with mutations so session and support revisions describe one saved state.
        const value = await db.transaction(async () => {
            if (m.role === 'staff') return staffSupportNotificationSchema.parse({ schemaVersion: '1', type: 'support.snapshot',
                requests: (await db.all('supportRequests')).filter(q => q.orgId === m.orgId && q.status !== 'acknowledged').map(supportRequestDto) });
            const s = await db.get('sessions', client.sessionId!);
            if (!s || s.orgId !== m.orgId || s.learnerId !== m.learnerId) throw Error('FORBIDDEN');
            const q = s.activeSupportRequestId ? await db.get('supportRequests', s.activeSupportRequestId) : undefined;
            if (q && (q.orgId !== m.orgId || q.sessionId !== s.id)) throw Error('FORBIDDEN');
            return learnerSupportNotificationSchema.parse({ schemaVersion: '1', type: 'session.support.snapshot', payload: {
                schemaVersion: '1', sessionId: s.id, releaseId: s.releaseId, status: s.status, stepIndex: s.stepIndex, revision: s.revision,
                ...(q ? { support: { requestId: q.id, status: q.status, revision: q.revision } } : {})
            } });
        });
        if (clients.has(client) && client.expiresAt > Date.now()) client.send(value);
    }
    function refresh(client: Client) { void snapshot(client).catch(() => client.close()); }
    // shortcut: local process delivery only; add Firestore watches for multiple API instances.
    function publish(orgId: string, sessionId: string) {
        for (const client of clients)
            if (client.member.orgId === orgId && (client.member.role === 'staff' || client.sessionId === sessionId)) refresh(client);
    }
    return {
        publish,
        publishRequest(orgId: string, requestId: string) {
            void Promise.resolve().then(() => db.get('supportRequests', requestId)).then(q => {
                if (q?.orgId === orgId) publish(orgId, q.sessionId);
            }).catch(() => { /* HTTP commit remains valid; reconnect/poll recovers notification failures. */ });
        },
        upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
            const reject = () => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
            let url: URL;
            try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { reject(); return; }
            const origin = req.headers.origin;
            const allowedOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
            const key = req.headers['sec-websocket-key'];
            if (url.pathname !== '/api/v1/ws' || [...url.searchParams.keys()].some(k => k !== 'sessionId') || url.searchParams.getAll('sessionId').length > 1 ||
                !origin || origin !== allowedOrigin || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
                !req.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade') || req.headers['sec-websocket-version'] !== '13' ||
                typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) { reject(); return; }
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
                createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
            let client: Client | undefined, attempted = false, ended = false;
            let expiry: ReturnType<typeof setTimeout> | undefined;
            const timeout = setTimeout(() => wire.close(), 5000);
            const wire = connection(socket, message => {
                if (attempted) { wire.close(); return; }
                attempted = true;
                void (async () => {
                    const { idToken } = supportWsAuthSchema.parse(JSON.parse(message));
                    const m = await auth.verify(idToken);
                    if (ended) return;
                    if (!m || !m.expiresAt || !Number.isFinite(m.expiresAt) || m.expiresAt <= Date.now() || !['staff', 'learner'].includes(m.role)) throw Error('AUTH');
                    const sessionId = url.searchParams.get('sessionId') ?? undefined;
                    if (m.role === 'staff' ? sessionId !== undefined : !sessionId || !m.learnerId) throw Error('SCOPE');
                    client = { member: m, sessionId, expiresAt: m.expiresAt, send: wire.send, close: wire.close };
                    clients.add(client);
                    expiry = setTimeout(() => wire.close(), Math.min(m.expiresAt - Date.now(), 2147483647));
                    await snapshot(client);
                    clearTimeout(timeout);
                })().catch(() => wire.close());
            }, () => {
                ended = true; clearTimeout(timeout); clearTimeout(expiry);
                if (client) clients.delete(client);
            });
            if (head.length) wire.receive(head);
        }
    };
}
