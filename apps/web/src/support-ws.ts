// Demo authentication matches the HTTP client; Firebase token refresh belongs to #36.
export function subscribeSupport(token: string, sessionId: string | undefined, receive: (value: unknown) => void) {
    let active = true, socket: WebSocket, timer: ReturnType<typeof setTimeout>;
    function connect() {
        if (!active) return;
        const url = new URL('/api/v1/ws', location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        if (sessionId) url.searchParams.set('sessionId', sessionId);
        socket = new WebSocket(url);
        socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', idToken: token }));
        socket.onmessage = event => { try { receive(JSON.parse(event.data)); } catch { socket.close(); } };
        socket.onclose = () => { if (active) timer = setTimeout(connect, 3000); };
        socket.onerror = () => socket.close();
    }
    connect();
    return () => { active = false; clearTimeout(timer); socket?.close(); };
}
