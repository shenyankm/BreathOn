import { pendingReview } from '../src/lib/admin-overview.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function find(node:any,type:unknown):any[]{if(!node||typeof node!=='object')return[];if(Array.isArray(node))return node.flatMap(n=>find(n,type));return [...(node.type===type?[node]:[]),...find(node.props?.children,type)]}
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve))
test('visit review compares the doctor and leads to scenario generation',async()=>{
  const slots:any[]=[],effects:(()=>void)[]=[],exports:Record<string,(props:any)=>any>={};let cursor=0
  const jsx=(type:unknown,props:unknown,key:unknown)=>({type,props,key})
  const calls:{path:string;body?:any}[]=[]
  const visit={id:'visit1',version:3,status:'submitted',doctor_id:'doc1',owner_id:'rep',visited_at:'2026-10-30',source:'recording',redacted_text:'经脱敏拜访内容'}
  const api=async(path:string,options?:RequestInit)=>{calls.push({path,body:options?.body?JSON.parse(String(options.body)):undefined});if(path==='/visits')return [visit];if(path==='/visits/visit1/review')return {...visit,review:{case_id:'case1'}};return []}
  const source=readFileSync(new URL('../src/components/admin-review.tsx',import.meta.url),'utf8')
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
    exports,AbortController,encodeURIComponent,
    require(module:string){if(module==='react')return {useState(initial:any){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],(next:any)=>{slots[i]=typeof next==='function'?next(slots[i]):next}]},useEffect(fn:()=>void,deps:unknown[]){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i][j])){effects.push(fn);slots[i]=deps}}};if(module==='react/jsx-runtime')return {jsx,jsxs:jsx};if(module==='@/lib/admin-overview')return {pendingReview};if(module==='@/lib/platform-api')return {api};return new Proxy({}, {get:(_,key)=>String(key)})},
  })
  const render=()=>{cursor=0;const tree=exports.AdminReview({onWorkspace(){},onSection(){}});effects.splice(0).forEach(fn=>fn());return tree}
  render();await settle();let tree=render()
  find(tree,'Button').find(node=>node.props.children==='审核').props.onClick()
  tree=render()
  const doctorType=find(tree,'section').flatMap(section=>Array.isArray(section.props.children)?section.props.children:[]).find(node=>typeof node?.type==='function')?.type
  assert.equal(find(tree,doctorType)[0].props.doctorId,'doc1')
  assert.ok(find(tree,'p').some(node=>node.props.children==='经脱敏拜访内容'))
  find(tree,'Textarea')[0].props.onChange({target:{value:'记录为本次情境'}});tree=render()
  find(tree,'Button').find(node=>node.props.children==='用于模拟情境').props.onClick();await settle();tree=render()
  assert.equal(calls.find(c=>c.path==='/visits/visit1/review')?.body.decision,'scenario')
  assert.equal(find(tree,'a').find(a=>String(a.props.href).includes('case=case1'))?.props.href,'#workspace?tab=scenario&case=case1')
})

test('fact update requires confirmed public evidence and opens an unpublished doctor draft',async()=>{
  const slots:any[]=[],effects:(()=>void)[]=[],exports:Record<string,(props:any)=>any>={};let cursor=0
  const jsx=(type:unknown,props:unknown,key:unknown)=>({type,props,key}),calls:{path:string;body?:any}[]=[]
  const visit={id:'v',version:1,status:'submitted',doctor_id:'d',owner_id:'rep',source:'self_report',redacted_text:'观察，不能作为事实'}
  const source={id:'source',title:'医院简介',status:'approved',usable:true,source_url:'https://hospital.example/doctor',pages:[{number:1,text:'张医生是该院内分泌科医师。'}]}
  const api=async(path:string,options?:RequestInit)=>{calls.push({path,body:options?.body?JSON.parse(String(options.body)):undefined});if(path==='/visits')return [visit];if(path==='/catalog/content')return [source];if(path==='/catalog/content/source')return source;if(path==='/visits/v/review')return {...visit,review:{doctor_draft_id:'draft1'}};return []}
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/admin-review.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,AbortController,encodeURIComponent,require(module:string){if(module==='react')return {useState(initial:any){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],(next:any)=>{slots[i]=typeof next==='function'?next(slots[i]):next}]},useEffect(fn:()=>void,deps:unknown[]){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i][j])){effects.push(fn);slots[i]=deps}}};if(module==='react/jsx-runtime')return {jsx,jsxs:jsx};if(module==='@/lib/admin-overview')return {pendingReview};if(module==='@/lib/platform-api')return {api};return new Proxy({}, {get:(_,key)=>String(key)})}})
  const render=()=>{cursor=0;const tree=exports.AdminReview({onWorkspace(){},onSection(){}});effects.splice(0).forEach(fn=>fn());return tree}
  render();await settle();let tree=render();find(tree,'Button').find(node=>node.props.children==='审核').props.onClick();tree=render()
  find(tree,'Select')[0].props.onValueChange('source');await settle();tree=render()
  let textareas=find(tree,'Textarea');textareas[0].props.onChange({target:{value:'张医生是该院内分泌科医师。'}});textareas[1].props.onChange({target:{value:'医院公开简介'}});tree=render()
  assert.equal(find(tree,'Button').find(n=>n.props.children==='创建事实更新草稿').props.disabled,true)
  find(tree,'Checkbox')[0].props.onCheckedChange(true);tree=render()
  find(tree,'Button').find(n=>n.props.children==='创建事实更新草稿').props.onClick();await settle();tree=render()
  const body=calls.find(c=>c.path==='/visits/v/review')?.body
  assert.equal(body.decision,'fact');assert.equal(body.quote,'张医生是该院内分泌科医师。');assert.equal(body.identity_confirmed,true)
  assert.equal(find(tree,'a').find(a=>String(a.props.href).includes('doctor=draft1'))?.props.href,'#workspace?tab=doctor&doctor=draft1')
})
