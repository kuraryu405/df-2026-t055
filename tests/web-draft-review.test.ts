import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
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
source = source.slice(source.indexOf('function Draft('), source.indexOf('\nfunction Support('));
source = `import React, {useState,useEffect,useRef} from ${JSON.stringify(hookUrl)};
import {missingDraftChecks,draftPreviewMode,savedDraftReview} from ${JSON.stringify(new URL('../apps/web/src/draft-review.ts', import.meta.url).href)};
const api=(...args)=>globalThis.draftApi(...args); const go=()=>{}; const Asset=()=>null;
export ${source}`;
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { Draft } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
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
    return {render,calls,get server(){return server},setFail:(v:number)=>fail=v,setReleaseChecks:(v:boolean)=>releaseChecks=v,bump:()=>{server={...server,revision:9}}};
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
    assert.match(text(tree),/revision 2/);assert.equal(input(tree,'写真・説明確認済み').props.checked,false);
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
test('preview starts in draft mode, separates hidden caution and coaching, switches with keyboard-native select',async()=>{
    const h=harness();let tree=await open(h);let focused=false;
    button(tree,'本人表示をプレビュー').props.onClick({currentTarget:{focus(){focused=true}}});tree=h.render();
    assert.equal(input(tree,'プレビューの表示方法').props.value,'photo_only');
    let learner=nodes(tree).find(n=>n.props['aria-label']==='本人への提示内容');assert.doesNotMatch(text(learner),/折る|端に注意/);assert.match(text(tree),/伝える注意：端に注意/);assert.match(text(tree),/手本を示す/);
    change(tree,'プレビューの表示方法','photo_text');tree=h.render();learner=nodes(tree).find(n=>n.props['aria-label']==='本人への提示内容');assert.match(text(learner),/折る.*端に注意/);
    nodes(tree).find(n=>n.props.onKeyDown).props.onKeyDown({key:'Escape'});assert.equal(focused,true);assert.equal(nodes(h.render()).some(n=>n.props.role==='dialog'),false);
});
