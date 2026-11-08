export interface Store {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
export type SafetyEvent = {
    clientEventId: string;
    expectedRevision: number;
    type: 'stop' | 'help';
};
export type SafetyState = {
    stopped: boolean;
    waiting: boolean;
    pending: SafetyEvent[];
    helpRevision?: number;
};
export function safetyKey(uid: string, sessionId: string) {
    return `safety:${uid}:${sessionId}`;
}
export function readSafety(store: Store, key: string): SafetyState {
    const value = store.getItem(key);
    if (!value) return { stopped: false, waiting: false, pending: [] };
    try {
        const state = JSON.parse(value);
        if (typeof state.stopped !== 'boolean' || typeof state.waiting !== 'boolean' || !Array.isArray(state.pending)) throw Error('INVALID_SAFETY_STATE');
        return state;
    } catch { return { stopped: true, waiting: false, pending: [] }; }
}
// Persist before issuing a network request; stopped is retained after acknowledgement.
export function hold(store: Store, key: string, event: SafetyEvent) {
    const s = readSafety(store, key);
    if (event.type === 'stop') {
        if (s.stopped) return s;
        s.stopped = true;
        s.waiting = false;
        s.pending = s.pending.filter(value => value.type !== 'help');
    } else {
        if (s.stopped || s.waiting) return s;
        s.waiting = true;
        s.helpRevision = event.expectedRevision + 1;
    }
    s.pending.push(event);
    store.setItem(key, JSON.stringify(s));
    return s;
}
export function delivered(store: Store, key: string, eventId: string, response?: { status: string; revision: number } | void) {
    const s = readSafety(store, key);
    const event = s.pending.find(value => value.clientEventId === eventId);
    if (event?.type === 'help' && response && !s.stopped) {
        if (response.status === 'waiting_help') s.helpRevision = response.revision;
        if (response.status === 'active' && response.revision > (s.helpRevision ?? event.expectedRevision + 1)) s.waiting = false;
    }
    s.pending = s.pending.filter(e => e.clientEventId !== eventId);
    store.setItem(key, JSON.stringify(s));
    return s;
}
export function clearWaiting(store: Store, key: string) {
    const s = readSafety(store, key);
    if (s.stopped) return s;
    s.waiting = false;
    store.setItem(key, JSON.stringify(s));
}
export type SafetyTransport = {
    send: (event: SafetyEvent) => Promise<void | { status: string; revision: number }>;
    load: () => Promise<{
        status: string;
        revision: number;
    }>;
};
const sending = new WeakMap<Store, Map<string, Promise<boolean>>>();
export function flushSafety(store: Store, key: string, transport: SafetyTransport): Promise<boolean> {
    let keys = sending.get(store);
    if (!keys) sending.set(store, keys = new Map());
    const prior = keys.get(key);
    if (prior) return prior;
    const promise = flush(store, key, transport).finally(() => keys!.delete(key));
    keys.set(key, promise);
    return promise;
}
async function flush(store: Store, key: string, transport: SafetyTransport): Promise<boolean> {
    while (true) {
        const event = [...readSafety(store, key).pending].sort((a, b) => Number(b.type === 'stop') - Number(a.type === 'stop'))[0];
        if (!event) return true;
        if (event.type === 'help' && readSafety(store, key).stopped) {
            delivered(store, key, event.clientEventId);
            continue;
        }
        try {
            const response = await transport.send(event);
            delivered(store, key, event.clientEventId, response);
        }
        catch (error) {
            if (event.type === 'help' && (error as {
                status?: number;
            }).status === 409) {
                try {
                    const fresh = await transport.load();
                    if (fresh.status === 'waiting_help') {
                        delivered(store, key, event.clientEventId, fresh);
                        continue;
                    }
                    if (fresh.status === 'stopped') {
                        const s = readSafety(store, key);
                        s.stopped = true;
                        store.setItem(key, JSON.stringify(s));
                        delivered(store, key, event.clientEventId);
                        continue;
                    }
                    // An in-flight next may have committed first. Preserve the event ID and wait state.
                    if (fresh.status === 'active') {
                        if (readSafety(store, key).stopped) continue;
                        const updated = { ...event, expectedRevision: fresh.revision };
                        const s = readSafety(store, key);
                        s.helpRevision = fresh.revision + 1;
                        s.pending = s.pending.map(e => e.clientEventId === event.clientEventId ? updated : e);
                        store.setItem(key, JSON.stringify(s));
                        const response = await transport.send(updated);
                        delivered(store, key, event.clientEventId, response);
                        continue;
                    }
                }
                catch {
                }
            }
            return false;
        }
    }
}

export type PendingSessionStart = { taskId: string; clientRequestId: string; intent?: { type: 'help' | 'stop'; clientEventId: string } };
export const startKey = (uid: string) => `session-start:${uid}`;
export function readSessionStart(store: Store, uid: string): PendingSessionStart | undefined {
    const value = store.getItem(startKey(uid));
    return value ? JSON.parse(value) : undefined;
}
export function beginSessionStart(store: Store, uid: string, taskId: string, clientRequestId: string) {
    const prior = readSessionStart(store, uid);
    if (prior && prior.taskId !== taskId) throw Error('開始中の作業を確認してください');
    const value = prior ?? { taskId, clientRequestId };
    store.setItem(startKey(uid), JSON.stringify(value));
    return value;
}
export function holdStartIntent(store: Store, uid: string, type: 'help' | 'stop', clientEventId: string) {
    const value = readSessionStart(store, uid);
    if (!value || value.intent?.type === 'stop') return value;
    value.intent = { type, clientEventId };
    store.setItem(startKey(uid), JSON.stringify(value));
    return value;
}
