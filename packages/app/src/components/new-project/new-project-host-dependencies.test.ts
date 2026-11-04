import assert from "node:assert/strict"
import test from "node:test"

import { defaultNewProjectConfiguration } from "./new-project-options.ts"
import { newProjectHostDependencyScript } from "./new-project-host-dependencies.ts"

test("builds dependency script for recommended Next.js project creation", () => {
  const script = newProjectHostDependencyScript(defaultNewProjectConfiguration)

  assert.match(script, /git --version/)
  assert.match(script, /docker --version/)
  assert.match(script, /pnpm create next-app --help/)
  assert.match(script, /pnpm install --help/)
  assert.match(script, /corepack prepare pnpm@10\.34\.9 --activate/)
  assert.match(script, /corepack pnpm install --help/)
})

test("builds dependency script for npm SvelteKit project creation", () => {
  const script = newProjectHostDependencyScript({
    ...defaultNewProjectConfiguration,
    frontend: "sveltekit",
    packageManager: "npm",
  })

  assert.match(script, /npx sv --version/)
  assert.match(script, /npm install --help/)
})

test("builds dependency script for FastAPI Python setup", () => {
  const script = newProjectHostDependencyScript({
    ...defaultNewProjectConfiguration,
    backend: "fastapi",
    frontend: "vue-vite",
    packageManager: "uv",
  })

  assert.match(script, /npm create vite --help/)
  assert.match(script, /pip --version/)
})
