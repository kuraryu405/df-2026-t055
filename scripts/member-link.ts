import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Repository } from '../apps/api/src/adapters.ts';
import { validMember } from '../apps/api/src/firebase-auth.ts';

export async function manageMember(db: Repository, args: string[]) {
    const [operation, uid, memberId] = args;
    if (args.length !== 3 || !['link', 'unlink'].includes(operation) || !uid || uid.length > 128
        || /[\s/]/.test(uid) || !memberId || /[\s/]/.test(memberId)) throw Error('INVALID_MEMBER_LINK_ARGUMENTS');
    await db.transaction(async () => {
        const member = await db.get('members', memberId);
        if (!member || !validMember({ ...member, uid })) throw Error('INVALID_MEMBER');
        const matches = (await db.all('members')).filter(m => m.uid === uid && m.id !== memberId);
        if (matches.length || (member.uid && member.uid !== uid)) throw Error('MEMBER_LINK_CONFLICT');
        if (operation === 'unlink') {
            if (member.uid !== uid) throw Error('MEMBER_LINK_NOT_FOUND');
            const { uid: removed, ...unlinked } = member;
            await db.put('members', unlinked);
        } else {
            if (member.role === 'learner') {
                const learner = await db.get('learners', member.learnerId);
                if (!learner || learner.orgId !== member.orgId) throw Error('INVALID_LEARNER');
            }
            await db.put('members', { ...member, uid });
        }
    });
}
// Explicit repository module avoids silently writing to a throwaway MemoryRepository.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const [modulePath, ...args] = process.argv.slice(2);
        if (!modulePath) throw Error();
        const { repository } = await import(pathToFileURL(resolve(modulePath)).href);
        await manageMember(repository, args);
        console.log('Member link updated');
    } catch {
        console.error('Member link failed; check repository and arguments');
        process.exitCode = 1;
    }
}
