import type { ReactNode } from 'react'
import { Input } from './input'
import { Label } from './label'

export function Field({ label, name, value = '', type = 'text', required = true, children, maxLength = 1000, htmlFor }: { label: string; name?: string; value?: string | number; type?: string; required?: boolean; children?: ReactNode; maxLength?: number; htmlFor?: string }) {
  const control = children ?? <Input name={name} defaultValue={value} type={type} required={required} maxLength={maxLength} className="min-h-11 font-normal" />
  if (htmlFor) return <div className="grid min-w-0 gap-2 text-sm"><Label htmlFor={htmlFor}>{label}</Label>{control}</div>
  return <Label className="grid min-w-0 gap-2 text-sm leading-normal"><span className="font-medium">{label}</span>{control}</Label>
}
