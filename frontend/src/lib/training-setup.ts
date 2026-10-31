import type { Scenario } from './catalog-types.ts'

export const trainingPresets = [
  { id: 'coached', label: '辅助练习', description: '实时建议与结束后复盘；自由练习不评分。', experience: 'practice', mode: 'assisted' },
  { id: 'combat', label: '实战练习', description: '无实时提示，结束后复盘；自由练习不评分。', experience: 'combat', mode: 'independent' },
] as const

export type TrainingPreset = typeof trainingPresets[number]

export function presetFor(experience: string, _mode?: string): TrainingPreset {
  return experience === 'combat' ? trainingPresets[1] : trainingPresets[0]
}

export function recommendedScenario(scenes: Scenario[]) {
  const published = scenes.filter(scene => scene.status === 'published')
  return published.find(scene => scene.difficulty === 'basic' && (!scene.situation || scene.situation === 'first_visit')) ?? published[0]
}
