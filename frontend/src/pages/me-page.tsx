import { Button } from '@/components/ui/button'
import { ToggleGroup,ToggleGroupItem } from '@/components/ui/toggle-group'
import { trainingPresets,type TrainingPreset } from '@/lib/training-setup'
import { LogOut } from 'lucide-react'
import { memo } from 'react'

export const MePage = memo(function MePage({ username, preset, onPresetChange, onLogout, logoutDisabled = false }: {
  username?: string; preset: TrainingPreset; onPresetChange: (preset: TrainingPreset) => void
  onLogout?: () => void; logoutDisabled?: boolean
}) {
  return <div className="space-y-6">
    <h1 className="text-xl font-semibold">设置</h1>
    <section className="space-y-2"><h2 className="text-sm text-muted-foreground">当前账号</h2><p className="break-words font-medium">{username || '当前账号'}</p></section>
    <section className="space-y-3"><h2 id="default-practice-mode" className="font-medium">默认练习方式</h2>
      <ToggleGroup type="single" variant="outline" className="flex-wrap" aria-labelledby="default-practice-mode" value={preset.id} onValueChange={id => { const option = trainingPresets.find(option => option.id === id); if (option) onPresetChange(option) }}>{trainingPresets.map(option => <ToggleGroupItem key={option.id} value={option.id} className="min-h-11">{option.label}</ToggleGroupItem>)}</ToggleGroup>
    </section>
    {onLogout && <div className="space-y-3">
      <Button variant="outline" size="lg" className="w-full min-h-11" disabled={logoutDisabled} onClick={onLogout}><LogOut aria-hidden="true" />退出登录</Button>
      {logoutDisabled && <p className="text-sm leading-6 text-muted-foreground">请先结束演练并确认保存，再退出登录。</p>}
    </div>}
  </div>
})
