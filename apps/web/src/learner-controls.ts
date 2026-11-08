import { iconPaths } from './vendor/lucide/paths.ts';

export type LearnerControlLabel = 'はじめる' | 'もどる' | 'つぎへ' | 'おわる' | '手伝って' | 'やめる' | 'つづける';

// Fixed upstream Lucide paths. Names, commit and licenses are in vendor/lucide.
export function learnerControlPaths(label: LearnerControlLabel | '待つ' | '担当' | '警告' | 'マニュアル' | '追加'): readonly string[] {
    switch (label) {
        case 'はじめる': return iconPaths.play;
        case 'もどる': return iconPaths['arrow-left'];
        case 'つぎへ': return iconPaths['arrow-right'];
        case 'つづける': return iconPaths['step-forward'];
        case 'おわる': return iconPaths.check;
        case '手伝って': return iconPaths['hand-helping'];
        case 'やめる': return iconPaths.octagon;
        case '待つ': return iconPaths.hourglass;
        case '担当': return iconPaths.handshake;
        case '警告': return iconPaths['triangle-exclamation-point'];
        case 'マニュアル': return iconPaths['book-open'];
        case '追加': return iconPaths.plus;
    }
}

export function imageFailureText(alt: string, failed: boolean): string | undefined {
    return failed ? `写真を表示できません：${alt}` : undefined;
}
