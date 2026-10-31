import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown } from 'lucide-react'
import { ScrollArea } from './ui/scroll-area'
import { Button } from './ui/button'
import { isNearBottom } from '@/lib/scroll-position'
import type { VoiceMessage } from '@/lib/voice-events'

export function TranscriptScrollArea({ messages, children }: { messages: VoiceMessage[]; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [unread, setUnread] = useState(false)
  const viewport = () => root.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
  function jumpToLatest() {
    const element = viewport()
    following.current = true
    if (element) element.scrollTop = element.scrollHeight
    setUnread(false)
  }
  useLayoutEffect(() => {
    if (following.current) jumpToLatest()
    else setUnread(true)
  }, [messages])
  return <div className="relative flex min-h-0 flex-1 flex-col">
    <ScrollArea ref={root} className="min-h-0 flex-1" onScrollCapture={event => {
      if (event.target !== viewport()) return
      following.current = isNearBottom(event.target as HTMLElement)
      if (following.current) setUnread(false)
    }}>{children}</ScrollArea>
    {unread && <Button className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm" onClick={jumpToLatest}><ArrowDown aria-hidden="true" />有新消息</Button>}
  </div>
}
