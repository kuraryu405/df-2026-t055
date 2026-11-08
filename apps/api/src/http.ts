// Small Node HTTP router; no framework state is shared across requests.
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
export type Request = {
    method: string;
    path: string;
    searchParams: URLSearchParams;
    headers: IncomingMessage['headers'];
    params: Record<string, string>;
    body: any;
    rawBody: Buffer;
    file?: {
        buffer: Buffer;
    };
    is: (mime: string) => boolean;
};
export type Response = {
    locals: Record<string, any>;
    set: (key: string, value: string) => Response;
    status: (code: number) => Response;
    json: (value: any) => void;
    send: (value: any) => void;
    type: (value: string) => Response;
    sendFile: (path: string) => Promise<void>;
    sendStatus: (code: number) => void;
};
export type NextFunction = (error?: unknown) => void;
type Handler = (req: Request, res: Response, next: NextFunction) => any;
type ErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => any;
type Route = {
    method?: string;
    path: string | RegExp;
    handler: Handler;
    error?: boolean;
    prefix?: boolean;
};
export class Router {
    routes: Route[] = [];
    use(path: string | Handler | ErrorHandler | Router, ...handlers: (Handler | ErrorHandler | Router)[]) {
        if (typeof path !== 'string')
            handlers.unshift(path);
        const prefix = typeof path === 'string' ? path : '/';
        for (const h of handlers) {
            if (h instanceof Router)
                this.routes.push({ path: prefix, prefix: true, handler: async (req, res, next) => {
                        const original = req.path;
                        req.path = req.path.slice(prefix === '/' ? 0 : prefix.length) || '/';
                        await h.dispatch(req, res, (err) => {
                            req.path = original;
                            next(err);
                        });
                    } });
            else
                this.routes.push({
                    path: prefix, prefix: true, handler: h as Handler, error: h.length === 4
                });
        }
        return this;
    }
    get(path: string | RegExp, ...h: Handler[]) {
        return this.add('GET', path, h);
    }
    post(path: string, ...h: Handler[]) {
        return this.add('POST', path, h);
    }
    patch(path: string, ...h: Handler[]) {
        return this.add('PATCH', path, h);
    }
    put(path: string, ...h: Handler[]) {
        return this.add('PUT', path, h);
    }
    private add(method: string, path: string | RegExp, h: Handler[]) {
        for (const handler of h)
            this.routes.push({ method, path, handler });
        return this;
    }
    async dispatch(req: Request, res: Response, done: NextFunction) {
        let index = 0;
        const next: NextFunction = (error) => {
            const route = this.routes[index++];
            if (!route) {
                done(error);
                return;
            }
            if (!!error !== !!route.error) {
                next(error);
                return;
            }
            if (route.method && route.method !== req.method) {
                next(error);
                return;
            }
            let match = true;
            let params: Record<string, string> = {};
            if (typeof route.path === 'string') {
                if (route.prefix)
                    match = route.path === '/' || req.path === route.path || req.path.startsWith(route.path + '/');
                else {
                    const keys: string[] = [];
                    const pattern = route.path.split('/').map(p => p.startsWith(':') ? (keys.push(p.slice(1)), '([^/]+)') : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
                    const m = new RegExp(`^${pattern}$`).exec(req.path);
                    match = !!m;
                    if (m) {
                        try {
                            params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
                        }
                        catch {
                            next(Object.assign(Error('INVALID_PATH'), { status: 422, code: 'INVALID_PATH' }));
                            return;
                        }
                    }
                }
            }
            else
                match = route.path.test(req.path);
            if (!match) {
                next(error);
                return;
            }
            req.params = params;
            try {
                const value = route.error ? (route.handler as any)(error, req, res, next) : route.handler(req, res, next);
                Promise.resolve(value).catch(next);
            }
            catch (e) {
                next(e);
            }
        };
        next();
    }
    async fetch(input: globalThis.Request): Promise<globalThis.Response> {
        const rawBody = Buffer.from(await input.arrayBuffer());
        if (rawBody.length > 51 * 1024 * 1024)
            return globalThis.Response.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'ファイルが大きすぎます', requestId: crypto.randomUUID() } }, { status: 422 });
        const headers = Object.fromEntries(input.headers.entries());
        const req: Request = {
            method: input.method, path: new URL(input.url).pathname, searchParams: new URL(input.url).searchParams, headers, params: {}, body: undefined, rawBody, is: (mime) => String(headers['content-type'] ?? '').split(';')[0].trim() === mime
        };
        return new Promise(resolveResponse => {
            let status = 200;
            const outputHeaders = new Headers();
            let sent = false;
            const finish = (value: BodyInit | null) => {
                if (sent)
                    return;
                sent = true;
                resolveResponse(new globalThis.Response(value, { status, headers: outputHeaders }));
            };
            const res: Response = {
                locals: {}, set(k, v) {
                    outputHeaders.set(k, v);
                    return res;
                }, status(c) {
                    status = c;
                    return res;
                }, json(v) {
                    outputHeaders.set('content-type', 'application/json; charset=utf-8');
                    finish(JSON.stringify(v));
                }, send(v) {
                    finish(v);
                }, type(v) {
                    outputHeaders.set('content-type', v);
                    return res;
                }, async sendFile(p) {
                    try {
                        const b = await readFile(p);
                        outputHeaders.set('content-type', mime[extname(p)] ?? 'application/octet-stream');
                        finish(b);
                    }
                    catch {
                        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'ファイルがありません', requestId: res.locals.requestId } });
                    }
                }, sendStatus(c) {
                    status = c;
                    finish(null);
                }
            };
            void this.dispatch(req, res, (err) => {
                if (!sent)
                    res.status(err ? 500 : 404).json({ error: { code: err ? 'INTERNAL_ERROR' : 'NOT_FOUND', message: '処理できません', requestId: res.locals.requestId } });
            }).catch(() => {
                if (!sent)
                    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '処理できません', requestId: res.locals.requestId } });
            });
        });
    }
    listen(port: number, host: string, callback?: () => void) {
        return createServer(async (input, output) => {
            let size = 0;
            const chunks: Buffer[] = [];
            try {
                for await (const chunk of input) {
                    size += chunk.length;
                    if (size > 51 * 1024 * 1024) {
                        output.writeHead(422).end();
                        return;
                    }
                    chunks.push(chunk);
                }
                const headers = new Headers();
                for (const [k, v] of Object.entries(input.headers))
                    if (v !== undefined)
                        headers.set(k, Array.isArray(v) ? v.join(',') : v);
                const method = input.method ?? 'GET';
                const request = new globalThis.Request(`http://${input.headers.host ?? 'localhost'}${input.url ?? '/'}`, { method, headers, ...(['GET', 'HEAD'].includes(method) ? {} : { body: new Uint8Array(Buffer.concat(chunks)) }) });
                const result = await this.fetch(request);
                output.writeHead(result.status, Object.fromEntries(result.headers));
                if (result.body) {
                    for await (const chunk of result.body) {
                        if (!output.write(chunk))
                            await once(output, 'drain');
                    }
                }
                output.end();
            }
            catch {
                if (!output.writableEnded) {
                    if (output.headersSent)
                        output.destroy();
                    else
                        output.writeHead(500).end();
                }
            }
        }).listen(port, host, callback);
    }
}
const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg'
};
function http() {
    return new Router();
}
http.Router = () => new Router();
http.json = (_options?: {
    limit?: string;
}): Handler => (req, _res, next) => {
    if (!req.is('application/json') || req.rawBody.length === 0)
        return next();
    try {
        if (req.rawBody.length > 1024 * 1024)
            throw Error();
        req.body = JSON.parse(req.rawBody.toString());
        next();
    }
    catch {
        next(Object.assign(Error('INVALID_JSON'), { type: 'entity.parse.failed' }));
    }
};
http.static = (root: string): Handler => async (req, res, next) => {
    if (req.method !== 'GET')
        return next();
    const p = resolve(root, '.' + decodeURIComponent(req.path));
    if (!p.startsWith(resolve(root) + '/'))
        return next();
    try {
        if (!(await stat(p)).isFile())
            return next();
        await res.sendFile(p);
    }
    catch {
        next();
    }
};
export default http;
