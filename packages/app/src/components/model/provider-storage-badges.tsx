import type { ProviderCredentialSummary } from "@blame/agent-runtime"

import { SyncBadge } from "@/components/sync-choice"
import { useCloudAuth } from "@/context/cloud-auth"

/**
 * Where a provider's connections are kept: shown only with an account, where
 * there is a choice. A connection to Claude Code lives on this computer by
 * nature and says nothing.
 */
export function ProviderStorageBadges({
  credentials,
}: {
  credentials: ProviderCredentialSummary[]
}) {
  const accountMode = useCloudAuth().mode === "account"
  const kept = credentials.filter(
    (credential) => credential.authMethod !== "local-cli"
  )
  if (!accountMode || !kept.length) return null
  return (
    <span className="ml-2 inline-flex gap-1 align-middle">
      {kept.some((credential) => credential.storage !== "device") ? (
        <SyncBadge mode="account" />
      ) : null}
      {kept.some((credential) => credential.storage === "device") ? (
        <SyncBadge mode="device" />
      ) : null}
    </span>
  )
}
