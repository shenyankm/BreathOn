import { ChevronRight, ClipboardList, LogOut, NotebookPen, UserRound } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

export function MePage({ username, onLogout, logoutDisabled = false }: {
  username?: string; onLogout?: () => void; logoutDisabled?: boolean
}) {
  return <div className="space-y-6">
    <h1 className="sr-only">我的</h1>
    <Card className="gap-0 bg-transparent py-0 ring-0">
      <CardContent className="flex flex-col items-center gap-4 px-4 py-8">
        <Avatar aria-hidden="true" className="size-24"><AvatarFallback className="text-3xl">{username?.slice(0, 1) || <UserRound aria-hidden="true" className="size-10" />}</AvatarFallback></Avatar>
        <p className="min-w-0 break-words text-base font-medium">{username || '当前账号'}</p>
      </CardContent>
      <nav aria-label="我的记录" className="overflow-hidden rounded-3xl border bg-card divide-y">
        <Button asChild variant="ghost" className="h-16 w-full justify-start gap-3 rounded-none px-4"><a href="#visits"><NotebookPen aria-hidden="true" className="size-5" /><span className="flex-1 text-left">拜访记录</span><ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" /></a></Button>
        <Button asChild variant="ghost" className="h-16 w-full justify-start gap-3 rounded-none px-4"><a href="#records"><ClipboardList aria-hidden="true" className="size-5" /><span className="flex-1 text-left">练习记录</span><ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" /></a></Button>
      </nav>
    </Card>
    {onLogout && <div className="space-y-3">
      <Button variant="outline" className="h-12 w-full" disabled={logoutDisabled} onClick={onLogout}><LogOut aria-hidden="true" />退出登录</Button>
      {logoutDisabled && <p className="text-sm leading-6 text-muted-foreground">请先结束演练并确认保存，再退出登录。</p>}
    </div>}
  </div>
}
