import React, { useEffect, useRef, useState } from 'react';
import { learnerProfileDetailSchema, learnerProfileListResponseSchema, type LearnerProfileUpdateRequest, type LearnerProfileCreateRequest, type LearnerProfileDetail, type LearnerProfileSummary } from '../../../packages/shared/src/learner-profile.ts';
import { buildLearnerProfileUpdate, learnerProfileToForm, buildLearnerProfile, emptyLearnerForm, type LearnerForm } from './learner-form.ts';

const notes = [['learnerWishes', '本人希望'], ['staffObservations', '職員による観察'], ['staffSuggestions', '職員による提案'], ['confirmedGuidance', '確認済みの配慮']] as const;
export function ProfileValues({ profile }: { profile: LearnerProfileCreateRequest | LearnerProfileUpdateRequest }) {
    const p = profile.preferences;
    return <dl><dt>表示名</dt><dd>{profile.displayName}</dd>{notes.map(([key, label]) => <React.Fragment key={key}><dt>{label}</dt><dd>{profile[key]?.join('／') || '未確認'}</dd></React.Fragment>)}
        <dt>希望する表示</dt><dd>{p?.displayMode === 'photo_only' ? '写真のみ' : p?.displayMode === 'photo_text' ? '写真＋短文' : '未確認'}</dd>
        <dt>短文の長さ</dt><dd>{p?.sentenceLength ?? '未確認'}</dd><dt>音声ガイド</dt><dd>{p?.audioGuidance === undefined ? '未確認' : p.audioGuidance ? '希望する' : '希望しない'}</dd>
        <dt>表示のヒント</dt><dd>{p?.splitHints || '未確認'}</dd><dt>障害に関する情報（任意）</dt><dd>{profile.disabilityInfo ? <>{profile.disabilityInfo.detail}<br/>出典：{profile.disabilityInfo.source}<br/>確認日時：{profile.disabilityInfo.confirmedAt}</> : profile.disabilityInfo === null ? '削除する' : '未確認'}</dd></dl>;
}
export function StaffLearners({ path, api, go }: { path: string; api: (path: string, method?: string, body?: unknown) => Promise<any>; go: (path: string) => void }) {
    const [items, setItems] = useState<LearnerProfileSummary[]>([]), [detail, setDetail] = useState<LearnerProfileDetail>();
    const [form, setForm] = useState<LearnerForm>({ ...emptyLearnerForm });
    const [preview, setPreview] = useState<LearnerProfileCreateRequest | LearnerProfileUpdateRequest>(), [error, setError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
    const sending = useRef(false), heading = useRef<HTMLHeadingElement>(null);
    const [conflict, setConflict] = useState(false);
    const isEdit = path.endsWith('/edit');
    const id = path.slice('/staff/learners'.length + 1).replace(/\/edit$/, '');
    const isNew = path === '/staff/learners/new';
    useEffect(() => {
        let active = true;
        setError(''); setDetail(undefined); setPreview(undefined); setForm({ ...emptyLearnerForm }); setConflict(false);
        if (isNew) return;
        setLoading(true);
        (async () => {
            try {
                const result = await api(id ? `/learners/${encodeURIComponent(id)}` : '/learners');
                if (active) { if (id) { const saved = learnerProfileDetailSchema.parse(result); setDetail(saved); if (isEdit) setForm(learnerProfileToForm(saved)); } else setItems(learnerProfileListResponseSchema.parse(result).items); }
            } catch (e) { if (active) setError((e as Error).message); }
            finally { if (active) setLoading(false); }
        })();
        return () => { active = false; };
    }, [path]);
    useEffect(() => { heading.current?.focus(); }, [path, preview]);
    const field = (key: keyof LearnerForm) => ({ value: form[key], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm(old => ({ ...old, [key]: e.target.value })) });
    const submit = async () => {
        if (sending.current || conflict || !preview) return;
        sending.current = true; setBusy(true); setError('');
        try { await api(isEdit ? `/learners/${encodeURIComponent(id)}` : '/learners', isEdit ? 'PATCH' : 'POST', preview); go(isEdit ? `/staff/learners/${id}` : '/staff/learners'); }
        catch (e) { setError((e as Error).message); if ((e as { status?: number }).status === 409) setConflict(true); }
        finally { sending.current = false; setBusy(false); }
    };
    const refresh = async () => {
        setBusy(true); setError('');
        try { setDetail(learnerProfileDetailSchema.parse(await api(`/learners/${encodeURIComponent(id)}`))); setPreview(undefined); setConflict(false); }
        catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
    };
    return <section><h1 ref={heading} tabIndex={-1}>{isEdit ? preview ? '更新内容の確認' : '本人プロフィール編集' : isNew ? preview ? '登録内容の確認' : '本人プロフィール登録' : detail ? `${detail.displayName}のプロフィール` : '本人一覧'}</h1>
        {error && <p role="alert">{error}</p>}
        {isEdit && detail && <aside><h2>保存されている値（最新取得時）</h2><ProfileValues profile={detail}/><p>登録者：{detail.enteredBy}／更新者：{detail.updatedBy}／revision：{detail.revision}</p><p>入力値は最新値の取得では変わりません。比較してから更新内容を確認してください。</p></aside>}
        {conflict && <button disabled={busy} onClick={() => void refresh()}>最新値を取得</button>}
        {isEdit && (loading || !detail) ? loading ? <p role="status">読み込み中です</p> : null : isNew || isEdit ? preview ? <><ProfileValues profile={isEdit && !Object.hasOwn(preview, 'disabilityInfo') ? { ...preview, disabilityInfo: detail?.disabilityInfo } : preview}/>{isEdit && !Object.hasOwn(preview, 'disabilityInfo') && <p>障害に関する情報：変更しない（保持）</p>}<button disabled={busy} onClick={() => { setPreview(undefined); setError(''); }}>修正へ戻る</button><button disabled={busy || conflict} onClick={() => void submit()}>{busy ? isEdit ? '更新しています…' : '登録しています…' : isEdit ? 'この内容で更新する' : 'この内容で登録する'}</button></> : <form onSubmit={e => { e.preventDefault(); try { setPreview(isEdit ? buildLearnerProfileUpdate(form, detail!.revision) : buildLearnerProfile(form)); setError(''); } catch (e) { setError((e as Error).message); } }}>
            <p>空欄は未確認として保存します。希望・観察・提案は分けて記録してください。</p>
            <label>表示名（必須）<input required maxLength={100} {...field('displayName')}/></label>
            {notes.map(([key, label]) => <label key={key}>{label}（任意・1行1件、各500文字以内、20件まで）<textarea {...field(key)}/></label>)}
            <label>希望する表示<select {...field('displayMode')}><option value="">未確認</option><option value="photo_only">写真のみ</option><option value="photo_text">写真＋短文</option></select></label>
            <label>短文の長さ（任意・1〜40文字）<input type="number" min={1} max={40} step={1} {...field('sentenceLength')}/></label>
            <label>音声ガイド<select {...field('audioGuidance')}><option value="">未確認</option><option value="true">希望する</option><option value="false">希望しない</option></select></label>
            <label>表示のヒント（任意・200文字以内）<textarea maxLength={200} {...field('splitHints')}/></label>
            <fieldset><legend>障害に関する情報（任意）</legend><p>本人が共有を希望する支援上必要な内容に限ります。記録する場合は3項目すべてを入力してください。</p>
                {isEdit && <label>障害情報の変更<select {...field('disabilityAction')}><option value="keep">変更しない（保持・送信時は省略）</option><option value="replace">新しい値に置き換える</option><option value="delete">明示的に削除する（nullを送信）</option></select></label>}
                {(!isEdit || form.disabilityAction === 'replace') && <><label>詳細<input maxLength={500} required={!!(form.disabilitySource || form.disabilityConfirmedAt)} {...field('disabilityDetail')}/></label>
                <label>出典<input maxLength={200} required={!!(form.disabilityDetail || form.disabilityConfirmedAt)} {...field('disabilitySource')}/></label>
                <label>確認日時（端末の現地時刻）<input type="datetime-local" step="any" required={!!(form.disabilityDetail || form.disabilitySource)} {...field('disabilityConfirmedAt')}/></label></>}
            </fieldset><button type="submit" disabled={busy || conflict}>{isEdit ? '更新内容を確認する' : '登録内容を確認する'}</button></form> : loading ? <p role="status">読み込み中です</p> : detail ? <><ProfileValues profile={detail}/><button onClick={() => go(`/staff/learners/${id}/edit`)}>プロフィールを編集する</button></> : <><button onClick={() => go('/staff/learners/new')}>本人を登録する</button>{items.length ? <ul>{items.map(item => <li key={item.learnerId}><button onClick={() => go(`/staff/learners/${encodeURIComponent(item.learnerId)}`)}>{item.displayName}の詳細</button></li>)}</ul> : !error && <p>登録された本人はいません。</p>}</>}
        <button disabled={busy} onClick={() => go('/staff/learners')}>本人一覧へ戻る</button>
    </section>;
}
