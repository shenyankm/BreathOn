import { identity, type User } from './core.ts'

export class Tasks {
  private running = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private closed = false
  start(id: string, user: User, work: (signal: AbortSignal) => Promise<void>) {
    if (this.closed) throw new Error('Service is stopping')
    if (this.running.has(id)) throw new Error('Task already active')
    const controller = new AbortController()
    const promise = Promise.resolve()
      .then(() => identity.run(user, () => work(controller.signal)))
      .catch((error) => {
        console.error(
          JSON.stringify({
            event: 'background_failed',
            error_type: error?.constructor?.name ?? 'Error',
          }),
        )
      })
      .finally(() => this.running.delete(id))
    this.running.set(id, { controller, promise })
  }
  active(id: string) {
    return this.running.has(id)
  }
  async cancel(id: string) {
    const task = this.running.get(id)
    task?.controller.abort()
    await task?.promise
  }
  async close() {
    this.closed = true
    const tasks = [...this.running.values()]
    for (const task of tasks) task.controller.abort()
    await Promise.allSettled(tasks.map((task) => task.promise))
  }
}
