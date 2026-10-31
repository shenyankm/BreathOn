import { useMemo } from 'react'
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
  useEffect(() => {
    const controller = new AbortController()
    api<ManagedDrug[]>('/catalog/drug', { signal: controller.signal })
      .then(rows => { if (!controller.signal.aborted) setDrug(rows.find(isAppDrug) ?? null) })
      .catch(() => { if (!controller.signal.aborted) setDrug(null) })
    return () => controller.abort()
  }, [])
  return drug
}

/** Coach landing: orb, current doctor IP, scenario cards, 辅助/实战 switch and the start button. */
export function BpCoach({ choice, onChoice, preset, onPreset, onStart, session }: {
  choice: CoachChoice; onChoice: (value: CoachChoice) => void; preset: TrainingPreset; onPreset: (value: TrainingPreset) => void
  onStart: (drugId: string) => void; session: { title: string; note: string } | null
}) {
  const { doctors } = useBp()
  const drug = useAppDrug()
  const list = useMemo(() => ipDoctors(doctors.data ?? []), [doctors.data])
  const doctor = list.find(row => row.id === choice.doctorId) ?? list[1] ?? list[0]
  const ip = doctor?.ip_profile
  const info = scenarios[choice.scenario]
  return <section className="screen active coach-top" id="coach" aria-label="AI 教练">
    <div className="topline" style={{ textAlign: 'left' }}><span className="eyebrow">AI DOCTOR SIMULATION</span><span className="tag orange">LIVE</span></div>
    <div className="orb" aria-hidden="true" />
    <h1>Ready to practice?</h1><p>选择一个医生 IP，开始今天的模拟拜访。</p>
    {session ? <a className="coach-doctor" href="#start" style={{ textDecoration: 'none', color: 'inherit' }}><div style={{ flex: 1 }}><strong>{session.title}</strong><small>{session.note}</small></div><span className="chip">返回演练</span></a> : <>
      <Status loading={doctors.loading} error={doctors.error} retry={doctors.reload}>
        {doctor && ip ? <div className="coach-doctor"><img src={ipImage(ip.ip_key)} alt="" /><div style={{ flex: 1 }}><strong>{doctor.name}</strong><small>{ip.style} · 关注{doctor.focus}</small></div>
          <a className="chip" href="#pick" style={{ textDecoration: 'none' }}>更换</a></div> : <p className="sub" style={{ marginTop: 18 }}>暂无已发布的医生 IP，请联系管理员。</p>}
      </Status>
      <div className="coach-settings" id="coachSettings" style={{ textAlign: 'left' }}>
        <div className="soft-card" style={{ marginTop: 12 }}>
          <p className="setting-label">AI 对话设置</p>
          <div className="scenario-grid" role="radiogroup" aria-label="练习重点">{scenarioOrder.map((key, index) =>
            <button key={key} type="button" role="radio" aria-checked={choice.scenario === key} className={`scenario-card ${choice.scenario === key ? 'active' : ''}`} onClick={() => onChoice({ ...choice, scenario: key })}>
              <span className="scenario-num">{String(index + 1).padStart(2, '0')}</span><span><strong>{scenarios[key].label}</strong><small>{scenarios[key].desc}</small></span><span className="check" aria-hidden="true">✓</span></button>)}</div>
          <div role="group" aria-label="演练方式" className="chips" style={{ marginTop: 12 }}>{trainingPresets.map(item => <button key={item.id} type="button" className={`chip ${preset.id === item.id ? 'active' : ''}`} aria-pressed={preset.id === item.id} onClick={() => onPreset(item)}>{item.label}</button>)}</div>
          <p className="sub" style={{ margin: '0 0 8px' }}>{preset.description}</p>
          <button type="button" className="mini-btn coach-start" style={{ width: '100%', padding: 14, fontSize: 12, borderRadius: 14 }} disabled={!doctor || !drug} onClick={() => drug && onStart(drug.id)}>开始本轮对话</button>
          {drug === null && <p role="alert" className="sub" style={{ marginTop: 8 }}>暂无已发布的练习药品，暂时不能开始。</p>}
          <p className="sub" style={{ marginTop: 8 }}>本轮对话为语音演练，需要麦克风权限；练习药品：{drug ? `${drug.name}（${drug.brand}）` : '加载中…'}。</p>
        </div>
        <div className="section-row"><h2>本轮训练关注</h2><a href="#me" style={{ color: '#8d8d88', fontSize: 10 }}>评分标准 →</a></div>
        <div className="tag-row">{['需求探索', '证据匹配', '合规边界', '推进下一步'].map((tag, index) => <span key={tag} className={`tag ${['teal', 'lilac', 'orange', ''][index]}`}>{tag}</span>)}</div>
        <p className="sub" style={{ marginTop: 10 }}>{info.prompt && `开场参考：${info.prompt}`}</p>
      </div></>}
  </section>
}

export function BpPicker({ onChoose }: { onChoose: (id: string) => void }) {
  const { doctors } = useBp()
  const list = ipDoctors(doctors.data ?? [])
  return <section className="screen active" id="coach-doctor-picker" aria-label="选择医生 IP">
    <Back label="返回 AI 教练" href="#coach" />
    <Topline eyebrow="DOCTOR IP SELECT" tag={`${list.length} 类医生 IP`} />
    <h1 className="page-title">选择医生 IP</h1><p className="sub">选择本轮要训练的医生，先看关注点，再开始对话。</p>
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
    <Back label="七类医生 IP" href="#pick" />
    <Topline eyebrow="DOCTOR IP BRIEF" tag="培训要点" tone="lilac" />
    {row && ip ? <div className="doctor-detail-panel">
      <div className="doctor-detail-head"><img src={ipImage(ip.ip_key)} alt="" /><div><h3>{row.name}</h3><p>{ip.style}<br />{ip.domain}<br />重点：{row.focus}</p></div></div>
      <div className="tag-row" style={{ marginTop: 12 }}>{ip.tags.map(tag => <span key={tag} className="tag lilac">{tag}</span>)}</div>
      {ip.modules.map(([heading, body]) => <div key={heading} className="doctor-module"><strong>{heading}</strong><small>{body}</small></div>)}
      <div className="btn-row"><button type="button" className="mini-btn" onClick={onChoose}>选择此医生，返回 AI 训练</button></div>
      <div className="detail-callout">医生 IP 是训练角色模型，用于帮助代表理解不同科室的关注点，不代表任何具体医生。</div>
    </div> : <p className="sub">没有找到这个医生 IP。</p>}
  </section>
}
