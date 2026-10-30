import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, AudioLines, BookOpen, ChevronRight, CircleHelp, ClipboardList, Clock3, FileText, Info, Mic, MicOff, Phone, PhoneOff, RotateCcw, ShieldCheck, Sparkles, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatTime, drugDetails } from '@/lib/session'
import { useVoiceSession } from '@/hooks/use-voice-session'
import { PracticeHome } from '@/pages/practice-home'
import { MePage } from '@/pages/me-page'
import { api } from '@/lib/platform-api'
import { AppNavigation } from '@/components/app-navigation'
import { presetFor, trainingPresets, type TrainingPreset } from '@/lib/training-setup'
const LibraryPage = lazy(() => import('@/pages/library-page').then(module => ({ default: module.LibraryPage })))
const RecordsPage = lazy(() => import('@/pages/records-page').then(module => ({ default: module.RecordsPage })))
const VisitsPage = lazy(() => import('@/pages/visits-page').then(module => ({ default: module.VisitsPage })))
import { ScenarioPicker, type TrainingChoice } from '@/components/scenario-picker'
import { AssessmentView } from '@/components/assessment-view'
import { CoachAnalysis } from '@/components/coach-analysis'
import { MedicalCheckView } from '@/components/medical-check'
import drugLabelUrl from '@/assets/library/S5LGV8EM_SMS_24mg.pdf?url'

type DoctorProfile = {
  id: string; version: string; display_name: string; specialty: string; disclaimer: string
  details: [string, string][]; sources: { title: string; url: string }[]
}

function App({ onLogout, username }: { onLogout?: () => void; username?: string; role?: 'admin' | 'representative' }) {
  const voice = useVoiceSession()
  const [page, setPage] = useState(() => ['home', 'start', 'library', 'me', 'records', 'visits'].includes(window.location.hash.slice(1).split('?')[0]) ? window.location.hash.slice(1).split('?')[0] : 'home')
  const [preferredSource, setPreferredSource] = useState('practice')
  const [preferredMode, setPreferredMode] = useState('assisted')
  const [doctorProfile, setDoctorProfile] = useState<DoctorProfile | null>(null)
  const [doctorError, setDoctorError] = useState('')
  const pageScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function changePage() {
      const target = window.location.hash.slice(1).split('?')[0]
      setPage(['home', 'start', 'library', 'me', 'records', 'visits'].includes(target) ? target : 'home')
      pageScrollRef.current?.querySelector('[data-slot="scroll-area-viewport"]')?.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', changePage)
    return () => window.removeEventListener('hashchange', changePage)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    api<DoctorProfile>('/doctor', { signal: controller.signal, timeoutMs: 5000 })
      .then(setDoctorProfile)
      .catch(() => { if (!controller.signal.aborted) setDoctorError('医生资料暂时无法加载，请刷新重试。') })
    return () => controller.abort()
  }, [])
  const [source, setSource] = useState('practice')
  const [nextSource, setNextSource] = useState('practice')
  const [nextTraining, setNextTraining] = useState<TrainingChoice>({scenario_id:'',stage:'full'})
  const [trainingReady, setTrainingReady] = useState(false)
  const practice = source === 'practice'
  const sessionDoctor = voice.training?.doctor ?? voice.freeContext?.doctor
  const doctorName = sessionDoctor?.display_name ?? doctorProfile?.display_name ?? '医生（训练模拟）'
  const profileDetails = sessionDoctor ? [['专业背景',sessionDoctor.public_facts||'虚构训练角色'],['训练人群',sessionDoctor.population],['训练关注点',sessionDoctor.focus],['训练交流方式',sessionDoctor.training_style]] : doctorProfile?.details ?? []
  const profileNotice = sessionDoctor ? '依据培训配置构建的 AI 模拟角色，不代表任何真实医生、医院或产品背书；训练方式与情绪均为虚构设定。' : doctorProfile?.disclaimer ?? 'AI 训练模拟，资料加载后可查看专业背景与来源。'

  const [nextMode, setNextMode] = useState('assisted')
  const [review, setReview] = useState(false)
  const [setup, setSetup] = useState(false)
  const [view, setView] = useState('transcript')
  const transcriptRef = useRef<HTMLDivElement>(null)
  const scenarioTitleRef = useRef<HTMLHeadingElement>(null)
  const assisted = source !== 'combat' && voice.mode === 'assisted'
  const messages = voice.messages
  const seconds = voice.seconds
  const muted = voice.muted
  const ended = voice.status === 'ended' || voice.status === 'error'
  const active = voice.status === 'active'
  const connecting = voice.status === 'connecting'
  const inSession = active || connecting || voice.analysisStatus === 'thinking'
  const unsaved = ended && messages.length > 0 && !voice.saved
  const latestTrainee = voice.messages.filter(message => message.role === 'trainee').at(-1)
  const coachIsPrevious = latestTrainee && latestTrainee.id !== voice.coach?.based_on
  const latestMedicalConflict = voice.medicalChecks.findLast(check => check.status === 'contradicted')
  const callStatus = { idle: '待开始', connecting: '连接中', active: '通话中', ended: '已结束', error: '连接失败' }[voice.status]

  function openSetup() { setNextTraining(({remediation_id: _remediation, ...choice})=>choice); setTrainingReady(false); setNextMode(preferredMode); setNextSource(preferredSource); setSetup(true);window.location.hash='start' }

  function startPractice(choice:TrainingChoice,preset:TrainingPreset) {
    if(inSession)return
    setNextTraining(choice);setNextSource(preset.experience);setNextMode(preset.mode)
    if(unsaved){setTrainingReady(false);setSetup(true);window.location.hash='start';return}
    setSource(preset.experience);setPreferredSource(preset.experience);setPreferredMode(preset.mode)
    setReview(false);setView('transcript')
    window.location.hash = 'start'
    void voice.start(preset.mode,preset.experience,choice)
  }

  useEffect(() => {
    const viewport = transcriptRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
    viewport?.scrollTo({ top: viewport.scrollHeight })
  }, [messages])

  function restart() {
    if(inSession)return
    voice.stop()
    setSource(nextSource)
    const selectedMode = nextSource === 'combat' ? 'independent' : nextTraining.remediation_id ? nextMode : 'assisted'
    setPreferredSource(nextSource); setPreferredMode(selectedMode)
    if (nextSource === 'practice' || nextSource === 'combat') void voice.start(selectedMode, nextSource, nextTraining)
    setSetup(false)
    setReview(false)
    setView('transcript')
  }

  const coach = <Card className="h-full">
    <CardHeader>
      <div className="flex items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4" />{source === 'combat' ? '实战复盘' : 'AI 实时教练'}</CardTitle>
        <Badge variant="secondary">{assisted ? '实时辅助' : '结束后复盘'}</Badge>
      </div>
    </CardHeader>
    <CardContent>
      {!assisted ? <div className="flex min-h-80 flex-col items-center justify-center gap-4 text-center">
        <ShieldCheck className="size-8 text-muted-foreground" />
        <h2 className="font-medium">{source === 'combat' ? '结束后查看 AI 复盘' : '实时提示已关闭'}</h2>
      </div> : <div className="min-h-80 space-y-6 py-4" aria-live="polite">
        {voice.practiceState === 'thinking' && <Badge variant="secondary">正在分析本轮回答…</Badge>}
        {voice.coach ? <>
          <Badge variant="outline">{voice.coach.superseded ? '提示待更新' : coachIsPrevious ? '上一轮建议' : '本轮建议'}</Badge>
          <CoachAnalysis coach={voice.coach} />
        </> : <section className="py-6"><h2 className="mb-3 text-sm font-medium">等待你的第一轮回答</h2></section>}
        {active && voice.practiceState === 'error' && <Button variant="outline" size="sm" onClick={voice.retryReply}><RotateCcw />重试医生与教练回复</Button>}
        {voice.training || voice.freeContext ? <Button asChild variant="outline" size="sm"><a href="#library"><BookOpen />查看训练资料</a></Button> : <Button asChild variant="outline" size="sm"><a href={drugLabelUrl} target="_blank" rel="noreferrer"><BookOpen />查看场景资料</a></Button>}
      </div>}
    </CardContent>
  </Card>

  const transcript = <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex items-center justify-between px-6 pb-4 pt-5"><h2 className="flex items-center gap-2 text-sm font-medium"><FileText className="size-4" />对话转录</h2><span className="text-xs text-muted-foreground">{messages.length} 条</span></div>
    <ScrollArea ref={transcriptRef} className="h-80 lg:h-[340px]">
    <div role="log" aria-label="演练对话转录" aria-live="polite" className="space-y-5 px-6 pb-5">

      {messages.length === 0 && <p className="py-20 text-center text-sm text-muted-foreground">{connecting ? '正在建立语音连接…' : practice ? '开始后直接用语音回答医生' : '开始实战后，对话将在这里显示'}</p>}
      {messages.map((message, index) => <div key={index} className={`flex gap-3 ${message.role === 'trainee' ? 'flex-row-reverse' : ''}`}>
        <Avatar className="mt-0.5 size-8 shrink-0"><AvatarFallback>{message.role === 'doctor' ? doctorName.slice(0, 1) : <UserRound className="size-4" />}</AvatarFallback></Avatar>
        <div className="min-w-0 max-w-[85%] sm:max-w-[82%]">
          <div className={`mb-1.5 flex items-center gap-2 text-xs ${message.role === 'trainee' ? 'justify-end' : ''}`}><span className="font-medium">{message.role === 'doctor' ? doctorName : '我'}</span><span className="tabular-nums text-muted-foreground">{message.time}</span>{(message.interrupted || message.partial) && <Badge variant="outline">{message.interrupted ? '已打断' : '转录中'}</Badge>}</div>
          <p className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-7 ${message.role === 'trainee' ? 'rounded-tr-sm bg-primary text-primary-foreground' : 'rounded-tl-sm bg-muted text-foreground'}`}>{message.text}</p>
          {message.role === 'trainee' && voice.medicalChecks.filter(check => check.message_id === message.id).map(check => <MedicalCheckView key={check.message_id} check={check}/>)}
          {message.role === 'trainee' && voice.policyChecks.filter(check => check.message_id === message.id && (voice.mode === 'assisted' || check.risk === 'high')).map(check => <Alert key={check.rule_id} className="mt-2"><ShieldCheck /><AlertTitle>疑似合规风险 · 自动初筛</AlertTitle><AlertDescription><p>原话：{check.quote}</p><p>{check.reason}</p><p>{check.policy_title} · {check.article}：{check.policy_quote}</p>{check.source_url && <a href={check.source_url} target="_blank" rel="noreferrer" className="underline">核对政策来源</a>}<p>需要人工复核，不构成违法认定。</p></AlertDescription></Alert>)}
          {message.role === 'trainee' && voice.policyUnavailable.some(check => check.message_id === message.id) && <p role="status" className="mt-2 text-sm text-muted-foreground">合规风险初筛暂不可用，本句需要人工核对。</p>}
        </div>
      </div>)}
      {practice && active && voice.practiceState === 'thinking' && <p role="status" className="pb-3 text-sm text-muted-foreground">医生正在回复…</p>}
    </div>
    </ScrollArea>
    <div className="mx-6 mb-5 rounded-xl border px-4 py-5 text-sm text-muted-foreground">{active ? muted ? '麦克风已静音' : practice ? '直接回答医生，停顿后医生与教练会回应' : '请直接说话，支持随时打断医生' : practice ? '语音回答 · 医生语音与文字回复 · 实时教练' : '使用麦克风与医生交流'}</div>
  </div>

  return <div className="flex h-svh flex-col bg-muted/30 pb-[calc(4rem+env(safe-area-inset-bottom))] pt-[calc(3.5rem+env(safe-area-inset-top))]">
    <AppNavigation page={page} inSession={inSession}/>
    <ScrollArea ref={pageScrollRef} className="min-h-0 min-w-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[960px] px-4 py-5 outline-none sm:px-6 sm:py-6">
      {['visits', 'records'].includes(page) && <Button asChild variant="ghost" className="mb-4 h-11 px-2"><a href="#me"><ArrowLeft />返回我的</a></Button>}
      {page === 'me' && <MePage username={username} onLogout={onLogout} logoutDisabled={inSession || unsaved}/>}
      {(page === 'home' || page === 'start' && voice.status === 'idle' && !setup) && <PracticeHome initialChoice={nextTraining} initialPreset={presetFor(preferredSource,preferredMode)} sessionState={voice.analysisStatus==='thinking'?'thinking':active?'active':connecting?'connecting':''} seconds={seconds} onStart={startPractice} onChoiceChange={setNextTraining} onPresetChange={preset=>{setPreferredSource(preset.experience);setPreferredMode(preset.mode)}}/>}
      {page === 'library' && <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">正在加载学习资料…</p>}><LibraryPage /></Suspense>}
      {page === 'visits' && <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">正在加载拜访日记…</p>}><VisitsPage /></Suspense>}
      {page === 'records' && <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">正在加载复盘记录…</p>}><RecordsPage onStart={choice=>{if(inSession){window.location.hash='start';return}setNextTraining(choice);setTrainingReady(false);setNextMode(choice.mode??preferredMode);setNextSource(choice.experience??'practice');setSetup(true);window.location.hash='start'}} /></Suspense>}
      <section hidden={page !== 'start' || voice.status === 'idle'}>
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"><span>学术拜访演练</span><ChevronRight className="size-3" /><span>{voice.training?.scenario.disease ?? (voice.freeContext?.drug.name || '成人体重管理')}</span></div><h1 className="text-2xl font-semibold tracking-tight">{voice.training?.scenario.title ?? (voice.freeContext ? `${voice.freeContext.drug.name} · 自由演练` : '研究证据的有效沟通')}</h1></div><div className="flex shrink-0 items-center gap-2"><Dialog><DialogTrigger asChild><Button variant="outline" className="h-11 sm:h-8"><ClipboardList />场景说明</Button></DialogTrigger><DialogContent className="flex h-[88vh] flex-col overflow-hidden sm:max-w-5xl" onOpenAutoFocus={event => { event.preventDefault(); scenarioTitleRef.current?.focus({ preventScroll: true }) }}>
        <DialogHeader className="shrink-0"><DialogTitle ref={scenarioTitleRef} tabIndex={-1} className="outline-none">{voice.training?.scenario.title ?? (voice.freeContext ? `${voice.freeContext.drug.name} · 自由演练` : '研究证据的有效沟通')}</DialogTitle><DialogDescription>{voice.freeContext ? `${doctorName} · 自由组合 · 不评分` : voice.training ? `${voice.training.scenario.disease} · 建议 ${Math.round(voice.training.scenario.duration_seconds / 60)} 分钟` : '成人体重管理 · 基础难度 · 建议 5 分钟'}</DialogDescription></DialogHeader>
        <ScrollArea className="min-h-0 flex-1" >
        <div className="space-y-6 pr-4">
        <div className="grid grid-cols-1 items-start gap-6 py-2 text-sm lg:grid-cols-2">
          <Card>
            <CardHeader><div className="flex items-center justify-between gap-3"><CardTitle>医生画像</CardTitle><Badge variant="secondary">AI 训练角色</Badge></div></CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center gap-3"><Avatar className="size-12"><AvatarFallback>{doctorName.slice(0, 1)}</AvatarFallback></Avatar><div><h2 className="font-medium">{doctorName}</h2></div></div>
              <dl className="space-y-3">{profileDetails.map(([label, value]) => <div key={label} className="grid grid-cols-[88px_1fr] gap-3 leading-6"><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}</dl>
              <Separator />
              <section><h3 className="mb-2 font-medium">主要关注点</h3><div className="flex flex-wrap gap-2">{['研究设计', '适用人群', '安全性', '证据局限'].map(point => <Badge variant="outline" key={point}>{point}</Badge>)}</div></section>
              <section><h3 className="mb-2 font-medium">训练中的追问方式</h3><p className="leading-6 text-muted-foreground">先回应当前问题，再用具体资料解释。不接受把研究平均结果当作个体保证，或把跨研究比较说成直接比较。</p></section>
              <p className="text-xs leading-6 text-muted-foreground">{profileNotice}</p>
              {!sessionDoctor && doctorError && <p role="alert" className="text-sm text-destructive">{doctorError}</p>}
              {(sessionDoctor || doctorProfile) && <section><h3 className="mb-2 font-medium">公开资料来源</h3><ul className="space-y-2">{(sessionDoctor ? sessionDoctor.sources.map(url => ({title:url,url})) : doctorProfile?.sources ?? []).map(item => <li key={item.url}><a href={item.url} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4">{item.title}<span className="sr-only">（新标签页打开）</span></a></li>)}</ul><p className="mt-2 text-xs text-muted-foreground">{sessionDoctor ? '背景来源以本次训练配置为准' : `资料核对：${doctorProfile?.version}`}</p></section>}

            </CardContent>
          </Card>
          {voice.training ? <Card><CardHeader><CardTitle>场景资料</CardTitle></CardHeader><CardContent className="space-y-5"><dl className="space-y-3 text-sm"><div><dt className="text-muted-foreground">产品</dt><dd className="mt-1">{voice.training.scenario.product}</dd></div><div><dt className="text-muted-foreground">疾病／治疗领域</dt><dd className="mt-1">{voice.training.scenario.disease}</dd></div><div><dt className="text-muted-foreground">训练目标</dt><dd className="mt-1 leading-7">{voice.training.scenario.objective}</dd></div></dl><section className="space-y-3"><h3 className="text-sm font-medium">训练资料版本</h3>{voice.training.documents.length ? voice.training.documents.map(doc => <p key={doc.id} className="text-sm leading-7">{doc.title} · {doc.version_label}</p>) : <p className="text-sm leading-7 text-muted-foreground">本场景未绑定训练资料；医学结论仍需核实。</p>}</section><p className="text-xs leading-6 text-muted-foreground">量表：{voice.training.rubric.name} · {voice.training.rubric.calibration_status === 'calibrated' ? '已校准' : '尚未校准'}</p></CardContent></Card> : voice.freeContext ? <Card><CardHeader><CardTitle>本次自由演练</CardTitle></CardHeader><CardContent className="space-y-4"><dl className="space-y-3"><div><dt className="text-muted-foreground">交流药品</dt><dd className="mt-1 font-medium">{voice.freeContext.drug.name}{voice.freeContext.drug.brand && ` · ${voice.freeContext.drug.brand}`}</dd></div><div><dt className="text-muted-foreground">模拟医生</dt><dd className="mt-1">{doctorName}</dd></div></dl><p className="text-sm leading-7 text-muted-foreground">自由组合不使用场景评分。药品名称仅用于确定交流主题，不构成医生推荐、适应症或医学证据；具体医学陈述需核对有效来源。</p><Button asChild variant="outline" className="h-11"><a href="#library">查看学习资料<BookOpen /></a></Button></CardContent></Card> : <Card>
            <CardHeader><div className="flex items-center justify-between gap-3"><CardTitle>药品信息</CardTitle><Badge variant="outline">说明书摘录</Badge></div></CardHeader>
            <CardContent className="space-y-5">
              <dl className="space-y-3">{drugDetails.map(([label, value]) => <div key={label} className="grid grid-cols-[104px_1fr] gap-3 leading-6"><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}</dl>
              <Separator />
              <section><h3 className="mb-2 font-medium">本轮适用范围</h3><p className="leading-6">在控制饮食和增加体力活动基础上，用于成人长期体重控制：初始 BMI ≥ 28 kg/m²；或 BMI ≥ 24 kg/m²，并伴至少一种体重相关合并症。</p><p className="mt-2 text-xs leading-5 text-muted-foreground">来源：项目说明书第 2 页。文件另列成人 2 型糖尿病血糖控制，本轮不展开该训练范围。</p></section>
              <Accordion type="single" collapsible>
                <AccordionItem value="evidence"><AccordionTrigger>研究讨论线索</AccordionTrigger><AccordionContent><p className="leading-6">GLORY-1 为一项随机、双盲、安慰剂对照的 III 期研究，共纳入 610 例患者，研究期为 48 周。交流时应说明研究人群、主要终点和局限，而非只报疗效数字。</p><p className="mt-2 text-xs text-muted-foreground">来源：项目说明书第 17 页。</p></AccordionContent></AccordionItem>
                <AccordionItem value="safety"><AccordionTrigger>重要安全信息摘要</AccordionTrigger><AccordionContent className="space-y-3 leading-6"><p>常见不良反应包括恶心、腹泻、呕吐等胃肠道反应。</p><p>存在甲状腺 C 细胞肿瘤风险警告；啮齿类动物中的发现与人类的相关性尚未确定。</p><p>对活性成份或辅料过敏者、有甲状腺髓样癌（MTC）个人或家族史者、MEN 2 患者禁用；妊娠期及哺乳期禁用。</p><p className="text-xs text-muted-foreground">仅为摘要，不涵盖所有风险。完整禁忌、注意事项及特殊人群信息见原文第 1、5、11—14 页。</p></AccordionContent></AccordionItem>
              </Accordion>
              <div className="rounded-xl bg-muted/50 p-3"><div className="mb-2 flex items-center justify-between gap-2"><span className="text-xs font-medium">项目资料 · 版本待确认</span><Button asChild variant="link" size="sm" className="h-auto p-0 text-xs"><a href={drugLabelUrl} target="_blank" rel="noreferrer">查看说明书<BookOpen /></a></Button></div><p className="text-xs leading-5 text-muted-foreground">文件修订日期含占位文本。当前仅供原型训练参考，正式培训前需医学审核确认版本。</p></div>
            </CardContent>
          </Card>}
        </div>
        <section className="rounded-xl border p-4"><h2 className="mb-2 text-sm font-medium">本轮目标</h2><p className="text-sm leading-6 text-muted-foreground">识别医生关注点，用“研究人群 → 设计与终点 → 结果与局限”的顺序回应，平衡交流获益与风险；资料不足时明确说明并安排核实。</p></section>
        <p className="flex items-center gap-2 text-xs leading-5 text-muted-foreground"><Info className="size-3.5 shrink-0" />请勿输入真实患者信息。</p>
        </div>
        </ScrollArea>
      </DialogContent></Dialog><Button variant="outline" className="h-11 sm:h-8" onClick={openSetup}><RotateCcw />重新开始</Button></div></div>
      {voice.error && <Alert className="mb-5" role="alert"><Info /><AlertTitle>语音提示</AlertTitle><AlertDescription>{voice.error}</AlertDescription></Alert>}
      {voice.policyPaused && <Alert className="mb-5" role="alert"><ShieldCheck /><AlertTitle>高风险提示，收音已暂停</AlertTitle><AlertDescription>请查看对话中的原话及政策依据。人工核对后可继续演练。<Button className="mt-3" variant="outline" onClick={voice.resumePolicy}>继续演练</Button></AlertDescription></Alert>}
      {latestMedicalConflict && <Alert className="mb-5 border-destructive/40" role="alert"><Info/><AlertTitle>医学表述需要纠正</AlertTitle><AlertDescription><p>{latestMedicalConflict.statements.find(row => row.correction)?.correction}</p><Button variant="outline" size="sm" onClick={() => setView('transcript')}>查看原话与依据</Button></AlertDescription></Alert>}
      {practice && active && voice.speechState === 'error' && <Button variant="outline" size="sm" className="mb-5" onClick={voice.retrySpeech}><RotateCcw />重试医生朗读</Button>}
      {/* The canvas divides 7:5 after one 24px gutter; both cards share the same outer edges. */}
      <Tabs value={view} onValueChange={setView}>
      <div className="grid items-stretch gap-6 lg:grid-cols-[7fr_5fr]">
        <Card className="min-w-0 gap-0 overflow-hidden">
          <CardHeader className="pb-5"><div className="flex items-center justify-between gap-2"><CardTitle className="flex items-center gap-2 text-base"><Phone className="size-4" />{practice ? '学术对话练习' : '电话演练'}</CardTitle><Badge variant={active ? 'secondary' : 'outline'}><span className={`size-1.5 rounded-full ${active ? 'bg-emerald-600' : 'bg-muted-foreground'}`} />{callStatus}</Badge></div></CardHeader>
          <CardContent className="pb-6"><div className="flex items-center gap-4"><Avatar className="size-16"><AvatarFallback className="text-xl">{doctorName.slice(0, 1)}</AvatarFallback></Avatar><div className="flex-1"><h2 className="font-semibold">{doctorName}</h2><p className="mt-1 text-sm text-muted-foreground">{sessionDoctor?.specialty ?? '内分泌科'} · AI 训练角色</p><div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="size-3.5" /><span className="tabular-nums" aria-label="通话时长">{formatTime(seconds)}</span><span> / 建议 {formatTime(voice.training?.scenario.duration_seconds ?? 300)}</span></div></div><AudioLines className="size-8 text-muted-foreground" /></div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span role="status" className="text-xs text-muted-foreground">{active ? practice && voice.speechState === 'speaking' ? '医生正在朗读…' : muted ? '已静音' : '麦克风已连接' : connecting ? '正在连接…' : practice ? '语音对练 · 医生会朗读回复' : '豆包全双工语音'}</span><div className="flex gap-2">
              {!practice && active && <Button variant="outline" size="sm" onClick={voice.interrupt}>打断</Button>}
              <Button variant="outline" size="sm" disabled={!active || voice.policyPaused} aria-pressed={muted} onClick={voice.toggleMute}>{muted ? <MicOff /> : <Mic />}{muted ? '取消静音' : '静音'}</Button>
              {!active && !connecting && <Button size="sm" onClick={openSetup}><Phone />开始演练</Button>}
              {connecting && <Button variant="outline" size="sm" onClick={voice.stop}>取消连接</Button>}
              {(active || ended) && <Button variant={active ? 'destructive' : 'outline'} size="sm" onClick={() => { voice.stop(); setReview(true) }}>{active ? <PhoneOff /> : <FileText />}{active ? '结束演练' : '查看复盘'}</Button>}
            </div></div>
          </CardContent>
          <Separator />
          <TabsList className="mx-6 mt-5 mb-1 grid w-auto grid-cols-2 group-data-horizontal/tabs:h-14 sm:group-data-horizontal/tabs:h-8 lg:hidden"><TabsTrigger value="transcript">对话转录</TabsTrigger><TabsTrigger value="coach">AI 教练</TabsTrigger></TabsList>
          <TabsContent value="transcript" forceMount className={`min-h-0 flex-1 flex-col lg:flex ${view === 'transcript' ? 'flex' : 'hidden'}`}>{transcript}</TabsContent>
        </Card>
        <TabsContent value="coach" forceMount className={`min-w-0 lg:block ${view === 'coach' ? 'block' : 'hidden'}`}>{coach}</TabsContent>
      </div>
      </Tabs>
      </section>
    </main>
    <Dialog open={setup} onOpenChange={setSetup}><DialogContent><DialogHeader><DialogTitle>开始新的演练</DialogTitle><DialogDescription>{unsaved?'本次对话尚未确认保存。重新开始会清空本页对话，请先确认已保留需要的内容。':nextTraining.remediation_id?'沿用原场景、环节和演练方式。':'确认场景与演练方式。'}</DialogDescription></DialogHeader><ScrollArea className="min-h-0 [&>[data-slot=scroll-area-viewport]]:max-h-[55vh]"><div className="space-y-3 py-4 pr-4">{!nextTraining.remediation_id&&<><label htmlFor="training-preset" className="text-sm font-medium">演练方式</label><Select value={presetFor(nextSource,nextMode).id} onValueChange={id=>{const preset=trainingPresets.find(option=>option.id===id);if(preset){setNextSource(preset.experience);setNextMode(preset.mode)}}}><SelectTrigger id="training-preset" className="w-full"><SelectValue/></SelectTrigger><SelectContent>{trainingPresets.map(preset=><SelectItem value={preset.id} key={preset.id}>{preset.label}</SelectItem>)}</SelectContent></Select><p className="text-sm leading-7 text-muted-foreground">{presetFor(nextSource,nextMode).description}</p></>}{nextTraining.remediation_id&&<p className="text-sm leading-7">本次方式：{nextSource==='combat'?'实战练习':nextMode==='assisted'?'辅助练习':'历史练习（无实时辅助）'}</p>}<ScenarioPicker value={nextTraining} onChange={setNextTraining} onReady={setTrainingReady} /></div></ScrollArea><DialogFooter><Button variant="outline" onClick={() => setSetup(false)}>取消</Button><Button disabled={!trainingReady||inSession} onClick={restart}>开始演练<ArrowRight /></Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={review} onOpenChange={setReview}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>演练复盘</DialogTitle><DialogDescription>{assisted ? '实时辅助' : '结束后复盘'} · {formatTime(seconds)} · {practice ? '练习模式' : '实战模式'}</DialogDescription></DialogHeader><ScrollArea className="min-h-0 [&>[data-slot=scroll-area-viewport]]:max-h-[55vh]"><div className="space-y-5 py-2 pr-4"><Alert><CircleHelp /><AlertTitle>{!voice.coach?.superseded && voice.coach?.assessment?.total != null ? '训练评价' : '本次未形成总分'}</AlertTitle><AlertDescription>评价仅覆盖可观察且有依据的内容，医学判断仍需专业复核。</AlertDescription></Alert><div className="grid grid-cols-2 gap-4 rounded-lg border p-4 text-sm"><div><p className="text-muted-foreground">学员发言</p><p className="mt-2 text-xl font-medium tabular-nums">{messages.filter(message => message.role === 'trainee').length}<span className="text-sm text-muted-foreground"> 次</span></p></div><div><p className="text-muted-foreground">对话记录</p><p className="mt-2 text-xl font-medium tabular-nums">{messages.length}<span className="text-sm text-muted-foreground"> 条</span></p></div></div>{source !== 'combat' && voice.coach && (voice.coach.superseded || !voice.coach.assessment ? <CoachAnalysis coach={voice.coach} review /> : voice.coach.assessment && <AssessmentView assessment={voice.coach.assessment} />)}{source === 'combat' && <section aria-live="polite"><h2 className="mb-4 font-medium">AI 复盘</h2>{voice.analysisStatus === 'thinking' ? <p role="status" className="text-sm text-muted-foreground">正在等待最终转录并整理复盘，请稍候…</p> : voice.coach ? <CoachAnalysis coach={voice.coach} review /> : <p className="text-sm text-muted-foreground">{voice.analysisStatus === 'no_speech' ? '本次没有可分析的学员发言。' : '本次复盘未完成。对话保存状态见下方；请保留原文后重新演练。'}</p>}</section>}<p className="text-sm text-muted-foreground">{voice.saved ? <a className="underline underline-offset-4" href={`#records?session=${voice.sessionId}`} onClick={()=>setReview(false)}>查看完整复盘与原话</a> : '对话尚未确认保存，可返回本页查看。'}</p></div></ScrollArea><DialogFooter><Button variant="outline" onClick={() => setReview(false)}><ArrowLeft />返回演练</Button><Button disabled={inSession} onClick={() => { setReview(false); openSetup() }}><RotateCcw />再练一次</Button></DialogFooter></DialogContent></Dialog>
  </ScrollArea></div>
}

export default App
