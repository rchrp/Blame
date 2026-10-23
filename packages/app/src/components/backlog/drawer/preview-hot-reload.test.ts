import assert from "node:assert/strict"
import test from "node:test"

import { previewHotReloads } from "./preview-hot-reload.ts"

test("frameworks with a hot reload client refresh the page themselves", () => {
  assert.equal(previewHotReloads(["node", "pnpm", "next.js", "prisma"]), true)
  assert.equal(previewHotReloads(["Vite", "typescript"]), true)
  assert.equal(previewHotReloads(["nuxtjs"]), true)
  assert.equal(previewHotReloads(["SvelteKit"]), true)
})

test("server frameworks leave the open page as it was", () => {
  assert.equal(previewHotReloads(["python", "django", "postgresql"]), false)
  assert.equal(previewHotReloads(["ruby", "rails"]), false)
  assert.equal(previewHotReloads(["node", "express"]), false)
})

test("an unknown stack does not trigger reloads", () => {
  assert.equal(previewHotReloads([]), undefined)
  assert.equal(previewHotReloads(undefined), undefined)
})
