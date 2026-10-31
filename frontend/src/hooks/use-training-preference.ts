import { useEffect, useRef, useState } from 'react'
import { loadTrainingPreference, saveTrainingPreference } from '../lib/training-preferences'
import { presetFor, type TrainingPreset } from '../lib/training-setup'

export function useTrainingPreference(account?: string) {
  const [preset, setPreset] = useState<TrainingPreset>(() => presetFor('practice'))
  const [storageError, setStorageError] = useState('')
  const revision = useRef(0)
  const mounted = useRef(false)

  useEffect(() => {
    let cancelled = false
    mounted.current = true
    const initialRevision = revision.current
    if (account) {
      loadTrainingPreference(account).then(value => {
        if (!cancelled && revision.current === initialRevision) setPreset(presetFor(value ?? 'practice'))
      }).catch(() => {
        if (!cancelled && revision.current === initialRevision) setStorageError('无法读取本机练习偏好，本次使用默认选项。')
      })
    }
    return () => { cancelled = true; mounted.current = false }
  }, [account])

  function selectPreset(next: TrainingPreset) {
    const currentRevision = ++revision.current
    setPreset(next)
    setStorageError('')
    if (account) {
      saveTrainingPreference(account, next.experience).catch(() => {
        if (mounted.current && revision.current === currentRevision) {
          setStorageError('练习方式未能保存到本机，当前选择仍可使用。')
        }
      })
    }
  }

  return { preset, selectPreset, storageError }
}
