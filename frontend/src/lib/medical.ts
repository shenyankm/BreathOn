export type MedicalCitation = { source_id: string; chunk_id: string; page: number; quote: string; title: string; url: string; sha256: string; published_at: string | null; retrieved_at: string; kind: string; quality: string; jurisdiction: string }
export type MedicalStatus = 'checking' | 'supported' | 'contradicted' | 'insufficient' | 'not_medical' | 'unavailable'
export type MedicalCheck = { message_id?: string; text: string; status: MedicalStatus; reason?: string; corpus_version?: string; preliminary: boolean; statements: { id: string; text: string; status: MedicalStatus; reason: string; correction: string; citations: MedicalCitation[] }[] }
export const medicalLabels: Record<MedicalStatus, string> = { checking: '正在核验', supported: '检索依据支持', contradicted: '发现医学表述冲突', insufficient: '依据不足，待核实', not_medical: '无医学断言', unavailable: '尚未完成核验' }

export function updateMedicalChecks(previous: MedicalCheck[], check: MedicalCheck) {
  const index = previous.findIndex(row => row.message_id === check.message_id)
  return index < 0 ? [...previous, check] : previous.map((row, i) => i === index ? check : row)
}

export function invalidateMedicalCheck(previous: MedicalCheck[], id: string, text: string) {
  const index = previous.findIndex(row => row.message_id === id && row.text !== text)
  if (index < 0) return previous
  const updated = previous.slice()
  updated[index] = { ...previous[index], text, status: 'checking', statements: [], reason: '转录已修正，正在重新核验。' }
  return updated
}

export function indexProductSources<T extends { id: string }>(products: { id: string; sources: string[] }[], sources: T[]) {
  const byId = new Map(sources.map((source, index) => [source.id, { source, index }]))
  return new Map(products.map(product => [product.id, [...new Set(product.sources)]
    .flatMap(id => { const entry = byId.get(id); return entry ? [entry] : [] })
    .sort((a, b) => a.index - b.index).map(entry => entry.source)]))
}
