import { learnerControlPath, imageFailureText, type LearnerControlLabel } from './learner-controls.ts';
import { learnerStepPresentation, type LearnerDisplaySession } from './learner-display.ts';
import { isManualDraft, releaseCopySource, beginReleaseCopy, type ReleaseCopyState } from './release-copy.ts';
import { releaseCopyResponseSchema } from '../../../packages/shared/src/index.ts';
import { missingDraftChecks, draftPreviewMode, savedDraftReview } from './draft-review.ts';
import { StaffLearners } from './staff-learners.tsx';
import { createTokenProvider } from './auth.ts';
import { subscribeSupport, type SupportConnection } from './support-ws.ts';
import { StaffSupport } from './staff-support.tsx';
import { staffSupportNotificationSchema, learnerSupportNotificationSchema } from '../../../packages/shared/src/support.ts';
import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { EditedStep, ReviewChecks, LearnerSessionDTO } from '../../../packages/shared/src/index.ts';
import { hold, readSafety, flushSafety, safetyKey, clearWaiting, readSessionStart, beginSessionStart, holdStartIntent, startKey } from './safety.ts';
import './style.css';
const accounts = [['staff', '職員1'], ['staff-2', '職員2'], ['learner-a', '本人 Aさん'], ['learner-b', '本人 Bさん'], ['newcomer', '新人']] as const;
const isStaffAccount = (uid: string) => uid === 'staff' || uid === 'staff-2';
// Keep each local-demo actor in its own tab, including reloads during support tests.
let account = sessionStorage.getItem('demoAccount') ?? localStorage.getItem('demoAccount') ?? 'staff';
sessionStorage.setItem('demoAccount', account);
const getToken = createTokenProvider(() => account);
async function api(path: string, method = 'GET', body?: unknown) {
    const r = await fetch(`/api/v1${path}`, { method, headers: { Authorization: `Bearer ${await getToken()}`, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
    const data = await r.json();
    if (!r.ok)
        throw Object.assign(Error(`${data.error?.code ?? r.status}：${r.status === 409 ? '状態が変わりました。再取得してください' : data.error?.message ?? '通信を確認してください'}`), { status: r.status, code: data.error?.code });
    return data;
}
function go(path: string) {
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
}
function Asset({ id, video = false, audio = false, startMs = 0, endMs, alt = 'この工程の手元の写真' }: {
    id: string;
    alt?: string;
    video?: boolean;
    audio?: boolean;
    startMs?: number;
    endMs?: number;
}) {
    const [url, setUrl] = useState('');
    const [failedId, setFailedId] = useState('');
    useEffect(() => {
        let active = true, object = '';
        setUrl('');
        setFailedId('');
        getToken().then(token => fetch(`/api/v1/assets/${id}`, { headers: { Authorization: `Bearer ${token}` } })).then(async (r) => {
            if (!r.ok)
                throw Error();
            object = URL.createObjectURL(await r.blob());
            if (active)
                setUrl(object);
        }).catch(() => {
            if (active) setFailedId(id);
        });
        return () => {
            active = false;
            if (object)
                URL.revokeObjectURL(object);
        };
    }, [id]);
    const failure = imageFailureText(alt, !audio && !video && failedId === id);
    if (failure) return <div className="placeholder" role="status">{failure}</div>;
    return url ? audio ? <audio key={id} src={url} controls preload="metadata" aria-label="手順の読み上げ"/> : video ? <video key={`${id}:${startMs}:${endMs}`} src={`${url}#t=${startMs / 1000}${endMs === undefined ? '' : ',' + endMs / 1000}`} controls preload="metadata"/> : <img key={id} src={url} alt={alt} onError={() => setFailedId(id)}/> : <div className="placeholder">写真・動画を読み込み中</div>;
}
function App() {
    const [path, setPath] = useState(location.pathname);
    const [uid, setUid] = useState(account);
    const [error, setError] = useState('');
    useEffect(() => {
        const f = () => {
            setPath(location.pathname);
            setError('');
        };
        window.addEventListener('popstate', f);
        return () => window.removeEventListener('popstate', f);
    }, []);
    const action = async (fn: () => Promise<void>) => {
        setError('');
        try {
            await fn();
        }
        catch (e) {
            setError((e as Error).message);
        }
    };
    return <><header><a href="#" onClick={e => {
            e.preventDefault();
            go(isStaffAccount(uid) ? '/staff' : uid === 'newcomer' ? '/handover' : '/me');
        }}>てじゅんのバトン</a><span>開発デモ · Fake生成</span><label>デモアカウント <select value={uid} onChange={e => {
            account = e.target.value;
            sessionStorage.setItem('demoAccount', account);
            setUid(account);
            go(isStaffAccount(account) ? '/staff' : account === 'newcomer' ? '/handover' : '/me');
        }}>{accounts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></header><main key={uid}><p className="notice">架空プロフィールを使ったローカルデモです。生成候補は職員の原動画照合・承認が必要です。</p>{error && <div role="alert" className="error">{error}</div>}{isStaffAccount(uid) ? <Staff path={path} action={action}/> : uid === 'newcomer' ? <Handover path={path} action={action}/> : <Learner uid={uid} path={path} action={action}/>}</main></>;
}
type Action = (fn: () => Promise<void>) => Promise<void>;
function Staff({ path, action }: {
    path: string;
    action: Action;
}) {
    const [tasks, setTasks] = useState<any[]>([]), [learners, setLearners] = useState<any[]>([]), [chosen, setChosen] = useState('a'), [title, setTitle] = useState('タオル折り・紙巻き・袋入れ'), [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false);
    useEffect(() => {
        void action(async () => {
            setTasks((await api('/tasks')).tasks);
            setLearners((await api('/learners')).items);
        });
    }, [path]);
    const draftMatch = path.match(/\/drafts\/([^/]+)/);
    if (draftMatch)
        return <Draft key={draftMatch[1]} id={draftMatch[1]} action={action}/>;
    if (path === '/staff/support')
        return <Support/>;
    return <><nav><button onClick={() => go('/staff')}>作業一覧</button><button onClick={() => go('/staff/learners')}>本人一覧・登録</button><button onClick={() => go('/staff/tasks/new')}>＋ 手本を登録</button><button onClick={() => go('/staff/support')}>支援要求</button><button onClick={() => go('/staff/handover')}>承認版を確認・割当</button></nav>{path === '/staff/learners' || path.startsWith('/staff/learners/') ? <StaffLearners key={path} path={path} api={api} go={go}/> : path.startsWith('/staff/handover') ? <Handover path={path.replace('/staff', '')} action={action} staff/> : path === '/staff/tasks/new' ? <section><h1>手本動画を登録</h1><label>作業名<input value={title} onChange={e => setTitle(e.target.value)}/></label><label>MP4（音声付き・50MB / 180秒以内）<input type="file" accept="video/mp4" onChange={e => setFile(e.target.files?.[0] ?? null)}/></label><button disabled={!file || busy} onClick={() => void action(async () => {
                setBusy(true);
                try {
                    const { taskId } = await api('/tasks', 'POST', { title });
                    const form = new FormData();
                    form.append('video', file!);
                    await api(`/tasks/${taskId}/video`, 'POST', form);
                    go('/staff');
                }
                finally {
                    setBusy(false);
                }
            })}>{busy ? '動画を検査しています…' : '動画を登録する'}</button></section> : <><h1>職員の作業一覧</h1><label>本人プロフィール<select value={chosen} onChange={e => setChosen(e.target.value)}>{learners.map(l => <option key={l.learnerId} value={l.learnerId}>{l.displayName}：{l.preferences.splitHints}</option>)}</select></label>{tasks.length === 0 && <p>「手本を登録」から動画を登録してください。</p>}{tasks.map(t => <section key={t.id}><h2>{t.title}</h2><p>{t.status === 'ready' ? '動画登録済み' : '動画の登録待ち'}</p>{t.videoAssetId && <Asset id={t.videoAssetId} video/>}{t.generationJobs?.map((j: any) => <p key={j.jobId}>生成状態：{j.status} <button onClick={() => go(`/staff/tasks/${t.id}/drafts/${j.draftId}`)}>下書きを開く</button></p>)}<button disabled={t.status !== 'ready' || busy} onClick={() => void action(async () => {
                    setBusy(true);
                    try {
                        const r = await api(`/tasks/${t.id}/generations`, 'POST', { learnerId: chosen });
                        go(`/staff/tasks/${t.id}/drafts/${r.draftId}`);
                    }
                    finally {
                        setBusy(false);
                    }
                })}>AIの下書きを作る（開発用Fake）</button></section>)}</>}</>;
}
function Draft({ id, action }: {
    id: string;
    action: Action;
}) {
    const [draft, setDraft] = useState<any>(), [task, setTask] = useState<any>(), [steps, setSteps] = useState<EditedStep[]>([]), [checks, setChecks] = useState<ReviewChecks>({ presentationConfirmed: false, flagResolution: '', steps: {} }), [release, setRelease] = useState<any>(), [busy, setBusy] = useState(false), [preview, setPreview] = useState<number | null>(null);
    const [displayMode, setDisplayMode] = useState<'photo_only' | 'photo_text'>('photo_text'), [audioGuidance, setAudioGuidance] = useState(false);
    const [source, setSource] = useState('');
    const [previewMode, setPreviewMode] = useState<'photo_only' | 'photo_text'>('photo_text');
    const [error, setError] = useState(''), [conflict, setConflict] = useState(false), [latest, setLatest] = useState<any>();
    const sending = useRef(false);
    const previewTrigger = useRef<HTMLButtonElement | null>(null);
    const closePreview = () => { setPreview(null); previewTrigger.current?.focus(); };
    const loadSource = async (d: any) => {
        setSource('');
        if (isManualDraft(d)) {
            const approval = (await api(`/handover/releases/${d.sourceReleaseId}`)).release;
            const summary = (await api('/handover/releases')).releases.find((r: any) => r.releaseId === d.sourceReleaseId);
            if (!summary) throw Error('コピー元の承認版が見つかりません。再取得してください。');
            setSource(releaseCopySource(summary, approval));
        }
    };
    const load = async () => {
        const d = (await api(`/drafts/${id}`)).draft;
        setDraft(d);
        setDisplayMode(draftPreviewMode(d.displayMode));
        setAudioGuidance(d.audioGuidance ?? false);
        setSteps(d.editedSteps);
        setChecks(d.reviewChecks);
        setTask((await api(`/tasks/${d.taskId}`)).task);
        await loadSource(d);
    };
    useEffect(() => {
        void action(load);
    }, [id]);
    useEffect(() => {
        if (!draft || isManualDraft(draft) || draft.status !== 'generating')
            return;
        const timer = setInterval(() => void action(load), 3000);
        return () => clearInterval(timer);
    }, [id, draft?.status, draft?.sourceReleaseId]);
    if (!draft)
        return <p>下書きを取得中…</p>;
    const change = (i: number, key: keyof EditedStep, value: string | number) => {
        setSteps(old => old.map((s, j) => i === j ? { ...s, [key]: value } : s));
        setChecks(c => ({ ...c, presentationConfirmed: false, steps: { ...c.steps, [steps[i].stepId]: { videoVerified: ['sourceStartMs', 'sourceEndMs', 'frameMs'].includes(key) ? false : (c.steps[steps[i].stepId]?.videoVerified ?? false), photoTextVerified: false } } }));
    };
    const manual = isManualDraft(draft);
    const flagsRequired = !manual && !!(draft.aiProposal?.reviewFlags.length || draft.aiProposal?.steps.some((s: any) => s.reviewFlags.length));
    const missing = missingDraftChecks(steps, checks, flagsRequired);
    const run = async (fn: () => Promise<void>) => {
        if (sending.current) return;
        sending.current = true;
        setBusy(true); setError('');
        try { await fn(); }
        catch (e) {
            if ((e as {status?: number}).status === 409) {
                setConflict(true);
                setError('状態が変わりました。入力は保持しています。「最新値を取得」して比較してから再保存してください。');
            } else setError((e as Error).message);
        } finally { sending.current = false; setBusy(false); }
    };
    const fetchLatest = async () => {
        const d = (await api(`/drafts/${id}`)).draft;
        setLatest(d);
        setDraft({ ...draft, revision: d.revision });
        setConflict(d.status !== 'editing');
        if (isManualDraft(d) && !source) await loadSource(d);
        if (d.status !== 'editing') setError('最新の下書きは編集できない状態です。入力は保持しています。');
    };
    const save = async () => {
        const result = savedDraftReview(await api(`/drafts/${id}`, 'PATCH', { expectedRevision: draft.revision, editedSteps: steps, displayMode, audioGuidance, reviewChecks: checks }));
        setDraft({ ...draft, ...result });
        setChecks(result.reviewChecks);
        setLatest(undefined);
        return result;
    };
    return <><nav><button onClick={() => go('/staff')}>作業一覧</button><button onClick={() => go(`/staff/drafts/${id}/review`)}>確認・承認へ</button><button onClick={() => {
            localStorage.removeItem(`approval:${id}`);
            if (draft.status === 'editing') void run(fetchLatest);
            else void action(load);
        }}>{draft.status === 'editing' ? '最新値を取得' : '再取得'}</button></nav><h1>{manual ? '承認版のコピー' : 'AIの下書き（解釈）'}</h1>{manual && <p role="status">{source || 'コピー元の承認版を取得中です。'}</p>}<p>本人：{draft.learnerId === 'a' ? 'Aさん（9工程）' : 'Bさん（折るを細分化・11工程）'} / revision {draft.revision} / {draft.status}</p>{!manual && draft.status === 'generating' ? <p role="status">動画解析中です。3秒ごとに状態を確認しています。</p> : !manual && draft.status === 'failed' ? <section><p role="alert">生成に失敗しました。本人用の手順は作成されていません。</p><button onClick={() => void action(async () => {
                const r = await api(`/tasks/${draft.taskId}/generations`, 'POST', { learnerId: draft.learnerId });
                go(`/staff/tasks/${draft.taskId}/drafts/${r.draftId}`);
            })}>新しいジョブで再試行</button></section> : draft.status === 'approved' ? <section><h2>承認済みです</h2><button onClick={() => go('/staff/handover')}>承認版を確認・本人へ割当</button></section> : <><p>{manual ? '承認版をコピーした手作業の下書きです。原動画と照合し、修正後にすべての確認を行ってから、新しい版として承認してください。元の承認版と実行中の手順は変わりません。' : 'Fake候補です。動画の動作・原音と候補を照合し、必要な修正と写真切り出しを行ってください。確認欄はすべて未確認から始まります。'}</p>{error && <p role="alert">{error}</p>}{latest && <section><h2>サーバーの最新値（入力は保持）</h2><p>revision {latest.revision} / {latest.status}</p><p>表示方法：{latest.displayMode} / 音声：{String(latest.audioGuidance)}</p><pre>{JSON.stringify({ editedSteps: latest.editedSteps, reviewChecks: latest.reviewChecks }, null, 2)}</pre></section>}<fieldset disabled={busy}><legend>この作業の提示設定</legend><label>表示方法<select value={displayMode} onChange={e => { setDisplayMode(e.target.value as typeof displayMode); setChecks(c => ({ ...c, presentationConfirmed: false })); }}><option value="photo_only">写真のみ</option><option value="photo_text">写真＋短文</option></select></label><label><input type="checkbox" checked={audioGuidance} onChange={e => { setAudioGuidance(e.target.checked); setChecks(c => ({ ...c, presentationConfirmed: false })); }}/>音声ガイドを希望する</label></fieldset><fieldset disabled={busy}><legend>工程の編集と確認</legend><div className="workspace"><aside>{task?.videoAssetId && <Asset id={task.videoAssetId} video/>}{!manual && <><h2>AIの候補・確認が必要な点</h2>{draft.aiProposal?.reviewFlags.map((f: string) => <p key={f}>{f}</p>)}{draft.aiProposal?.steps.map((s: any) => <details key={s.stepId}><summary>{s.stepId}：{s.startMs}–{s.endMs} ms</summary><p>観察候補：{s.observationCandidate}</p><p>声の候補：{s.speechCandidate || '聞き取り未確認'}</p>{s.reviewFlags.map((f: string) => <p key={f}>{f}</p>)}</details>)}</>}</aside><div>{steps.map((s, i) => <section key={s.stepId}><h2>工程 {i + 1}</h2>{s.imageAssetId && <Asset id={s.imageAssetId}/>}<label>本人に見せる短文（40文字以内）<input maxLength={40} value={s.text} onChange={e => change(i, 'text', e.target.value)}/></label><label>写真の代替テキスト（200文字以内）<input maxLength={200} value={s.imageAltText ?? ''} onChange={e => change(i, 'imageAltText', e.target.value)}/></label><label>本人に見せる注意<input maxLength={200} value={s.visibleCaution} onChange={e => change(i, 'visibleCaution', e.target.value)}/></label><div className="times">{(['sourceStartMs', 'sourceEndMs', 'frameMs'] as const).map((key, j) => <label key={key}>{['開始ms', '終了ms', '写真ms'][j]}<input type="number" min={0} value={s[key]} onChange={e => change(i, key, Number(e.target.value))}/></label>)}</div><button disabled={busy} onClick={() => void action(async () => {
                    setBusy(true);
                    try {
                        const r = await api(`/drafts/${id}/frames`, 'POST', { frameMs: s.frameMs });
                        change(i, 'imageAssetId', r.imageAssetId);
                    }
                    finally {
                        setBusy(false);
                    }
                })}>この時刻の写真を原動画から切り出す</button>{(['verifiedObservation', 'verifiedSpeech', 'coaching', 'completionCheck'] as const).map((key, j) => <label key={key}>{['確認した動作', '確認した声', '職員用声かけ・待つ位置', '完成基準'][j]}<textarea maxLength={200} value={s[key]} onChange={e => change(i, key, e.target.value)}/></label>)}{(['videoVerified', 'photoTextVerified'] as const).map((key, j) => <label className="check" key={key}><input type="checkbox" checked={checks.steps[s.stepId]?.[key] ?? false} onChange={e => setChecks(c => ({ ...c, steps: { ...c.steps, [s.stepId]: { ...(c.steps[s.stepId] ?? { videoVerified: false, photoTextVerified: false }), [key]: e.target.checked } } }))}/>{['動画照合済み', '写真・説明確認済み'][j]}</label>)}<button onClick={e => { previewTrigger.current = e.currentTarget; setPreviewMode(draftPreviewMode(displayMode)); setPreview(i); }}>本人表示をプレビュー</button><button onClick={() => {
                    const newStep = {
                        ...s, stepId: crypto.randomUUID(), text: '', imageAssetId: ''
                    };
                    setSteps(old => [...old.slice(0, i + 1), newStep, ...old.slice(i + 1)]);
                    setChecks(c => ({ ...c, presentationConfirmed: false }));
                }} disabled={steps.length >= 20}>次に工程を追加</button><button disabled={steps.length <= 1} onClick={() => {
                    setSteps(old => old.filter((_, j) => j !== i));
                    setChecks(c => ({ ...c, presentationConfirmed: false }));
                }}>この工程を削除</button></section>)}</div></div><section><h2>承認までに必要な確認・再確認</h2>{missing.length ? <ul>{missing.map(item => <li key={item}>{item}</li>)}</ul> : <p role="status">確認が揃いました。保存後のサーバー確認を経て承認できます。</p>}<p>内容を変えて保存すると、サーバーが確認を解除します。保存後にプレビューし、確認を付け直してください。</p><label>確認が必要な点への対応記録<textarea maxLength={2000} value={checks.flagResolution} onChange={e => setChecks(c => ({ ...c, flagResolution: e.target.value }))}/></label><label className="check"><input type="checkbox" checked={checks.presentationConfirmed} onChange={e => setChecks(c => ({ ...c, presentationConfirmed: e.target.checked }))}/>本人への提示内容確認済み</label><button disabled={busy || conflict} onClick={() => void run(async () => { await save(); })}>編集と確認を保存</button><button disabled={busy || conflict || missing.length > 0} onClick={() => void run(async () => {
                    const key = `approval:${id}`;
                    const saved = localStorage.getItem(key);
                    let payload = saved ? JSON.parse(saved) : undefined;
                    if (!payload) {
                        const result = await save();
                        if (missingDraftChecks(steps, result.reviewChecks, flagsRequired).length) {
                            setError('保存後の内容に再確認が必要です。プレビューし、確認を付け直してください。');
                            return;
                        }
                        payload = { expectedRevision: result.revision, approvalRequestId: crypto.randomUUID() };
                    }
                    localStorage.setItem(key, JSON.stringify(payload));
                    const r = await api(`/drafts/${id}/approve`, 'POST', payload);
                    setRelease(r);
                    setDraft({ ...draft, status: 'approved', revision: payload.expectedRevision });
            })}>この内容を承認</button></section></fieldset></>}{release && <section><h2>版 {release.version} を新規保存しました</h2><button onClick={() => void action(async () => {
                await api(`/assignments/${draft.learnerId}/${draft.taskId}`, 'PUT', { releaseId: release.releaseId });
                go('/staff/handover');
            })}>本人の端末へ渡す（次回開始版）</button></section>}{preview !== null && steps[preview] && <div className="modal" role="dialog" aria-modal="true" aria-label="職員用本人表示プレビュー"><section onKeyDown={e => { if (e.key === 'Escape') closePreview();
                if (e.key === 'Tab') {
                    const controls = e.currentTarget.querySelectorAll<HTMLElement>('select, button');
                    const first = controls[0], last = controls[controls.length - 1];
                    if (e.shiftKey && e.target === first) { e.preventDefault(); last.focus(); }
                    else if (!e.shiftKey && e.target === last) { e.preventDefault(); first.focus(); }
                } }}><p>職員認証内のプレビュー（未承認）</p><label>プレビューの表示方法<select autoFocus value={previewMode} onChange={e => setPreviewMode(e.target.value as typeof previewMode)}><option value="photo_only">写真のみ</option><option value="photo_text">写真＋短文</option></select></label><div aria-label="本人への提示内容"><p>工程 {preview + 1} / {steps.length}</p><Asset id={steps[preview].imageAssetId} alt={steps[preview].imageAltText || steps[preview].text}/>{previewMode === 'photo_text' && <><h2>{steps[preview].text}</h2><p>{steps[preview].visibleCaution}</p></>}</div><aside><h2>職員の確認用</h2><p>代替テキスト：{steps[preview].imageAltText || steps[preview].text}</p>{previewMode === 'photo_only' && <><p>写真のみでは短文・注意書きを表示しません。写真の順序を確認し、本人と一対一で手本を示して注意の伝わり方を確かめてください。</p><p>伝える注意：{steps[preview].visibleCaution || 'なし'}</p><p>声かけ・待つ位置：{steps[preview].coaching || '未記録'}</p><p>必要な伝え方を工程の「職員用声かけ・待つ位置」に記録してから提示内容を確認してください。音声だけに頼らず確認してください。</p></>}<p>音声ガイド：{audioGuidance ? '希望あり（承認時に生成。ここでは再生しません）' : '希望なし'}</p></aside><button onClick={closePreview}>閉じる</button></section></div>}</>;
}
function Support() {
    return <StaffSupport api={api} getToken={getToken} go={go}/>;
}
function Handover({ path, action, staff = false }: {
    path: string;
    action: Action;
    staff?: boolean;
}) {
    const [items, setItems] = useState<any[]>([]), [release, setRelease] = useState<any>(), [read, setRead] = useState(''), [filter, setFilter] = useState('');
    const copyStates = useRef<Record<string, ReleaseCopyState>>({});
    const [copying, setCopying] = useState(false), [copyError, setCopyError] = useState('');
    const releaseId = path.match(/\/releases\/([^/]+)/)?.[1];
    useEffect(() => {
        let active = true;
        void action(async () => {
            setRelease(undefined);
            setCopyError('');
            const releases = (await api('/handover/releases')).releases;
            if (!active) return;
            setItems(releases);
            if (releaseId) {
                const detail = (await api(`/handover/releases/${releaseId}`)).release;
                if (active) setRelease(detail);
            }
        });
        return () => { active = false; };
    }, [path]);
    return <><h1>職員が確認した手順・教え方</h1><p>承認版だけを表示します。</p>{releaseId && release?.releaseId === releaseId ? <><button onClick={() => go(staff ? '/staff/handover' : '/handover')}>一覧へ</button><p>承認者 {release.approvedBy} / {new Date(release.approvedAt).toLocaleString('ja-JP')}</p>{staff && <><button disabled={copying || !items.some(r => r.releaseId === releaseId)} onClick={async () => {
                const state = copyStates.current[releaseId] ??= { sending: false };
                const clientRequestId = beginReleaseCopy(state);
                if (!clientRequestId) return;
                setCopying(true); setCopyError('');
                try {
                    const summary = items.find(r => r.releaseId === releaseId);
                    const result = releaseCopyResponseSchema.parse(await api(`/releases/${releaseId}/drafts`, 'POST', { clientRequestId }));
                    go(`/staff/tasks/${summary.taskId}/drafts/${result.draftId}`);
                } catch (e) { setCopyError((e as Error).message); }
                finally { state.sending = false; setCopying(false); }
            }}>コピーして直す</button>{copying && <p role="status">承認版をコピーしています。</p>}{copyError && <p role="alert">{copyError}</p>}</>}{release.learnerSteps.map((s: any, i: number) => {
                const g = release.staffGuide[i];
                return <section key={s.stepId}><h2>{i + 1}：{s.text}</h2><div className="two"><Asset id={s.imageAssetId}/><div><p>{s.visibleCaution}</p><p>確認した動作：{g.verifiedObservation}</p><p>確認した声：{g.verifiedSpeech || '記録なし'}</p><p>声かけ・待つ位置：{g.coaching}</p><p>完成基準：{g.completionCheck}</p><p>原動画：{g.sourceStartMs}–{g.sourceEndMs} ms</p><Asset id={release.videoAssetId} video startMs={g.sourceStartMs} endMs={g.sourceEndMs}/></div></div></section>;
            })}{!staff && <button onClick={() => void action(async () => {
                    setRead((await api(`/handover/releases/${releaseId}/read`, 'POST', {})).readAt);
                })}>引き継ぎを読んだ</button>}{read && <p>閲覧時刻を記録しました：{new Date(read).toLocaleString('ja-JP')}</p>}</> : <><label>本人で絞り込む<select value={filter} onChange={e => setFilter(e.target.value)}><option value="">すべて</option><option value="a">Aさん</option><option value="b">Bさん</option></select></label>{!items.length && <p>承認済み版はまだありません。</p>}{items.filter(r => !filter || r.learnerId === filter).map(r => <section key={r.releaseId}><h2>{r.title} / {r.displayName} / 版 {r.version}</h2><p>承認者 {r.approvedBy} / {new Date(r.approvedAt).toLocaleString('ja-JP')}</p><button onClick={() => go(`${staff ? '/staff' : ''}/handover/releases/${r.releaseId}`)}>教え方を見る</button>{staff ? <button onClick={() => void action(async () => {
                        await api(`/assignments/${r.learnerId}/${r.taskId}`, 'PUT', { releaseId: r.releaseId });
                        alert('次回の開始版として割り当てました');
                    })}>本人の端末へ渡す（次回開始版）</button> : null}</section>)}</>}</>;
}
function Learner({ uid, path, action }: { uid: string; path: string; action: Action }) {
    type Session = LearnerDisplaySession & { support?: { requestId: string; status: 'open' | 'assigned' | 'in_progress' | 'acknowledged'; revision: number } };
    const sessionId = path.match(/\/me\/sessions\/([^/]+)/)?.[1];
    const pendingStart = readSessionStart(localStorage, uid);
    const currentSession = useRef<Session | undefined>(undefined);
    const starting = useRef(false), eventSending = useRef(false);
    const homeIntent = useRef<'help' | 'stop' | undefined>(pendingStart?.intent?.type);
    const resumeEvent = useRef<{ clientEventId: string; expectedRevision: number; type: 'resume' } | undefined>(undefined);
    const [assignments, setAssignments] = useState<any[]>([]), [storedSession, setSession] = useState<Session>();
    const [safetyTick, setSafetyTick] = useState(0), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
    const [homeHalted, setHomeHalted] = useState(!!pendingStart?.intent);
    const [connection, setConnection] = useState<SupportConnection>('connecting');
    const session = storedSession?.sessionId === sessionId ? storedSession : undefined;
    const key = sessionId ? safetyKey(uid, sessionId) : '';
    const safety = readSafety(localStorage, key);

    function accept(state: Partial<Session> & { sessionId: string; releaseId: string; status: Session['status']; stepIndex: number; revision: number }) {
        if (state.sessionId !== sessionId || readSafety(localStorage, key).stopped) return;
        const previous = currentSession.current;
        if (previous && (previous.sessionId !== state.sessionId || previous.releaseId !== state.releaseId || state.revision < previous.revision)) return;
        if (previous && ['stopped', 'completed'].includes(previous.status) && previous.status !== state.status) return;
        if (previous?.support && state.revision === previous.revision &&
            (!state.support || state.support.requestId !== previous.support.requestId || state.support.revision < previous.support.revision)) return;
        if (!previous && !state.steps) return;
        const local = readSafety(localStorage, key);
        if (state.status === 'stopped') hold(localStorage, key, { type: 'stop', clientEventId: crypto.randomUUID(), expectedRevision: state.revision });
        if (local.waiting && !local.pending.length && state.status === 'active' && state.revision > (local.helpRevision ?? previous?.revision ?? state.revision))
            clearWaiting(localStorage, key);
        const next = { ...previous, ...state } as Session;
        if (state.status !== 'waiting_help') delete next.support;
        currentSession.current = next;
        setSession(next);
    }
    function finishStart(response: Session) {
        const pending = readSessionStart(localStorage, uid);
        const intent = pending?.intent ?? (homeIntent.current ? { type: homeIntent.current, clientEventId: crypto.randomUUID() } : undefined);
        if (intent) hold(localStorage, safetyKey(uid, response.sessionId), { ...intent, expectedRevision: response.revision });
        localStorage.removeItem(startKey(uid));
        go(`/me/sessions/${response.sessionId}`);
    }
    useEffect(() => {
        let active = true;
        currentSession.current = undefined;
        setSession(undefined);
        void action(async () => {
            if (sessionId) {
                const fresh = await api(`/me/sessions/${sessionId}`);
                if (active) accept(fresh);
            } else {
                const data = await api('/me/assignments');
                if (active) setAssignments(data.assignments);
            }
        });
        return () => { active = false; };
    }, [uid, path]);
    useEffect(() => {
        if (sessionId) return;
        let active = true;
        const recover = async () => {
            const pending = readSessionStart(localStorage, uid);
            if (!pending?.intent || starting.current || !active || account !== uid) return;
            starting.current = true;
            try {
                const response = await api('/me/sessions', 'POST', { taskId: pending.taskId, clientRequestId: pending.clientRequestId });
                if (active && account === uid) finishStart(response);
            } catch { if (active) setMessage('近くの職員をよんでください。開始した作業の停止・支援要求を送り直しています。'); }
            finally { starting.current = false; }
        };
        void recover();
        const timer = setInterval(() => void recover(), 2000);
        return () => { active = false; clearInterval(timer); };
    }, [uid, sessionId, homeHalted]);
    useEffect(() => {
        let running = false, active = true;
        const retry = async () => {
            if (running) return;
            running = true;
            try {
                const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
                    .filter((value): value is string => !!value && value.startsWith(`safety:${uid}:`));
                for (const pendingKey of keys) {
                    if (!active || account !== uid) return;
                    if (!readSafety(localStorage, pendingKey).pending.length) continue;
                    const pendingSession = pendingKey.slice(`safety:${uid}:`.length);
                    const ok = await flushSafety(localStorage, pendingKey, {
                        send: async event => {
                            if (!active || account !== uid) throw Error('ACCOUNT_CHANGED');
                            return api(`/me/sessions/${pendingSession}/events`, 'POST', event);
                        },
                        load: () => api(`/me/sessions/${pendingSession}`)
                    });
                    if (active && pendingKey === key) {
                        setMessage(ok ? '' : '近くの職員をよんでください。送信をやり直しています。');
                        if (ok) setSafetyTick(value => value + 1);
                        if (ok && !readSafety(localStorage, key).stopped) {
                            try { const fresh = await api(`/me/sessions/${sessionId}`); if (active) accept(fresh); } catch { /* Keep the local wait. */ }
                        }
                    }
                }
            } finally { running = false; }
        };
        void retry();
        const timer = setInterval(() => void retry(), 2000);
        return () => { active = false; clearInterval(timer); };
    }, [uid, key, safetyTick]);
    useEffect(() => {
        if (!sessionId || !(safety.waiting || session?.status === 'waiting_help') || safety.stopped) return;
        let active = true, connected = false;
        const poll = async () => {
            if (!active || connected) return;
            try { const fresh = await api(`/me/sessions/${sessionId}`); if (active) accept(fresh); }
            catch { /* Disconnection cannot release the wait. */ }
        };
        void poll();
        const timer = setInterval(() => void poll(), 3000);
        const unsubscribe = subscribeSupport(getToken, sessionId, value => {
            const state = learnerSupportNotificationSchema.parse(value).payload;
            if (active) accept(state);
        }, value => { connected = value === 'connected'; if (active) setConnection(value); });
        return () => { active = false; clearInterval(timer); unsubscribe(); };
    }, [uid, sessionId, safety.waiting, safety.stopped, session?.status]);
    function requestSafety(type: 'help' | 'stop') {
        if (!sessionId) {
            if (homeIntent.current !== 'stop') homeIntent.current = type;
            holdStartIntent(localStorage, uid, homeIntent.current!, crypto.randomUUID());
            setHomeHalted(true);
            setMessage(homeIntent.current === 'stop' ? '作業をやめました' : '近くの職員をよんでください');
            return;
        }
        hold(localStorage, key, { clientEventId: crypto.randomUUID(), expectedRevision: currentSession.current?.revision ?? 0, type });
        setMessage('');
        setSafetyTick(value => value + 1);
    }
    async function event(type: 'back' | 'next' | 'complete' | 'resume') {
        if (eventSending.current || readSafety(localStorage, key).stopped || !currentSession.current) return;
        eventSending.current = true; setBusy(true);
        try {
            let revision = currentSession.current.revision;
            if (type === 'resume') {
                const fresh = await api(`/me/sessions/${sessionId}`);
                if (readSafety(localStorage, key).stopped) return;
                accept(fresh);
                if (fresh.status !== 'waiting_help' || fresh.support?.status !== 'acknowledged') return;
                revision = fresh.revision;
            } else if (readSafety(localStorage, key).waiting) return;
            const input = type === 'resume' ? resumeEvent.current ??= { clientEventId: crypto.randomUUID(), expectedRevision: revision, type }
                : { clientEventId: crypto.randomUUID(), expectedRevision: revision, type };
            await api(`/me/sessions/${sessionId}/events`, 'POST', input);
            const fresh = await api(`/me/sessions/${sessionId}`);
            if (readSafety(localStorage, key).stopped) return;
            accept(fresh);
            if (type === 'resume') resumeEvent.current = undefined;
        } finally { eventSending.current = false; setBusy(false); }
    }
    const step = session ? learnerStepPresentation(session) : undefined;
    const waiting = safety.waiting || session?.status === 'waiting_help';
    const support = session?.support;
    const waitingTitle = safety.pending.some(value => value.type === 'help') ? '職員をよんでいます'
        : support?.status === 'assigned' ? '担当の職員が決まりました' : support?.status === 'in_progress' ? '職員が手伝っています'
        : support?.status === 'acknowledged' ? '対応が終わりました' : '職員を待っています';
    const waitingDetail = message || (safety.pending.length ? '送信しています。'
        : support?.status === 'acknowledged' ? 'つづけるを押すと、同じ工程に戻ります。'
        : connection === 'connected' ? '職員の応答を待っています。' : '通信を確認しながら待っています。');
    return <div className="learner"><p className="eyebrow">職員が確認した手順</p>{!sessionId ? <><h1>{homeHalted ? message || (homeIntent.current === 'stop' ? '作業をやめました' : '近くの職員をよんでください') : 'きょうの さぎょう'}</h1>
        {!homeHalted && (assignments.length ? assignments.map(assignment => <section key={assignment.taskId}><h2>{assignment.title}</h2><button className="primary" disabled={busy} onClick={() => void action(async () => {
            if (starting.current) return;
            const pending = beginSessionStart(localStorage, uid, assignment.taskId, crypto.randomUUID());
            starting.current = true; setBusy(true);
            try { const response = await api('/me/sessions', 'POST', { taskId: pending.taskId, clientRequestId: pending.clientRequestId }); if (account === uid) finishStart(response); }
            finally { starting.current = false; setBusy(false); }
        })}>{learnerControlContent('はじめる')}</button></section>) : <p>職員をよんでください</p>)}</>
        : safety.stopped || session?.status === 'stopped' ? <section>{learnerStateIcon('stopped')}<h1>作業をやめました</h1><p>職員と そうだんしてください</p><p role="status">{message || (safety.pending.length ? '停止を知らせています。' : '停止を職員に知らせました。')}</p></section>
        : waiting ? <section><div role="status">{learnerStateIcon(message ? 'failed' : support?.status ?? 'sending')}<h1>{waitingTitle}</h1><p>{waitingDetail}</p></div>
            <button disabled={busy || safety.pending.length > 0 || support?.status !== 'acknowledged'} onClick={() => void action(() => event('resume'))}>{learnerControlContent('つづける')}</button></section>
        : session?.status === 'completed' ? <section><h1>おわりました</h1><p>職員をよんでください</p></section>
        : session ? <section><p className="position">{session.stepIndex + 1} / {session.steps.length}</p><Asset id={step!.imageAssetId} alt={step!.imageAltText}/>{step!.text !== undefined && <h1>{step!.text}</h1>}{step!.audioAssetId && <Asset key={step!.audioAssetId} id={step!.audioAssetId} audio/>}{step!.visibleCaution !== undefined && <p>{step!.visibleCaution}</p>}
            <div className="controls"><button disabled={busy || session.stepIndex === 0} onClick={() => void action(() => event('back'))}>{learnerControlContent('もどる')}</button><button className="primary" disabled={busy} onClick={() => void action(() => event(session.stepIndex === session.steps.length - 1 ? 'complete' : 'next'))}>{learnerControlContent(session.stepIndex === session.steps.length - 1 ? 'おわる' : 'つぎへ')}</button></div></section>
        : <p>読み込み中です</p>}
        <div className="safety"><button className="help" onClick={() => requestSafety('help')} disabled={homeIntent.current === 'stop' || safety.stopped || waiting || session?.status === 'stopped' || session?.status === 'completed'}>{learnerControlContent('手伝って')}</button><button className="stop" onClick={() => requestSafety('stop')}>{learnerControlContent('やめる')}</button></div></div>;
}
function learnerStateIcon(state: string) {
    const paths: Record<string, string> = {
        stopped: learnerControlPath('やめる'), failed: 'M12 3 2 21h20L12 3Zm0 6v5m0 3v1',
        sending: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4v6l4 2',
        open: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4v6l4 2',
        assigned: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 22v-3a8 8 0 0 1 16 0v3',
        in_progress: learnerControlPath('手伝って'), acknowledged: 'm4 12 5 5L20 5'
    };
    return <svg className="state-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2"><path d={paths[state] ?? paths.sending}/></svg>;
}
function learnerControlContent(label: LearnerControlLabel) {
    return <><svg className="control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={learnerControlPath(label)}/></svg><span>{label}</span></>;
}
createRoot(document.getElementById('root')!).render(<App />);
