import { ChevronRight, ClipboardList, LogOut, NotebookPen, UserRound } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

export function MePage({ username, onLogout, logoutDisabled = false }: {
  username?: string; onLogout?: () => void; logoutDisabled?: boolean
}) {
  return <div className="space-y-6">
    <header><h1 className="text-[22px] leading-8 font-semibold tracking-tight sm:text-2xl">我的</h1></header>
    <Card className="gap-0 py-0">
      <CardContent className="flex items-center gap-3 border-b px-4 py-5">
        <Avatar aria-hidden="true" className="size-12"><AvatarFallback><UserRound className="size-6" /></AvatarFallback></Avatar>
        <p className="min-w-0 break-words text-base font-medium">{username || '当前账号'}</p>
      </CardContent>
      <nav aria-label="我的记录" className="divide-y">
        <Button asChild variant="ghost" className="h-16 w-full justify-start gap-3 rounded-none px-4"><a href="#visits"><NotebookPen aria-hidden="true" className="size-5" /><span className="flex-1 text-left">拜访日记</span><ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" /></a></Button>
        <Button asChild variant="ghost" className="h-16 w-full justify-start gap-3 rounded-none px-4"><a href="#records"><ClipboardList aria-hidden="true" className="size-5" /><span className="flex-1 text-left">复盘记录</span><ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" /></a></Button>
      </nav>
    </Card>
    {onLogout && <div className="space-y-3">
      <Button variant="outline" className="h-12 w-full" disabled={logoutDisabled} onClick={onLogout}><LogOut aria-hidden="true" />退出登录</Button>
      {logoutDisabled && <p className="text-sm leading-6 text-muted-foreground">请先结束演练并确认保存，再退出登录。</p>}
    </div>}
  </div>
}
