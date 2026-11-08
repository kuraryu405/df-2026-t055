import type { TokenProvider } from './auth.ts';
export type SupportConnection = 'connecting' | 'connected' | 'disconnected';
export function subscribeSupport(getToken: TokenProvider, sessionId: string | undefined, receive: (value: unknown) => void,
    status: (value: SupportConnection) => void = () => {}) {
    let active = true, socket: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    function reconnect() {
        if (!active) return;
        status('disconnected');
        clearTimeout(timer);
        timer = setTimeout(connect, 3000);
    }
    function connect() {
        if (!active) return;
        status('connecting');
        const url = new URL('/api/v1/ws', location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        if (sessionId) url.searchParams.set('sessionId', sessionId);
        let current: WebSocket;
        try { current = socket = new WebSocket(url); }
        catch { reconnect(); return; }
        current.onopen = async () => {
            try {
                const token = await getToken();
                if (active && current === socket && current.readyState === WebSocket.OPEN)
                    current.send(JSON.stringify({ type: 'auth', idToken: token }));
            } catch { current.close(); }
        };
        current.onmessage = event => {
            if (!active || current !== socket) return;
            try {
                receive(JSON.parse(event.data));
                // Only an authenticated snapshot ends fallback polling.
                status('connected');
            } catch { current.close(); }
        };
        current.onclose = () => { if (active && current === socket) reconnect(); };
        current.onerror = () => current.close();
    }
    connect();
    return () => { active = false; clearTimeout(timer); socket?.close(); };
}
