import { medicalLabels, type MedicalCheck } from '@/lib/medical'

export function MedicalCheckView({ check }: { check: MedicalCheck }) {
  if (check.status === 'not_medical') return null
  const conflict = check.status === 'contradicted'
  return <section aria-label="医学依据核验" aria-live="polite" className={`mt-3 space-y-3 rounded-xl border p-4 text-sm leading-6 ${conflict ? 'border-destructive/40 bg-destructive/5' : 'bg-background'}`}>
    <h3 className={`font-medium ${conflict ? 'text-destructive' : ''}`}>{medicalLabels[check.status]}<span className="ml-2 font-normal text-muted-foreground">自动初筛</span></h3>
    {check.reason && <p className="text-muted-foreground">{check.reason}</p>}
    {check.statements.filter(row => row.status !== 'not_medical').map(row => <div key={row.id} className="space-y-2">
      {check.statements.length > 1 && <p className="font-medium">{row.text}</p>}
      <p>{row.reason}</p>
      {row.correction && <p role="alert" className="font-medium text-destructive">纠正：{row.correction}</p>}
      {row.citations.map((citation, index) => <details key={`${citation.chunk_id}-${index}`} className="text-muted-foreground">
        <summary className="cursor-pointer break-words py-1 underline underline-offset-4">{citation.title} · 第 {citation.page} 页 / 段</summary>
        <blockquote className="my-2 whitespace-pre-wrap border-l-2 pl-3">{citation.quote}</blockquote>
        <p className="text-xs">版本：{citation.published_at || '未确认'} · 适用地区：{citation.jurisdiction} · {citation.quality === 'abstract' ? '仅摘要' : '归档原文'}</p>
        <a className="mt-2 inline-block underline underline-offset-4" target="_blank" rel="noreferrer" href={`/api/medical/sources/${encodeURIComponent(citation.source_id)}?version=${encodeURIComponent(citation.sha256)}#p${citation.page}`}>核对归档原文（新标签页）</a>
      </details>)}
    </div>)}
    {check.status !== 'checking' && <p className="text-xs text-muted-foreground">仅覆盖已识别原话与已检索依据，需医学专业复核；不能替代临床判断。</p>}
  </section>
}
