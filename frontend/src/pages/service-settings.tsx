import { Alert,AlertDescription,AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from '@/components/ui/card'
import { Item,ItemContent,ItemDescription,ItemTitle } from '@/components/ui/item'
import { loadServiceStatus,readServiceStatus,saveServiceStatus,serviceChecks } from '@/lib/service-status'
import { CheckIcon,CircleHelp,CircleX,RotateCcw } from 'lucide-react'
import { useEffect,useRef,useState } from 'react'

export function ServiceSettings() {
  const [serviceStatus, setServiceStatus] = useState(loadServiceStatus)
  const [serviceError, setServiceError] = useState('')
  const [serviceChecking, setServiceChecking] = useState(false)
  const serviceRequest = useRef<AbortController | null>(null)
  const healthyServices = serviceChecks.filter(({key})=>serviceStatus?.[key]?.ok === true).length
  useEffect(() => () => serviceRequest.current?.abort(), [])
  async function refreshServices() {
    if (serviceRequest.current) return
    const controller = new AbortController()
    serviceRequest.current = controller
    setServiceChecking(true); setServiceError('')
    try {
      const data = await readServiceStatus(controller.signal)
      if (!controller.signal.aborted) {setServiceStatus(data); saveServiceStatus(data)}
    } catch {
      if (!controller.signal.aborted) setServiceError('无法完成服务检测，请确认后端已启动后重试。')
    } finally {
      serviceRequest.current = null
      if (!controller.signal.aborted) setServiceChecking(false)
    }
  }
  return <div className="mx-auto max-w-3xl space-y-7">
        <Item><ItemContent><ItemTitle><h1>{"服务设置"}</h1></ItemTitle><ItemDescription>{"刷新将产生外部服务用量。"}</ItemDescription></ItemContent></Item>
        <Card >
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="space-y-1"><CardTitle><h2>服务状态</h2></CardTitle><CardDescription role="status">{serviceChecking?'正在检测服务…':serviceStatus?`上次检测：${healthyServices} / ${serviceChecks.length} 项正常`:'尚未检测'}</CardDescription></div>
          <Button variant="outline" className="min-w-24 min-h-11" disabled={serviceChecking} onClick={refreshServices}><RotateCcw aria-hidden="true" className={serviceChecking ? " " : ""}/>{serviceChecking?'检测中':'刷新'}</Button>
        </CardHeader>
        <CardContent aria-busy={serviceChecking}>
          {serviceError&&<Alert variant="destructive" className="mb-4" role="alert"><CircleHelp aria-hidden="true"/><AlertTitle>检查失败</AlertTitle><AlertDescription>{serviceError}{serviceStatus?' 下方保留上次检测结果。':''}</AlertDescription></Alert>}
          <dl className="divide-y">
            {serviceChecks.map(({key,label})=>{
              const result=serviceStatus?.[key]
              const ready=result?.ok===true
              return <div key={key} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                <dt className="min-w-0"><span className="block text-sm font-medium">{label}</span><span className="mt-1 block break-words text-xs leading-5 text-muted-foreground">{result?.model||(serviceChecking?'读取模型中…':'模型信息未获取')}</span>{result&&!result.ok&&<span className="mt-1 block text-xs leading-5 text-destructive">{result.message}</span>}</dt>
                <dd className="shrink-0"><Badge variant="outline" className={`h-7 px-2.5 ${!result ? "text-muted-foreground" : ready ? " " : " text-destructive"}`}>{!result?<CircleHelp aria-hidden="true"/>:ready?<CheckIcon aria-hidden="true"/>:<CircleX aria-hidden="true"/>}{!result?(serviceChecking?'检测中':'未检测'):ready?'正常':'异常'}</Badge></dd>
              </div>
            })}
          </dl>
        </CardContent>
        </Card>
      </div>
}
