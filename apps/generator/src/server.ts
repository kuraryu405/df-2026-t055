import http from '../../api/src/http.ts';
if (process.env.NODE_ENV === 'production')
    throw Error('Cloud Tasks OIDC adapter required');
const app = http();
app.use(http.json());
const token = process.env.INTERNAL_TOKEN ?? 'local-generator-only';
app.post('/api/v1/internal/generate', async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`)
        return res.sendStatus(403);
    try {
        const r = await fetch(`${process.env.API_URL ?? 'http://127.0.0.1:3001'}/api/v1/internal/generate`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(req.body) });
        res.status(r.status).send(await r.text());
    }
    catch {
        res.sendStatus(503);
    }
});
// Local Cloud Tasks substitute: recover queued jobs and expired leases using a private API-side poll.
app.listen(Number(process.env.GENERATOR_PORT ?? 3002), process.env.LISTEN_HOST ?? '127.0.0.1');
let running = false;
setInterval(async () => {
    if (running)
        return;
    running = true;
    try {
        await fetch(`${process.env.API_URL ?? 'http://127.0.0.1:3001'}/api/v1/internal/drain`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    }
    catch {
    }
    finally {
        running = false;
    }
}, 1000);
