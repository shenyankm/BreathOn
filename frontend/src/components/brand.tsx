import logo from '@/assets/brand/breathon-logo.png'
import { Avatar,AvatarFallback,AvatarImage } from '@/components/ui/avatar'

export function Brand({ iconClassName = 'size-8' }: { iconClassName?: string }) {
  return <span className="inline-flex shrink-0 items-center gap-2.5 font-semibold">
    <Avatar className={iconClassName} aria-hidden="true"><AvatarImage src={logo} alt="" /><AvatarFallback>循</AvatarFallback></Avatar>
    <span>循言 EviSpeak</span>
  </span>
}
