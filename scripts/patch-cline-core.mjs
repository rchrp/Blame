// Applies Blame's changes to a pristine @cline/core package directory.
//
//   node scripts/patch-cline-core.mjs <package directory>
//
// The SDK ships minified bundles, so a stored diff never survives an upgrade.
// Each change below is located by structure instead of by minified names and
// must match exactly the expected number of times, otherwise nothing is
// written. scripts/cline-sdk-update.mjs runs this to regenerate the pnpm patch;
// see patches/README.md for what the changes do. It also writes
// dist/blame-patch.json, which runtime health checks use to tell a patched core
// from a pristine one.
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const id = "[\\w$]+"
const patchMarker = "dist/blame-patch.json"
const bundles = ["dist/index.js", "dist/hub/index.js", "dist/hub/daemon/entry.js"]

/** A transformation: files it applies to, how often per file, and the rewrite. */
const changes = [
  {
    name: "type: compaction imageTokenLimit",
    files: { "dist/types/config.d.ts": 1 },
    pattern: /export interface CoreCompactionConfig \{\n/g,
    replace: (match) =>
      `${match}    /** Blame: token bound per accepted image in compaction estimates. */\n    imageTokenLimit?: number;\n`,
  },
  {
    name: "type: hub subscribe replay option",
    files: { "dist/hub/client/index.d.ts": 1 },
    pattern: /(subscribe\(listener: \(event: HubEventEnvelope\) => void, options\?: \{\n\s+sessionId\?: string;\n)/g,
    replace: (match) =>
      `${match}        /** Blame: start a new execution without replaying a previous subscription. Reconnects still replay missed events. */\n        replay?: boolean;\n`,
  },
  {
    // The message estimator counts every image at a flat per-image constant.
    name: "image estimator: configurable per-image tokens",
    files: Object.fromEntries(bundles.map((file) => [file, 1])),
    prepare: (text) => {
      const alias = text.match(new RegExp(`ESTIMATED_TOKENS_PER_IMAGE as (${id})`))?.[1]
      if (!alias) throw new Error("ESTIMATED_TOKENS_PER_IMAGE import not found")
      return { alias }
    },
    pattern: ({ alias }) =>
      new RegExp(`function (${id})\\(\\)(\\{let ${id}=new WeakMap;return\\(${id}\\)=>\\{[^]*?\\*)${escape(alias)}(;return)`, "g"),
    replace: (_match, name, body, end, { alias }) =>
      `function ${name}(blameImageTokens=${alias})${body}blameImageTokens${end}`,
  },
  {
    name: "compaction: use imageTokenLimit for message and request estimates",
    files: Object.fromEntries(bundles.map((file) => [file, 1])),
    pattern: new RegExp(
      `let (${id})=\\{\\.\\.\\.(${id})\\.compaction,\\.\\.\\.(${id})\\.compaction\\};if\\(\\1\\.enabled!==!0\\)return;let (${id})=(${id})\\(\\)([^]*?),(${id})=(${id})\\(\\{systemPrompt:(${id})\\.systemPrompt,messages:\\9\\.apiMessages,tools:\\9\\.tools\\}\\)`,
      "g",
    ),
    replace: (_match, config, a, b, estimator, factory, between, request, estimateRequest, input) => {
      const bounded = `(Number.isFinite(${config}.imageTokenLimit)&&${config}.imageTokenLimit>0)`
      return `let ${config}={...${a}.compaction,...${b}.compaction};if(${config}.enabled!==!0)return;let ${estimator}=${factory}(${bounded}?${config}.imageTokenLimit:void 0)${between},${request}=(${bounded}?${estimator}:${estimateRequest})({systemPrompt:${input}.systemPrompt,messages:${input}.apiMessages,tools:${input}.tools})`
    },
  },
  {
    // Session starts sent to a hub rebuild the compaction config field by field.
    name: "transport: keep imageTokenLimit in serialized compaction config",
    files: { "dist/index.js": 1 },
    pattern: new RegExp(
      `compaction:\\{enabled:(${id})\\.enabled,strategy:\\1\\.strategy,preserveRecentTokens:\\1\\.preserveRecentTokens,summarizer:\\1\\.summarizer\\}`,
      "g",
    ),
    replace: (match, config) => `${match.slice(0, -1)},imageTokenLimit:${config}.imageTokenLimit}`,
  },
  {
    name: "hub client: subscribe without replaying a previous execution",
    files: { "dist/index.js": 1, "dist/hub/index.js": 1 },
    pattern: new RegExp(
      `subscribe\\((${id}),(${id})\\)\\{let (${id})=\\2\\?\\.sessionId\\?\\.trim\\(\\)\\|\\|void 0,(${id})=\\{listener:\\1,sessionId:\\3\\}`,
      "g",
    ),
    replace: (match, _listener, options, session) =>
      `${match};if(${options}?.replay===false&&!this.subscriptionCounts.has(this.subscriptionKeyForSessionId(${session})))this.lastEventSequenceByKey.delete(this.subscriptionKeyForSessionId(${session}))`,
  },
  {
    name: "planned sessions: subscribe without replay",
    files: { "dist/index.js": 1 },
    pattern: new RegExp(`this\\.ensureSessionSubscription\\((${id})\\)\\}cleanupPlannedSession`, "g"),
    replace: (_match, session) => `this.ensureSessionSubscription(${session},false)}cleanupPlannedSession`,
  },
  {
    name: "session subscription: forward the replay option",
    files: { "dist/index.js": 1 },
    pattern: new RegExp(
      `ensureSessionSubscription\\((${id})\\)\\{(let (${id})=\\1\\.trim\\(\\);if\\(!\\3\\|\\|this\\.sessionSubscriptions\\.has\\(\\3\\)\\)return;let ${id}=this\\.client\\.subscribe\\(\\(${id}\\)=>\\{this\\.handleHubEvent\\(${id}\\)\\},\\{sessionId:\\3)\\}`,
      "g",
    ),
    replace: (_match, session, body) => `ensureSessionSubscription(${session},blameReplay=true){${body},replay:blameReplay}`,
  },
  {
    // A distinct, newer build identity keeps an unpatched hub from being reused.
    name: "hub build identity",
    files: Object.fromEntries(bundles.map((file) => [file, 1])),
    pattern: /return"(sdk-v1-[0-9a-f]{64})"\.trim\(\)/g,
    replace: (_match, build) => `return"blame-${build}".trim()`,
  },
  {
    name: "hub build time",
    files: Object.fromEntries(bundles.map((file) => [file, 1])),
    pattern: new RegExp(
      `(if\\(Number\\.isFinite\\(${id}\\)&&${id}>0\\)return ${id};return Number\\.isFinite\\()(\\d{13})\\)\\?\\2:void 0\\}`,
      "g",
    ),
    replace: (_match, head, time) => `${head}${Number(time) + 1})?${Number(time) + 1}:void 0}`,
  },
]

export async function patchClineCore(directory) {
  const files = new Map()
  const read = async (file) => {
    if (!files.has(file)) files.set(file, await readFile(join(directory, file), "utf8"))
    return files.get(file)
  }
  for (const change of changes) {
    for (const [file, expected] of Object.entries(change.files)) {
      const text = await read(file)
      const context = change.prepare?.(text) ?? {}
      const pattern = typeof change.pattern === "function" ? change.pattern(context) : change.pattern
      const found = [...text.matchAll(pattern)].length
      if (found !== expected) {
        throw new Error(`${change.name}: expected ${expected} match(es) in ${file}, found ${found}`)
      }
      files.set(file, text.replace(pattern, (...args) => change.replace(...args.slice(0, -2), context)))
    }
  }
  files.set(patchMarker, `${JSON.stringify({ changes: changes.map((change) => change.name) }, null, 2)}\n`)
  for (const [file, text] of files) await writeFile(join(directory, file), text, "utf8")
  return [...files.keys()]
}

function escape(value) {
  return value.replace(/[$]/g, "\\$")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
  if (!directory) {
    console.error("Usage: node scripts/patch-cline-core.mjs <@cline/core package directory>")
    process.exit(1)
  }
  for (const file of await patchClineCore(directory)) console.log(`patched ${file}`)
}
