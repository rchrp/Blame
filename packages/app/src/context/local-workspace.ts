import type { ApiConnection } from "@blame/agent-runtime"

type WorkspaceRow = Record<string, unknown>

type WorkspaceBundle = {
  format: "blame-workspace"
  version: 1
  tables: Record<string, WorkspaceRow[] | undefined>
}

// Well under the API's 20 MB body limit, so a long history moves in parts.
const maximumBatchBytes = 4 * 1024 * 1024

/**
 * Copies the workspace built without an account into the account the person
 * just signed in to. The account keeps what it already has; running this
 * again after an interruption adds only what is still missing.
 */
export async function transferLocalWorkspace(
  local: ApiConnection,
  account: ApiConnection
) {
  const bundle = await send<WorkspaceBundle>(local, "/account/workspace")
  for (const batch of workspaceBatches(bundle)) {
    await send(account, "/account/workspace", {
      body: JSON.stringify(batch),
      method: "PUT",
    })
  }
}

/**
 * Splits a workspace into requests that keep table order. Each one repeats
 * the projects, which the account uses to place every other row.
 */
export function workspaceBatches(
  bundle: WorkspaceBundle,
  limit = maximumBatchBytes
) {
  const projects = bundle.tables.projects ?? []
  const base = { format: bundle.format, version: bundle.version }
  const batches: WorkspaceBundle[] = []
  let current: WorkspaceBundle["tables"] = { projects }
  let size = byteLength(projects)
  for (const [table, rows] of Object.entries(bundle.tables)) {
    if (table === "projects" || !rows?.length) continue
    for (const row of rows) {
      const rowSize = byteLength(row)
      if (size + rowSize > limit && Object.keys(current).length > 1) {
        batches.push({ ...base, tables: current })
        current = { projects }
        size = byteLength(projects)
      }
      ;(current[table] ??= []).push(row)
      size += rowSize
    }
  }
  batches.push({ ...base, tables: current })
  return batches
}

function byteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

async function send<T = unknown>(
  connection: ApiConnection,
  path: string,
  init?: RequestInit
) {
  const response = await fetch(`${connection.url}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
  })
  if (!response.ok) {
    throw new Error(
      `Your local workspace could not be moved to your account (${response.status}).`
    )
  }
  const body = (await response.json()) as { data: T }
  return body.data
}
