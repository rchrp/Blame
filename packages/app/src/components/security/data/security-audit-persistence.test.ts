import assert from "node:assert/strict"
import test from "node:test"

import type { SecurityAudit } from "@blame/agent-runtime"

import { persistSecurityAudit } from "./security-audit-persistence.ts"

const audit = (id: string, sequence: number) =>
  ({ id, projectId: "project", sequence }) as SecurityAudit

test("saves each audit change once, in order, whoever asks", async () => {
  const saved: number[] = []
  const save = async (_projectId: string, value: SecurityAudit) => {
    await new Promise((resolve) => setTimeout(resolve, 5 - value.sequence))
    saved.push(value.sequence)
    return value
  }
  await Promise.all([
    persistSecurityAudit(save, "project", audit("a", 1)),
    persistSecurityAudit(save, "project", audit("a", 2)),
    persistSecurityAudit(save, "project", audit("a", 2)),
    persistSecurityAudit(save, "project", audit("a", 1)),
  ])
  assert.deepEqual(saved, [1, 2])
})

test("refuses to save an audit under another project", async () => {
  await assert.rejects(
    persistSecurityAudit(async (_id, value) => value, "other", audit("b", 1)),
    /project identity is invalid/
  )
})
