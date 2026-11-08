import React, { useEffect, useRef, useState } from 'react';
import { learnerProfileDetailSchema, learnerProfileListResponseSchema, type LearnerProfileCreateRequest, type LearnerProfileDetail, type LearnerProfileSummary } from '../../../packages/shared/src/learner-profile.ts';
import { buildLearnerProfile, emptyLearnerForm, type LearnerForm } from './learner-form.ts';

const notes = [['learnerWishes', '本人希望'], ['staffObservations', '職員による観察'], ['staffSuggestions', '職員による提案']] as const;
export function ProfileValues({ profile }: { profile: LearnerProfileCreateRequest }) {
    const p = profile.preferences;
    return <dl><dt>表示名</dt><dd>{profile.displayName}</dd>{notes.map(([key, label]) => <React.Fragment key={key}><dt>{label}</dt><dd>{profile[key]?.join('／') || '未確認'}</dd></React.Fragment>)}
        <dt>希望する表示</dt><dd>{p?.displayMode === 'photo_only' ? '写真のみ' : p?.displayMode === 'photo_text' ? '写真＋短文' : '未確認'}</dd>
        <dt>短文の長さ</dt><dd>{p?.sentenceLength ?? '未確認'}</dd><dt>音声ガイド</dt><dd>{p?.audioGuidance === undefined ? '未確認' : p.audioGuidance ? '希望する' : '希望しない'}</dd>
        <dt>表示のヒント</dt><dd>{p?.splitHints || '未確認'}</dd><dt>障害に関する情報（任意）</dt><dd>{profile.disabilityInfo ? <>{profile.disabilityInfo.detail}<br/>出典：{profile.disabilityInfo.source}<br/>確認日時：{profile.disabilityInfo.confirmedAt}</> : '未確認'}</dd></dl>;
}
export function StaffLearners({ path, api, go }: { path: string; api: (path: string, method?: string, body?: unknown) => Promise<any>; go: (path: string) => void }) {
    const [items, setItems] = useState<LearnerProfileSummary[]>([]), [detail, setDetail] = useState<LearnerProfileDetail>();
    const [form, setForm] = useState<LearnerForm>({ ...emptyLearnerForm });
    const [preview, setPreview] = useState<LearnerProfileCreateRequest>(), [error, setError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
    const sending = useRef(false), heading = useRef<HTMLHeadingElement>(null);
    const isNew = path === '/staff/learners/new';
    useEffect(() => {
        let active = true;
        setError(''); setDetail(undefined);
        if (isNew) return;
        setLoading(true);
        const id = path.slice('/staff/learners'.length + 1);
        (async () => {
            try {
                const result = await api(id ? `/learners/${encodeURIComponent(id)}` : '/learners');
                if (active) { if (id) setDetail(learnerProfileDetailSchema.parse(result)); else setItems(learnerProfileListResponseSchema.parse(result).items); }
            } catch (e) { if (active) setError((e as Error).message); }
            finally { if (active) setLoading(false); }
        })();
        return () => { active = false; };
    }, [path]);
    useEffect(() => { heading.current?.focus(); }, [path, preview]);
    const field = (key: keyof LearnerForm) => ({ value: form[key], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm(old => ({ ...old, [key]: e.target.value })) });
    const submit = async () => {
        if (sending.current || !preview) return;
        sending.current = true; setBusy(true); setError('');
        try { await api('/learners', 'POST', preview); go('/staff/learners'); }
        catch (e) { setError((e as Error).message); }
        finally { sending.current = false; setBusy(false); }
    };
    return <section><h1 ref={heading} tabIndex={-1}>{isNew ? preview ? '登録内容の確認' : '本人プロフィール登録' : detail ? `${detail.displayName}のプロフィール` : '本人一覧'}</h1>
        {error && <p role="alert">{error}</p>}
        {isNew ? preview ? <><ProfileValues profile={preview}/><button disabled={busy} onClick={() => { setPreview(undefined); setError(''); }}>修正へ戻る</button><button disabled={busy} onClick={() => void submit()}>{busy ? '登録しています…' : 'この内容で登録する'}</button></> : <form onSubmit={e => { e.preventDefault(); try { setPreview(buildLearnerProfile(form)); setError(''); } catch (e) { setError((e as Error).message); } }}>
            <p>空欄は未確認として登録します。希望・観察・提案は分けて記録してください。</p>
            <label>表示名（必須）<input required maxLength={100} {...field('displayName')}/></label>
            {notes.map(([key, label]) => <label key={key}>{label}（任意・1行1件、各500文字以内、20件まで）<textarea {...field(key)}/></label>)}
            <label>希望する表示<select {...field('displayMode')}><option value="">未確認</option><option value="photo_only">写真のみ</option><option value="photo_text">写真＋短文</option></select></label>
            <label>短文の長さ（任意・1〜40文字）<input type="number" min={1} max={40} step={1} {...field('sentenceLength')}/></label>
            <label>音声ガイド<select {...field('audioGuidance')}><option value="">未確認</option><option value="true">希望する</option><option value="false">希望しない</option></select></label>
            <label>表示のヒント（任意・200文字以内）<textarea maxLength={200} {...field('splitHints')}/></label>
            <fieldset><legend>障害に関する情報（任意）</legend><p>本人が共有を希望する支援上必要な内容に限ります。記録する場合は3項目すべてを入力してください。</p>
                <label>詳細<input maxLength={500} required={!!(form.disabilitySource || form.disabilityConfirmedAt)} {...field('disabilityDetail')}/></label>
                <label>出典<input maxLength={200} required={!!(form.disabilityDetail || form.disabilityConfirmedAt)} {...field('disabilitySource')}/></label>
                <label>確認日時（端末の現地時刻）<input type="datetime-local" required={!!(form.disabilityDetail || form.disabilitySource)} {...field('disabilityConfirmedAt')}/></label>
            </fieldset><button type="submit">登録内容を確認する</button></form> : loading ? <p role="status">読み込み中です</p> : detail ? <><ProfileValues profile={detail}/><h2>確認済みの配慮</h2><p>{detail.confirmedGuidance?.join('／') || '未確認'}</p></> : <><button onClick={() => go('/staff/learners/new')}>本人を登録する</button>{items.length ? <ul>{items.map(item => <li key={item.learnerId}><button onClick={() => go(`/staff/learners/${encodeURIComponent(item.learnerId)}`)}>{item.displayName}の詳細</button></li>)}</ul> : !error && <p>登録された本人はいません。</p>}</>}
        <button disabled={busy} onClick={() => go('/staff/learners')}>本人一覧へ戻る</button>
    </section>;
}
