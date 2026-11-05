import type { SecurityAudit } from "@blame/agent-runtime"

type SaveSecurityAudit = (
  projectId: string,
  audit: SecurityAudit
) => Promise<SecurityAudit>

type Persistence = { promise: Promise<SecurityAudit>; sequence: number }

// One save queue per audit for the whole window, so the recorder and the
// audit views never save the same audit twice or out of order.
const persistence = new Map<string, Persistence>()

export function persistSecurityAudit(
  save: SaveSecurityAudit,
  projectId: string,
  audit: SecurityAudit
) {
  if (audit.projectId !== projectId)
    return Promise.reject(
      new Error("Security audit project identity is invalid.")
    )
  const key = `${projectId}:${audit.id}`
  const queued = persistence.get(key)
  if (queued && queued.sequence >= audit.sequence) return queued.promise
  const promise = (queued?.promise ?? Promise.resolve(audit))
    .catch(() => audit)
    .then(() => save(projectId, audit))
  persistence.set(key, { promise, sequence: audit.sequence })
  return promise
}
