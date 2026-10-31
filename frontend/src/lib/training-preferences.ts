import { invoke } from '@tauri-apps/api/core'

// Keep writes ordered across rapid selections and account remounts.
let pending: Promise<void> = Promise.resolve()

export async function loadTrainingPreference(account: string): Promise<string | null> {
  await pending.catch(() => {})
  const value = await invoke<unknown>('load_training_preference', { account })
  if (value !== null && value !== 'practice' && value !== 'combat') throw new Error('Invalid training preference')
  return value
}

export function saveTrainingPreference(account: string, experience: string): Promise<void> {
  pending = pending.catch(() => {}).then(() => invoke<void>('save_training_preference', { account, experience }))
  return pending
}
