import { useState } from 'react'
import { useBp } from './data'
import { findLesson } from './logic'
import { Back, Status, Topline } from './parts'
import { scenarios } from './types'

export function BpLesson({ id, onPractice }: { id: string; onPractice: (ipId: string, scenario: keyof typeof scenarios) => void }) {
  const { curriculum, setLesson, notify } = useBp()
  const [busy, setBusy] = useState(false)
  const lesson = curriculum.data ? findLesson(curriculum.data.levels, id) : undefined
  async function change(state: 'none' | 'planned' | 'completed', message: string) {
    setBusy(true)
    const error = await setLesson(id, state)
    setBusy(false)
    notify(error || message)
  }
  return <section className="screen active" id="training-detail" aria-label="课程详情">
    <Back label={`${lesson?.level ?? 'L1'} 课程目录`} href={`#level/${lesson?.level ?? 'L1'}`} />
    <Topline eyebrow="LESSON DETAIL" tag={lesson?.level} />
    <Status loading={curriculum.loading} error={curriculum.error} retry={curriculum.reload}>
      {lesson ? <div className="training-detail-card">
        <h2>{lesson.title}</h2><p>{lesson.summary}</p>
        {lesson.sections.map(([heading, body]) => <div key={heading} className="detail-point"><strong>{heading}</strong><small>{body}</small></div>)}
        {lesson.unverified_figures && <div className="detail-callout" role="note">此课程中的收入、产品数量与医保覆盖数字来自设计稿，尚未经公司资料核对，请以正式披露资料为准。</div>}
        <div className="detail-callout">完成后会同步到管理后台的训练记录，并更新你的能力进度。</div>
        <div className="btn-row" style={{ display: 'flex', gap: 7, marginTop: 12 }}>
          {lesson.state === 'planned'
            ? <button type="button" className="mini-btn soft" disabled={busy} onClick={() => change('none', '已移出今日训练计划')}>移出今日训练计划</button>
            : lesson.state === 'completed' ? <button type="button" className="mini-btn soft" disabled={busy} onClick={() => change('none', '已取消完成标记')}>已完成 · 点击取消</button>
              : <button type="button" className="mini-btn" disabled={busy} onClick={() => change('planned', '已加入今日训练计划')}>加入今日训练计划</button>}
          {lesson.state !== 'completed' && <button type="button" className="mini-btn soft" disabled={busy} onClick={() => change('completed', '已标记完成')}>标记完成</button>}
        </div>
        {lesson.action?.kind === 'practice' && <button type="button" className="mini-btn" style={{ width: '100%', marginTop: 8 }} onClick={() => onPractice(lesson.action!.kind === 'practice' ? (lesson.action as { ip_id: string }).ip_id : '', (lesson.action as { scenario: keyof typeof scenarios }).scenario)}>开始这个模拟拜访</button>}
        {lesson.action?.kind === 'doctor_ips' && <a className="mini-btn" href="#doctors" style={{ display: 'block', textAlign: 'center', marginTop: 8, textDecoration: 'none' }}>查看七类医生 IP</a>}
      </div> : <p className="sub">没有找到这个课程。</p>}
    </Status>
  </section>
}
