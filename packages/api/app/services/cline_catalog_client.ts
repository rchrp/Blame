import type { ModelInfo, ProviderInfo } from '@cline/llms'
import { Worker } from 'node:worker_threads'

export type ClineProviderCatalog = {
  authoritativeModels: boolean
  provider: ProviderInfo
  models: Record<string, ModelInfo>
}

type ClineCatalogRequest =
  { kind: 'catalog' } | { kind: 'live'; url: string; providerIds: string[] }
type ClineCatalogResponse<T> = { ok: true; value: T } | { ok: false; message: string }

export function loadClineProviderCatalog() {
  return runClineCatalogWorker<ClineProviderCatalog[]>({ kind: 'catalog' })
}

export function fetchClineLiveProviderModels(url: string, providerIds: string[]) {
  return runClineCatalogWorker<Record<string, Record<string, ModelInfo>>>({
    kind: 'live',
    url,
    providerIds,
  })
}

function runClineCatalogWorker<T>(request: ClineCatalogRequest) {
  const url = clineCatalogWorkerUrl()
  const worker = new Worker(url, { workerData: request, execArgv: workerExecArguments(url) })
  return workerResult<T>(worker)
}

function clineCatalogWorkerUrl() {
  const extension = new URL(import.meta.url).pathname.endsWith('.ts') ? 'ts' : 'js'
  return new URL(`./cline_catalog_worker.${extension}`, import.meta.url)
}

function workerExecArguments(url: URL) {
  return url.pathname.endsWith('.ts') ? ['--import=@poppinss/ts-exec'] : []
}

function workerResult<T>(worker: Worker) {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    worker.once('message', (response: ClineCatalogResponse<T>) => {
      settled = true
      if (response.ok) resolve(response.value)
      else reject(new Error(response.message))
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Cline catalog worker exited with code ${code}`))
    })
  })
}
