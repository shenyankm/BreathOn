import { useMemo } from 'react'
import logo from '@/assets/brand/breathon-logo.png'
import { useBp } from './data'
import { deltaText, formatDate, greeting, scoreText } from './logic'
import { ipImage } from './images'
import { ipDoctors } from './logic'

export function BpHome({ username, sessionLine }: { username?: string; sessionLine?: { text: string } | null }) {
  const { home, doctors, curriculum, settings, refresh } = useBp()
  const now = useMemo(() => new Date(), [])
  const strip = useMemo(() => formatDate(now), [now])
  const featured = settings.data?.doctor_recommendation && doctors.data ? ipDoctors(doctors.data)[1] ?? ipDoctors(doctors.data)[0] : undefined
  const h = home.data
  const name = username || '同事'
  return <section className="screen active" id="home" aria-label="首页">
    <div className="topline">
      <div className="brandline"><img className="brandmark" src={logo} alt="" aria-hidden="true" width={40} height={40} /><div><strong>灵息 BREATHON</strong></div></div>
      <a className="profile-avatar profile-initials" href="#me" aria-label="我的账号">{name.slice(0, 1)}</a>
    </div>
    <h1 className="hero-title">{greeting(now)}，<span>{name}</span></h1>
    {sessionLine && <a className="soft-card" href="#start" style={{ display: 'block', marginTop: 14 }}><strong style={{ fontSize: 12 }}>{sessionLine.text}</strong><small className="sub" style={{ display: 'block', marginTop: 4 }}>点击返回演练 ›</small></a>}
    {(home.error || curriculum.error || doctors.error || settings.error) && <div role="alert" className="soft-card"><p className="sub">部分数据读取失败，请检查网络后重试。</p><button className="mini-btn soft" onClick={refresh}>重新加载</button></div>}
    <div className="date-strip" aria-label="日期">{strip.map(item => <div key={item.day} className={`date ${item.active ? 'active' : ''}`}><b>{item.day}</b>{item.week}</div>)}</div>
    <a className="focus-card" href="#doctors" aria-label="今日拜访准备，进入医生 IP">
      <div className="prep-head"><span className="focus-label">今日拜访准备</span><span className="prep-count">3 个环节</span></div>
      <h2>把一次拜访<br />准备完整</h2>
      <div className="prep-steps"><span className="prep-step"><b>01</b>医生 IP</span><span className="prep-step"><b>02</b>核心证据</span><span className="prep-step"><b>03</b>开场问题</span></div>
      <span className="circle-arrow" aria-hidden="true">↗</span>
    </a>
    <div className="section-row"><h2>今日医生 IP</h2><a href="#doctors" >查看全部 →</a></div>
    {featured ? <a className="doctor-mini" href="#doctors" style={{ textDecoration: 'none', color: 'inherit' }}>
      <img src={ipImage(featured.ip_profile?.ip_key)} alt={featured.name} />
      <div style={{ flex: 1 }}><strong>{featured.ip_profile!.dept} · {featured.ip_profile!.role}</strong><small>{featured.ip_profile!.style} · 关注{featured.focus}</small>
        <div className="tag-row"><span className="tag teal">{featured.ip_profile!.tags[0]}</span><span className="tag lilac">{featured.ip_profile!.tags[1]}</span></div></div>
      <span className="task-arrow" aria-hidden="true">›</span>
    </a> : <p className="sub">{settings.data?.doctor_recommendation === false ? '医生推荐已关闭，仍可查看全部医生。' : doctors.loading || settings.loading ? '正在加载…' : doctors.error ? '医生资料暂时无法加载。' : '暂无已发布的医生 IP。'}</p>}
    <div className="metrics">
      <div className="metric"><div className="metric-top">知识掌握度</div>
        <strong>{h ? `${h.mastery_percent}%` : '—'}</strong><small>{curriculum.data ? `已完成 ${curriculum.data.levels.reduce((n, l) => n + l.completed, 0)} / ${curriculum.data.levels.reduce((n, l) => n + l.total, 0)} 个课程` : ' '}</small>
        <div className="progress"><i style={{ width: `${h?.mastery_percent ?? 0}%` }} /></div></div>
      <div className="metric"><div className="metric-top">训练得分</div>
        <strong>{scoreText(h?.latest_score ?? null)}</strong><small>{h?.latest_score === null || !h ? '暂无评分' : deltaText(h.week_delta)}</small>
        <div className="progress"><i style={{ width: `${h?.latest_score ?? 0}%` }} /></div></div>
    </div>
    <div className="section-row"><h2>待完成任务</h2><a href="#training" >进入训练 →</a></div>
    <div className="task-card">
      {h && h.tasks.length ? h.tasks.map((lesson, index) => <a key={lesson.id} className="task" href={`#lesson/${lesson.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
        <span className="task-icon">{String(index + 1).padStart(2, '0')}</span>
        <span className="task-text"><strong>{lesson.title}</strong><small>{lesson.level} · {lesson.tagline || lesson.summary}</small></span><span className="task-arrow" aria-hidden="true">›</span></a>)
        : <p className="training-plan-empty">暂无计划，可从课程详情加入。</p>}
    </div>
  </section>
}
