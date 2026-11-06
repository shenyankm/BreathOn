import templates from '../../../backend/resources/scenario-templates.json' with { type: 'json' }

type ScenarioTemplate = {
  label: string; group: string; objective: string; background: string; opening: string
  difficulty: string; duration_seconds: number; stages: string[]; objections: string[]; success_criteria: string[]
}
export const scenarioTemplates: Record<string, ScenarioTemplate> = templates
export const scenarioGroups = [...new Set(Object.values(scenarioTemplates).map(template => template.group))]
export const situations: Record<string, string> = Object.fromEntries(Object.entries(scenarioTemplates).map(([key, template]) => [key, template.label]))
export function scenarioDefaults(situation: string) {
  const template = scenarioTemplates[situation] ?? scenarioTemplates.first_visit
  return { ...template, title: template.label, situation }
}
