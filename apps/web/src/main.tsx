import { StaffLearners } from './staff-learners.tsx';
import { createTokenProvider } from './auth.ts';
import { subscribeSupport } from './support-ws.ts';
import { staffSupportNotificationSchema, learnerSupportNotificationSchema } from '../../../packages/shared/src/support.ts';
import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { EditedStep, ReviewChecks, LearnerSessionDTO } from '../../../packages/shared/src/index.ts';
import { hold, readSafety, flushSafety, safetyKey, clearWaiting } from './safety.ts';
import './style.css';
const accounts = [['staff', '職員'], ['learner-a', '本人 Aさん'], ['learner-b', '本人 Bさん'], ['newcomer', '新人']] as const;
let account = localStorage.getItem('demoAccount') ?? 'staff';
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
function Asset({ id, video = false, audio = false, startMs = 0, endMs }: {
    id: string;
    video?: boolean;
    audio?: boolean;
    startMs?: number;
    endMs?: number;
}) {
    const [url, setUrl] = useState('');
    useEffect(() => {
        let active = true, object = '';
        setUrl('');
        getToken().then(token => fetch(`/api/v1/assets/${id}`, { headers: { Authorization: `Bearer ${token}` } })).then(async (r) => {
            if (!r.ok)
                throw Error();
            object = URL.createObjectURL(await r.blob());
            if (active)
                setUrl(object);
        }).catch(() => {
        });
        return () => {
            active = false;
            if (object)
                URL.revokeObjectURL(object);
        };
    }, [id]);
    return url ? audio ? <audio key={id} src={url} controls preload="metadata" aria-label="手順の読み上げ"/> : video ? <video key={`${id}:${startMs}:${endMs}`} src={`${url}#t=${startMs / 1000}${endMs === undefined ? '' : ',' + endMs / 1000}`} controls preload="metadata"/> : <img src={url} alt="この工程の手元の写真"/> : <div className="placeholder">写真・動画を読み込み中</div>;
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
            go(uid === 'staff' ? '/staff' : uid === 'newcomer' ? '/handover' : '/me');
        }}>てじゅんのバトン</a><span>開発デモ · Fake生成</span><label>デモアカウント <select value={uid} onChange={e => {
            account = e.target.value;
            localStorage.setItem('demoAccount', account);
            setUid(account);
            go(account === 'staff' ? '/staff' : account === 'newcomer' ? '/handover' : '/me');
        }}>{accounts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></header><main key={uid}><p className="notice">架空プロフィールを使ったローカルデモです。生成候補は職員の原動画照合・承認が必要です。</p>{error && <div role="alert" className="error">{error}</div>}{uid === 'staff' ? <Staff path={path} action={action}/> : uid === 'newcomer' ? <Handover path={path} action={action}/> : <Learner uid={uid} path={path} action={action}/>}</main></>;
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
        return <Support action={action}/>;
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
    const load = async () => {
        const d = (await api(`/drafts/${id}`)).draft;
        setDraft(d);
        setSteps(d.editedSteps);
        setChecks(d.reviewChecks);
        setTask((await api(`/tasks/${d.taskId}`)).task);
    };
    useEffect(() => {
        void action(load);
    }, [id]);
    useEffect(() => {
        if (draft?.status !== 'generating')
            return;
        const timer = setInterval(() => void action(load), 3000);
        return () => clearInterval(timer);
    }, [draft?.status]);
    if (!draft)
        return <p>下書きを取得中…</p>;
    const change = (i: number, key: keyof EditedStep, value: string | number) => {
        setSteps(old => old.map((s, j) => i === j ? { ...s, [key]: value } : s));
        setChecks(c => ({ ...c, presentationConfirmed: false, steps: { ...c.steps, [steps[i].stepId]: { videoVerified: false, photoTextVerified: false } } }));
    };
    const save = async () => {
        const result = await api(`/drafts/${id}`, 'PATCH', { expectedRevision: draft.revision, editedSteps: steps, reviewChecks: checks });
        setDraft({ ...draft, revision: result.revision });
        return result.revision;
    };
    return <><nav><button onClick={() => go('/staff')}>作業一覧</button><button onClick={() => go(`/staff/drafts/${id}/review`)}>確認・承認へ</button><button onClick={() => {
            localStorage.removeItem(`approval:${id}`);
            void action(load);
        }}>再取得</button></nav><h1>AIの下書き（解釈）</h1><p>本人：{draft.learnerId === 'a' ? 'Aさん（9工程）' : 'Bさん（折るを細分化・11工程）'} / revision {draft.revision} / {draft.status}</p>{draft.status === 'generating' ? <p role="status">動画解析中です。3秒ごとに状態を確認しています。</p> : draft.status === 'failed' ? <section><p role="alert">生成に失敗しました。本人用の手順は作成されていません。</p><button onClick={() => void action(async () => {
                const r = await api(`/tasks/${draft.taskId}/generations`, 'POST', { learnerId: draft.learnerId });
                go(`/staff/tasks/${draft.taskId}/drafts/${r.draftId}`);
            })}>新しいジョブで再試行</button></section> : draft.status === 'approved' ? <section><h2>承認済みです</h2><button onClick={() => go('/staff/handover')}>承認版を確認・本人へ割当</button></section> : <><p>Fake候補です。動画の動作・原音と候補を照合し、必要な修正と写真切り出しを行ってください。確認欄はすべて未確認から始まります。</p><div className="workspace"><aside>{task?.videoAssetId && <Asset id={task.videoAssetId} video/>}<h2>AIの候補・確認が必要な点</h2>{draft.aiProposal?.reviewFlags.map((f: string) => <p key={f}>{f}</p>)}{draft.aiProposal?.steps.map((s: any) => <details key={s.stepId}><summary>{s.stepId}：{s.startMs}–{s.endMs} ms</summary><p>観察候補：{s.observationCandidate}</p><p>声の候補：{s.speechCandidate || '聞き取り未確認'}</p>{s.reviewFlags.map((f: string) => <p key={f}>{f}</p>)}</details>)}</aside><div>{steps.map((s, i) => <section key={s.stepId}><h2>工程 {i + 1}</h2>{s.imageAssetId && <Asset id={s.imageAssetId}/>}<label>本人に見せる短文（40文字以内）<input maxLength={40} value={s.text} onChange={e => change(i, 'text', e.target.value)}/></label><label>本人に見せる注意<input maxLength={200} value={s.visibleCaution} onChange={e => change(i, 'visibleCaution', e.target.value)}/></label><div className="times">{(['sourceStartMs', 'sourceEndMs', 'frameMs'] as const).map((key, j) => <label key={key}>{['開始ms', '終了ms', '写真ms'][j]}<input type="number" min={0} value={s[key]} onChange={e => change(i, key, Number(e.target.value))}/></label>)}</div><button disabled={busy} onClick={() => void action(async () => {
                    setBusy(true);
                    try {
                        const r = await api(`/drafts/${id}/frames`, 'POST', { frameMs: s.frameMs });
                        change(i, 'imageAssetId', r.imageAssetId);
                    }
                    finally {
                        setBusy(false);
                    }
                })}>この時刻の写真を原動画から切り出す</button>{(['verifiedObservation', 'verifiedSpeech', 'coaching', 'completionCheck'] as const).map((key, j) => <label key={key}>{['確認した動作', '確認した声', '職員用声かけ・待つ位置', '完成基準'][j]}<textarea maxLength={200} value={s[key]} onChange={e => change(i, key, e.target.value)}/></label>)}{(['videoVerified', 'photoTextVerified'] as const).map((key, j) => <label className="check" key={key}><input type="checkbox" checked={checks.steps[s.stepId]?.[key] ?? false} onChange={e => setChecks(c => ({ ...c, steps: { ...c.steps, [s.stepId]: { ...(c.steps[s.stepId] ?? { videoVerified: false, photoTextVerified: false }), [key]: e.target.checked } } }))}/>{['動画照合済み', '写真・説明確認済み'][j]}</label>)}<button onClick={() => setPreview(i)}>本人表示をプレビュー</button><button onClick={() => {
                    const newStep = {
                        ...s, stepId: crypto.randomUUID(), text: '', imageAssetId: ''
                    };
                    setSteps(old => [...old.slice(0, i + 1), newStep, ...old.slice(i + 1)]);
                    setChecks(c => ({ ...c, presentationConfirmed: false }));
                }} disabled={steps.length >= 20}>次に工程を追加</button><button disabled={steps.length <= 1} onClick={() => {
                    setSteps(old => old.filter((_, j) => j !== i));
                    setChecks(c => ({ ...c, presentationConfirmed: false }));
                }}>この工程を削除</button></section>)}</div></div><section><label>確認が必要な点への対応記録<textarea value={checks.flagResolution} onChange={e => setChecks(c => ({ ...c, flagResolution: e.target.value }))}/></label><label className="check"><input type="checkbox" checked={checks.presentationConfirmed} onChange={e => setChecks(c => ({ ...c, presentationConfirmed: e.target.checked }))}/>本人への提示内容確認済み</label><button disabled={busy} onClick={() => void action(async () => {
                setBusy(true);
                try {
                    await save();
                }
                finally {
                    setBusy(false);
                }
            })}>編集と確認を保存</button><button disabled={busy} onClick={() => void action(async () => {
                setBusy(true);
                try {
                    const key = `approval:${id}`;
                    const saved = localStorage.getItem(key);
                    const payload = saved ? JSON.parse(saved) : { expectedRevision: await save(), approvalRequestId: crypto.randomUUID() };
                    localStorage.setItem(key, JSON.stringify(payload));
                    const r = await api(`/drafts/${id}/approve`, 'POST', payload);
                    setRelease(r);
                    setDraft({ ...draft, status: 'approved', revision: payload.expectedRevision });
                }
                finally {
                    setBusy(false);
                }
            })}>この内容を承認</button></section></>}{release && <section><h2>版 {release.version} を新規保存しました</h2><button onClick={() => void action(async () => {
                await api(`/assignments/${draft.learnerId}/${draft.taskId}`, 'PUT', { releaseId: release.releaseId });
                go('/staff/handover');
            })}>本人の端末へ渡す（次回開始版）</button></section>}{preview !== null && steps[preview] && <div className="modal" role="dialog" aria-modal="true" aria-label="職員用本人表示プレビュー"><section><p>職員認証内のプレビュー（未承認）</p><Asset id={steps[preview].imageAssetId}/><h2>{steps[preview].text}</h2><p>{steps[preview].visibleCaution}</p><button onClick={() => setPreview(null)}>閉じる</button></section></div>}</>;
}
function Support({ action }: {
    action: Action;
}) {
    const [items, setItems] = useState<any[]>([]);
    const loadSequence = useRef(0);
    const load = async () => {
        const sequence = ++loadSequence.current;
        const data = await api('/support-requests');
        if (sequence === loadSequence.current) setItems(data.requests);
    };
    useEffect(() => {
        void action(load);
        const t = setInterval(() => void action(load), 3000);
        const unsubscribe = subscribeSupport(getToken, undefined, value => {
            staffSupportNotificationSchema.parse(value);
            void action(load);
        });
        return () => { clearInterval(t); unsubscribe(); };
    }, []);
    return <><button onClick={() => go('/staff')}>作業一覧</button><h1>支援要求</h1><p>3秒間隔で更新します。</p>{!items.length && <p>未対応の要求はありません。</p>}{items.map(q => <section key={q.requestId}><h2>{q.kind === 'stop' ? 'やめる' : '手伝って'}：{q.status === 'open' ? '対応待ち' : q.status === 'assigned' ? '担当決定済み' : '対応中'}</h2><button onClick={() => void action(async () => {
                await api(`/support-requests/${q.requestId}/${q.kind === 'stop' ? 'acknowledge' : q.status === 'open' ? 'claim' : q.status === 'assigned' ? 'start' : 'acknowledge'}`, 'POST', {});
                await load();
            })}>{q.kind === 'stop' ? '確認した' : q.status === 'open' ? '担当する' : q.status === 'assigned' ? '対応開始' : '対応済み'}</button></section>)}</>;
}
function Handover({ path, action, staff = false }: {
    path: string;
    action: Action;
    staff?: boolean;
}) {
    const [items, setItems] = useState<any[]>([]), [release, setRelease] = useState<any>(), [read, setRead] = useState(''), [filter, setFilter] = useState('');
    const releaseId = path.match(/\/releases\/([^/]+)/)?.[1];
    useEffect(() => {
        void action(async () => {
            setItems((await api('/handover/releases')).releases);
            if (releaseId)
                setRelease((await api(`/handover/releases/${releaseId}`)).release);
        });
    }, [path]);
    return <><h1>職員が確認した手順・教え方</h1><p>承認版だけを表示します。</p>{releaseId && release ? <><button onClick={() => go(staff ? '/staff/handover' : '/handover')}>一覧へ</button><p>承認者 {release.approvedBy} / {new Date(release.approvedAt).toLocaleString('ja-JP')}</p>{release.learnerSteps.map((s: any, i: number) => {
                const g = release.staffGuide[i];
                return <section key={s.stepId}><h2>{i + 1}：{s.text}</h2><div className="two"><Asset id={s.imageAssetId}/><div><p>{s.visibleCaution}</p><p>確認した動作：{g.verifiedObservation}</p><p>確認した声：{g.verifiedSpeech || '記録なし'}</p><p>声かけ・待つ位置：{g.coaching}</p><p>完成基準：{g.completionCheck}</p><p>原動画：{g.sourceStartMs}–{g.sourceEndMs} ms</p><Asset id={release.videoAssetId} video startMs={g.sourceStartMs} endMs={g.sourceEndMs}/></div></div></section>;
            })}{!staff && <button onClick={() => void action(async () => {
                    setRead((await api(`/handover/releases/${releaseId}/read`, 'POST', {})).readAt);
                })}>引き継ぎを読んだ</button>}{read && <p>閲覧時刻を記録しました：{new Date(read).toLocaleString('ja-JP')}</p>}</> : <><label>本人で絞り込む<select value={filter} onChange={e => setFilter(e.target.value)}><option value="">すべて</option><option value="a">Aさん</option><option value="b">Bさん</option></select></label>{!items.length && <p>承認済み版はまだありません。</p>}{items.filter(r => !filter || r.learnerId === filter).map(r => <section key={r.releaseId}><h2>{r.title} / {r.displayName} / 版 {r.version}</h2><p>承認者 {r.approvedBy} / {new Date(r.approvedAt).toLocaleString('ja-JP')}</p><button onClick={() => go(`${staff ? '/staff' : ''}/handover/releases/${r.releaseId}`)}>教え方を見る</button>{staff ? <button onClick={() => void action(async () => {
                        await api(`/assignments/${r.learnerId}/${r.taskId}`, 'PUT', { releaseId: r.releaseId });
                        alert('次回の開始版として割り当てました');
                    })}>本人の端末へ渡す（次回開始版）</button> : null}</section>)}</>}</>;
}
function Learner({ uid, path, action }: {
    uid: string;
    path: string;
    action: Action;
}) {
    const sessionId = path.match(/\/me\/sessions\/([^/]+)/)?.[1];
    const latestSupport = useRef({ sessionId: '', session: -1, requestId: '', support: -1 });
    const [assignments, setAssignments] = useState<any[]>([]), [session, setSession] = useState<LearnerSessionDTO>(), [safetyTick, setSafetyTick] = useState(0), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [homeHalted, setHomeHalted] = useState(false);
    const key = sessionId ? safetyKey(uid, sessionId) : '';
    const safety = readSafety(localStorage, key);
    useEffect(() => {
        setSession(undefined);
        void action(async () => {
            if (sessionId)
                setSession(await api(`/me/sessions/${sessionId}`));
            else
                setAssignments((await api('/me/assignments')).assignments);
        });
    }, [path]);
    useEffect(() => {
        let running = false, active = true;
        const retry = async () => {
            if (running)
                return;
            running = true;
            try {
                const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => !!k && k.startsWith(`safety:${uid}:`));
                for (const pendingKey of keys) {
                    if (!active || account !== uid)
                        return;
                    if (!readSafety(localStorage, pendingKey).pending.length)
                        continue;
                    const pendingSession = pendingKey.slice(`safety:${uid}:`.length);
                    const ok = await flushSafety(localStorage, pendingKey, {
                        send: async (e) => {
                            await api(`/me/sessions/${pendingSession}/events`, 'POST', e);
                        },
                        load: () => api(`/me/sessions/${pendingSession}`)
                    });
                    if (active && pendingKey === key) {
                        setMessage(ok ? (readSafety(localStorage, pendingKey).stopped ? '停止を職員に知らせました' : '職員をよんでいます') : '近くの職員をよんでください。送信をやり直しています。');
                        if (ok)
                            setSafetyTick(x => x + 1);
                    }
                }
            }
            finally {
                running = false;
            }
        };
        void retry();
        const timer = setInterval(retry, 2000);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [uid, key, safetyTick]);
    useEffect(() => {
        if (!sessionId || !(safety.waiting || session?.status === 'waiting_help') || safety.stopped) return;
        let active = true;
        const apply = (state: { sessionId: string; releaseId: string; status: LearnerSessionDTO['status']; stepIndex: number; revision: number; support?: { requestId: string; revision: number; status: string } }) => {
            if (!active || state.sessionId !== sessionId || readSafety(localStorage, key).stopped) return;
            const latest = latestSupport.current;
            if (latest.sessionId === sessionId && (state.revision < latest.session || (state.support?.requestId === latest.requestId && state.support && state.support.revision < latest.support))) return;
            latestSupport.current = { sessionId, session: state.revision, requestId: state.support?.requestId ?? (state.revision === latest.session ? latest.requestId : ''), support: state.support?.revision ?? (state.revision === latest.session ? latest.support : -1) };
            setSession(previous => {
                if (!previous || previous.releaseId !== state.releaseId || state.revision < previous.revision) return previous;
                // Only a saved transition beyond the help revision can release the local wait.
                const pending = readSafety(localStorage, key);
                if (state.status === 'active' && state.revision > previous.revision && !pending.pending.length) clearWaiting(localStorage, key);
                return { ...previous, status: state.status, stepIndex: state.stepIndex, revision: state.revision };
            });
            if (state.support) setMessage(state.support.status === 'open' ? '職員をよんでいます' : state.support.status === 'acknowledged' ? '対応が終わりました' : '担当の職員が決まりました');
        };
        const poll = async () => { try { apply(await api(`/me/sessions/${sessionId}`)); } catch { /* Keep waiting during disconnects. */ } };
        const timer = setInterval(() => void poll(), 3000);
        const unsubscribe = subscribeSupport(getToken, sessionId, value => apply(learnerSupportNotificationSchema.parse(value).payload));
        return () => { active = false; clearInterval(timer); unsubscribe(); };
    }, [uid, sessionId, safety.waiting, safety.stopped, session?.status]);
    const requestSafety = (type: 'help' | 'stop') => {
        if (!sessionId) {
            setHomeHalted(true);
            setMessage(type === 'stop' ? '作業をやめました' : '近くの職員をよんでください');
            return;
        }
        hold(localStorage, key, { clientEventId: crypto.randomUUID(), expectedRevision: session?.revision ?? 0, type });
        setMessage('近くの職員をよんでください。送信しています。');
        setSafetyTick(x => x + 1);
    };
    const event = async (type: string) => {
        if (readSafety(localStorage, key).stopped)
            return;
        setBusy(true);
        try {
            await api(`/me/sessions/${sessionId}/events`, 'POST', { clientEventId: crypto.randomUUID(), expectedRevision: session!.revision, type });
            if (type === 'resume')
                clearWaiting(localStorage, key);
            const s = await api(`/me/sessions/${sessionId}`);
            setSession(s);
        }
        finally {
            setBusy(false);
        }
    };
    return <div className="learner"><p className="eyebrow">職員が確認した手順</p>{!sessionId ? <><h1>{homeHalted ? message : 'きょうの さぎょう'}</h1>{!homeHalted && (assignments.length ? assignments.map(a => <section key={a.taskId}><h2>{a.title}</h2><button className="primary" disabled={busy} onClick={() => void action(async () => {
                    setBusy(true);
                    try {
                        const s = await api('/me/sessions', 'POST', { taskId: a.taskId, clientRequestId: crypto.randomUUID() });
                        go(`/me/sessions/${s.sessionId}`);
                    }
                    finally {
                        setBusy(false);
                    }
                })}>はじめる</button></section>) : <p>職員をよんでください</p>)}</> : safety.stopped || session?.status === 'stopped' ? <section><h1>作業をやめました</h1><p>職員と そうだんしてください</p><p role="status">{message}</p></section> : safety.waiting || session?.status === 'waiting_help' ? <section><h1>職員をよんでいます</h1><p role="status">{message}</p><button disabled={busy || safety.pending.length > 0 || !session} onClick={() => void action(async () => {
                const fresh = await api(`/me/sessions/${sessionId}`);
                setSession(fresh);
                await api(`/me/sessions/${sessionId}/events`, 'POST', { clientEventId: crypto.randomUUID(), expectedRevision: fresh.revision, type: 'resume' });
                clearWaiting(localStorage, key);
                setSession(await api(`/me/sessions/${sessionId}`));
            })}>つづける</button></section> : session?.status === 'completed' ? <section><h1>おわりました</h1><p>職員をよんでください</p></section> : session ? <section><p className="position">{session.stepIndex + 1} / {session.steps.length}</p><Asset id={session.steps[session.stepIndex].imageAssetId}/><h1>{session.steps[session.stepIndex].text}</h1>{session.steps[session.stepIndex].audioAssetId && <Asset key={session.steps[session.stepIndex].audioAssetId} id={session.steps[session.stepIndex].audioAssetId!} audio/>}<p>{session.steps[session.stepIndex].visibleCaution}</p><div className="controls"><button disabled={busy || session.stepIndex === 0} onClick={() => void action(() => event('back'))}>もどる</button><button className="primary" disabled={busy} onClick={() => void action(() => event(session.stepIndex === session.steps.length - 1 ? 'complete' : 'next'))}>{session.stepIndex === session.steps.length - 1 ? 'おわる' : 'つぎへ'}</button></div></section> : <p>読み込み中です</p>}<div className="safety"><button className="help" onClick={() => requestSafety('help')} disabled={safety.stopped || session?.status === 'stopped'}>手伝って</button><button className="stop" onClick={() => requestSafety('stop')}>やめる</button></div></div>;
}
createRoot(document.getElementById('root')!).render(<App />);
