type WorkerRequest<Input> = {
  id: string
  input: Input
}

type WorkerResponse<Output> = {
  error?: string
  id: string
  result?: Output
}

type PendingWorkerTask = {
  abort?: () => void
  // Aborted while the worker runs it: its result is dropped.
  dropped?: boolean
  input: unknown
  key?: string
  reject: (error: Error) => void
  resolve: (value: unknown) => void
  signal?: AbortSignal
}

const workerClients = new Map<string, WorkerClient>()

// Requests sharing a key keep only the latest: one runs in the worker at a
// time, and a new one replaces the one waiting, which is never run.
export function runWorkerTask<Input, Output>(
  url: URL,
  input: Input,
  signal?: AbortSignal,
  key?: string
) {
  return workerClient(url).request<Input, Output>(input, signal, key)
}

export function workerTaskAborted(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

function workerClient(url: URL) {
  const key = url.href
  const current = workerClients.get(key)
  if (current) return current
  const next = new WorkerClient(key, url)
  workerClients.set(key, next)
  return next
}

class WorkerClient {
  private readonly key: string
  // Posted to the worker, by request id.
  private readonly pending = new Map<string, PendingWorkerTask>()
  // Waiting for the request of the same key to finish, by key.
  private readonly waiting = new Map<string, PendingWorkerTask>()
  private readonly running = new Set<string>()
  private readonly worker: Worker

  constructor(key: string, url: URL) {
    this.key = key
    this.worker = new Worker(url, { type: "module" })
    this.worker.onmessage = ({ data }: MessageEvent<WorkerResponse<unknown>>) =>
      this.resolve(data)
    this.worker.onerror = (event) => this.fail(new Error(event.message))
  }

  request<Input, Output>(input: Input, signal?: AbortSignal, key?: string) {
    return new Promise<Output>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      const task: PendingWorkerTask = {
        input,
        key,
        reject,
        resolve: (value) => resolve(value as Output),
        signal,
      }
      task.abort = () => this.abort(task)
      signal?.addEventListener("abort", task.abort, { once: true })
      if (key && this.running.has(key)) {
        const replaced = this.waiting.get(key)
        this.waiting.set(key, task)
        if (replaced) settle(replaced, () => replaced.reject(abortError()))
        return
      }
      this.post(task)
    })
  }

  private post(task: PendingWorkerTask) {
    const id = crypto.randomUUID()
    this.pending.set(id, task)
    if (task.key) this.running.add(task.key)
    this.worker.postMessage({
      id,
      input: task.input,
    } satisfies WorkerRequest<unknown>)
  }

  private abort(task: PendingWorkerTask) {
    if (task.key && this.waiting.get(task.key) === task)
      this.waiting.delete(task.key)
    else task.dropped = true
    settle(task, () => task.reject(abortError()))
  }

  private resolve(data: WorkerResponse<unknown>) {
    const task = this.pending.get(data.id)
    if (!task) return
    this.pending.delete(data.id)
    if (task.key) {
      this.running.delete(task.key)
      const next = this.waiting.get(task.key)
      this.waiting.delete(task.key)
      if (next) this.post(next)
    }
    if (task.dropped) return
    settle(task, () =>
      data.error
        ? task.reject(new Error(data.error))
        : task.resolve(data.result)
    )
  }

  private fail(error: Error) {
    this.worker.terminate()
    workerClients.delete(this.key)
    for (const task of [...this.pending.values(), ...this.waiting.values()]) {
      if (!task.dropped) settle(task, () => task.reject(error))
    }
    this.pending.clear()
    this.waiting.clear()
    this.running.clear()
  }
}

function settle(task: PendingWorkerTask, finish: () => void) {
  if (task.abort) task.signal?.removeEventListener("abort", task.abort)
  finish()
}

function abortError() {
  return new DOMException("Worker task aborted", "AbortError")
}

export type { WorkerRequest, WorkerResponse }
