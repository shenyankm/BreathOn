import logo from '@/assets/brand/breathon-logo.png'

export function Brand({ iconClassName = 'size-8' }: { iconClassName?: string }) {
  return <span className="inline-flex shrink-0 items-center gap-2.5 font-semibold">
    <img src={logo} alt="" aria-hidden="true" width={40} height={40} className={`block shrink-0 object-contain ${iconClassName}`} />
    <span>BreathOn</span>
  </span>
}
