// Terminal output as the project runner receives it, one string per event,
// for the run log bench and the terminal text tests: a long build, a chatty
// dev server, and installs that redraw their progress in place. The same
// seed always gives the same output.
export type RunLogStream = "build" | "dev-server" | "progress"

export const runLogStreams: RunLogStream[] = ["build", "dev-server", "progress"]

export function* runLogEvents(stream: RunLogStream, seed = 1) {
  const random = seededRandom(seed)
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!
  const number = (max: number) => Math.floor(random() * max)
  for (let index = 0; ; index += 1) {
    if (stream === "build") yield buildEvent(index, number, pick)
    else if (stream === "dev-server") yield devServerEvent(index, number, pick)
    else yield progressEvent(index, number, pick)
  }
}

const crates = ["serde", "tokio", "hyper", "regex", "clap", "tracing", "rand"]
const files = ["Board.tsx", "use-runner.ts", "api/items.ts", "Card.tsx"]
const routes = ["/api/items?page=3", "/dashboard", "/_next/static/chunk.js"]

// cargo's progress bar, redrawn with a carriage return, between the crates
// it compiles; vite's transform counter, redrawn by moving to the first
// column; warnings and the size of each bundle.
function buildEvent(
  index: number,
  number: (max: number) => number,
  pick: <T>(items: T[]) => T
) {
  const kind = number(10)
  if (kind < 4) {
    const lines = 1 + number(12)
    let text = ""
    for (let line = 0; line < lines; line += 1)
      text += `\r\u001b[K   \u001b[1m\u001b[32mCompiling\u001b[0m ${pick(crates)}-${index}-${line} v1.${number(40)}.${number(9)} (/workspace/crates/${pick(crates)})\n`
    return `${text}\u001b[1m\u001b[36m    Building\u001b[0m [${"=".repeat(number(40))}>${" ".repeat(number(20))}] ${index}/9000: ${pick(crates)}`
  }
  if (kind < 7)
    return `\u001b[2K\u001b[1Gtransforming (${index}) \u001b[2msrc/components/${pick(files)}\u001b[22m`
  if (kind < 9)
    return `\u001b[2K\u001b[1G\u001b[33m⚠️  warning\u001b[39m: unused variable \`item_${index}\` in src/${pick(files)}:${number(400)}:${number(80)}\n   \u001b[2m= note: #[warn(unused_variables)] on by default\u001b[22m\n`
  return `\u001b[2K\u001b[1Gdist/assets/${pick(files)}-${index.toString(36)}.js   \u001b[1m\u001b[33m${number(900)}.${number(99)} kB\u001b[39m\u001b[22m │ gzip: ${number(200)}.${number(99)} kB\n✓ built in ${number(9)}.${number(99)}s 🚀\n`
}

// One request or compilation per event, now and then a stack trace.
function devServerEvent(
  index: number,
  number: (max: number) => number,
  pick: <T>(items: T[]) => T
) {
  const kind = number(20)
  if (kind < 14)
    return ` GET ${pick(routes)} \u001b[32m200\u001b[39m in ${number(400)}ms\n`
  if (kind < 18)
    return ` \u001b[32m✓\u001b[39m Compiled ${pick(routes)} in ${number(3000)}ms (${number(4000)} modules)\n`
  if (kind < 19) return ` \u001b[37m○\u001b[39m Compiling /page-${index} ...\n`
  return ` \u001b[31m⨯\u001b[39m TypeError: Cannot read properties of undefined (reading 'id')\n    at Card (src/components/${pick(files)}:${number(200)}:${number(40)})\n    at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:${number(20000)}:18)\n`
}

// npm's spinner, which moves back to the first column and clears the line;
// a layer download redrawn with a carriage return; pnpm's counter, which
// moves up a line to redraw itself.
function progressEvent(
  index: number,
  number: (max: number) => number,
  pick: <T>(items: T[]) => T
) {
  const kind = number(10)
  const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[index % 10]
  if (kind < 4)
    return `\u001b[1G\u001b[0K${spinner} reify:${pick(crates)}: \u001b[32mtiming\u001b[39m reifyNode:node_modules/${pick(crates)} Completed in ${number(900)}ms`
  if (kind < 7)
    return `\r${index.toString(16).padStart(12, "0")}: Downloading [${"=".repeat(number(50))}>${" ".repeat(number(10))}]  ${number(90)}.${number(9)}MB/${90 + number(10)}.4MB`
  if (kind < 9)
    return `\u001b[1A\u001b[2KProgress: resolved ${index}, reused ${index - number(9)}, downloaded ${number(9)}, added ${number(index + 1)}\n`
  return `\r\u001b[K${index.toString(16).padStart(12, "0")}: Pull complete\n`
}

// mulberry32: small, fast and the same everywhere.
function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
