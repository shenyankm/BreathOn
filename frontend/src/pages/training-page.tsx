import { ChevronRight } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'

export function TrainingPage() {
  const categories = [
    { id: 'L1', title: '公司与产品底盘', description: '了解产品，核对证据与适用范围', links: [{ href: '#products', title: '公司产品' }, { href: '#library', title: '全部药品与来源资料' }] },
    { id: 'L2', title: '疾病线与临床场景', description: '按疾病查资料，带着问题进入场景', links: [{ href: '#scenarios', title: '疾病与训练场景' }, { href: '#library', title: '搜索疾病相关药品' }] },
    { id: 'L3', title: '医生画像与沟通偏好', description: '了解专业背景、关注点和交流方式', links: [{ href: '#doctors', title: '查看医生训练角色' }] },
    { id: 'L4', title: '模拟拜访与复盘', description: '完成一次交流，再回看真实反馈', links: [{ href: '#practice', title: '进入 AI 教练' }, { href: '#records', title: '练习记录与复盘' }, { href: '#visits', title: '拜访记录与录音' }] },
  ]
  return <div className="space-y-6"><p className="breathon-eyebrow">REP ACADEMY</p><PageHeader title="能力训练" description="从产品底盘，到疾病线，再到医生沟通。" /><div className="breathon-hero"><h2 className="text-xl font-semibold">按今天的需要，选择训练内容</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">L1–L4 是内容分类，所有分类均可直接进入。</p></div><Accordion type="multiple" defaultValue={['L1']} className="space-y-3 overflow-visible rounded-none border-0">{categories.map(category => <AccordionItem key={category.id} value={category.id} className="overflow-hidden rounded-3xl border bg-card data-open:bg-card px-2"><AccordionTrigger className="min-h-24 gap-3 py-4 hover:no-underline"><span className="breathon-level" data-level={category.id}>{category.id}</span><span className="min-w-0 flex-1 text-left"><span className="block text-base font-semibold">{category.title}</span><span className="mt-1 block text-sm font-normal leading-6 text-muted-foreground">{category.description}</span></span></AccordionTrigger><AccordionContent className="pb-3">{category.links.map(link => <Button asChild variant="ghost" key={link.href} className="h-auto min-h-14 w-full justify-between gap-3 border-t px-2 py-3 whitespace-normal"><a href={link.href}><span className="text-left">{link.title}</span><ChevronRight aria-hidden="true" className="shrink-0" /></a></Button>)}</AccordionContent></AccordionItem>)}</Accordion></div>
}
