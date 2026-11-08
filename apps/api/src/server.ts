import http from './http.ts';
import { resolve } from 'node:path';
import { createApp } from './app.ts';
import { MemoryRepository, seed } from './adapters.ts';
import { createWorker } from '../../generator/src/worker.ts';
import { configuredStorage } from './cloud-storage.ts';
import { configuredRepository } from './firestore-repository.ts';
import { configuredModel } from '../../generator/src/model.ts';
if (process.env.NODE_ENV === 'production')
    throw Error('Install production Auth/Repository/Storage/Queue/OIDC adapters before deployment');
const db = configuredRepository(), storage = configuredStorage();
if (db instanceof MemoryRepository) seed(db);
const limit = Number(process.env.GENERATION_GLOBAL_LIMIT ?? 30);
const runJob = createWorker(db, storage, configuredModel(process.env), limit);
const { app } = createApp({
    db, storage, globalLimit: limit, runJob
});
app.get('/', (_req, res) => res.sendFile(resolve('apps/web/dist/index.html')));
app.use(http.static(resolve('apps/web/dist')));
app.get(/^\/(staff|me|handover)(\/.*)?$/, (_req, res) => res.sendFile(resolve('apps/web/dist/index.html')));
app.listen(Number(process.env.API_PORT ?? 3001), '127.0.0.1', () => console.log('Local API :3001 (configured model / in-memory store)'));
