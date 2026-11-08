import React, { useEffect, useRef, useState } from 'react';
import { supportRecordSchema, supportRequestListResponseSchema, staffSupportNotificationSchema,
    type SupportRecord, type SupportRequest } from '../../../packages/shared/src/support.ts';
import { subscribeSupport, type SupportConnection } from './support-ws.ts';
import type { TokenProvider } from './auth.ts';

type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
type TextFields = Pick<SupportRecord, 'observedDifficulty' | 'assistanceGiven' | 'improvementSuggestion'>;
type Editor = { request: SupportRequest; open: boolean; loaded: boolean; revision: number; text: TextFields;
    saving: boolean; dirty: boolean; error: string; notice: string; conflict?: SupportRecord };
const emptyText = (): TextFields => ({ observedDifficulty: '', assistanceGiven: '', improvementSuggestion: '' });
const recordText = (record: SupportRecord): TextFields => ({ observedDifficulty: record.observedDifficulty,
    assistanceGiven: record.assistanceGiven, improvementSuggestion: record.improvementSuggestion });
const statusText = { open: '未担当', assigned: '担当決定', in_progress: '対応中', acknowledged: '対応完了' };

export function StaffSupport({ api, getToken, go }: { api: Api; getToken: TokenProvider; go: (path: string) => void }) {
    const [items, setItems] = useState<SupportRequest[]>([]), [completed, setCompleted] = useState(false);
    const [connection, setConnection] = useState<SupportConnection>('connecting');
    const [error, setError] = useState(''), [notice, setNotice] = useState('');
    const [busy, setBusy] = useState<Record<string, boolean>>({}), [consent, setConsent] = useState<Record<string, boolean>>({});
    const [editors, setEditors] = useState<Record<string, Editor>>({});
    const live = useRef(true), sequence = useRef(0), currentEditors = useRef(editors);
    const resumeKeys = useRef<Record<string, { clientRequestId: string; expectedSessionRevision: number }>>({});
    currentEditors.current = editors;
    const changeEditor = (id: string, change: (value: Editor) => Editor) => setEditors(previous => {
        const next = { ...previous, [id]: change(previous[id]) };
        currentEditors.current = next;
        return next;
    });
    async function load() {
        const version = ++sequence.current;
        const response = supportRequestListResponseSchema.parse(await api(`/support-requests${completed ? '?status=acknowledged' : ''}`));
        if (!live.current || version !== sequence.current) return;
        setItems(previous => response.requests.map(request => {
            const old = previous.find(value => value.requestId === request.requestId);
            return old && (old.revision > request.revision || old.revision === request.revision &&
                (old.context?.sessionRevision ?? -1) > (request.context?.sessionRevision ?? -1)) ? old : request;
        }));
    }
    useEffect(() => {
        live.current = true;
        const refresh = () => { void load().catch(() => { if (live.current) setError('一覧を取得できません。通信を確認してください。入力した記録は残っています。'); }); };
        refresh();
        const unsubscribe = subscribeSupport(getToken, undefined, value => {
            staffSupportNotificationSchema.parse(value);
            refresh();
        }, value => { if (live.current) setConnection(value); });
        return () => { live.current = false; sequence.current++; unsubscribe(); };
    }, [completed]);
    useEffect(() => {
        if (connection === 'connected') return;
        const timer = setInterval(() => { void load().catch(() => { if (live.current) setError('通信を確認しています。入力した記録は残っています。'); }); }, 3000);
        return () => clearInterval(timer);
    }, [connection, completed]);

    async function openRecord(request: SupportRequest) {
        const id = request.requestId;
        if (currentEditors.current[id]) {
            changeEditor(id, value => ({ ...value, open: true }));
            return;
        }
        const editor: Editor = { request, open: true, loaded: false, revision: 0, text: emptyText(), saving: false,
            dirty: false, error: '', notice: '' };
        currentEditors.current = { ...currentEditors.current, [id]: editor };
        setEditors(currentEditors.current);
        try {
            const record = supportRecordSchema.parse(await api(`/support-requests/${id}/record`));
            if (live.current) changeEditor(id, value => ({ ...value, loaded: true, revision: record.revision, text: recordText(record) }));
        } catch (e) {
            if (!live.current) return;
            if ((e as { status?: number }).status === 404) changeEditor(id, value => ({ ...value, loaded: true }));
            else changeEditor(id, value => ({ ...value, error: '記録を取得できません。支援と再開は続けられます。' }));
        }
    }
    async function refreshRecord(id: string) {
        try {
            const record = supportRecordSchema.parse(await api(`/support-requests/${id}/record`));
            if (live.current) changeEditor(id, value => value.loaded
                ? { ...value, conflict: record, error: '保存済みの記録を表示しました。入力は残っています。' }
                : { ...value, loaded: true, revision: record.revision, text: recordText(record), error: '' });
        } catch (e) {
            if (!live.current) return;
            if ((e as { status?: number }).status === 404) changeEditor(id, value => ({ ...value, loaded: true, revision: 0, error: '' }));
            else changeEditor(id, value => ({ ...value, error: '最新の記録を取得できません。入力は残っています。' }));
        }
    }
    async function saveRecord(id: string) {
        const editor = currentEditors.current[id];
        if (!editor.loaded || editor.saving || editor.conflict) return;
        const text = { ...editor.text };
        changeEditor(id, value => ({ ...value, saving: true, error: '', notice: '' }));
        try {
            const saved = supportRecordSchema.parse(await api(`/support-requests/${id}/record`, 'PUT', { expectedRevision: editor.revision, ...text }));
            if (live.current) changeEditor(id, value => ({ ...value, revision: saved.revision,
                dirty: JSON.stringify(value.text) !== JSON.stringify(text), notice: '記録を保存しました。' }));
        } catch (e) {
            if (!live.current) return;
            changeEditor(id, value => ({ ...value, error: '保存できませんでした。入力は残っています。' }));
            if ((e as { status?: number }).status === 409) await refreshRecord(id);
        } finally {
            if (live.current) changeEditor(id, value => ({ ...value, saving: false }));
        }
    }
    async function operate(request: SupportRequest, operation: 'claim' | 'start' | 'acknowledge' | 'resume') {
        const id = request.requestId;
        if (busy[id]) return;
        if (operation === 'resume' && (!consent[id] || !request.context)) return;
        setBusy(previous => ({ ...previous, [id]: true })); setError(''); setNotice('');
        try {
            const body = operation === 'resume' ? resumeKeys.current[id] ??= {
                clientRequestId: crypto.randomUUID(), expectedSessionRevision: request.context!.sessionRevision
            } : {};
            await api(`/support-requests/${id}/${operation}`, 'POST', body);
            if (!live.current) return;
            delete resumeKeys.current[id];
            setConsent(previous => ({ ...previous, [id]: false }));
            setNotice(operation === 'resume' ? '対応完了と再開を保存しました。' : '状態を保存しました。');
            if (operation === 'start') void openRecord(request);
            try { await load(); }
            catch { if (live.current) setError('操作は保存しましたが、一覧を再取得できませんでした。通信を確認しています。'); }
        } catch (e) {
            if (!live.current) return;
            const status = (e as { status?: number }).status;
            setError(status === 409 ? '担当または状態が変わりました。一覧を更新します。入力した記録は残っています。'
                : '操作を保存できませんでした。最新の状態を確認してから、もう一度選んでください。');
            if (status === 409 || status === 403) delete resumeKeys.current[id];
            try { await load(); } catch { /* Keep the last confirmed state and form values. */ }
        } finally {
            if (live.current) setBusy(previous => ({ ...previous, [id]: false }));
        }
    }
    return <div className="staff-support"><div className="page-actions"><button className="dads-button" data-type="outline" data-size="md" onClick={() => go('/staff')}>作業一覧</button></div><p className="section-label">本人の作業を支える</p><h1>支援対応</h1><p className="page-lead">担当と対応状況を確かめて支援します。記録は後から入力できます。</p>
        <p role="status">{connection === 'connected' ? '支援状態の更新を受信しています。' : '通信を確認しながら、3秒ごとに一覧を取得します。'}</p>
        <div className="support-tabs" role="group" aria-label="表示する支援要求"><button className="dads-button" data-type="outline" data-size="md" aria-pressed={!completed} onClick={() => setCompleted(false)}>未完了</button>
            <button className="dads-button" data-type="outline" data-size="md" aria-pressed={completed} onClick={() => setCompleted(true)}>対応完了・後から記録</button></div>
        {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
        {!items.length && <p>{completed ? '対応完了の要求はありません。' : '未対応の要求はありません。'}</p>}
        {items.map(request => {
            const id = request.requestId, context = request.context, actions = context?.actions ?? [];
            return <section key={id} aria-label={`${request.kind === 'stop' ? '停止通知' : '支援要求'} ${context?.displayName ?? id}`}>
                <h2>{request.kind === 'stop' ? '停止通知' : '手伝って'}：{request.kind === 'stop' ? request.status === 'acknowledged' ? '確認済み' : '未確認' : statusText[request.status]}</h2>
                {context ? <><p>{context.displayName} ／ {context.taskTitle} ／ 工程 {context.stepIndex + 1}</p><p>作業の状態：{context.sessionStatus === 'stopped' ? '停止済み' : context.sessionStatus === 'waiting_help' ? '支援待ち' : context.sessionStatus === 'completed' ? '完了' : '作業中'}</p></>
                    : <p>対象の情報を確認できません。担当者に確認してください。</p>}
                {'assignedTo' in request && <p>担当：{request.assignedTo}</p>}
                {actions.includes('claim') && <button className="dads-button" data-type="outline" data-size="md" disabled={busy[id]} onClick={() => void operate(request, 'claim')}>担当します</button>}
                {actions.includes('start') && <button className="dads-button" data-type="outline" data-size="md" disabled={busy[id]} onClick={() => void operate(request, 'start')}>対応を始める</button>}
                {actions.includes('acknowledge') && <button className="dads-button" data-type="outline" data-size="md" disabled={busy[id]} onClick={() => void operate(request, 'acknowledge')}>{request.kind === 'stop' ? '停止通知を確認した' : '対応完了のみを記録'}</button>}
                {actions.includes('resume') && <div><label className="check"><input type="checkbox" checked={consent[id] ?? false} onChange={e => setConsent(previous => ({ ...previous, [id]: e.target.checked }))}/>本人に再開の希望を確かめました</label>
                    <button className="dads-button" data-type="outline" data-size="md" disabled={busy[id] || !consent[id]} onClick={() => void operate(request, 'resume')}>対応を終えてつづける</button></div>}
                {actions.includes('record') && <button className="dads-button" data-type="outline" data-size="md" onClick={() => void openRecord(request)}>支援記録を開く</button>}
                {request.kind === 'stop' && <p>通知の確認では、本人の停止を解除しません。</p>}
            </section>;
        })}
        {Object.entries(editors).filter(([, editor]) => editor.open).map(([id, editor]) => <section key={id} aria-label="支援記録">
            <h2>支援記録：{editor.request.context?.displayName ?? id}</h2><p>{editor.request.context?.taskTitle} ／ 工程 {(editor.request.context?.stepIndex ?? 0) + 1}</p>
            <p>記録の保存を待たずに、対面支援と作業の再開を続けられます。</p>
            {(['observedDifficulty', 'assistanceGiven', 'improvementSuggestion'] as const).map((field, index) => <label key={field}>
                {['どこでつまずいたか', '何をしたか', '次回の改善提案'][index]}<textarea maxLength={2000} value={editor.text[field]} disabled={!editor.loaded}
                    onChange={e => changeEditor(id, value => ({ ...value, dirty: true, text: { ...value.text, [field]: e.target.value }, notice: '' }))}/></label>)}
            {editor.error && <p role="alert" className="error">{editor.error}</p>}{editor.notice && <p role="status">{editor.notice}{editor.dirty ? '追記は未保存です。' : ''}</p>}
            {editor.conflict && <aside className="record-conflict"><h3>最新の保存内容（版 {editor.conflict.revision}）</h3>
                <p>つまずき：{editor.conflict.observedDifficulty || '未記入'}</p><p>支援：{editor.conflict.assistanceGiven || '未記入'}</p><p>次回案：{editor.conflict.improvementSuggestion || '未記入'}</p>
                <button className="dads-button" data-type="outline" data-size="md" onClick={() => changeEditor(id, value => ({ ...value, revision: value.conflict!.revision, conflict: undefined, error: '', notice: '入力を残しました。保存する内容を確認してください。' }))}>入力を残して、最新版を基に編集を続ける</button></aside>}
            {!editor.loaded && <button className="dads-button" data-type="outline" data-size="md" onClick={() => void refreshRecord(id)}>記録の取得をやり直す</button>}
            <button className="dads-button" data-type="outline" data-size="md" disabled={!editor.loaded || editor.saving || !!editor.conflict} onClick={() => void saveRecord(id)}>{editor.saving ? '保存しています' : '記録を保存する'}</button>
            <button className="dads-button" data-type="outline" data-size="md" onClick={() => changeEditor(id, value => ({ ...value, open: false }))}>後で記録する</button>
        </section>)}
    </div>;
}
