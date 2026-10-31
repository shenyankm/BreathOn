import { ArrowRight, BookOpen, ClipboardList, Stethoscope } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { formatTime } from '@/lib/session'

export function HomePage({ username, sessionStatus, seconds }: { username?: string; sessionStatus: string; seconds: number }) {
  return <div className="space-y-6">
    <header className="flex items-center justify-between gap-3"><div><p className="font-semibold tracking-wide">灵息 BREATHON</p><p className="breathon-eyebrow mt-1">REP WORKSPACE</p></div><Button asChild variant="secondary" className="size-12 rounded-full"><a href="#me" aria-label="我的账号">{username?.slice(0, 1) || '我'}</a></Button></header>
    <div><h1 className="text-3xl font-semibold leading-tight">你好，<br /><span className="break-words">{username || '欢迎回来'}</span></h1><p className="mt-3 text-sm leading-6 text-muted-foreground">今天，把合适的证据交给合适的医生。</p></div>
    {sessionStatus && <Card><CardContent className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm">{sessionStatus} · {formatTime(seconds)}</p><Button asChild><a href="#start">返回演练<ArrowRight aria-hidden="true" /></a></Button></CardContent></Card>}
    <section className="breathon-hero space-y-5" aria-labelledby="preparation-title"><p className="breathon-eyebrow">今日拜访准备</p><h2 id="preparation-title" className="text-3xl font-semibold leading-tight">把一次拜访<br />准备完整</h2><div className="flex flex-wrap gap-x-5 gap-y-2 text-sm"><span>01 医生画像</span><span>02 核心证据</span><span>03 模拟沟通</span></div><Button asChild size="lg"><a href="#training">开始准备<ArrowRight aria-hidden="true" /></a></Button></section>
    <section className="space-y-3" aria-labelledby="workspace-title"><h2 id="workspace-title" className="text-lg font-semibold">我的训练工作台</h2><div className="grid gap-3 sm:grid-cols-3">{[
      { href: '#doctors', title: '了解医生', description: '查看背景、关注点与模拟训练设定', icon: Stethoscope },
      { href: '#library', title: '阅读资料', description: '核对药品、疾病与来源原文', icon: BookOpen },
      { href: '#records', title: '回看复盘', description: '从真实对话和反馈中继续练习', icon: ClipboardList },
    ].map(item => <Button key={item.href} asChild variant="outline" className="h-auto min-h-24 justify-start gap-4 rounded-3xl bg-card px-5 py-4 whitespace-normal"><a href={item.href}><item.icon aria-hidden="true" className="size-6 shrink-0 text-primary" /><span className="min-w-0 text-left"><span className="block text-base font-semibold">{item.title}</span><span className="mt-1 block text-sm font-normal leading-6 text-muted-foreground">{item.description}</span></span></a></Button>)}</div></section>
  </div>
}
