import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import ts from 'typescript';
import { learnerControlPaths, imageFailureText, type LearnerControlLabel } from '../apps/web/src/learner-controls.ts';

test('seven sourced pictograms are distinct and failures retain approved alt text',()=>{
    const labels: LearnerControlLabel[]=['はじめる','もどる','つぎへ','おわる','手伝って','やめる','つづける'];
    assert.equal(new Set(labels.map(label => learnerControlPaths(label).join("\n"))).size,7);
    assert.notDeepEqual(learnerControlPaths('手伝って'),learnerControlPaths('やめる'));
    assert.equal(imageFailureText('タオルの端を合わせる',true),'写真を表示できません：タオルの端を合わせる');
    assert.equal(imageFailureText('手元',false),undefined);
});

test('actual controls preserve independent upstream SVG paths and their accessible label',async()=>{
    const main=await readFile(new URL('../apps/web/src/main.tsx',import.meta.url),'utf8');
    const source=main.slice(main.indexOf('function learnerControlContent('),main.indexOf('\ncreateRoot('));
    const imports=`import React from ${JSON.stringify(import.meta.resolve('react'))};\nimport {learnerControlPaths} from ${JSON.stringify(new URL('../apps/web/src/learner-controls.ts',import.meta.url).href)};\nexport `;
    const compiled=ts.transpileModule(imports+source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.ESNext}}).outputText;
    const {learnerControlContent}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
    for(const label of ['はじめる','もどる','つぎへ','つづける','おわる','手伝って','やめる'] as const){
        const [svg,text]=learnerControlContent(label).props.children;
        assert.equal(svg.props['aria-hidden'],'true');assert.equal(svg.props.focusable,'false');
        assert.equal(text.props.children,label);
        assert.deepEqual(React.Children.toArray(svg.props.children).map((path:any)=>path.props.d),learnerControlPaths(label));
    }
});

test('actual Asset replaces decode and HTTP failures and recovers on asset change; media unchanged',async()=>{
    const main=await readFile(new URL('../apps/web/src/main.tsx',import.meta.url),'utf8');
    const source=main.slice(main.indexOf('function Asset('),main.indexOf('\nfunction App('));
    const hookSource=`import React from '${import.meta.resolve('react')}';export default React;
let state=[],cursor=0,last,effects=[];
export function begin(){cursor=0;effects=[]}
export function useState(v){const i=cursor++;if(!(i in state))state[i]=v;return[state[i],v=>state[i]=v]}
export function useEffect(fn,deps){if(last!==deps[0]){last=deps[0];effects.push(fn)}}
export async function flush(){effects.forEach(fn=>fn());await new Promise(r=>setImmediate(r))}
`;
    const url='data:text/javascript;base64,'+Buffer.from(hookSource).toString('base64'),hooks=await import(url);
    const imports=`import React,{useState,useEffect} from ${JSON.stringify(url)};
import {imageFailureText} from ${JSON.stringify(new URL('../apps/web/src/learner-controls.ts',import.meta.url).href)};
const getToken=async()=>'test';export `;
    const compiled=ts.transpileModule(imports+source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.ESNext}}).outputText;
    const {Asset}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
    const fetchBefore=globalThis.fetch;let ok=true;
    globalThis.fetch=(async()=>({ok,blob:async()=>new Blob(['image'])})) as any;
    const render=(id:string,extra={})=>{hooks.begin();return Asset({id,alt:'手元の写真',...extra})};
    try{
        render('one');await hooks.flush();let tree=render('one');assert.equal(tree.type,'img');assert.equal(tree.props.alt,'手元の写真');
        tree.props.onError();tree=render('one');assert.equal(tree.type,'div');assert.equal(tree.props.role,'status');assert.equal(tree.props.children,'写真を表示できません：手元の写真');
        render('two');await hooks.flush();assert.equal(render('two').type,'img');
        ok=false;render('three');await hooks.flush();assert.equal(render('three').props.children,'写真を表示できません：手元の写真');
        render('audio',{audio:true});await hooks.flush();assert.equal(render('audio',{audio:true}).props.children,'写真・動画を読み込み中');
        render('video',{video:true});await hooks.flush();assert.equal(render('video',{video:true}).props.children,'写真・動画を読み込み中');
    }finally{globalThis.fetch=fetchBefore;}
});

test('DADS palette keeps text, primary, help and stop distinguishable at required contrast',async()=>{
    const tokens=await readFile(new URL('../apps/web/src/vendor/dads/tokens.css',import.meta.url),'utf8');
    const colors=Object.fromEntries([...tokens.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map(match=>[match[1],match[2]]));
    const luminance=(hex:string)=>hex.slice(1).match(/../g)!.map(c=>parseInt(c,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
    const contrast=(a:string,b:string)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
    for(const [foreground,background] of [
        ['color-neutral-solid-gray-900','color-neutral-white'],
        ['color-neutral-solid-gray-700','color-neutral-solid-gray-50'],
        ['color-primitive-blue-900','color-neutral-white'],
        ['color-primitive-blue-1000','color-primitive-blue-50'],
        ['color-neutral-solid-gray-900','color-primitive-yellow-50'],
        ['color-neutral-white','color-primitive-red-1000']
    ]) assert.ok(contrast(colors[foreground],colors[background])>=4.5,`${foreground} / ${background}`);
    // Real focus, reflow and fixed-bar geometry are checked in the browser audit.
});
