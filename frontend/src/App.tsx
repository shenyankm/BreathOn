import { practiceTask, voiceStatus } from '@/lib/practice-experience'
import { doctorLabel } from '@/lib/doctor-label'
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, CircleHelp, Info, RotateCcw, ShieldCheck } from 'lucide-react'
import { LoadingBlock } from '@/components/loading-block'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { ScrollArea } from '@/components/ui/scroll-area'
import { groupByMessage } from '@/lib/voice-events'
import { formatTime, drugDetails } from '@/lib/session'
import { TranscriptScrollArea } from '@/components/transcript-scroll-area'
import { restoreScrollPosition } from '@/lib/scroll-position'
import { animatePageTransition } from '@/lib/page-transition'
import { useVoiceSession } from '@/hooks/use-voice-session'
import { useTrainingPreference } from '@/hooks/use-training-preference'
import { api } from '@/lib/platform-api'
import { PracticeStage } from '@/components/practice-stage'
import { presetFor, trainingPresets, type TrainingPreset } from '@/lib/training-setup'
import { BpProvider } from '@/bp/data'
import { BpShell } from '@/bp/shell'
import { BpBack } from '@/bp/back'
import type { Route } from '@/bp/route'
import { parseRoute } from '@/bp/route'
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
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  const page: string = route.page
  const { preset: preferredPreset, selectPreset, storageError } = useTrainingPreference(username)
  const preferredSource = preferredPreset.experience
  const preferredMode = preferredPreset.mode
  const [doctorProfile, setDoctorProfile] = useState<DoctorProfile | null>(null)
  const [doctorError, setDoctorError] = useState('')
  const pageScrollRef = useRef<HTMLDivElement>(null)
  const currentPage = useRef(page)
  const scrollPositions = useRef(new Map<string, number>())

  useLayoutEffect(() => {
    const viewport = pageScrollRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
    const content = pageScrollRef.current?.querySelector('main')
    if (viewport && content) return restoreScrollPosition(viewport, content, scrollPositions.current.get(page) ?? 0)
  }, [page])

  useEffect(() => page === 'start' ? undefined : animatePageTransition(pageScrollRef.current?.querySelector('main') ?? null), [page])

  useEffect(() => {
    function changePage() {
      const next = parseRoute(window.location.hash)
      if (next.page === currentPage.current) { setRoute(next); return }
      const viewport = pageScrollRef.current?.querySelector('[data-slot="scroll-area-viewport"]')
      scrollPositions.current.set(currentPage.current, viewport?.scrollTop ?? 0)
      currentPage.current = next.page
      setRoute(next)
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
  const doctorName = doctorLabel(sessionDoctor?.display_name ?? doctorProfile?.display_name ?? '医生')
  const profileDetails = sessionDoctor ? [['专业背景',sessionDoctor.public_facts||'虚构训练角色'],['训练人群',sessionDoctor.population],['训练关注点',sessionDoctor.focus],['训练交流方式',sessionDoctor.training_style]] : doctorProfile?.details ?? []
  const profileNotice = sessionDoctor ? '依据培训配置构建的 AI 模拟角色，不代表任何真实医生、医院或产品背书；训练方式与情绪均为虚构设定。' : doctorProfile?.disclaimer ?? 'AI 训练模拟，资料加载后可查看专业背景与来源。'

  const [nextMode, setNextMode] = useState('assisted')
  const [review, setReview] = useState(false)
  const [setup, setSetup] = useState(false)
  const scenarioTitleRef = useRef<HTMLHeadingElement>(null)
  const assisted = source !== 'combat' && voice.mode === 'assisted'
  const messages = voice.messages
  const seconds = voice.seconds
  const muted = voice.muted
  const ended = voice.status === 'ended' || voice.status === 'error'
  const active = voice.status === 'active'
  const connecting = voice.status === 'connecting'
  const inSession = active || connecting || voice.saving || voice.analysisStatus === 'thinking'
  const canRestart = ended && voice.saved && !inSession && !voice.retryingSave
  const canRetrySave = ended && !voice.saved && !!voice.sessionId && !inSession
  const unsaved = ended && messages.length > 0 && !voice.saved
  const latestTrainee = voice.messages.findLast(message => message.role === 'trainee')
  const coachIsPrevious = latestTrainee && latestTrainee.id !== voice.coach?.based_on
  const latestMedicalConflict = voice.medicalChecks.findLast(check => check.status === 'contradicted')
  const callStatus = voiceStatus(voice)
  const task = practiceTask(voice.training, voice.freeContext)

  function openSetup() { setNextTraining(({remediation_id: _remediation, ...choice})=>choice); setTrainingReady(false); setNextMode(preferredMode); setNextSource(preferredSource); setSetup(true);window.location.hash='start' }

  function startPractice(choice:TrainingChoice,preset:TrainingPreset) {
    if(inSession)return
    setNextTraining(choice);setNextSource(preset.experience);setNextMode(preset.mode)
    if(unsaved){setTrainingReady(false);setSetup(true);window.location.hash='start';return}
    setSource(preset.experience);selectPreset(preset)
    setReview(false)
    window.location.hash = 'start'
    void voice.start(preset.mode,preset.experience,choice)
  }


  function restart() {
    if(inSession || voice.retryingSave)return
    voice.stop()
    setSource(nextSource)
    const selectedMode = nextSource === 'combat' ? 'independent' : nextTraining.remediation_id ? nextMode : 'assisted'
    selectPreset(presetFor(nextSource, selectedMode))
    if (nextSource === 'practice' || nextSource === 'combat') void voice.start(selectedMode, nextSource, nextTraining)
    setSetup(false)
    setReview(false)
  }

  const coach = <Card className="gap-0 border-0 bg-transparent py-0 shadow-none ring-0">
    <CardContent className="px-1">
      {!assisted ? <div className="flex flex-col items-center justify-center gap-4 py-4 text-center">
        <ShieldCheck className="size-8 text-muted-foreground" />
        <h2 className="font-medium">{source === 'combat' ? '结束后查看 AI 复盘' : '实时提示已关闭'}</h2>
      </div> : <div className="space-y-4" aria-live="polite">
        {voice.practiceState === 'thinking' && <Badge variant="secondary">正在分析本轮回答…</Badge>}
        {voice.coach ? <>
          <Badge variant="outline">{voice.coach.superseded ? '提示待更新' : coachIsPrevious ? '上一轮建议' : '本轮建议'}</Badge>
          <CoachAnalysis coach={voice.coach} />
        </> : <p className="text-sm text-muted-foreground">等待回答…</p>}
        {active && voice.practiceState === 'error' && <Button variant="outline" size="sm" onClick={voice.retryReply}><RotateCcw />重试回复</Button>}
      </div>}
    </CardContent>
  </Card>

  const medicalByMessage = useMemo(() => groupByMessage(voice.medicalChecks), [voice.medicalChecks])
  const policyByMessage = useMemo(() => groupByMessage(voice.policyChecks), [voice.policyChecks])
  const unavailableByMessage = useMemo(() => groupByMessage(voice.policyUnavailable), [voice.policyUnavailable])
  const transcript = useMemo(() => <div className="flex h-full min-h-0 flex-1 flex-col">
    <h2 className="sr-only">对话转录</h2>
    <TranscriptScrollArea messages={messages}>
    <div role="log" aria-label="演练对话转录" aria-live="polite" className="space-y-5 px-1 pb-5 sm:px-4">

      {messages.length === 0 && <p className="py-20 text-center text-sm text-muted-foreground">{connecting ? '连接中…' : '等待对话…'}</p>}
      {messages.map((message, index) => <div key={index} className={`flex w-full ${message.role === 'trainee' ? 'justify-end' : 'justify-start'}`}>
        <div className="min-w-0 max-w-[85%] sm:max-w-[82%]">
          <div className={`mb-1.5 flex items-center gap-2 text-xs ${message.role === 'trainee' ? 'justify-end' : ''}`}><span className="font-medium">{message.role === 'doctor' ? doctorName : '我'}</span><span className="tabular-nums text-muted-foreground">{message.time}</span>{(message.interrupted || message.partial) && <Badge variant="outline">{message.interrupted ? '已打断' : '转录中'}</Badge>}</div>
          <p className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-base leading-7 ${message.role === 'trainee' ? 'rounded-tr-sm bg-primary text-primary-foreground' : 'rounded-tl-sm bg-muted text-foreground'}`}>{message.text}</p>
          {message.role === 'trainee' && (medicalByMessage.get(message.id) ?? []).map(check => <MedicalCheckView key={check.message_id} check={check}/>)}
          {message.role === 'trainee' && (policyByMessage.get(message.id) ?? []).filter(check => voice.mode === 'assisted' || check.risk === 'high').map(check => <Alert key={check.rule_id} className="mt-2"><ShieldCheck /><AlertTitle>疑似合规风险 · 自动初筛</AlertTitle><AlertDescription><p>原话：{check.quote}</p><p>{check.reason}</p><p>{check.policy_title} · {check.article}：{check.policy_quote}</p>{check.source_url && <a href={check.source_url} target="_blank" rel="noreferrer" className="underline">核对政策来源</a>}<p>需要人工复核，不构成违法认定。</p></AlertDescription></Alert>)}
          {message.role === 'trainee' && unavailableByMessage.has(message.id) && <p role="status" className="mt-2 text-sm text-muted-foreground">合规风险初筛暂不可用，本句需要人工核对。</p>}
        </div>
      </div>)}
      {practice && active && voice.practiceState === 'thinking' && <p role="status" className="pb-3 text-sm text-muted-foreground">医生正在回复…</p>}
    </div>
    </TranscriptScrollArea>

  </div>, [messages, doctorName, medicalByMessage, policyByMessage, unavailableByMessage, voice.mode, connecting, practice, active, voice.practiceState])

  const sessionActions = <div className="flex shrink-0 items-center gap-2"><Dialog><DialogTrigger asChild><Button variant="outline" size="lg" className="rounded-full"><BookOpen />练习资料</Button></DialogTrigger><DialogContent className="flex h-[88vh] flex-col overflow-hidden sm:max-w-5xl" onOpenAutoFocus={event => { event.preventDefault(); scenarioTitleRef.current?.focus({ preventScroll: true }) }}>
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
              <section><h3 className="mb-2 font-medium">主要关注点</h3><div className="flex flex-wrap gap-2"><p className="leading-6 text-muted-foreground">{task.focus || profileDetails.find(([label]) => label === '训练关注点')?.[1] || '围绕本轮目标交流。'}</p></div></section>
              <section><h3 className="mb-2 font-medium">训练中的追问方式</h3><p className="leading-6 text-muted-foreground">{task.style || profileDetails.find(([label]) => label === '训练交流方式')?.[1] || '根据当前回答继续提问。'}</p></section>
              <p className="text-xs leading-6 text-muted-foreground">{profileNotice}</p>
              {!sessionDoctor && doctorError && <p role="alert" className="text-sm text-destructive">{doctorError}</p>}
              {(sessionDoctor || doctorProfile) && <section><h3 className="mb-2 font-medium">公开资料来源</h3><ul className="space-y-2">{(sessionDoctor ? sessionDoctor.sources.map(url => ({title:url,url})) : doctorProfile?.sources ?? []).map(item => <li key={item.url}><a href={item.url} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4">{item.title}<span className="sr-only">（新标签页打开）</span></a></li>)}</ul><p className="mt-2 text-xs text-muted-foreground">{sessionDoctor ? '背景来源以本次训练配置为准' : `资料核对：${doctorProfile?.version}`}</p></section>}

            </CardContent>
          </Card>
          {voice.training ? <Card><CardHeader><CardTitle>场景资料</CardTitle></CardHeader><CardContent className="space-y-5"><dl className="space-y-3 text-sm"><div><dt className="text-muted-foreground">产品</dt><dd className="mt-1">{voice.training.scenario.product}</dd></div><div><dt className="text-muted-foreground">疾病／治疗领域</dt><dd className="mt-1">{voice.training.scenario.disease}</dd></div><div><dt className="text-muted-foreground">训练目标</dt><dd className="mt-1 leading-7">{voice.training.scenario.objective}</dd></div></dl><section className="space-y-3"><h3 className="text-sm font-medium">训练资料版本</h3><Button asChild variant="outline"><a href="#library">查看参考资料<BookOpen /></a></Button>{voice.training.documents.length ? voice.training.documents.map(doc => <p key={doc.id} className="text-sm leading-7">{doc.title} · {doc.version_label}</p>) : <p className="text-sm leading-7 text-muted-foreground">本场景未绑定训练资料；医学结论仍需核实。</p>}</section><p className="text-xs leading-6 text-muted-foreground">量表：{voice.training.rubric.name} · {voice.training.rubric.calibration_status === 'calibrated' ? '已校准' : '尚未校准'}</p></CardContent></Card> : voice.freeContext ? <Card><CardHeader><CardTitle>本次自由演练</CardTitle></CardHeader><CardContent className="space-y-4"><dl className="space-y-3"><div><dt className="text-muted-foreground">交流药品</dt><dd className="mt-1 font-medium">{voice.freeContext.drug.name}{voice.freeContext.drug.brand && ` · ${voice.freeContext.drug.brand}`}</dd></div><div><dt className="text-muted-foreground">模拟医生</dt><dd className="mt-1">{doctorName}</dd></div></dl><p className="text-sm leading-7 text-muted-foreground">自由组合不使用场景评分。药品名称仅用于确定交流主题，不构成医生推荐、适应症或医学证据；具体医学陈述需核对有效来源。</p><Button asChild variant="outline"><a href="#library">查看学习资料<BookOpen /></a></Button></CardContent></Card> : <Card>
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
        <section className="rounded-xl border p-4"><h2 className="mb-2 text-sm font-medium">本轮目标 · {task.stage}</h2><p className="text-sm leading-6 text-muted-foreground">{task.objective}</p></section>
        <p className="flex items-center gap-2 text-xs leading-5 text-muted-foreground"><Info className="size-3.5 shrink-0" />请勿输入真实患者信息。</p>
        </div>
        </ScrollArea>
      </DialogContent></Dialog>{canRestart && <Button variant="outline" size="lg" className="rounded-full" onClick={openSetup}><RotateCcw />重新开始</Button>}{canRetrySave && <Button variant="outline" size="lg" className="rounded-full" disabled={voice.retryingSave} onClick={voice.retrySave}><RotateCcw />{voice.retryingSave ? '保存中…' : '重试保存'}</Button>}</div>

  const sessionLine = voice.status === 'idle' ? null : { text: `${unsaved ? '对话尚未保存' : callStatus} · ${formatTime(seconds)}` }
  const pageContent = <BpShell route={route} username={username} onLogout={onLogout} logoutDisabled={inSession || unsaved}
    sessionLine={sessionLine} sessionActive={inSession || unsaved} preferredPreset={preferredPreset} onPreset={selectPreset}
    onStart={(choice: TrainingChoice, preset: TrainingPreset) => startPractice(choice, preset)}
    records={<Suspense fallback={<LoadingBlock label="正在加载复盘记录…" />}><RecordsPage onStart={choice=>{if(inSession){window.location.hash='start';return}setNextTraining(choice);setTrainingReady(false);setNextMode(choice.mode??preferredMode);setNextSource(choice.experience??'practice');setSetup(true);window.location.hash='start'}} /></Suspense>}
    visits={<Suspense fallback={<LoadingBlock label="正在加载拜访日记…" />}><VisitsPage key={username} account={username} /></Suspense>}
    library={<Suspense fallback={<LoadingBlock label="正在加载学习资料…" />}><LibraryPage companyOnly onPractice={choice => { if(inSession){window.location.hash='start';return} setNextTraining({scenario_id:'',stage:'full',...choice});window.location.hash='coach' }} /></Suspense>}
    inSession={inSession} />
  return <BpProvider account={username}><BpBack route={route} /><div className={`bp bp-ambient flex h-svh flex-col pt-[env(safe-area-inset-top)] ${page === 'start' ? 'pb-[env(safe-area-inset-bottom)]' : 'pb-[calc(5.5rem+env(safe-area-inset-bottom))]'}`}>
    <ScrollArea ref={pageScrollRef} className="min-h-0 min-w-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[560px] px-5 py-3 outline-none">
      {storageError && <Alert className="mb-4"><Info /><AlertTitle>本机存储提示</AlertTitle><AlertDescription>{storageError}</AlertDescription></Alert>}
      {page !== 'start' && pageContent}
      {page === 'start' && voice.status === 'idle' && <section className="soft-card space-y-4"><h1 className="text-xl font-semibold">暂无进行中的演练</h1><p className="sub">选择医生和练习重点后，即可开始新的演练。</p><Button asChild><a href="#coach">返回 AI 教练</a></Button></section>}
      {voice.status !== 'idle' && <section hidden={page !== 'start'} className={page !== 'start' ? 'hidden' : undefined}>
      {practice && <div className="mb-3 flex items-center justify-between gap-2"><Button asChild variant="ghost" className="size-12 shrink-0 rounded-full" aria-label="返回练习配置"><a href="#practice"><ArrowLeft aria-hidden="true" /></a></Button>{sessionActions}</div>}
      {practice && voice.error && <Alert className="mb-5" role="alert"><Info /><AlertTitle>语音提示</AlertTitle><AlertDescription>{voice.error}</AlertDescription></Alert>}
      {voice.policyPaused && <Alert className="mb-5" role="alert"><ShieldCheck /><AlertTitle>高风险提示，收音已暂停</AlertTitle><AlertDescription>请查看对话中的原话及政策依据。人工核对后可继续演练。<Button className="mt-3" variant="outline" onClick={voice.resumePolicy}>继续演练</Button></AlertDescription></Alert>}
      {latestMedicalConflict && <Alert className="mb-5 border-destructive/40" role="alert"><Info/><AlertTitle>医学表述需要纠正</AlertTitle><AlertDescription><p>{latestMedicalConflict.statements.find(row => row.correction)?.correction}</p><p>请在对话中核对原话与依据。</p></AlertDescription></Alert>}
      {practice && active && voice.speechState === 'error' && <Button variant="outline" size="sm" className="mb-5" onClick={voice.retrySpeech}><RotateCcw />重试医生朗读</Button>}
      <PracticeStage actions={sessionActions} practice={practice} doctorName={doctorName} seconds={seconds} status={callStatus} error={voice.error} active={active} connecting={connecting} muted={muted} outputMuted={voice.outputMuted} policyPaused={voice.policyPaused} transcript={transcript} coach={coach} onMute={voice.toggleMute} onOutputMute={voice.toggleOutputMute} onInterrupt={voice.interrupt} onEnd={() => { voice.stop(); if (!connecting) setReview(true) }} />

      </section>}
    </main>
    <Dialog open={setup} onOpenChange={setSetup}><DialogContent className="flex h-[min(44rem,calc(100dvh-2rem))] flex-col overflow-hidden"><DialogHeader className="shrink-0"><DialogTitle>开始新的演练</DialogTitle><DialogDescription>{unsaved?'本次对话尚未确认保存。重新开始会清空本页对话，请先确认已保留需要的内容。':nextTraining.remediation_id?'沿用原场景、环节和演练方式。':'确认场景与演练方式。'}</DialogDescription></DialogHeader><ScrollArea className="min-h-0 flex-1"><div className="space-y-3 py-4 pr-4">{!nextTraining.remediation_id&&<><span id="training-preset-label" className="text-sm font-medium">演练方式</span><div role="group" aria-labelledby="training-preset-label" className="grid grid-cols-2 gap-1 rounded-2xl bg-muted p-1">{trainingPresets.map(preset=><Button key={preset.id} type="button" variant={presetFor(nextSource,nextMode).id===preset.id?'default':'ghost'} aria-pressed={presetFor(nextSource,nextMode).id===preset.id} className="h-12 min-w-0 rounded-xl px-2 motion-reduce:transition-none" onClick={()=>{setNextSource(preset.experience);setNextMode(preset.mode)}}>{preset.label}</Button>)}</div></>}{nextTraining.remediation_id&&<p className="text-sm leading-7">本次方式：{nextSource==='combat'?'实战练习':nextMode==='assisted'?'辅助练习':'历史练习（无实时辅助）'}</p>}<ScenarioPicker value={nextTraining} onChange={setNextTraining} onReady={setTrainingReady} /></div></ScrollArea><DialogFooter className="shrink-0"><Button variant="outline" onClick={() => setSetup(false)}>取消</Button><Button disabled={!trainingReady||inSession} onClick={restart}>开始演练<ArrowRight /></Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={review} onOpenChange={setReview}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>演练复盘</DialogTitle><DialogDescription>{assisted ? '实时辅助' : '结束后复盘'} · {formatTime(seconds)} · {practice ? '练习模式' : '实战模式'}</DialogDescription></DialogHeader><ScrollArea className="min-h-0 [&>[data-slot=scroll-area-viewport]]:max-h-[55vh]"><div className="space-y-5 py-2 pr-4"><Alert><CircleHelp /><AlertTitle>{!voice.coach?.superseded && voice.coach?.assessment?.total != null ? '训练评价' : voice.freeContext ? '沟通反馈 · 不评分' : '本次未形成总分'}</AlertTitle><AlertDescription>评价仅覆盖可观察且有依据的内容，医学判断仍需专业复核。</AlertDescription></Alert>{source !== 'combat' && voice.coach && (voice.coach.superseded || !voice.coach.assessment ? <CoachAnalysis coach={voice.coach} review /> : voice.coach.assessment && <AssessmentView assessment={voice.coach.assessment} />)}{source === 'combat' && <section aria-live="polite"><h2 className="mb-4 font-medium">AI 复盘</h2>{voice.analysisStatus === 'thinking' ? <p role="status" className="text-sm text-muted-foreground">正在等待最终转录并整理复盘，请稍候…</p> : voice.coach ? <CoachAnalysis coach={voice.coach} review /> : <p className="text-sm text-muted-foreground">{voice.analysisStatus === 'no_speech' ? '本次没有可分析的学员发言。' : '本次复盘未完成。已保存的对话可从练习记录查看；无需重复录入原话。'}</p>}</section>}<div className="grid grid-cols-2 gap-4 rounded-lg border p-4 text-sm"><div><p className="text-muted-foreground">学员发言</p><p className="mt-2 text-xl font-medium tabular-nums">{messages.filter(message => message.role === 'trainee').length}<span className="text-sm text-muted-foreground"> 次</span></p></div><div><p className="text-muted-foreground">对话记录</p><p className="mt-2 text-xl font-medium tabular-nums">{messages.length}<span className="text-sm text-muted-foreground"> 条</span></p></div></div><p className="text-sm text-muted-foreground">{voice.saved ? <a className="underline underline-offset-4" href={`#records?session=${voice.sessionId}`} onClick={()=>setReview(false)}>查看完整复盘与原话</a> : '对话尚未确认保存，可返回本页查看。'}</p></div></ScrollArea><DialogFooter><Button variant="outline" onClick={() => setReview(false)}><ArrowLeft />返回演练</Button>{canRetrySave && <Button disabled={voice.retryingSave} onClick={voice.retrySave}>{voice.retryingSave ? '保存中…' : '重试保存'}</Button>}</DialogFooter></DialogContent></Dialog>
  </ScrollArea></div></BpProvider>
}

export default App
