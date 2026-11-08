import type { TokenProvider } from './auth.ts';
export function subscribeSupport(getToken: TokenProvider, sessionId: string | undefined, receive: (value: unknown) => void) {
    let active = true, socket: WebSocket, timer: ReturnType<typeof setTimeout>;
    function connect() {
        if (!active) return;
        const url = new URL('/api/v1/ws', location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        if (sessionId) url.searchParams.set('sessionId', sessionId);
        socket = new WebSocket(url);
        const current = socket;
        socket.onopen = async () => {
            try {
                const token = await getToken();
                if (active && current === socket && current.readyState === WebSocket.OPEN)
                    current.send(JSON.stringify({ type: 'auth', idToken: token }));
            } catch { current.close(); }
        };
        socket.onmessage = event => { try { receive(JSON.parse(event.data)); } catch { socket.close(); } };
        socket.onclose = () => { if (active) timer = setTimeout(connect, 3000); };
        socket.onerror = () => socket.close();
    }
    connect();
    return () => { active = false; clearTimeout(timer); socket?.close(); };
}
