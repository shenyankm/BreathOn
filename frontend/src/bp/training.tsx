import { useState } from 'react'
import { useBp } from './data'
import { levelTone, progressLine } from './logic'
import { Back, Row, Status, Topline } from './parts'
import type { Lesson } from './types'

function PlanItem({ lesson }: { lesson: Lesson }) {
  return <a className="plan-item" href={`#lesson/${lesson.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
    <span className="plan-mark">{lesson.level}</span><span className="plan-copy"><strong>{lesson.title}</strong><small>{lesson.summary}</small></span><span className="plan-arrow" aria-hidden="true">›</span></a>
}

export function BpTraining() {
  const { curriculum, home } = useBp()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const level = home.data?.level
  const streak = home.data?.streak_days
  return <section className="screen active" id="training" aria-label="训练">
    <Topline tag={streak ? `${streak} 天连续练习` : '开始你的第一天'} />
    <h1 className="page-title">能力训练</h1>
    <div className="progress-card">
      <div className="row"><span>当前学习进度</span><b>{level ? `${level.percent}%` : '—'}</b></div>
      <h2>{level ? `${level.level} · ${level.title}` : '正在加载…'}</h2>
      <p>{level ? progressLine(level) : ' '}</p>
      <div className="progress"><i style={{ width: `${level?.percent ?? 0}%` }} /></div>
    </div>
    <Status loading={curriculum.loading} error={curriculum.error} retry={curriculum.reload}>
      <div className="training-plan-panel" id="trainingPlanPanel">
        <div className="section-row"><h2>我的训练计划</h2><span className="tag teal">{curriculum.data?.plan.length ?? 0} 项</span></div>
        {curriculum.data?.plan.length ? curriculum.data.plan.map(item => <PlanItem key={item.id} lesson={item} />) : <div className="training-plan-empty">从课程详情加入训练计划。</div>}
      </div>
      <div className="level-list">
        {curriculum.data?.levels.map(item => {
          // L1 and L2 open their catalogue page; L3 and L4 expand in place, exactly as in the prototype.
          const direct = item.level === 'L1' || item.level === 'L2'
          const expanded = !!open[item.level]
          return <div key={item.level} className={`level-card ${expanded ? 'open' : ''}`}>
            {direct ? <a className="level-head" href={`#level/${item.level}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="level-left"><span className={`level-badge ${levelTone(item.level)}`}>{item.level}</span><div><strong>{item.title}</strong><small>{item.summary}</small></div></div><span className="level-chevron" aria-hidden="true">›</span></a>
              : <button type="button" className="level-head" aria-expanded={expanded} style={{ width: '100%', background: 'transparent', textAlign: 'left' }} onClick={() => setOpen(previous => ({ ...previous, [item.level]: !previous[item.level] }))}>
                <div className="level-left"><span className={`level-badge ${levelTone(item.level)}`}>{item.level}</span><div><strong>{item.title}</strong><small>{item.summary}</small></div></div><span className="level-chevron">{expanded ? '−' : '＋'}</span></button>}
            <div className="level-body">
              {item.lessons.map(lesson => <div key={lesson.id} className="lesson"><div style={{ minWidth: 0, flex: 1 }}><strong>{lesson.title}</strong><small>{lesson.tagline || lesson.summary}</small></div>
                <a className="lesson-go" href={item.level === 'L3' ? '#level/L3' : `#lesson/${lesson.id}`}
                  style={{ background: '#e2fbf5', color: '#168f82', borderRadius: 10, textDecoration: 'none' }}>{item.level === 'L4' ? '开始' : '进入'}</a></div>)}
            </div>
          </div>
        })}
      </div>
    </Status>
  </section>
}

export function BpLevel({ level }: { level: string }) {
  const { curriculum } = useBp()
  const item = curriculum.data?.levels.find(row => row.level === level)
  return <section className="screen active" id="training-level-detail" aria-label={`${level} 课程目录`}>
    <Back label="能力训练" href="#training" />
    <Status loading={curriculum.loading} error={curriculum.error} retry={curriculum.reload}>
      {item ? <><h1 className="page-title">{item.level} · {item.title}</h1><p className="sub">{item.subtitle}</p>
        <div className="mobile-list">{item.lessons.map((lesson, index) => <Row key={lesson.id} index={String(index + 1).padStart(2, '0')} title={lesson.title} note={lesson.summary} href={`#lesson/${lesson.id}`} />)}</div></>
        : <p className="sub">没有找到这个等级。</p>}
    </Status>
  </section>
}
