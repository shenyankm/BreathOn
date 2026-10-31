import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@/lib/platform-api'
import type { Curriculum, DoctorRecord, Home, Queue, Settings } from './types'

type Load<T> = { data: T | null; loading: boolean; error: string }
const empty = { data: null, loading: true, error: '' }

function useLoad<T>(path: string, version: number): Load<T> & { reload: () => void } {
  const [state, setState] = useState<Load<T>>(empty)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    // Keep the previous data on screen during a refresh; only the very first load shows the loading state.
    setState(previous => previous.data ? { ...previous, error: '' } : { ...previous, loading: true, error: '' })
    api<T>(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ data, loading: false, error: '' })
    }).catch(cause => {
      if (!controller.signal.aborted) setState({ data: null, loading: false, error: cause instanceof Error ? cause.message : '请稍后重试。' })
    })
    return () => controller.abort()
  }, [path, tick, version])
  return { ...state, reload: useCallback(() => setTick(value => value + 1), []) }
}

type Store = {
  home: ReturnType<typeof useLoad<Home>>
  curriculum: ReturnType<typeof useLoad<Curriculum>>
  doctors: ReturnType<typeof useLoad<DoctorRecord[]>>
  settings: ReturnType<typeof useLoad<Settings>>
  queue: ReturnType<typeof useLoad<Queue>>
  refresh: () => void
  setLesson: (id: string, state: 'none' | 'planned' | 'completed') => Promise<string>
  setSetting: (patch: Partial<Settings>) => Promise<string>
  toast: string
  notify: (message: string) => void
}

const Context = createContext<Store | null>(null)
export function useBp() {
  const value = useContext(Context)
  if (!value) throw new Error('BpProvider is missing')
  return value
}

export function BpProvider({ children, account }: { children: ReactNode; account?: string }) {
  // Keyed by account: a different account remounts the store, so no cached data can carry over.
  return <BpStore key={account ?? ''}>{children}</BpStore>
}

function BpStore({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0)
  const home = useLoad<Home>('/home', version)
  const curriculum = useLoad<Curriculum>('/curriculum', version)
  const doctors = useLoad<DoctorRecord[]>('/catalog/doctor', version)
  const settings = useLoad<Settings>('/me/settings', version)
  const queue = useLoad<Queue>('/me/review-queue', version)
  const [toast, setToast] = useState('')
  const timer = useRef<number>(0)
  const notify = useCallback((message: string) => {
    setToast(message)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(''), 2100)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const refresh = useCallback(() => setVersion(value => value + 1), [])
  const setLesson = useCallback(async (id: string, state: 'none' | 'planned' | 'completed') => {
    try {
      await api<Curriculum>(`/curriculum/lessons/${id}`, { method: 'PUT', body: JSON.stringify({ state }) })
      setVersion(value => value + 1)
      return ''
    } catch (cause) { return cause instanceof Error ? cause.message : '保存失败，请重试。' }
  }, [])
  const setSetting = useCallback(async (patch: Partial<Settings>) => {
    try {
      await api<Settings>('/me/settings', { method: 'PUT', body: JSON.stringify(patch) })
      setVersion(value => value + 1)
      return ''
    } catch (cause) { return cause instanceof Error ? cause.message : '保存失败，请重试。' }
  }, [])
  const value = useMemo(() => ({ home, curriculum, doctors, settings, queue, refresh, setLesson, setSetting, toast, notify }),
    [home, curriculum, doctors, settings, queue, refresh, setLesson, setSetting, toast, notify])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
