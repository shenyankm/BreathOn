import { useMemo, useState } from 'react'
import { useBp } from './data'
import { ipImage } from './images'
import { AREAS, filterByArea, ipDoctors } from './logic'
import { Back, Status } from './parts'
import type { DoctorRecord } from './types'

/** L3 doctor IP library: filter chips, 2-column grid, detail card with 开始模拟拜访. */
export function BpDoctors({ selectedId, onSelect, onStart }: { selectedId: string; onSelect: (id: string) => void; onStart: (id: string) => void }) {
  const { doctors, notify } = useBp()
  const [area, setArea] = useState<string>('全部')
  const list = useMemo(() => ipDoctors(doctors.data ?? []), [doctors.data])
  const shown = filterByArea(list, area)
  const current = list.find(row => row.id === selectedId) ?? list[1] ?? list[0]
  return <section className="screen active" id="doctors" aria-label="我的医生 IP">
    <Back label="返回 L3 医生 IP" href="#level/L3" />
    <div className="topline"><button type="button" className="chip" disabled={doctors.loading} onClick={doctors.reload}>刷新医生资料</button></div>
    <h1 className="page-title">我的医生 IP</h1>
    <div className="chips" role="group" aria-label="按领域筛选">{AREAS.map(item => <button key={item} type="button" className={`chip ${area === item ? 'active' : ''}`} aria-pressed={area === item} onClick={() => setArea(item)}>{item}</button>)}</div>
    <Status loading={doctors.loading} error={doctors.error} retry={doctors.reload}>
      {list.length === 0 ? <p className="sub">暂无已发布的医生 IP。</p> : <>
        <div className="doctor-grid" id="doctorGrid">{shown.map(row => <IpCard key={row.id} row={row} active={row.id === current?.id} onPick={() => { onSelect(row.id); requestAnimationFrame(() => document.getElementById('doctorDetail')?.scrollIntoView({ block: 'start', behavior: 'instant' })) }} />)}</div>
        {shown.length === 0 && <p className="sub" style={{ marginTop: 12 }}>这个领域暂时没有医生 IP。</p>}
        {current && <IpDetail row={current} onStart={() => onStart(current.id)} onDraft={async () => { const ip = current.ip_profile!; try { await navigator.clipboard.writeText(`${current.name}\n切入方式：${ip.entry}\n常见追问：${ip.question}\n推荐证据入口：${ip.match}`); notify('已复制沟通要点') } catch { notify('复制失败，请长按沟通要点手动复制') } }} />}
      </>}
    </Status>
  </section>
}

function IpCard({ row, active, onPick }: { row: DoctorRecord; active: boolean; onPick: () => void }) {
  const ip = row.ip_profile!
  return <button type="button" className={`doctor-card ${active ? 'active' : ''}`} onClick={onPick} aria-pressed={active} style={{ padding: 0, textAlign: 'left' }}>
    <img src={ipImage(ip.ip_key)} alt={`${ip.dept}医生 IP 插图`} />
    <div className="body"><strong>{ip.dept}</strong><small>{ip.style}</small>
      <div className="tag-row" style={{ marginTop: 8 }}><span className="tag teal">{ip.area}</span><span className="tag">{ip.tags[0]}</span></div></div>
  </button>
}

function IpDetail({ row, onStart, onDraft }: { row: DoctorRecord; onStart: () => void; onDraft: () => void }) {
  const ip = row.ip_profile!
  return <div className="detail-card" id="doctorDetail">
    <div className="doctor-head"><img src={ipImage(ip.ip_key)} alt="" /><div><h3>{row.name}</h3><p>{ip.role} · {ip.style}<br />关注：{row.focus}</p></div></div>
    <div className="tag-row" style={{ marginTop: 12 }}>{ip.tags.map(tag => <span key={tag} className="tag lilac">{tag}</span>)}</div>
    <div className="quote"><b>切入方式：</b>{ip.entry}<br /><b>常见追问：</b>{ip.question}<br /><b>推荐证据入口：</b>{ip.match}</div>
    <div className="btn-row"><button type="button" className="mini-btn" onClick={onStart}>开始模拟拜访</button><button type="button" className="mini-btn soft" onClick={onDraft}>复制沟通要点</button></div>
    <div className="detail-callout">医生 IP 是训练角色模型，用于帮助代表理解不同科室的关注点，不代表任何具体医生。</div>
  </div>
}

/** L3 catalogue: lesson row plus the seven IP cards; tapping a card opens that role's brief. */
export function BpL3({ onOpen }: { onOpen: (id: string) => void }) {
  const { doctors, curriculum } = useBp()
  const list = ipDoctors(doctors.data ?? [])
  const lesson = curriculum.data?.levels.find(level => level.level === 'L3')?.lessons[0]
  return <section className="screen active" id="training-level-detail" aria-label="L3 课程目录">
    <Back label="能力训练" href="#training" />
    <h1 className="page-title">L3 · 医生 IP 与偏好识别</h1>
    <Status loading={doctors.loading || curriculum.loading} error={doctors.error || curriculum.error} retry={() => { doctors.reload(); curriculum.reload() }}>
      <div className="mobile-list">{lesson && <a className="mobile-row" href={`#lesson/${lesson.id}`}><span className="row-icon">01</span><span className="row-copy"><strong>{lesson.title}</strong><small>{lesson.summary}</small></span><span className="row-end" aria-hidden="true">›</span></a>}</div>
      <div className="section-row"><h2>医生 IP</h2></div>
      <div className="doctor-grid l3-doctor-library">{list.map(row => <IpCard key={row.id} row={row} active={false} onPick={() => onOpen(row.id)} />)}</div>
      {list.length === 0 && <p className="sub">暂无已发布的医生 IP。</p>}
    </Status>
  </section>
}
