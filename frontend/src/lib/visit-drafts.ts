import { invoke } from '@tauri-apps/api/core'

let pending: Promise<unknown> = Promise.resolve()
export async function loadVisitDraft(account: string): Promise<string | null> {
  await pending.catch(() => {})
  return invoke<string | null>('load_visit_draft', { account })
}
export function saveVisitDraft(account: string, payload: string | null): Promise<void> {
  const write = pending.catch(() => {}).then(() => invoke<void>('save_visit_draft', { account, payload }))
  pending = write
  return write
}

export type VisitDraft = { doctor_id: string; drug_id: string; visited_at: string; source: string; text: string }
export type VisitEdit = { id: string; version: number; text: string; redacted: string; speakers: { speaker_id: string; role: string }[] }
export function parseVisitDraft(raw: string): { draft: VisitDraft; edit: VisitEdit | null } {
  const value = JSON.parse(raw)
  if (!value || value.format !== 1 || !value.draft || !['doctor_id','drug_id','visited_at','source','text'].every(key => typeof value.draft[key] === 'string')) throw new Error('本机草稿格式不兼容，请保留数据并更新应用。')
  const edit = value.edit
  if (edit && (typeof edit.id !== 'string' || !Number.isInteger(edit.version) || typeof edit.text !== 'string' || typeof edit.redacted !== 'string' || !Array.isArray(edit.speakers) || !edit.speakers.every((row: {speaker_id?: unknown; role?: unknown}) => typeof row.speaker_id === 'string' && ['doctor','representative','other','unknown'].includes(String(row.role))))) throw new Error('本机修改记录格式不兼容。')
  return { draft: value.draft, edit: edit ?? null }
}
