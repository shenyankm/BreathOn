export type Lesson = {
  id: string; title: string; summary: string; tagline: string; status: string; owner: string
  sections: [string, string][]; level: string; state: 'none' | 'planned' | 'completed'
  unverified_figures?: boolean; action?: { kind: 'practice'; scenario: ScenarioKey; ip_id: string } | { kind: 'doctor_ips' }
}
type ScenarioKey = 'first' | 'evidence' | 'next'
