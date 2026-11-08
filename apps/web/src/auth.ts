export type TokenProvider = () => Promise<string>;
// Pass the signed-in Firebase user's getIdToken callback when SDK binding is available.
export function createTokenProvider(demoAccount: () => string, firebase?: TokenProvider): TokenProvider {
    return firebase ?? (async () => demoAccount());
}
