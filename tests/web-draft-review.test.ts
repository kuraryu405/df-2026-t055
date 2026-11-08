import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
import { isManualDraft, releaseCopySource, beginReleaseCopy } from '../apps/web/src/release-copy.ts';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, doc } from '../apps/api/src/adapters.ts';
import { missingDraftChecks, draftPreviewMode, savedDraftReview } from '../apps/web/src/draft-review.ts';
// Run the actual component handlers with fake hooks, without a browser or added dependency.
const hookSource = `import React from '${import.meta.resolve('react')}';
let state=[], cursor=0, effects=[];
export default React;
export function begin(){cursor=0;effects=[];}
export function reset(){state=[];begin();}
export function useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v}];}
export function useRef(initial){const i=cursor++;return state[i]??=( {current:initial} );}
export function useEffect(fn,deps){const i=cursor++;if(!state[i]||deps.some((v,j)=>v!==state[i][j])){state[i]=deps;effects.push(fn);}}
export async function flush(){for(const fn of effects)fn();await new Promise(r=>setImmediate(r));}`;
const hookUrl = 'data:text/javascript;base64,' + Buffer.from(hookSource).toString('base64');
const hooks = await import(hookUrl);
let source = await readFile(new URL('../apps/web/src/main.tsx', import.meta.url), 'utf8');
source = source.slice(source.indexOf('function Draft('), source.indexOf('\nfunction Support(')) + '\nexport ' + source.slice(source.indexOf('function Handover('), source.indexOf('\nfunction Learner('));
source = `import React, {useState,useEffect,useRef} from ${JSON.stringify(hookUrl)};
import {missingDraftChecks,draftPreviewMode,savedDraftReview} from ${JSON.stringify(new URL('../apps/web/src/draft-review.ts', import.meta.url).href)};
import {isManualDraft,releaseCopySource,beginReleaseCopy} from ${JSON.stringify(new URL('../apps/web/src/release-copy.ts', import.meta.url).href)};
import {releaseCopyResponseSchema} from ${JSON.stringify(new URL('../packages/shared/src/index.ts', import.meta.url).href)};
const api=(...args)=>globalThis.draftApi(...args); const go=(path)=>globalThis.draftGo?.(path); const Asset=()=>null;
export ${source}`;
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { Draft, Handover } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
function nodes(tree: any): any[] {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (!React.isValidElement(tree)) return [];
    return [tree, ...nodes((tree.props as any).children)];
}
function text(tree: any): string {
    if (Array.isArray(tree)) return tree.map(text).join('');
    if (React.isValidElement(tree)) return text((tree.props as any).children);
    return tree == null ? '' : String(tree);
}
function button(tree: any, label: string) { return nodes(tree).find(n => n.type === 'button' && text(n) === label); }

function harness() {
    hooks.reset();
    const step = {stepId:'one',text:'折る',imageAssetId:'image',imageAltText:'手元',visibleCaution:'端に注意',coaching:'手本を示す',sourceStartMs:0,sourceEndMs:1000,frameMs:500,verifiedObservation:'',verifiedSpeech:'',completionCheck:''};
    const checks = {presentationConfirmed:true,flagResolution:'対応済み',steps:{one:{videoVerified:true,photoTextVerified:true}}};
    let server:any = {revision:1,status:'editing',taskId:'task',learnerId:'a',editedSteps:[step],reviewChecks:checks,displayMode:'photo_only',audioGuidance:true,aiProposal:{reviewFlags:['確認'],steps:[]}};
    let fail = 0, releaseChecks = false;
    const calls:any[] = [], storage = new Map();
    Object.assign(globalThis, {localStorage:{getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}, draftApi:async (url:string,method='GET',body?:any)=>{
        calls.push({url,method,body});
        if(method==='GET') return structuredClone(url.startsWith('/tasks')?{task:{}}:{draft:server});
        if(fail) throw Object.assign(Error('通信失敗'),{status:fail});
        if(method==='PATCH') {
            server={...server,...body,revision:server.revision+1,reviewChecks:releaseChecks?{...body.reviewChecks,presentationConfirmed:false,steps:{one:{videoVerified:true,photoTextVerified:false}}}:body.reviewChecks};
            return {schemaVersion:'1',revision:server.revision,reviewChecks:server.reviewChecks};
        }
        return {releaseId:'release',version:1};
    }});
    const render=()=>{hooks.begin();return Draft({id:'draft',action:async(fn:any)=>fn()});};
    return {render,calls,get server(){return server},setFail:(v:number)=>fail=v,setReleaseChecks:(v:boolean)=>releaseChecks=v,bump:()=>{server={...server,revision:9}},approve:()=>{server={...server,status:'approved',revision:9}}};
}
function input(tree:any,label:string) {return nodes(nodes(tree).find(n=>n.type==='label'&&text(n).startsWith(label))).find(n=>['input','textarea','select'].includes(n.type));}
function change(tree:any,label:string,value:any) { input(tree,label).props.onChange({target:{value,checked:value}}); }
async function settle(){await new Promise(r=>setImmediate(r));}
async function open(h:ReturnType<typeof harness>){h.render();await hooks.flush();return h.render();}

test('review helpers list missing steps and flags, default mode, and validate server response',()=>{
    const h=harness();
    assert.equal(draftPreviewMode(),'photo_text'); assert.equal(draftPreviewMode('photo_only'),'photo_only');
    assert.deepEqual(missingDraftChecks(h.server.editedSteps,h.server.reviewChecks,true),[]);
    assert.deepEqual(missingDraftChecks(h.server.editedSteps,{presentationConfirmed:false,flagResolution:' ',steps:{}},true),['本人への提示内容確認','工程 1：動画照合','工程 1：写真・説明確認','確認が必要な点への対応記録']);
    assert.throws(()=>savedDraftReview({revision:2}));
});
test('labelled edits PATCH presentation and alt, server checks replace local checks, re-confirm then approve',async()=>{
    const h=harness();let tree=await open(h);
    assert.equal(input(tree,'表示方法').props.value,'photo_only'); assert.equal(input(tree,'音声').props.checked,true);
    for(const n of nodes(tree).filter(n=>['input','textarea','select'].includes(n.type))) assert.ok(nodes(tree).some(l=>l.type==='label'&&nodes(l).includes(n)));
    change(tree,'表示方法','photo_text');tree=h.render();change(tree,'音声',false);tree=h.render();change(tree,'写真の代替','新しい手元');tree=h.render();
    assert.match(text(tree),/工程 1：写真・説明確認/);assert.equal(button(tree,'この内容を承認').props.disabled,true);
    h.setReleaseChecks(true);button(tree,'編集と確認を保存').props.onClick();await settle();tree=h.render();
    const patch=h.calls.find(c=>c.method==='PATCH').body;
    assert.equal(patch.displayMode,'photo_text');assert.equal(patch.audioGuidance,false);assert.equal(patch.editedSteps[0].imageAltText,'新しい手元');
    assert.match(text(tree),/保存版：2/);assert.equal(input(tree,'写真・説明確認済み').props.checked,false);
    change(tree,'写真・説明確認済み',true);tree=h.render();change(tree,'本人への提示内容確認済み',true);tree=h.render();
    h.setReleaseChecks(true);button(tree,'この内容を承認').props.onClick();await settle();tree=h.render();
    assert.equal(h.calls.some(c=>c.url.endsWith('/approve')),false);assert.ok(nodes(tree).some(n=>n.props.role==='alert'));
    h.setReleaseChecks(false);change(tree,'写真・説明確認済み',true);tree=h.render();change(tree,'本人への提示内容確認済み',true);tree=h.render();
    assert.equal(button(tree,'この内容を承認').props.disabled,false);
    button(tree,'この内容を承認').props.onClick();button(tree,'この内容を承認').props.onClick();await settle();
    assert.equal(h.calls.filter(c=>c.url.endsWith('/approve')).length,1);assert.match(text(h.render()),/承認済みです/);
});
test('409 and failed send preserve all input, fetch latest separately, retry latest revision',async()=>{
    const h=harness();let tree=await open(h);
    change(tree,'本人に見せる短文','変更した文');tree=h.render();change(tree,'写真の代替','変更した代替');tree=h.render();change(tree,'表示方法','photo_text');tree=h.render();change(tree,'音声',false);tree=h.render();change(tree,'確認が必要な点への対応記録','入力の記録');tree=h.render();change(tree,'写真・説明確認済み',true);tree=h.render();
    h.setFail(409);button(tree,'編集と確認を保存').props.onClick();await settle();tree=h.render();
    assert.ok(nodes(tree).some(n=>n.props.role==='alert'));assert.equal(button(tree,'編集と確認を保存').props.disabled,true);
    h.bump();button(tree,'最新値を取得').props.onClick();await settle();tree=h.render();
    assert.match(text(tree),/サーバーの最新値/);assert.equal(input(tree,'本人に見せる短文').props.value,'変更した文');assert.equal(input(tree,'写真の代替').props.value,'変更した代替');assert.equal(input(tree,'表示方法').props.value,'photo_text');assert.equal(input(tree,'音声').props.checked,false);assert.equal(input(tree,'確認が必要な点への対応記録').props.value,'入力の記録');assert.equal(input(tree,'写真・説明確認済み').props.checked,true);
    h.setFail(500);button(tree,'編集と確認を保存').props.onClick();await settle();tree=h.render();assert.equal(input(tree,'本人に見せる短文').props.value,'変更した文');
    h.setFail(0);button(tree,'編集と確認を保存').props.onClick();await settle();assert.equal(h.calls.filter(c=>c.method==='PATCH').at(-1).body.expectedRevision,9);
});
test('他職員が承認済みにした後の最新値取得は承認画面へ移る', async () => {
    const h = harness(); let tree = await open(h);
    change(tree, '本人に見せる短文', '変更した文'); tree = h.render();
    h.setFail(409); button(tree, '編集と確認を保存').props.onClick(); await settle(); tree = h.render();
    assert.equal(button(tree, '編集と確認を保存').props.disabled, true);
    h.approve(); button(tree, '最新値を取得').props.onClick(); await settle(); tree = h.render();
    assert.match(text(tree), /承認済みです/);
    assert.ok(button(tree, '承認版を確認・本人へ割当'));
    assert.equal(button(tree, '最新値を取得'), undefined);
});
test('preview starts in draft mode, separates hidden caution and coaching, switches with keyboard-native select',async()=>{
    const h=harness();let tree=await open(h);let focused=false;
    button(tree,'本人表示をプレビュー').props.onClick({currentTarget:{focus(){focused=true}}});tree=h.render();
    assert.equal(input(tree,'プレビューの表示方法').props.value,'photo_only');
    let learner=nodes(tree).find(n=>n.props['aria-label']==='本人への提示内容');assert.doesNotMatch(text(learner),/折る|端に注意/);assert.match(text(tree),/伝える注意：端に注意/);assert.match(text(tree),/手本を示す/);
    change(tree,'プレビューの表示方法','photo_text');tree=h.render();learner=nodes(tree).find(n=>n.props['aria-label']==='本人への提示内容');assert.match(text(learner),/折る.*端に注意/);
    nodes(tree).find(n=>n.props.onKeyDown).props.onKeyDown({key:'Escape'});assert.equal(focused,true);assert.equal(nodes(h.render()).some(n=>n.props.role==='dialog'),false);
});

test('manual origin, source label and copy guard preserve the UUID across retries', () => {
    assert.equal(isManualDraft({sourceReleaseId:'source'}),true);
    assert.equal(isManualDraft({jobId:'job'}),false);
    assert.equal(isManualDraft({sourceReleaseId:'source',jobId:'job'}),false);
    assert.equal(isManualDraft({}),false);
    assert.match(releaseCopySource({title:'タオル',version:3},{approvedBy:'職員',approvedAt:'2026-11-08T00:00:00Z'}),/コピー元の承認版：タオル \/ 版 3 \/ 承認者 職員/);
    const state={sending:false};
    const key=beginReleaseCopy(state)!;
    assert.match(key,/^[\da-f-]{36}$/);
    assert.equal(beginReleaseCopy(state),undefined);
    state.sending=false;
    assert.equal(beginReleaseCopy(state),key);
});

test('staff copy handlers use the real API through edit, re-confirm, approval and next assignment; running session stays fixed', async () => {
    const db=new MemoryRepository();seed(db);
    const bytes=new Map<string,Buffer>();
    const storage={async put(p:string,b:Buffer){bytes.set(p,Buffer.from(b));},async get(p:string){return bytes.get(p)!;},async open(p:string){return new Response(new Uint8Array(bytes.get(p)!)).body!;},async copy(a:string,b:string){bytes.set(b,Buffer.from(bytes.get(a)!));}};
    const {app}=createApp({db,storage,globalLimit:1});
    db.put('generationJobs',doc('demo',{id:'exhausted',budgetUsed:1}));
    const h=harness();
    db.put('tasks',doc('demo',{id:'task',title:'タオル',videoAssetId:'video'}));
    db.put('assets',doc('demo',{id:'video',kind:'video',durationMs:1000}));
    db.put('assets',doc('demo',{id:'image',kind:'image',draftId:'original',sourceVideoId:'video',frameMs:500,objectPath:'draft/image.jpg',mimeType:'image/jpeg'}));
    await storage.put('draft/image.jpg',Buffer.from('synthetic image'));
    db.put('drafts',doc('demo',{...h.server,id:'original',audioGuidance:false}));
    const calls:any[]=[];let path='',failCopy=false,failSource=false,failPatch=false;
    const request=async(url:string,method='GET',body?:any,token='staff')=>{
        const response=await app.fetch(new Request(`http://localhost/api/v1${url}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
        const data=await response.json();
        if(!response.ok)throw Object.assign(Error(data.error.code),{status:response.status});
        return data;
    };
    const original=await request('/drafts/original/approve','POST',{expectedRevision:1,approvalRequestId:'original'});
    await request('/assignments/a/task','PUT',{releaseId:original.releaseId});
    const started=await request('/me/sessions','POST',{taskId:'task',clientRequestId:'start'},'learner-a');
    const runningBefore=await request(`/me/sessions/${started.sessionId}`,'GET',undefined,'learner-a');
    const sourceBefore=structuredClone(db.get('releases',original.releaseId));
    const jobsBefore=structuredClone(db.all('generationJobs'));
    Object.assign(globalThis,{draftGo:(v:string)=>path=v,draftApi:async(url:string,method='GET',body?:any)=>{
        calls.push({url,method,body});
        if(failSource&&url===`/handover/releases/${original.releaseId}`)throw Error('出所取得失敗');
        if(failPatch&&method==='PATCH')throw Error('保存失敗');
        const result=await request(url,method,body);
        // A lost response after the API committed must retry with the same key.
        if(failCopy&&url.endsWith('/drafts')&&method==='POST')throw Error('応答を受信できません');
        return result;
    }});
    const renderHandover=(staff=true)=>{hooks.begin();return Handover({path:`${staff?'/staff':''}/handover/releases/${original.releaseId}`,staff,action:async(fn:any)=>fn()});};
    hooks.reset();renderHandover();await hooks.flush();let tree=renderHandover();
    const copyButton=button(tree,'コピーして直す');assert.ok(copyButton);assert.equal(copyButton.type,'button');assert.equal(copyButton.props.tabIndex,undefined);
    failCopy=true;
    const first=copyButton.props.onClick();const duplicate=copyButton.props.onClick();
    assert.equal(button(renderHandover(),'コピーして直す').props.disabled,true);
    await Promise.all([first,duplicate]);tree=renderHandover();
    assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(path,'');assert.match(text(tree),/応答を受信できません/);assert.ok(nodes(tree).some(n=>n.props.role==='alert'));
    failCopy=false;await button(tree,'コピーして直す').props.onClick();
    const posts=calls.filter(c=>c.method==='POST');assert.equal(posts[0].body.clientRequestId,posts[1].body.clientRequestId);
    const manual=db.all('drafts').find(d=>d.sourceReleaseId===original.releaseId)!;
    assert.equal(db.all('drafts').length,2);assert.equal(path,`/staff/tasks/task/drafts/${manual.id}`);
    hooks.reset();const renderDraft=()=>{hooks.begin();return Draft({id:manual.id,action:async(fn:any)=>fn()});};
    let intervals=0;const originalInterval=globalThis.setInterval;
    globalThis.setInterval=((...args:any[])=>{intervals++;return (originalInterval as any)(...args);}) as any;
    try {
        renderDraft();await hooks.flush();tree=renderDraft();await hooks.flush();
        assert.equal(intervals,0);
    } finally {globalThis.setInterval=originalInterval;}
    assert.match(text(tree),/承認版のコピー/);assert.match(text(tree),/コピー元の承認版：タオル \/ 版 1 \/ 承認者 staff/);
    assert.ok(text(tree).includes(new Date(sourceBefore!.approvedAt).toLocaleString('ja-JP')));
    assert.doesNotMatch(text(tree),/Fake候補|AIの候補|AIの下書き|動画解析中|再試行/);
    for(const label of ['動画照合済み','写真・説明確認済み','本人への提示内容確認済み'])assert.equal(input(tree,label).props.checked,false);
    assert.equal(button(tree,'この内容を承認').props.disabled,true);
    change(tree,'本人に見せる短文','赤い線にあわせます');tree=renderDraft();
    failPatch=true;button(tree,'編集と確認を保存').props.onClick();await settle();tree=renderDraft();
    assert.equal(input(tree,'本人に見せる短文').props.value,'赤い線にあわせます');assert.match(text(tree),/保存失敗/);
    failPatch=false;button(tree,'編集と確認を保存').props.onClick();await settle();tree=renderDraft();
    for(const label of ['動画照合済み','写真・説明確認済み','本人への提示内容確認済み']){change(tree,label,true);tree=renderDraft();}
    button(tree,'この内容を承認').props.onClick();await settle();tree=renderDraft();
    assert.match(text(tree),/版 2 を新規保存しました/);
    button(tree,'本人の端末へ渡す（次回開始版）').props.onClick();await settle();
    assert.equal(path,'/staff/handover');
    const assignment=db.all('assignments')[0];assert.notEqual(assignment.releaseId,original.releaseId);
    assert.equal(db.get('releases',assignment.releaseId)!.version,2);
    assert.equal(db.get('releases',assignment.releaseId)!.learnerSteps[0].text,'赤い線にあわせます');
    assert.deepEqual(db.get('releases',original.releaseId),sourceBefore);
    assert.deepEqual(await request(`/me/sessions/${started.sessionId}`,'GET',undefined,'learner-a'),runningBefore);
    assert.deepEqual(db.all('generationJobs'),jobsBefore);
    assert.equal(calls.some(c=>/\/jobs\/|\/generations/.test(c.url)),false);
    // Source fetch errors remain visible through the existing action error handling; editing stays available.
    failSource=true;let error='';hooks.reset();hooks.begin();Draft({id:manual.id,action:async(fn:any)=>{try{await fn();}catch(e){error=(e as Error).message;}}});await hooks.flush();assert.equal(error,'出所取得失敗');
    failSource=false;hooks.reset();renderHandover(false);await hooks.flush();tree=renderHandover(false);assert.equal(button(tree,'コピーして直す'),undefined);
});
