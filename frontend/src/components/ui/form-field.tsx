import type { ReactNode } from 'react'
import { Input } from './input'

export const inputClass = 'min-h-11 w-full rounded-lg border bg-background px-3 py-2 text-sm font-normal disabled:opacity-70'
export function Field({ label, name, value = '', type = 'text', required = true, children, maxLength = 1000, htmlFor }: { label: string; name?: string; value?: string | number; type?: string; required?: boolean; children?: ReactNode; maxLength?: number; htmlFor?: string }) {
  const control = children ?? <Input name={name} defaultValue={value} type={type} required={required} maxLength={maxLength} className="min-h-11 font-normal" />
  if (htmlFor) return <div className="grid min-w-0 gap-2 text-sm font-medium"><label htmlFor={htmlFor}>{label}</label>{control}</div>
  return <label className="grid min-w-0 gap-2 text-sm font-medium"><span>{label}</span>{control}</label>
}
