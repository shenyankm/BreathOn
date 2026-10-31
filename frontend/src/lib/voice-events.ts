import type { Assessment } from './catalog-types'
import type { Message } from './session'

export type VoiceMessage = Message & { id: string; partial: boolean; interrupted?: boolean }
export type TranscriptEvent = { id: string; role: 'doctor' | 'trainee'; text: string; final: boolean; replace?: boolean }

export function applyTranscript(messages: VoiceMessage[], event: TranscriptEvent, time: string): VoiceMessage[] {
  const last = messages.length - 1
  const index = messages[last]?.id === event.id ? last : messages.findIndex(message => message.id === event.id)
  if (index === -1) return event.text ? [...messages, { id: event.id, role: event.role, text: event.text, time, partial: !event.final }] : messages
  const message = messages[index]
  const text = (event.final || event.replace) ? event.text || message.text : message.text + event.text
  if (text === message.text && message.partial === !event.final) return messages
  const updated = messages.slice()
  updated[index] = { ...message, text, partial: !event.final }
  return updated
}

export type LiveCoach = { assessment?: Assessment; based_on: string; doctor_id: string; focus: string; analysis: string; points: string[]; reply: string; risk: string; incomplete?: boolean; superseded?: boolean; sources?: { id: string; title: string; url: string; date: string | null }[]; delivery?: { tone: string; fluency: string; logic: string; turn_taking: string } }

export function groupByMessage<T extends { message_id?: string }>(items: T[]) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    if (item.message_id === undefined) continue
    const group = groups.get(item.message_id)
    if (group) group.push(item)
    else groups.set(item.message_id, [item])
  }
  return groups
}
