import * as React from "react"

import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { createCloudApi } from "@/lib/cloud-api"

import { persistSecurityAudit } from "./data/security-audit-persistence"

// Saves every change of a running security audit for its own project,
// whichever page or project is open, including its failure: the desktop
// reports a failed audit as a change before the run's promise rejects.
export function SecurityAuditRecorder() {
  const auth = useCloudAuth()
  const runner = usePlatform().securityAudits
  const authenticated = auth.status === "authenticated"
  const cloud = React.useMemo(
    () => createCloudApi(auth.apiConnection),
    [auth.apiConnection]
  )

  React.useEffect(() => {
    if (!runner || !authenticated) return
    return runner.onChanged(({ audit }) => {
      if (!audit.projectId) return
      void persistSecurityAudit(
        cloud.saveSecurityAudit,
        audit.projectId,
        audit
      ).catch(() => undefined)
    })
  }, [authenticated, cloud, runner])
  return null
}
