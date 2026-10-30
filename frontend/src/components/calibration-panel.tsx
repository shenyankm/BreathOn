import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Field, inputClass } from './ui/form-field'
import { api } from '@/lib/platform-api'
import type { Rubric, Scenario } from '@/lib/catalog-types'

type Sample={id:string;title:string;label_type:string;expected_scores:Record<string,number|null>;labelled_by:string}
type Run={id:string;status:string;model:string;evaluator_version:string;sample_count:number;completed_count:number;error?:string;metrics:null|{expert_samples:number;synthetic_samples:number;calibrated:boolean;dimensions:{key:string;label:string;expected_count:number;paired_count:number;mae:number|null;within_one:number|null}[]}}
const runLabels:Record<string,string>={running:'执行中',cancel_requested:'本次推理完成后停止',completed:'已完成',cancelled:'已取消',interrupted:'已中断',failed:'未完成'}

export function CalibrationPanel({rubric}:{rubric:Rubric}) {
  const [samples,setSamples]=useState<Sample[]>([]);const [scenes,setScenes]=useState<Scenario[]>([])
  const [run,setRun]=useState<Run|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [refresh,setRefresh]=useState(0)
  const [messages,setMessages]=useState([{role:'doctor',text:''},{role:'trainee',text:''}])
  useEffect(()=>{
    const controller=new AbortController()
    Promise.all([api<Sample[]>(`/rubrics/${rubric.id}/samples`,{signal:controller.signal}),api<Scenario[]>('/catalog/scenario',{signal:controller.signal}),api<Run[]>(`/rubrics/${rubric.id}/calibration/runs`,{signal:controller.signal})]).then(([rows,scenarios,runs])=>{
      setSamples(rows);setScenes(scenarios.filter(s=>s.status==='published'&&s.rubric_id===rubric.id));if(runs.length)setRun(runs[0])
    }).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'校准数据加载失败')})
    return()=>controller.abort()
  },[rubric.id,refresh])
  useEffect(()=>{
    if(!run||!['running','cancel_requested'].includes(run.status))return
    const controller=new AbortController()
    const timer=window.setInterval(()=>{api<Run>(`/calibration/runs/${run.id}`,{signal:controller.signal}).then(setRun).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'进度暂不可用，可刷新数据确认')})},2500)
    return()=>{window.clearInterval(timer);controller.abort()}
  },[run])
  async function start(){
    setBusy(true);setError('')
    try{const current=await api<Rubric>(`/catalog/rubric/${rubric.id}`);setRun(await api<Run>(`/rubrics/${rubric.id}/calibration`,{method:'POST',body:JSON.stringify({version:current.version})}))}
    catch(cause){setError(cause instanceof Error?cause.message:'校准未能启动');setRefresh(v=>v+1)}finally{setBusy(false)}
  }
  async function cancel(){if(!run)return;setBusy(true);try{setRun(await api<Run>(`/calibration/runs/${run.id}/cancel`,{method:'POST'}))}catch(cause){setError(cause instanceof Error?cause.message:'取消未完成')}finally{setBusy(false)}}
  async function add(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const form=event.currentTarget;const data=new FormData(form);setBusy(true);setError('')
    const expected=Object.fromEntries(rubric.dimensions.map(d=>[d.key,data.get(d.key)===''?null:Number(data.get(d.key))]))
    try{await api('/calibration/samples',{method:'POST',body:JSON.stringify({title:data.get('title'),scenario_id:data.get('scenario'),label_type:data.get('label_type'),
      messages:messages.map((m,i)=>({...m,id:`m${i}`,final:true})),expected_scores:expected})});form.reset();setMessages([{role:'doctor',text:''},{role:'trainee',text:''}]);setRefresh(v=>v+1)}
    catch(cause){setError(cause instanceof Error?cause.message:'样本未能保存')}finally{setBusy(false)}
  }
  const active=run&&['running','cancel_requested'].includes(run.status)
  return <section className="mt-8 space-y-5 border-t pt-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-base font-medium">专家标注与模型校准</h3><p className="mt-2 text-xs leading-6 text-muted-foreground">每维度至少5个专家有效标注，MAE ≤ 0.5、相差不超过1分的比例 ≥ 90%。合成样本不用于认定校准通过。</p></div><Button variant="outline" size="sm" disabled={busy} onClick={()=>setRefresh(v=>v+1)}>刷新校准数据</Button></div>
    {error&&<p role="alert" className="text-sm leading-6 text-destructive">{error}</p>}
    <div className="space-y-3 rounded-lg bg-muted/30 p-4"><p className="text-sm">{samples.length} 个标注样本 · 每次最多评估20个，优先专家样本</p><div className="flex flex-wrap gap-3"><Button disabled={busy||Boolean(active)||!samples.length} onClick={()=>void start()}>调用模型运行校准</Button>{active&&<Button variant="outline" disabled={busy} onClick={()=>void cancel()}>停止后续样本</Button>}</div><p className="text-xs leading-6 text-muted-foreground">运行会消耗真实模型额度。中断不会自动重试；可刷新进度后决定是否重新运行。</p></div>
    {run&&<section className="space-y-4"><h4 className="text-sm font-medium">{runLabels[run.status]??run.status} · {run.completed_count} / {run.sample_count} 个样本</h4><p className="text-xs text-muted-foreground">模型 {run.model} · 评价规则 {run.evaluator_version}</p>{run.error&&<p className="text-sm text-muted-foreground">{run.error}</p>}{run.metrics&&<><p className="text-sm leading-7">{run.metrics.calibrated?'本次专家标注一致性达到校准条件。':'本次尚未达到专家标注校准条件。'} 专家样本 {run.metrics.expert_samples}，合成样本 {run.metrics.synthetic_samples}。</p><div className="overflow-x-auto rounded-lg border"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted-foreground"><th className="px-3 py-3 font-normal">维度</th><th className="px-3 py-3 text-right font-normal">有效配对</th><th className="px-3 py-3 text-right font-normal">MAE（0–4分）</th><th className="px-3 py-3 text-right font-normal">相差≤1分</th></tr></thead><tbody>{run.metrics.dimensions.map(d=><tr key={d.key} className="border-t"><td className="px-3 py-3">{d.label}</td><td className="px-3 py-3 text-right tabular-nums">{d.paired_count} / {d.expected_count}</td><td className="px-3 py-3 text-right tabular-nums">{d.mae===null?'—':d.mae.toFixed(2)}</td><td className="px-3 py-3 text-right tabular-nums">{d.within_one===null?'—':`${(d.within_one*100).toFixed(1)}%`}</td></tr>)}</tbody></table></div></>}</section>}
    {samples.length>0&&<details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm">查看标注样本</summary><ul className="mt-3 divide-y">{samples.map(s=><li key={s.id} className="py-3 text-sm"><p>{s.title}</p><p className="mt-1 text-xs leading-6 text-muted-foreground">{s.label_type==='expert'?'人工专家标注':'合成测试'} · {s.labelled_by}</p><p className="mt-1 text-xs leading-6 text-muted-foreground">{rubric.dimensions.map(d=>`${d.label}：${s.expected_scores[d.key]===null?'未观察':s.expected_scores[d.key]}`).join('；')}</p></li>)}</ul></details>}
    <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm">添加标注样本</summary><form className="mt-5 space-y-5" onSubmit={add}><Field label="样本名称" name="title" maxLength={120}/><Field label="场景"><select name="scenario" required className={inputClass}><option value="">选择绑定本量表的已发布场景</option>{scenes.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></Field><Field label="标注类型"><select name="label_type" className={inputClass} defaultValue="synthetic"><option value="synthetic">合成测试样本</option><option value="expert">经授权专家人工标注</option></select></Field><p className="text-xs leading-6 text-muted-foreground">使用合成或充分脱敏的训练文本，不录入患者身份信息。人工标注需要真实审核责任人确认。</p>
      {messages.map((message,index)=><div key={index} className="space-y-3 rounded-lg border p-3"><label className="block space-y-2 text-sm">说话人<select className={inputClass} value={message.role} onChange={e=>setMessages(messages.map((m,i)=>i===index?{...m,role:e.target.value}:m))}><option value="doctor">医生</option><option value="trainee">学员</option></select></label><label className="block space-y-2 text-sm">完整原话<Textarea required maxLength={4000} value={message.text} onChange={e=>setMessages(messages.map((m,i)=>i===index?{...m,text:e.target.value}:m))}/></label>{messages.length>1&&<Button type="button" variant="ghost" size="sm" onClick={()=>setMessages(messages.filter((_,i)=>i!==index))}>移除此条</Button>}</div>)}
      <Button type="button" variant="outline" disabled={messages.length>=32} onClick={()=>setMessages([...messages,{role:'trainee',text:''}])}>添加原话</Button>
      {rubric.dimensions.map(d=><Field key={d.key} label={d.label}><select name={d.key} className={inputClass} defaultValue=""><option value="">未观察／无法判断</option>{d.anchors.map((anchor,i)=><option key={i} value={i}>{i} 分 · {anchor}</option>)}</select></Field>)}
      <Button type="submit" disabled={busy||!scenes.length}>{busy?'正在保存…':'保存标注样本'}</Button>
    </form></details>
  </section>
}
