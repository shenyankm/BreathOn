import { HealthObservations } from '@/components/health-observations'
import { useEffect, useState } from 'react'
import { api } from '@/lib/platform-api'
import { isAppDrug } from '@/lib/app-drugs'
import { policyDocuments } from '@/lib/policies'
import { useBp } from './data'
import { ipImage } from './images'
import { ipDoctors } from './logic'
import { Back, Empty, Row, Status, Switch, Topline } from './parts'
import type { Settings } from './types'

const audiences = [
  { icon: '代', title: '医药代表', note: '需要快速找证据、适配医生并推进下一步。', task: '需要快速找到正确证据、匹配医生偏好、推进拜访下一步。', needs: ['疾病线', '医生 IP', '个性化话术', '模拟拜访和复盘'] },
  { icon: '医', title: '医生用户', note: '关注与临床决策有关的证据、终点和可操作性。', task: '关注与临床决策相关的证据，不同科室对终点、案例和负担敏感度不同。', needs: ['科室匹配', '证据透明', '临床可操作性', '患者管理价值'] },
  { icon: '息', title: '健康管理用户', note: '获取代谢反馈，自主选择是否上传数据。', task: '通过项链获取代谢反馈，并自主决定是否上传数据。', needs: ['简单趋势解释', '隐私授权控制', '生活方式建议'] },
]
const modules = [
  { id: 'products', mark: '药', title: '药品', note: '产品与证据' }, { id: 'audiences', mark: '像', title: '用户画像', note: '三类用户' },
  { id: 'policies', mark: '策', title: '政策', note: '合规与授权' }, { id: 'audit', mark: '审', title: '审核队列', note: '发布前审核' },
]
const workspace = [
  ...modules.map(item => ({ href: `#${item.id}`, mark: item.mark, title: { products: '药品', audiences: '用户画像', policies: '政策', audit: '审核队列' }[item.id]!, note: { products: '产品与证据边界', audiences: '代表 / 医生 / 健康用户', policies: '授权与合规内容', audit: '待审核内容' }[item.id]! })),
  { href: '#doctors', mark: '医', title: '医生 IP', note: '科室与沟通偏好' }, { href: '#training', mark: '训', title: '训练内容', note: 'L1-L4 训练路径' },
  { href: '#records', mark: '记', title: '代表记录', note: '训练与拜访复盘' }, { href: '#settings', mark: '设', title: '系统设置', note: '权限与内容版本' },
]
const switches: [keyof Settings, string][] = [['training_reminder', '训练提醒'], ['save_dialogue', '保存模拟对话到代表记录'], ['review_reminder', '接收内容审核提醒']]

export function BpMe({ username, onLogout, logoutDisabled }: { username?: string; onLogout?: () => void; logoutDisabled?: boolean }) {
  const { home, settings, setSetting, notify, doctors } = useBp()
  const [busy, setBusy] = useState('')
  const featured = settings.data?.doctor_recommendation ? ipDoctors(doctors.data ?? [])[2] : undefined
  async function toggle(key: keyof Settings) {
    if (!settings.data) return
    setBusy(key)
    const error = await setSetting({ [key]: !settings.data[key] })
    setBusy('')
    if (error) notify(error)
  }
  return <section className="screen active" id="profile" aria-label="我的">
    <Topline tag={home.data ? `${home.data.level.level} 进行中` : ''} />
    <h1 className="page-title">我的工作台</h1>
    <div className="profile-box">
      {featured ? <img src={ipImage(featured.ip_profile?.ip_key)} alt="" /> : <div className="profile-avatar profile-initials" style={{ width: 58, height: 58 }}>{(username ?? '我').slice(0, 1)}</div>}
      <div><strong>{username || '当前账号'}</strong><small>医药代表{home.data ? ` · ${home.data.streak_days > 0 ? `${home.data.streak_days} 天连续训练` : '尚未开始连续训练'}` : ''}</small>
        <div className="tag-row" style={{ marginTop: 8 }}>{home.data && <span className="tag lilac">{home.data.level.level} 进行中</span>}</div></div>
    </div>
    <div className="section-row"><h2>我的目标用户</h2></div>
    <div className="soft-card" style={{ padding: '0 14px' }}>{[
      { title: '医生用户', note: '按科室和沟通偏好匹配证据', href: '#audiences' }, { title: '健康管理用户', note: '尊重数据授权，不默认上传代谢数据', href: '#audiences' },
      { title: '区域团队', note: '沉淀反馈，形成可复用训练内容', href: '#audit' }].map(item =>
      <a key={item.title} className="record-row" href={item.href} style={{ textDecoration: 'none', color: 'inherit' }}><span><strong>{item.title}</strong><small>{item.note}</small></span><span className="row-end" aria-hidden="true">›</span></a>)}</div>
    <div className="section-row"><h2>设置</h2></div>
    <div className="section-row" style={{ margin: '0 0 10px' }}><h2>网页端同步模块</h2><a href="#workspace" >查看全部 →</a></div>
    <div className="module-grid">{modules.map(item => <a key={item.id} className="module-link" href={`#${item.id}`} style={{ textDecoration: 'none', color: 'inherit' }}><span className="module-icon" aria-hidden="true">{item.mark}</span><strong>{item.title}</strong><small>{item.note}</small></a>)}</div>
    <Status loading={settings.loading} error={settings.error} retry={settings.reload}>
      <div className="settings-list">{switches.map(([key, label]) => <div key={key} className="setting"><span>{label}</span><Switch on={!!settings.data?.[key]} label={label} busy={!!busy} onToggle={() => toggle(key)} /></div>)}</div>
    </Status>
    <div className="mobile-list">
      <Row title="拜访记录" note="录音转写、脱敏与提交" href="#visits" />
      <Row title="练习记录" note="复盘与重练" href="#records" />
    </div>
    {onLogout && <button type="button" className="mini-btn soft" style={{ width: '100%', marginTop: 16, padding: 13 }} disabled={logoutDisabled} onClick={onLogout}>退出登录</button>}
    {logoutDisabled && <p className="sub" style={{ marginTop: 6 }}>演练进行中或尚未保存，暂时不能退出登录。</p>}
  </section>
}

export function BpWorkspace() {
  return <section className="screen active" id="workspace" aria-label="工作台模块">
    <Back label="返回我的工作台" href="#me" />
    <Topline tag="与网页端同步" />
    <h1 className="page-title">工作台模块</h1><p className="sub">把网页端的管理逻辑，压缩成手机端可随时查看的入口。</p>
    <div className="module-grid">{workspace.map(item => <a key={item.title} className="module-link" href={item.href} style={{ textDecoration: 'none', color: 'inherit' }}><span className="module-icon" aria-hidden="true">{item.mark}</span><strong>{item.title}</strong><small>{item.note}</small></a>)}</div>
  </section>
}

type CatalogDrug = { id: string; name: string; brand: string; category: string; status: string; ownership: string }

export function BpProducts({ onOpen }: { onOpen: (id: string) => void }) {
  const [state, setState] = useState<{ rows: CatalogDrug[]; loading: boolean; error: string }>({ rows: [], loading: true, error: '' })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setState(previous => ({ ...previous, loading: true, error: '' }))
    api<CatalogDrug[]>('/catalog/drug', { signal: controller.signal }).then(rows => {
      if (!controller.signal.aborted) setState({ rows: rows.filter(isAppDrug), loading: false, error: '' })
    }).catch(cause => {
      if (!controller.signal.aborted) setState({ rows: [], loading: false, error: cause instanceof Error ? cause.message : '请稍后重试。' })
    })
    return () => controller.abort()
  }, [tick])
  return <section className="screen active" id="products" aria-label="药品与证据">
    <Back label="工作台模块" href="#workspace" />
    <Topline tag={`${state.rows.length} 个产品`} />
    <h1 className="page-title">药品与证据</h1><p className="sub">先选产品，再看对应疾病线、证据类型和说明书原文。</p>
    <Status loading={state.loading} error={state.error} retry={() => setTick(value => value + 1)}>
      {state.rows.length ? <div className="mobile-list">{state.rows.map((drug, index) => <button key={drug.id} type="button" className="product-mini" onClick={() => onOpen(drug.id)}>
        <span className={`product-mark logo-${index % 4}`} aria-hidden="true">{drug.name.slice(0, 1)}</span>
        <span><strong>{drug.name}</strong><small>{drug.brand} · {drug.category}</small></span><span className="row-end" aria-hidden="true">›</span></button>)}</div>
        : <Empty>暂无已发布的药品资料。</Empty>}
    </Status>
    <div className="detail-callout" style={{ marginTop: 14 }}>证据边界：产品信息来自公开说明书与官网，医学判断以最新有效说明书为准；探索性数据不能直接证明药品疗效。</div>
  </section>
}

export function BpAudiences() {
  const [open, setOpen] = useState<number | null>(null)
  return <section className="screen active" id="audiences" aria-label="用户画像">
    <Back label="工作台模块" href="#workspace" />
    <Topline tag="3 类核心用户" />
    <h1 className="page-title">用户画像</h1><p className="sub">同一套系统，服务代表、医生和健康管理用户的不同任务。</p>
    <div className="mobile-list">{audiences.map((item, index) => <button key={item.title} type="button" className="mobile-row" aria-pressed={open === index} onClick={() => setOpen(index)}>
      <span className="row-icon">{item.icon}</span><span className="row-copy"><strong>{item.title}</strong><small>{item.note}</small></span><span className="row-end" aria-hidden="true">›</span></button>)}</div>
    <div className="soft-card" id="personaDetail" style={{ marginTop: 14 }} aria-live="polite">{open === null ? <><strong style={{ fontSize: 12 }}>选择一个用户画像</strong><p className="sub" style={{ marginTop: 6 }}>查看他的核心任务、系统需要提供的能力和评价指标。</p></> :
      <><h3 style={{ margin: 0, fontSize: 14 }}>{audiences[open].title} · 深度画像</h3><p className="sub" style={{ margin: '8px 0' }}>{audiences[open].task}</p><div className="tag-row">{audiences[open].needs.map((need, i) => <span key={need} className={`tag ${i % 2 ? 'lilac' : 'teal'}`}>{need}</span>)}</div></>}</div>
  </section>
}

export function BpPolicies() {
  const [open, setOpen] = useState<number | null>(null)
  return <section className="screen active" id="policies" aria-label="政策与合规">
    <Back label="工作台模块" href="#workspace" />
    <Topline tag="版本管理" />
    <h1 className="page-title">政策与合规</h1><p className="sub">发布前先审核，使用时能找到清晰的边界。</p>
    <div className="mobile-list">{policyDocuments.map((policy, index) => <div key={policy.title}><button type="button" className="mobile-row" style={{ width: '100%' }} aria-expanded={open === index} onClick={() => setOpen(open === index ? null : index)}>
      <span className="row-icon">策</span><span className="row-copy"><strong>{policy.title}</strong><small>{policy.summary}</small></span><span className="policy-status">{policy.level}</span></button>
      {open === index && <div className="detail-callout" style={{ marginTop: 6 }}><b>{policy.source}</b><br />{policy.effectiveDate} · {policy.scope}<br /><a href={policy.url} target="_blank" rel="noopener noreferrer" style={{ color: '#168f82' }}>查看官方原文（新标签页）</a><br />政策摘要仅作学习参考，具体执行请以最新官方文件和所在机构制度为准。</div>}</div>)}</div>
  </section>
}

export function BpAudit() {
  const { queue, doctors } = useBp()
  void doctors
  return <section className="screen active" id="audit" aria-label="审核队列">
    <Back label="工作台模块" href="#workspace" />
    <Topline tag={`${queue.data?.pending ?? 0} 待处理`} tone="orange" />
    <h1 className="page-title">审核队列</h1><p className="sub">你提交的拜访记录与案例的审核进度。内容审核与发布由管理员在网页端处理。</p>
    <Status loading={queue.loading} error={queue.error} retry={queue.reload}>
      {queue.data?.items.length ? <div className="mobile-list">{queue.data.items.map(item => <div key={item.id} className="audit-card">
        <div className="row"><strong>{item.title}</strong><span className={`policy-status ${item.status === 'submitted' ? 'pending' : ''}`}>{item.status_label}</span></div>
        <small>{item.type} · 更新于 {item.updated_at ? new Date(item.updated_at).toLocaleString('zh-CN', { hour12: false }) : '—'}</small>
        <a className="mini-btn soft" href={item.kind === 'visit' ? '#visits' : '#records'} style={{ display: 'inline-block', marginTop: 10, textDecoration: 'none' }}>查看详情</a></div>)}</div>
        : <Empty>你还没有提交过需要审核的内容。在「拜访记录」确认并提交后，进度会显示在这里。</Empty>}
    </Status>
  </section>
}

export function BpSettings() {
  const { settings, setSetting, notify } = useBp()
  const [busy, setBusy] = useState('')
  const rows: [keyof Settings, string][] = [['doctor_recommendation', '医生 IP 推荐'], ['save_dialogue', '保存模拟对话到代表记录'], ['review_reminder', '内容审核提醒'], ['training_reminder', '训练提醒']]
  async function toggle(key: keyof Settings) {
    if (!settings.data) return
    setBusy(key)
    const error = await setSetting({ [key]: !settings.data[key] })
    setBusy('')
    if (error) notify(error)
  }
  return <section className="screen active" id="settings" aria-label="系统设置">
    <Back label="工作台模块" href="#workspace" />

    <h1 className="page-title">系统设置</h1><p className="sub">管理你的提醒、训练记录与推荐偏好。</p>
    <Status loading={settings.loading} error={settings.error} retry={settings.reload}>
      <div className="settings-list">{rows.map(([key, label]) => <div key={key} className="setting"><span>{label}</span><Switch on={!!settings.data?.[key]} label={label} busy={!!busy} onToggle={() => toggle(key)} /></div>)}</div>
    </Status>
    <HealthObservations/>
  </section>
}
