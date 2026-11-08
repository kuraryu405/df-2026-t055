import { DemoAuth, type Auth, type Repository, type Doc } from './adapters.ts';
import type { Member } from '../../../packages/shared/src/index.ts';

// The SDK binding must verify signature, issuer, audience and revocation; never decode an unverified JWT.
export interface FirebaseTokenClient {
    verifyIdToken(token: string, checkRevoked: true): Promise<{ uid: string; exp: number }>;
}
export function validMember(m: Doc): m is Doc & Member {
    return typeof m.uid === 'string' && !!m.uid && typeof m.orgId === 'string' && !!m.orgId
        && ['staff', 'learner', 'newcomer'].includes(m.role)
        && (m.role !== 'learner' || (typeof m.learnerId === 'string' && !!m.learnerId));
}
export class FirebaseAuth implements Auth {
    constructor(private db: Repository, private client: FirebaseTokenClient, private orgId: string) {
        if (!orgId) throw Error('FIREBASE_ORG_ID_REQUIRED');
    }
    async verify(token: string) {
        if (!token || /\s/.test(token)) return undefined;
        let claims;
        try { claims = await this.client.verifyIdToken(token, true); }
        catch { return undefined; }
        if (typeof claims.uid !== 'string' || !claims.uid || !Number.isSafeInteger(claims.exp)
            || claims.exp * 1000 <= Date.now()) return undefined;
        const matches = (await this.db.all('members')).filter(m => m.uid === claims.uid);
        if (matches.length !== 1) return undefined;
        const m = matches[0];
        if (!validMember(m) || m.orgId !== this.orgId) return undefined;
        if (m.role === 'learner') {
            const learner = await this.db.get('learners', m.learnerId!);
            if (!learner || learner.orgId !== m.orgId) return undefined;
        }
        return { uid: m.uid, orgId: m.orgId, role: m.role, learnerId: m.learnerId, expiresAt: claims.exp * 1000 };
    }
}
export function configuredAuth(db: Repository, env: NodeJS.ProcessEnv = process.env, client?: FirebaseTokenClient, auth?: Auth): Auth {
    if (auth) {
        if (env.NODE_ENV === 'production' && auth instanceof DemoAuth) throw Error('DEMO_AUTH_DISABLED');
        return auth;
    }
    const backend = env.AUTH_BACKEND ?? 'demo';
    if (backend === 'demo') {
        if (env.NODE_ENV === 'production') throw Error('DEMO_AUTH_DISABLED');
        return new DemoAuth(db);
    }
    if (backend !== 'firebase') throw Error('INVALID_AUTH_BACKEND');
    if (!client) throw Error('FIREBASE_CLIENT_NOT_CONFIGURED');
    return new FirebaseAuth(db, client, env.FIRESTORE_ORG_ID ?? '');
}
