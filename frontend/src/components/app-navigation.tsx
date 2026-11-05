import { ClipboardList,Settings,Sparkles } from 'lucide-react';
import { memo } from 'react';
import { NavigationMenu,NavigationMenuItem,NavigationMenuLink,NavigationMenuList } from './ui/navigation-menu';

export const AppNavigation = memo(function AppNavigation({ page, inSession }: { page: string; inSession: boolean }) {
  if (page === 'start') return null
  const tabs = [
    { id: 'practice', label: '练习', icon: Sparkles, href: inSession ? '#start' : '#practice' },
    { id: 'records', label: '记录', icon: ClipboardList, href: '#records' },
    { id: 'me', label: '设置', icon: Settings, href: '#me' },
  ]
  return <NavigationMenu aria-label="主导航" viewport={false} className="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-[960px] bg-background pb-[env(safe-area-inset-bottom)] [&>div]:w-full">
    <NavigationMenuList className="grid w-full grid-cols-3 gap-1 px-2 py-2">
      {tabs.map(tab => <NavigationMenuItem key={tab.id}><NavigationMenuLink href={tab.href} active={page === tab.id} aria-label={tab.label} aria-current={page === tab.id ? 'page' : undefined} className="min-h-14 flex-col items-center justify-center gap-1 px-2 py-2">
          <tab.icon aria-hidden="true" className="size-5" /><span className="text-xs">{tab.label}</span>
      </NavigationMenuLink></NavigationMenuItem>)}
    </NavigationMenuList>
  </NavigationMenu>
})
