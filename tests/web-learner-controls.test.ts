import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import ts from 'typescript';
import { learnerControlPath, imageFailureText, type LearnerControlLabel } from '../apps/web/src/learner-controls.ts';

test('seven original pictograms are distinct and failures retain approved alt text',()=>{
    const labels: LearnerControlLabel[]=['はじめる','もどる','つぎへ','おわる','手伝って','やめる','つづける'];
    assert.equal(new Set(labels.map(learnerControlPath)).size,7);
    assert.notEqual(learnerControlPath('手伝って'),learnerControlPath('やめる'));
    assert.equal(imageFailureText('タオルの端を合わせる',true),'写真を表示できません：タオルの端を合わせる');
    assert.equal(imageFailureText('手元',false),undefined);
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

test('CSS contract: native focus, non-color disabled cue, narrow and 200% text wrapping',async()=>{
    const css=await readFile(new URL('../apps/web/src/style.css',import.meta.url),'utf8');
    assert.match(css,/button:focus-visible[^}]*outline:4px solid #e3a830;outline-offset:3px/);
    assert.match(css,/\.learner button:disabled\{[^}]*border:3px dashed currentColor/);
    assert.match(css,/\.learner button\{[^}]*max-width:100%;min-width:0;width:100%[^}]*white-space:normal;overflow-wrap:anywhere/);
    assert.match(css,/\.learner \.control-icon\{width:1.5em;height:1.5em;flex:none/);
    assert.match(css,/@media\(max-width:760px\)\{\.learner \.controls,\.learner \.safety\{grid-template-columns:minmax\(0,1fr\)/);
    assert.match(css,/\.learner\{padding-bottom:16em\}\.learner \.safety\{position:fixed;bottom:0/);
    // Structural checks only: em icons scale with 200% text; no fixed height,
    // one flexible column and normal wrapping. Real layout/keyboard/AT remain unverified.
});
