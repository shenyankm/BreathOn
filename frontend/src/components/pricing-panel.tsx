import { useEffect, useState, type FormEvent } from 'react'
import { Button } from './ui/button'
import { Field } from './ui/form-field'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { api } from '@/lib/platform-api'
import { providerLabels, unitLabels, type PriceBook, type PriceRate } from '@/lib/progress'

export function PricingPanel() {
  const [book,setBook]=useState<PriceBook>({version:0,rates:[]})
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [refresh,setRefresh]=useState(0)
  const [expanded,setExpanded]=useState<string[]>([])
  const [today]=useState(()=>new Date().toISOString().slice(0,10))
  useEffect(()=>{const controller=new AbortController();api<PriceBook>('/usage/prices',{signal:controller.signal}).then(setBook).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'计价依据加载失败')}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});return()=>controller.abort()},[refresh])
  function change(index:number,patch:Partial<PriceRate>){setBook(current=>({...current,rates:current.rates.map((rate,i)=>i===index?{...rate,...patch}:rate)}));setNotice('')}
  async function save(event:FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');setNotice('');try{setBook(await api<PriceBook>('/usage/prices',{method:'PUT',body:JSON.stringify(book)}));setNotice('计价依据已保存，仅用于后续演练；历史演练保留原有价格快照。')}catch(cause){setError(cause instanceof Error?cause.message:'未能保存计价依据')}finally{setBusy(false)}}
  return <section className="space-y-5"><div><h2 className="text-lg font-medium">用量计价依据</h2></div>
    {loading?<p role="status" className="text-sm">正在加载计价依据…</p>:<form onSubmit={save} onInvalidCapture={()=>setExpanded(book.rates.map((_,index)=>String(index)))}><fieldset disabled={busy} className="space-y-5">
      {book.rates.length===0&&<p className="rounded-xl border p-5 text-sm leading-7">尚未配置计价依据。演练仍可记录用量，但不会猜测费用。</p>}
      <Accordion type="multiple" value={expanded} onValueChange={setExpanded} className="space-y-4">{book.rates.map((rate,index)=><AccordionItem value={String(index)} className="rounded-xl border bg-background px-5 last:border-b" key={index}><AccordionTrigger className="min-h-14 text-sm font-medium">{providerLabels[rate.provider]} · {unitLabels[rate.unit]}</AccordionTrigger><AccordionContent forceMount className="space-y-4 border-t pt-5">
        <div className="grid gap-4 sm:grid-cols-2"><Field label="服务" htmlFor={`price-provider-${index}`}><Select value={rate.provider} disabled={busy} onValueChange={value=>change(index,{provider:value})}><SelectTrigger id={`price-provider-${index}`} className="w-full font-normal"><SelectValue /></SelectTrigger><SelectContent position="popper" align="start">{Object.entries(providerLabels).map(([key,label])=><SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent></Select></Field><Field label="模型或资源名称"><Input className="min-h-11 font-normal" required maxLength={100} value={rate.model} onChange={event=>change(index,{model:event.target.value})}/></Field></div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Field label="计量单位" htmlFor={`price-unit-${index}`}><Select value={rate.unit} disabled={busy} onValueChange={value=>change(index,{unit:value})}><SelectTrigger id={`price-unit-${index}`} className="w-full font-normal"><SelectValue /></SelectTrigger><SelectContent position="popper" align="start">{Object.entries(unitLabels).map(([key,label])=><SelectItem value={key} key={key}>{label}</SelectItem>)}</SelectContent></Select></Field><Field label="计量数量"><Input className="min-h-11 font-normal" type="number" required min={1} max={1_000_000_000} step={1} value={rate.per_units} onChange={event=>change(index,{per_units:Number(event.target.value)})}/></Field><Field label="对应金额"><Input className="min-h-11 font-normal" type="number" required min={0} max={1_000_000} step="0.00000001" value={rate.amount} onChange={event=>change(index,{amount:event.target.value})}/></Field><Field label="币种" htmlFor={`price-currency-${index}`}><Select value={rate.currency} disabled={busy} onValueChange={value=>change(index,{currency:value})}><SelectTrigger id={`price-currency-${index}`} className="w-full font-normal"><SelectValue /></SelectTrigger><SelectContent position="popper" align="start"><SelectItem value="CNY">CNY 人民币</SelectItem><SelectItem value="USD">USD 美元</SelectItem></SelectContent></Select></Field></div>
        <div className="grid gap-4 sm:grid-cols-2"><Field label="计价来源链接"><Input className="min-h-11 font-normal" type="url" required maxLength={8192} value={rate.source_url} onChange={event=>change(index,{source_url:event.target.value})}/></Field><Field label="核对日期"><Input className="min-h-11 font-normal" type="date" required max={today} value={rate.checked_on} onChange={event=>change(index,{checked_on:event.target.value})}/></Field></div>
        <Field label="适用说明"><Input className="min-h-11 font-normal" maxLength={500} value={rate.note} onChange={event=>change(index,{note:event.target.value})}/></Field>
      <Button type="button" variant="ghost" onClick={()=>setBook(current=>({...current,rates:current.rates.filter((_,i)=>i!==index)}))}>移除规则</Button></AccordionContent></AccordionItem>)}</Accordion>
      <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={book.rates.length>=50} onClick={()=>{setExpanded(current=>[...current,String(book.rates.length)]);setBook(current=>({...current,rates:[...current.rates,{provider:'deepseek',model:'deepseek-flash',unit:'input_tokens',amount:'',per_units:1_000_000,currency:'USD',source_url:'https://api-docs.deepseek.com/quick_start/pricing/',checked_on:new Date().toISOString().slice(0,10),note:''}]}))}}>添加计价规则</Button><Button disabled={busy} type="submit">{busy?'正在保存…':'保存计价依据'}</Button></div>
      <p className="text-xs leading-6 text-muted-foreground">按演练开始时的价格估算，币种分别累计；未计价不代表免费，估算不等于实际账单。</p>
    </fieldset></form>}{notice&&<p role="status" className="text-sm leading-7">{notice}</p>}{error&&<div role="alert" className="flex flex-wrap items-center gap-3"><p className="text-sm text-destructive">{error}</p><Button variant="outline" onClick={()=>{setLoading(true);setError('');setRefresh(value=>value+1)}}>重新加载计价依据</Button></div>}
  </section>
}
