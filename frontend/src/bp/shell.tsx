import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import type { TrainingChoice } from '@/components/scenario-picker'
import type { TrainingPreset } from '@/lib/training-setup'
import type { CoachChoice } from './coach'
import { LoadingBlock } from '@/components/loading-block'
import { useBp } from './data'
import { BpHome } from './home'
import { BpNav } from './nav'
import { ipDoctors } from './logic'
import type { Route } from './route'
import type { ScenarioKey } from './types'

const BpDoctors = lazy(() => import('./doctors').then(module => ({ default: module.BpDoctors })))
const BpL3 = lazy(() => import('./doctors').then(module => ({ default: module.BpL3 })))
const BpLesson = lazy(() => import('./lesson').then(module => ({ default: module.BpLesson })))
const BpAudiences = lazy(() => import('./me').then(module => ({ default: module.BpAudiences })))
const BpAudit = lazy(() => import('./me').then(module => ({ default: module.BpAudit })))
const BpMe = lazy(() => import('./me').then(module => ({ default: module.BpMe })))
const BpPolicies = lazy(() => import('./me').then(module => ({ default: module.BpPolicies })))
const BpProducts = lazy(() => import('./me').then(module => ({ default: module.BpProducts })))
const BpSettings = lazy(() => import('./me').then(module => ({ default: module.BpSettings })))
const BpWorkspace = lazy(() => import('./me').then(module => ({ default: module.BpWorkspace })))
const BpLevel = lazy(() => import('./training').then(module => ({ default: module.BpLevel })))
const BpTraining = lazy(() => import('./training').then(module => ({ default: module.BpTraining })))
const BpCoach = lazy(() => import('./coach').then(module => ({ default: module.BpCoach })))
const BpBrief = lazy(() => import('./coach').then(module => ({ default: module.BpBrief })))
const BpPicker = lazy(() => import('./coach').then(module => ({ default: module.BpPicker })))


type Props = {
  route: Route; username?: string; onLogout?: () => void; logoutDisabled: boolean
  sessionLine: { text: string } | null; sessionActive: boolean; inSession: boolean
  preferredPreset: TrainingPreset; onPreset: (preset: TrainingPreset) => void
  onStart: (choice: TrainingChoice, preset: TrainingPreset) => void
  records: ReactNode; visits: ReactNode; library: ReactNode
}

/** The prototype's page hierarchy, one screen at a time. The live voice session itself lives in App. */
export function BpShell({ route, username, onLogout, logoutDisabled, sessionLine, sessionActive, inSession, preferredPreset, onPreset, onStart, records, visits, library }: Props) {
  const { doctors, notify } = useBp()
  const [choice, setChoice] = useState<CoachChoice>({ doctorId: '', scenario: 'first' })
  const [selected, setSelected] = useState('')
  const list = ipDoctors(doctors.data ?? [])
  // The prototype opens on the breast-surgery role; fall back to the first published role.
  const defaultDoctor = (list[1] ?? list[0])?.id ?? ''
  useEffect(() => { if (!choice.doctorId && defaultDoctor) setChoice(previous => ({ ...previous, doctorId: defaultDoctor })) }, [choice.doctorId, defaultDoctor])

  function begin(drugId: string) {
    if (inSession) { window.location.hash = 'start'; return }
    onStart({ scenario_id: '', stage: 'full', drug_id: drugId, doctor_id: choice.doctorId, focus: choice.scenario }, preferredPreset)
  }
  function practiceLesson(ipId: string, scenario: ScenarioKey) {
    setChoice({ doctorId: ipId, scenario })
    notify('已选择医生与练习重点，请确认后开始')
    window.location.hash = 'coach'
  }
  function pick(id: string) { setChoice(previous => ({ ...previous, doctorId: id })); notify('已选择医生，返回 AI 训练'); window.location.hash = 'coach' }

  let screen: ReactNode
  switch (route.page) {
    case 'home': screen = <BpHome username={username} sessionLine={sessionLine} />; break
    case 'training': screen = <BpTraining />; break
    case 'level': screen = route.level === 'L3' ? <BpL3 onOpen={id => { setSelected(id); window.location.hash = 'doctors' }} /> : <BpLevel level={route.level} />; break
    case 'lesson': screen = <BpLesson id={route.id} onPractice={practiceLesson} />; break
    case 'doctors': screen = <BpDoctors selectedId={selected} onSelect={setSelected} onStart={id => { setChoice(previous => ({ ...previous, doctorId: id })); window.location.hash = 'coach' }} />; break
    case 'coach': screen = <BpCoach choice={choice} onChoice={setChoice} preset={preferredPreset} onPreset={onPreset} onStart={begin}
      session={sessionActive ? { title: '演练进行中', note: sessionLine?.text ?? '返回当前演练' } : null} />; break
    case 'pick': screen = <BpPicker onChoose={id => { setSelected(id); window.location.hash = `brief/${id}` }} />; break
    case 'brief': screen = <BpBrief row={list.find(row => row.id === route.id)} onChoose={() => pick(route.id)} />; break
    case 'me': screen = <BpMe username={username} onLogout={onLogout} logoutDisabled={logoutDisabled} />; break
    case 'workspace': screen = <BpWorkspace />; break
    case 'products': screen = <BpProducts onOpen={() => { window.location.hash = 'library' }} />; break
    case 'library': screen = <><a className="mobile-back" href="#products"><b aria-hidden="true">‹</b>药品与证据</a>{library}</>; break
    case 'audiences': screen = <BpAudiences />; break
    case 'policies': screen = <BpPolicies />; break
    case 'audit': screen = <BpAudit />; break
    case 'settings': screen = <BpSettings />; break
    case 'records': screen = <><a className="mobile-back" href="#me"><b aria-hidden="true">‹</b>我的</a>{records}</>; break
    case 'visits': screen = <><a className="mobile-back" href="#me"><b aria-hidden="true">‹</b>我的</a>{visits}</>; break
    default: screen = null
  }
  return <>
    <Suspense fallback={<LoadingBlock label="正在加载页面…" />}>{screen}</Suspense>
    <BpNav route={route} sessionActive={sessionActive} />
  </>
}
