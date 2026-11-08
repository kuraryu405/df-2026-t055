import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
import { learnerStepPresentation } from '../apps/web/src/learner-display.ts';
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
source = source.slice(source.indexOf('function Learner('), source.indexOf('\ncreateRoot('));
const imports = `import React,{useState,useEffect,useRef} from ${JSON.stringify(hookUrl)};
import {learnerStepPresentation} from ${JSON.stringify(new URL('../apps/web/src/learner-display.ts',import.meta.url).href)};
import {hold,readSafety,flushSafety,safetyKey,clearWaiting} from ${JSON.stringify(new URL('../apps/web/src/safety.ts',import.meta.url).href)};
const api=(...args)=>globalThis.learnerApi(...args), account='learner-a', Asset=()=>null;
const subscribeSupport=()=>()=>{}, getToken=async()=>account;
export `;
const compiled=ts.transpileModule(imports+source,{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {Learner}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
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
const steps = [0,1].map(i=>({stepId:`s${i}`,order:i,imageAssetId:`image${i}`,imageAltText:`手元${i}`,text:`工程文${i}`,visibleCaution:`注意${i}`,...(i===0?{audioAssetId:'audio0'}:{})}));
function session(mode='photo_text', audio=true):any {
    return {schemaVersion:'1',sessionId:'session',releaseId:'fixed',displayMode:mode,audioGuidance:audio,status:'active',stepIndex:0,revision:0,
        steps:steps.map(({text,visibleCaution,audioAssetId,...photo})=>({...photo,...(mode==='photo_text'?{text,visibleCaution}:{}),...(audio&&audioAssetId?{audioAssetId}:{})}))};
}
function harness(initial:any) {
    hooks.reset();let server=structuredClone(initial);const calls:any[]=[],storage=new Map();
    Object.assign(globalThis,{localStorage:{get length(){return storage.size},key:(i:number)=>[...storage.keys()][i],getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},learnerApi:async(url:string,method='GET',body?:any)=>{
        calls.push({url,method,body});
        if(body){server.revision++;if(body.type==='next')server.stepIndex++;if(body.type==='back')server.stepIndex--;if(body.type==='complete')server.status='completed';if(body.type==='resume')server.status='active';}
        return structuredClone(server);
    }});
    const render=()=>{hooks.begin();return Learner({uid:'learner-a',path:'/me/sessions/session',action:async(fn:any)=>fn()});};
    return {render,calls,storage,setStatus:(status:string)=>server.status=status};
}
async function open(h:ReturnType<typeof harness>){h.render();const timer=globalThis.setInterval;globalThis.setInterval=(()=>0) as any;try{await hooks.flush();}finally{globalThis.setInterval=timer;}return h.render();}
async function click(tree:any,label:string){button(tree,label).props.onClick();await new Promise(r=>setImmediate(r));}
function assets(tree:any){return nodes(tree).filter(n=>typeof n.type==='function'&&n.type.name==='Asset');}

test('presentation uses session mode, keeps fixed images and alt, and supports legacy captions',()=>{
    const photo=session('photo_only'),caption=session();
    const before=structuredClone(photo);
    assert.equal(learnerStepPresentation(photo).text,undefined);
    assert.equal(learnerStepPresentation(photo).visibleCaution,undefined);
    // Even an unexpected extra caption must not select the mode.
    photo.steps[0].text='隠す';photo.steps[0].visibleCaution='隠す注意';
    assert.equal(learnerStepPresentation(photo).text,undefined);
    assert.equal(learnerStepPresentation(photo).imageAssetId,learnerStepPresentation(caption).imageAssetId);
    assert.equal(learnerStepPresentation(before).imageAltText,'手元0');
    const legacy={...caption,steps:steps.map(({imageAltText,...s})=>s)};delete legacy.displayMode;delete legacy.audioGuidance;
    assert.equal(learnerStepPresentation(legacy).imageAltText,'工程文0');
    assert.equal(learnerStepPresentation(legacy).text,'工程文0');
});
for(const mode of ['photo_only','photo_text']) test(`${mode}: actual Learner preserves location, media, back/next/complete and fixed release fetches`,async()=>{
    const initial=session(mode),before=structuredClone(initial),h=harness(initial);let tree=await open(h);
    assert.match(text(tree),/1 \/ 2/);
    for(const label of ['もどる','つぎへ','手伝って','やめる'])assert.ok(button(tree,label));
    assert.equal(button(tree,'もどる').props.disabled,true);
    assert.equal(text(tree).includes('工程文0'),mode==='photo_text');assert.equal(text(tree).includes('注意0'),mode==='photo_text');
    assert.doesNotMatch(text(tree),/undefined/);
    assert.equal(assets(tree)[0].props.alt,'手元0');assert.equal(assets(tree)[1].props.audio,true);
    await click(tree,'つぎへ');tree=h.render();assert.match(text(tree),/2 \/ 2/);assert.equal(assets(tree).length,1);assert.equal(assets(tree)[0].props.id,'image1');assert.ok(button(tree,'おわる'));
    await click(tree,'もどる');tree=h.render();assert.equal(assets(tree)[1].props.id,'audio0');
    await click(tree,'つぎへ');await click(h.render(),'おわる');tree=h.render();assert.match(text(tree),/おわりました/);assert.equal(assets(tree).length,0);
    assert.deepEqual(h.calls.filter(c=>c.method==='POST').map(c=>c.body.type),['next','back','next','complete']);
    assert.ok(h.calls.every(c=>c.url.startsWith('/me/sessions/session')));assert.deepEqual(initial,before);
});
test('silent release has no playback UI; legacy image receives caption as alt',async()=>{
    let h=harness(session('photo_only',false)),tree=await open(h);assert.equal(assets(tree).length,1);
    const legacy=session();delete legacy.displayMode;delete legacy.audioGuidance;legacy.steps=steps.map(({imageAltText,...s})=>s);
    h=harness(legacy);tree=await open(h);assert.equal(assets(tree)[0].props.alt,'工程文0');assert.match(text(tree),/工程文0/);
});
for(const mode of ['photo_only','photo_text']) test(`${mode}: help, resume and immediate stop keep existing handlers`,async()=>{
    const h=harness(session(mode));let tree=await open(h);
    await click(tree,'手伝って');tree=h.render();assert.match(text(tree),/職員をよんでいます/);assert.equal(assets(tree).length,0);
    const key='safety:learner-a:session',pending=JSON.parse(h.storage.get(key));assert.equal(pending.pending[0].type,'help');
    h.storage.set(key,JSON.stringify({...pending,pending:[]}));h.setStatus('waiting_help');
    await click(h.render(),'つづける');tree=h.render();assert.match(text(tree),/1 \/ 2/);assert.equal(assets(tree)[0].props.id,'image0');
    await click(tree,'やめる');tree=h.render();assert.match(text(tree),/作業をやめました/);assert.equal(assets(tree).length,0);assert.equal(button(tree,'つぎへ'),undefined);assert.equal(JSON.parse(h.storage.get(key)).pending[0].type,'stop');
});
test('actual Asset uses manual audio controls and metadata preload without autoplay',async()=>{
    const main=await readFile(new URL('../apps/web/src/main.tsx',import.meta.url),'utf8');
    const source=main.slice(main.indexOf('function Asset('),main.indexOf('\nfunction App('));
    const compiled=ts.transpileModule(`import React from '${import.meta.resolve('react')}';const useState=()=>['blob:approved',()=>{}],useEffect=()=>{};export ${source}`,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.ESNext}}).outputText;
    const {Asset}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
    const audio=Asset({id:'audio0',audio:true});assert.equal(audio.type,'audio');assert.equal(audio.props.controls,true);assert.equal(audio.props.preload,'metadata');assert.equal(audio.props.autoPlay,undefined);
    assert.equal(Asset({id:'image0',alt:'手元0'}).props.alt,'手元0');
});
