import { readFile } from 'node:fs/promises';
import React from 'react';
import ts from 'typescript';

export const tick = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve)); };
export function nodes(tree: any): any[] {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    return React.isValidElement(tree) ? [tree, ...nodes((tree.props as any).children)] : [];
}
export function text(tree: any): string {
    if (Array.isArray(tree)) return tree.map(text).join('');
    if (React.isValidElement(tree)) return text((tree.props as any).children);
    return tree == null ? '' : String(tree);
}
export const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && text(node) === label);

// Match existing component tests, including effect cleanup. Real-browser checks are separate.
export async function componentHarness(file: URL, mocks: Record<string, string> = {}, suppliedSource?: string) {
    const hookSource = `import React from ${JSON.stringify(import.meta.resolve('react'))};export default React;
const nonce=${JSON.stringify(crypto.randomUUID())};let slots=[],cursor=0,effects=[];
export function begin(){cursor=0;effects=[];}
export function useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value}];}
export function useRef(initial){const i=cursor++;return slots[i]??=({current:initial});}
export function useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){const slot=slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slot.cleanup?.();slot.cleanup=fn()});}}
export async function flush(){for(const fn of effects)fn();await new Promise(resolve=>setImmediate(resolve));}
export function unmount(){for(const slot of slots)slot?.cleanup?.();}
`;
    const hooksUrl = 'data:text/javascript;base64,' + Buffer.from(hookSource).toString('base64');
    const hooks = await import(hooksUrl);
    const source = suppliedSource ?? await readFile(file, 'utf8');
    let output = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    output = output.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name) => {
        const resolved = name === 'react' ? hooksUrl : mocks[name] ?? (name.startsWith('.') ? new URL(name, file).href : import.meta.resolve(name));
        return `from ${JSON.stringify(resolved)}`;
    });
    return { module: await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64')), hooks };
}
