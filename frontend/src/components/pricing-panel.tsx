import { useEffect, useState, type FormEvent } from 'react'
import { Button } from './ui/button'
import { Field, inputClass } from './ui/form-field'
import { api } from '@/lib/platform-api'
import { providerLabels, unitLabels, type PriceBook, type PriceRate } from '@/lib/progress'

export function PricingPanel() {
  const [book,setBook]=useState<PriceBook>({version:0,rates:[]})
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [refresh,setRefresh]=useState(0)
  const [today]=useState(()=>new Date().toISOString().slice(0,10))
  useEffect(()=>{const controller=new AbortController();api<PriceBook>('/usage/prices',{signal:controller.signal}).then(setBook).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'计价依据加载失败')}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});return()=>controller.abort()},[refresh])
  function change(index:number,patch:Partial<PriceRate>){setBook(current=>({...current,rates:current.rates.map((rate,i)=>i===index?{...rate,...patch}:rate)}));setNotice('')}
  async function save(event:FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');setNotice('');try{setBook(await api<PriceBook>('/usage/prices',{method:'PUT',body:JSON.stringify(book)}));setNotice('计价依据已保存，仅用于后续演练；历史演练保留原有价格快照。')}catch(cause){setError(cause instanceof Error?cause.message:'未能保存计价依据')}finally{setBusy(false)}}
  return <section className="space-y-5"><div><h2 className="text-lg font-medium">用量计价依据</h2><p className="mt-2 text-sm leading-7 text-muted-foreground">按供应商公开价格或实际合同填写。金额 ÷ 计量数量 × 已记录用量，形成估算；币种分开累计，缺少用量或价格时显示未计价，不视为免费。</p></div>
    {loading?<p role="status" className="text-sm">正在加载计价依据…</p>:<form onSubmit={save}><fieldset disabled={busy} className="space-y-5">
      {book.rates.length===0&&<p className="rounded-xl border p-5 text-sm leading-7">尚未配置计价依据。演练仍可记录用量，但不会猜测费用。</p>}
      {book.rates.map((rate,index)=><details className="rounded-xl border bg-background" key={index}><summary className="cursor-pointer p-5 text-sm font-medium">{providerLabels[rate.provider]} · {unitLabels[rate.unit]}</summary><div className="space-y-4 border-t p-5">
        <div className="grid gap-4 sm:grid-cols-2"><Field label="服务"><select className={inputClass} value={rate.provider} onChange={event=>change(index,{provider:event.target.value})}>{Object.entries(providerLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field><Field label="模型或资源名称"><input className={inputClass} required maxLength={100} value={rate.model} onChange={event=>change(index,{model:event.target.value})}/></Field></div>
        <div className="grid gap-4 sm:grid-cols-4"><Field label="计量单位"><select className={inputClass} value={rate.unit} onChange={event=>change(index,{unit:event.target.value})}>{Object.entries(unitLabels).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></Field><Field label="计量数量"><input className={inputClass} type="number" required min={1} max={1_000_000_000} step={1} value={rate.per_units} onChange={event=>change(index,{per_units:Number(event.target.value)})}/></Field><Field label="对应金额"><input className={inputClass} type="number" required min={0} max={1_000_000} step="0.00000001" value={rate.amount} onChange={event=>change(index,{amount:event.target.value})}/></Field><Field label="币种"><select className={inputClass} value={rate.currency} onChange={event=>change(index,{currency:event.target.value})}><option value="CNY">CNY 人民币</option><option value="USD">USD 美元</option></select></Field></div>
        <div className="grid gap-4 sm:grid-cols-2"><Field label="计价来源链接"><input className={inputClass} type="url" required maxLength={8192} value={rate.source_url} onChange={event=>change(index,{source_url:event.target.value})}/></Field><Field label="核对日期"><input className={inputClass} type="date" required max={today} value={rate.checked_on} onChange={event=>change(index,{checked_on:event.target.value})}/></Field></div>
        <Field label="适用说明"><input className={inputClass} maxLength={500} value={rate.note} onChange={event=>change(index,{note:event.target.value})}/></Field>
      <Button type="button" variant="ghost" onClick={()=>setBook(current=>({...current,rates:current.rates.filter((_,i)=>i!==index)}))}>移除规则</Button></div></details>)}
      <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={book.rates.length>=50} onClick={()=>setBook(current=>({...current,rates:[...current.rates,{provider:'deepseek',model:'deepseek-flash',unit:'input_tokens',amount:'',per_units:1_000_000,currency:'USD',source_url:'https://api-docs.deepseek.com/quick_start/pricing/',checked_on:new Date().toISOString().slice(0,10),note:''}]}))}>添加计价规则</Button><Button disabled={busy} type="submit">{busy?'正在保存…':'保存计价依据'}</Button></div>
      <p className="text-xs leading-6 text-muted-foreground">每次演练保存启动时的价格快照。分时、缓存、套餐优惠及失败后未报告的用量不作推测，估算不等于实际账单。</p>
    </fieldset></form>}{notice&&<p role="status" className="text-sm leading-7">{notice}</p>}{error&&<div role="alert" className="flex flex-wrap items-center gap-3"><p className="text-sm text-destructive">{error}</p><Button variant="outline" onClick={()=>{setLoading(true);setError('');setRefresh(value=>value+1)}}>重新加载计价依据</Button></div>}
  </section>
}
