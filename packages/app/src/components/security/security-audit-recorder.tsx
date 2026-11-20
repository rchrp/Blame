import * as React from "react"

import { useCloudAuth } from "@/context/cloud-auth"
import { createCloudApi } from "@/lib/cloud-api"

import { persistSecurityAudit } from "./data/security-audit-persistence"
import { useSecurityAuditRunner } from "./data/use-security-audits"

// Saves every change of a running security audit for its own project,
// whichever page or project is open, including its failure: the runner
// reports a failed audit as a change before the run's promise rejects.
// Live progress (a transient change) is shown, not saved.
export function SecurityAuditRecorder() {
  const auth = useCloudAuth()
  const runner = useSecurityAuditRunner()
  const authenticated = auth.status === "authenticated"
  const cloud = React.useMemo(
    () => createCloudApi(auth.apiConnection),
    [auth.apiConnection]
  )

  React.useEffect(() => {
    if (!runner || !authenticated) return
    return runner.onChanged(({ audit, transient }) => {
      if (transient || !audit.projectId) return
      void persistSecurityAudit(
        cloud.saveSecurityAudit,
        audit.projectId,
        audit
      ).catch(() => undefined)
    })
  }, [authenticated, cloud, runner])
  return null
}
