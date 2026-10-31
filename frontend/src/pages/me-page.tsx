import { memo } from 'react'
import { ChevronRight, ClipboardList, LogOut, NotebookPen, UserRound } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { Card, CardContent } from '@/components/ui/card'

export const MePage = memo(function MePage({ username, onLogout, logoutDisabled = false }: {
  username?: string; onLogout?: () => void; logoutDisabled?: boolean
}) {
  return <div className="space-y-6">
    <p className="breathon-eyebrow">MY WORKSPACE</p>
    <PageHeader title="我的工作台" />
    <Card className="gap-0 overflow-hidden py-0">
      <CardContent className="flex items-center gap-4 px-5 py-6">
        <Avatar aria-hidden="true" className="size-16 shrink-0"><AvatarFallback className="text-3xl">{username?.slice(0, 1) || <UserRound aria-hidden="true" className="size-10" />}</AvatarFallback></Avatar>
        <p className="min-w-0 break-words text-lg font-semibold">{username || '当前账号'}<span className="mt-1 block text-sm font-normal text-muted-foreground">我的学习与拜访记录</span></p>
      </CardContent>
      <nav aria-label="我的记录" className="overflow-hidden rounded-3xl border bg-card divide-y">
        <Button asChild variant="ghost" className="h-16 w-full justify-start gap-3 rounded-none px-4"><a href="#visits"><NotebookPen aria-hidden="true" className="size-5" /><span className="flex-1 text-left">拜访记录</span><ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" /></a></Button>
        <Button asChild variant="ghost" className="h-16 w-full justify-start gap-3 rounded-none px-4"><a href="#records"><ClipboardList aria-hidden="true" className="size-5" /><span className="flex-1 text-left">练习记录</span><ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" /></a></Button>
      </nav>
    </Card>
    {onLogout && <div className="space-y-3">
      <Button variant="outline" size="lg" className="w-full" disabled={logoutDisabled} onClick={onLogout}><LogOut aria-hidden="true" />退出登录</Button>
      {logoutDisabled && <p className="text-sm leading-6 text-muted-foreground">请先结束演练并确认保存，再退出登录。</p>}
    </div>}
  </div>
})
