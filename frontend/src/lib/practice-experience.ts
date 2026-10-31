import { stages, type FreePracticeContext, type TrainingSnapshot } from './catalog-types.ts'

export function practiceTask(training: TrainingSnapshot | null, free: FreePracticeContext | null) {
  return {
    stage: training ? stages[training.stage] ?? training.stage : '自由沟通',
    objective: training?.scenario.objective || (free ? `围绕${free.drug.name}，确认医生需求并回应当前问题。` : '确认医生需求，围绕当前问题展开交流。'),
    focus: free?.doctor.focus || '',
    style: free?.doctor.training_style || '',
  }
}

export function voiceStatus(state: { status: string; saving: boolean; analysisStatus: string; policyPaused: boolean; muted: boolean; playing: boolean; outputMuted: boolean; practiceState: string; speechState: string }) {
  if (state.saving) return state.analysisStatus === 'thinking' ? '正在整理复盘…' : '正在保存记录…'
  if (state.status !== 'active') return ({ idle: '待开始', connecting: '正在连接…', ended: '已结束', error: '连接中断' } as Record<string, string>)[state.status] ?? '待开始'
  if (state.policyPaused) return '收音已暂停'
  if (state.playing) return state.outputMuted ? '医生正在回应 · 声音已关闭' : '医生正在回应'
  if (state.muted) return '麦克风已静音'
  if (state.practiceState === 'error') return '回应未完成，可重试'
  if (state.speechState === 'error') return '朗读未完成，可查看文字或重试'
  if (state.practiceState === 'thinking') return '已收到，正在整理回应'
  return '可以开始说话'
}
