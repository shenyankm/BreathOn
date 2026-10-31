import { useMemo } from 'react'
import { Check } from 'lucide-react'
import { isAppDrug } from '@/lib/app-drugs'
import { trainingPresets, type TrainingPreset } from '@/lib/training-setup'
import type { ManagedDrug } from '@/lib/catalog-types'
import { api } from '@/lib/platform-api'
import { useEffect, useState } from 'react'
import { useBp } from './data'
import { ipImage } from './images'
import { ipDoctors } from './logic'
import { Back, Status, Topline } from './parts'
import { scenarioOrder, scenarios, type DoctorRecord, type ScenarioKey } from './types'

export type CoachChoice = { doctorId: string; scenario: ScenarioKey }

export function useAppDrug() {
  const [drug, setDrug] = useState<ManagedDrug | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api<ManagedDrug[]>('/catalog/drug', { signal: controller.signal })
      .then(rows => { if (!controller.signal.aborted) setDrug(rows.find(isAppDrug) ?? null) })
      .catch(() => { if (!controller.signal.aborted) { setDrug(null); setError('练习药品读取失败，请检查网络后重试。') } })
    return () => controller.abort()
  }, [revision])
  return { drug, error, reload: () => { setError(''); setDrug(undefined); setRevision(value => value + 1) } }
}

export function BpCoach({ choice, onChoice, preset, onPreset, onStart, session }: {
  choice: CoachChoice; onChoice: (value: CoachChoice) => void; preset: TrainingPreset; onPreset: (value: TrainingPreset) => void
  onStart: (drugId: string) => void; session: { title: string; note: string } | null
}) {
  const { doctors } = useBp()
  const { drug, error: drugError, reload: reloadDrug } = useAppDrug()
  const list = useMemo(() => ipDoctors(doctors.data ?? []), [doctors.data])
  const doctor = list.find(row => row.id === choice.doctorId) ?? list[1] ?? list[0]
  const ip = doctor?.ip_profile
  const info = scenarios[choice.scenario]
  return <section className="screen active coach-top" id="coach" aria-label="AI 教练">
    <div className="section-row coach-heading"><h1 className="page-title">AI 教练</h1><a href="#records">练习记录 →</a></div>
    {session ? <a className="coach-doctor" href="#start" style={{ textDecoration: 'none', color: 'inherit' }}><div style={{ flex: 1 }}><strong>{session.title}</strong><small>{session.note}</small></div><span className="chip">返回演练</span></a> : <>
      <Status loading={doctors.loading} error={doctors.error} retry={doctors.reload}>
        {doctor && ip ? <div className="coach-doctor"><img src={ipImage(ip.ip_key)} alt="" /><div style={{ flex: 1 }}><strong>{doctor.name}</strong><small>{ip.style} · 关注{doctor.focus}</small></div>
          <a className="chip" href="#pick" style={{ textDecoration: 'none' }}>更换</a></div> : <p className="sub" style={{ marginTop: 18 }}>暂无已发布的医生 IP，请联系管理员。</p>}
      </Status>
      <div className="coach-settings" id="coachSettings" style={{ textAlign: 'left' }}>
        <div className="soft-card" style={{ marginTop: 12 }}>
          <p className="setting-label">练习重点</p>
          <div className="scenario-grid" role="radiogroup" aria-label="练习重点" aria-describedby="coach-focus-description">{scenarioOrder.map(key =>
            <button key={key} type="button" role="radio" aria-checked={choice.scenario === key} className={`scenario-card ${choice.scenario === key ? 'active' : ''}`} onClick={() => onChoice({ ...choice, scenario: key })}>
              <strong>{scenarios[key].label}</strong><span className="check" aria-hidden="true"><Check size={12} /></span></button>)}</div>
          <p id="coach-focus-description" className="sub coach-focus-description">{info.desc}</p>
          <p className="setting-label">演练方式</p>
          <div role="group" aria-label="演练方式" aria-describedby="coach-mode-description" className="chips">{trainingPresets.map(item => <button key={item.id} type="button" className={`chip ${preset.id === item.id ? 'active' : ''}`} aria-pressed={preset.id === item.id} onClick={() => onPreset(item)}>{item.label}</button>)}</div>
          <p id="coach-mode-description" className="sub">{preset.description}</p>
          <p id="coach-permission" className="sub coach-permission">练习药品：{drug ? drug.name : drug === undefined ? '加载中…' : '暂无可用药品'} · 需麦克风权限</p>
          <button type="button" className="mini-btn coach-start" aria-describedby="coach-permission" disabled={!doctor || !drug} onClick={() => drug && onStart(drug.id)}>开始本轮对话</button>
          {drugError && <div role="alert"><p className="sub">{drugError}</p><button className="mini-btn soft" onClick={reloadDrug}>重新加载药品</button></div>}
          {drug === null && !drugError && <p role="alert" className="sub" style={{ marginTop: 8 }}>暂无已发布的练习药品，暂时不能开始。</p>}
        </div>
        <p className="sub" style={{ marginTop: 16 }}>{info.prompt && `开场参考：${info.prompt}`}</p>
      </div></>}
  </section>
}

export function BpPicker({ onChoose }: { onChoose: (id: string) => void }) {
  const { doctors } = useBp()
  const list = ipDoctors(doctors.data ?? [])
  return <section className="screen active" id="coach-doctor-picker" aria-label="选择医生 IP">
    <Back label="返回 AI 教练" href="#coach" />
    <Topline tag={`${list.length} 类医生 IP`} />
    <h1 className="page-title">选择医生 IP</h1>
    <Status loading={doctors.loading} error={doctors.error} retry={doctors.reload}>
      <div className="doctor-picker-grid">{list.map(row => <button key={row.id} type="button" className="doctor-picker-card" onClick={() => onChoose(row.id)} style={{ padding: 0 }}>
        <img src={ipImage(row.ip_profile!.ip_key)} alt="" /><div className="body"><strong>{row.name}</strong><small>{row.ip_profile!.style}<br />{row.ip_profile!.domain}</small>
          <div className="tag-row" style={{ marginTop: 8 }}>{row.ip_profile!.tags.slice(0, 2).map((tag, i) => <span key={tag} className={`tag ${i ? 'lilac' : 'teal'}`}>{tag}</span>)}</div></div></button>)}</div>
      {list.length === 0 && <p className="sub">暂无已发布的医生 IP。</p>}
    </Status>
  </section>
}

export function BpBrief({ row, onChoose }: { row: DoctorRecord | undefined; onChoose: () => void }) {
  const ip = row?.ip_profile
  return <section className="screen active" id="coach-doctor-detail" aria-label="医生 IP 详情">
    <Back label="选择医生 IP" href="#pick" />
    <Topline tag="培训要点" tone="lilac" />
    {row && ip ? <div className="doctor-detail-panel">
      <div className="doctor-detail-head"><img src={ipImage(ip.ip_key)} alt="" /><div><h3>{row.name}</h3><p>{ip.style}<br />{ip.domain}<br />重点：{row.focus}</p></div></div>
      <div className="tag-row" style={{ marginTop: 12 }}>{ip.tags.map(tag => <span key={tag} className="tag lilac">{tag}</span>)}</div>
      {ip.modules.map(([heading, body]) => <div key={heading} className="doctor-module"><strong>{heading}</strong><small>{body}</small></div>)}
      <div className="btn-row"><button type="button" className="mini-btn" onClick={onChoose}>选择此医生，返回 AI 训练</button></div>
      <div className="detail-callout">医生 IP 是训练角色模型，用于帮助代表理解不同科室的关注点，不代表任何具体医生。</div>
    </div> : <p className="sub">没有找到这个医生 IP。</p>}
  </section>
}
