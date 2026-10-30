import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const jsx=(type:unknown,props:unknown,key:unknown)=>({type,props,key})
function find(node:any,type:string):any[]{if(!node||typeof node!=='object')return[];if(Array.isArray(node))return node.flatMap(child=>find(child,type));return [...(node.type===type?[node]:[]),...find(node.props?.children,type)]}

test('scenario binds usable policies and preserves drug IDs when editing',()=>{
  const states:any[]=[], exports:Record<string,(props:any)=>any>={};let cursor=0, saved:any
  const source=readFileSync(new URL('../src/components/catalog-forms.tsx',import.meta.url),'utf8')
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
    exports,FormData:class{get(){return ''}},
    require(module:string){if(module==='react')return {useState(initial:any){const i=cursor++;if(!(i in states))states[i]=initial;return [states[i],(next:any)=>{states[i]=typeof next==='function'?next(states[i]):next}]}};if(module==='react/jsx-runtime')return {jsx,jsxs:jsx};if(module==='@/lib/catalog-types')return {stages:{opening:'开场'}};return new Proxy({}, {get:(_,key)=>String(key)})},
  })
  const props={item:{policy_ids:['old'],drug_id:'own',competitor_id:'peer',stages:['opening'],content_ids:[]},busy:false,disabled:false,save:(body:any)=>{saved=body},doctors:[],rubrics:[],contents:[],drugs:[{id:'own2',name:'本公司药',brand:'甲',ownership:'company',status:'published'},{id:'peer2',name:'竞品',brand:'乙',ownership:'competitor',status:'published'},{id:'draft',name:'未发布',ownership:'company',status:'draft'}],policies:[{id:'old',title:'旧文件',version_label:'v1',usable:false},{id:'good',title:'有效文件',version_label:'v2',usable:true},{id:'hidden',title:'待审核',version_label:'v1',usable:false}]}
  const render=()=>{cursor=0;return exports.ScenarioForm(props)}
  let view=render();let controls=find(view,'Checkbox')
  assert.equal(controls.length,3)
  controls[1].props.onCheckedChange(false)
  view=render();controls=find(view,'Checkbox')
  controls[1].props.onCheckedChange(true)
  view=render();find(view,'form')[0].props.onSubmit({preventDefault(){},currentTarget:{}})
  assert.deepEqual(Array.from(saved.policy_ids),['good'])
  assert.equal(saved.drug_id,'own');assert.equal(saved.competitor_id,'peer')
  const selects=find(view,'Select')
  const main=selects.find(node=>node.props.name==='drug_id'),competitor=selects.find(node=>node.props.name==='competitor_id')
  assert.ok(find(main,'SelectItem').some(option=>option.props.value==='own2'))
  assert.ok(!find(main,'SelectItem').some(option=>option.props.value==='draft'))
  assert.ok(!find(main,'SelectItem').some(option=>option.props.value==='peer2'))
  main.props.onValueChange('own2');competitor.props.onValueChange('peer2')
  view=render();find(view,'form')[0].props.onSubmit({preventDefault(){},currentTarget:{}})
  assert.equal(saved.drug_id,'own2');assert.equal(saved.competitor_id,'peer2')
  const next=find(view,'Select').find(node=>node.props.name==='drug_id');next.props.onValueChange('__none__')
  view=render();find(view,'form')[0].props.onSubmit({preventDefault(){},currentTarget:{}})
  assert.equal(saved.drug_id,null);assert.equal(saved.competitor_id,'peer2')
})
