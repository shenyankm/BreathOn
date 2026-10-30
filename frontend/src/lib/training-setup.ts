import type { Scenario } from './catalog-types.ts'

export const trainingPresets = [
  { id: 'coached', label: '带教练练习', description: '对话中提供实时回答建议。', experience: 'practice', mode: 'assisted' },
  { id: 'independent', label: '独立练习', description: '无实时建议，结束后复盘。', experience: 'practice', mode: 'independent' },
  { id: 'combat', label: '实战演练', description: '可随时打断医生，结束后复盘。', experience: 'combat', mode: 'independent' },
] as const

export type TrainingPreset = typeof trainingPresets[number]

export function presetFor(experience: string, mode: string): TrainingPreset {
  if (experience === 'combat') return trainingPresets[2]
  return trainingPresets.find(preset => preset.experience === experience && preset.mode === mode) ?? trainingPresets[0]
}

export function recommendedScenario(scenes: Scenario[]) {
  const published = scenes.filter(scene => scene.status === 'published')
  return published.find(scene => scene.difficulty === 'basic' && (!scene.situation || scene.situation === 'first_visit')) ?? published[0]
}
