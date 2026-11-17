import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import {
  captureCompileCache,
  compileCacheVolume,
  seedCompileCache,
  type CompileCacheTarget,
} from "./local-preview-compile-cache.ts";
import {
  dockerAvailable,
  hostShell,
  testDockerHost as host,
} from "./compile-cache-test-host.ts";

// Proves on a real `next dev` (Turbopack) that a story seeded from another
// story's cache serves its own code: changed, added and deleted pages, a
// changed module, client component, stylesheet and next.config, and other
// environment values, in both directions; and that a copy taken while the
// source compiler writes does not break the story it seeds. Slow and
// online (npm install): runs with BLAME_COMPILE_CACHE_E2E=1, against the
// local Docker or BLAME_TEST_DOCKER_PREFIX (a throwaway Lima VM).

const enabled = process.env.BLAME_COMPILE_CACHE_E2E === "1";
const image = "node:22-bookworm-slim";
const cache = ".next/dev/cache/turbopack";
const id = randomUUID().replace(/-/g, "").slice(0, 10);
const modules = `blame-e2e-node-modules-${id}`;
let root = "";
// Below the ephemeral range, where outgoing connections could hold a port.
let port = 21_000 + Math.floor(Math.random() * 2_000);

// Turbopack writes its cache only once it compiled enough: nine pages
// sharing heavy client components do.
const allPages = [
  "",
  "about/",
  "faq/",
  "pricing/",
  "blog/",
  "docs/",
  "team/",
  "jobs/",
  "help/",
];

const base: Record<string, string> = {
  "package.json": JSON.stringify({
    private: true,
    dependencies: {
      next: "16.4.6",
      react: "19.3.1",
      "react-dom": "19.3.1",
      "lucide-react": "1.73.0",
      recharts: "3.10.1",
      "date-fns": "4.4.0",
      zod: "4.6.7",
      "react-hook-form": "7.92.0",
      "@tanstack/react-query": "5.107.1",
      "framer-motion": "14.14.0",
      "@radix-ui/react-dialog": "1.3.1",
      "@radix-ui/react-tabs": "1.2.1",
      "lodash-es": "4.18.1",
    },
    devDependencies: {
      typescript: "5.9.3",
      "@types/react": "19.3.0",
      "@types/lodash-es": "4.17.12",
      tailwindcss: "4.3.5",
      "@tailwindcss/postcss": "4.3.5",
    },
  }),
  "next.config.mjs": "export default { reactStrictMode: true };\n",
  "postcss.config.mjs":
    'export default { plugins: { "@tailwindcss/postcss": {} } };\n',
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      lib: ["dom", "esnext"],
      strict: true,
      noEmit: true,
      module: "esnext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      isolatedModules: true,
      skipLibCheck: true,
      paths: { "@/*": ["./*"] },
    },
    include: ["**/*.ts", "**/*.tsx"],
  }),
  "app/globals.css": '@import "tailwindcss";\n',
  "app/layout.tsx": `import "./globals.css";
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  "lib/data.ts": "export const label = (i: number) => `Item ${i}`;\n",
  // Enough to compile for Turbopack to persist its cache: it skips writing
  // the cache of a tiny app.
  "components/Widgets.tsx":
    '"use client";\nimport * as Icons from "lucide-react";\nimport { LineChart, Line, XAxis, YAxis, Tooltip, BarChart, Bar, PieChart, Pie, ResponsiveContainer } from "recharts";\nimport { format, addDays, formatDistance } from "date-fns";\nimport { z } from "zod";\nimport { useForm } from "react-hook-form";\nimport { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";\nimport { motion, AnimatePresence } from "framer-motion";\nimport * as Dialog from "@radix-ui/react-dialog";\nimport * as Tabs from "@radix-ui/react-tabs";\nimport { groupBy, sortBy, debounce } from "lodash-es";\nimport { useState } from "react";\n\nconst schema = z.object({ email: z.string().email(), age: z.number().min(0) });\nconst client = new QueryClient();\nconst data = Array.from({ length: 30 }, (_, i) => ({ day: format(addDays(new Date(2026, 0, 1), i), "MMM d"), v: (i * 37) % 100 }));\nconst iconNames = Object.keys(Icons).filter((k) => /^[A-Z]/.test(k)).slice(0, 60);\n\nfunction Inner({ label }: { label: string }) {\n  const q = useQuery({ queryKey: ["x", label], queryFn: async () => sortBy(data, "v") });\n  const { register } = useForm<z.infer<typeof schema>>();\n  const [open, setOpen] = useState(false);\n  const groups = groupBy(data, (d) => d.v % 3);\n  const onType = debounce(() => undefined, 100);\n  return (\n    <div className="grid gap-4">\n      <Tabs.Root defaultValue="a"><Tabs.List><Tabs.Trigger value="a">Chart</Tabs.Trigger><Tabs.Trigger value="b">Icons</Tabs.Trigger></Tabs.List>\n        <Tabs.Content value="a"><div style={{ height: 200 }}><ResponsiveContainer><LineChart data={q.data ?? data}><XAxis dataKey="day" /><YAxis /><Tooltip /><Line dataKey="v" /></LineChart></ResponsiveContainer></div>\n          <BarChart width={300} height={120} data={data}><Bar dataKey="v" /></BarChart><PieChart width={120} height={120}><Pie data={data.slice(0, 5)} dataKey="v" /></PieChart></Tabs.Content>\n        <Tabs.Content value="b"><div className="flex flex-wrap gap-1">{iconNames.map((n) => { const I = (Icons as any)[n]; return <I key={n} size={14} />; })}</div></Tabs.Content></Tabs.Root>\n      <input {...register("email")} onChange={onType} className="border p-1" placeholder={formatDistance(new Date(2026, 0, 1), new Date(2026, 2, 1))} />\n      <p>{Object.keys(groups).length} groups for {label}</p>\n      <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger>Open</Dialog.Trigger><Dialog.Portal><Dialog.Content><Dialog.Title>Hi</Dialog.Title></Dialog.Content></Dialog.Portal></Dialog.Root>\n      <AnimatePresence>{open && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>Animated</motion.div>}</AnimatePresence>\n    </div>\n  );\n}\nexport function Widgets({ label }: { label: string }) {\n  return <QueryClientProvider client={client}><Inner label={label} /></QueryClientProvider>;\n}\n',
  "components/Card.tsx": `"use client";
import { useState } from "react";
import * as Icons from "lucide-react";
export function Card() {
  const [n, setN] = useState(0);
  const names = Object.keys(Icons).filter((k) => /^[A-Z]/.test(k)).slice(0, 40);
  return <button onClick={() => setN(n + 1)}>CARD-base {n} {names.length}</button>;
}
`,
  ...Object.fromEntries(
    allPages.map((path) => [
      `app/${path}page.tsx`,
      `import { Card } from "@/components/Card";
import { label } from "@/lib/data";
import { Widgets } from "@/components/Widgets";
export default function Page() {
  return <main><h1>MARK-${path || "home/"}</h1><p>ENV:{process.env.NEXT_PUBLIC_STORY ?? "unset"}</p><p>{label(3)}</p><Card /><Widgets label="w" /></main>;
}
`,
    ]),
  ),
};

// What a story changes: a page, a shared module, a client component, the
// stylesheet and next.config; it adds a page and deletes another.
const changes: Record<string, string | null> = {
  "app/about/page.tsx": base["app/about/page.tsx"]!.replace(
    "MARK-about/",
    "MARK-about-changed/",
  ),
  "lib/data.ts": "export const label = (i: number) => `Changed ${i}`;\n",
  "components/Card.tsx": base["components/Card.tsx"]!.replace(
    "CARD-base",
    "CARD-changed",
  ),
  "app/globals.css": '@import "tailwindcss";\n.story-changed { color: red; }\n',
  "next.config.mjs":
    'export default { reactStrictMode: true, env: { CONFIG_FLAG: "CFG-changed" }, async redirects() { return [{ source: "/old", destination: "/about", permanent: false }]; } };\n',
  "app/added/page.tsx":
    "export default function Added() { return <p>ADDED {process.env.CONFIG_FLAG}</p>; }\n",
  "app/faq/page.tsx": null,
};

before(async () => {
  if (!enabled || !(await dockerAvailable())) return;
  root = (await hostShell("mktemp -d /tmp/blame-next-cache.XXXXXX")).trim();
  await writeStory("install", base);
  await hostShell(
    `docker volume create "$2" >/dev/null && docker run --rm -v "$1/install:/workspace" -v "$2:/workspace/node_modules" -w /workspace ${image} npm install --no-audit --no-fund --loglevel=error`,
    root,
    modules,
  );
});

after(async () => {
  if (!root) return;
  await hostShell(
    `docker ps -aq --filter "label=blame.e2e=$3" | xargs -r docker rm -f >/dev/null
docker run --rm -v "$1:/r" busybox:1.37.0 sh -c 'rm -rf /r/* /r/.[!.]*'
rmdir "$1"; docker volume rm -f "$2" "$4" >/dev/null`,
    root,
    modules,
    id,
    compileCacheVolume(id),
  ).catch(() => undefined);
});

async function writeStory(name: string, files: Record<string, string | null>) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null)
      await hostShell('rm -f "$1"', `${root}/${name}/${path}`);
    else await host.writeFile(`${root}/${name}/${path}`, content);
  }
}

function target(name: string): CompileCacheTarget {
  return {
    worktree: `${root}/${name}`,
    dependencyKey: id,
    directories: [cache, ".next/cache/turbopack"],
    owner: { uid: 0, gid: 0 },
  };
}

/** Starts `next dev` for a story and returns its port once it answers. */
async function serve(name: string, env: string) {
  port += 1;
  await hostShell(
    `docker run -d --name "blame-e2e-$3-$1" --label "blame.e2e=$3" -e NEXT_TELEMETRY_DISABLED=1 ${env ? `-e NEXT_PUBLIC_STORY=${env}` : ""} -p "127.0.0.1:$4:3000" -v "$2/$1:/workspace" -v "$5:/workspace/node_modules" -w /workspace ${image} npx next dev -H 0.0.0.0 -p 3000 >/dev/null
for i in $(seq 1 600); do curl -s -o /dev/null -m 120 "http://127.0.0.1:$4/" && exit 0; sleep 0.2; done; exit 1`,
    name,
    root,
    id,
    String(port),
    modules,
  );
  return port;
}

async function page(at: number, path: string) {
  const out = await hostShell(
    'curl -s -m 120 -o /tmp/blame-e2e-body -w "%{http_code} %{redirect_url}" "http://127.0.0.1:$1$2"; echo; cat /tmp/blame-e2e-body',
    String(at),
    path,
  );
  const [status, ...body] = out.split("\n");
  return { status: status!.trim(), body: body.join("\n") };
}

async function stylesheet(at: number, html: string) {
  const links = [...html.matchAll(/\/_next\/static\/[^"]+\.css/g)].map(
    (match) => match[0],
  );
  let css = "";
  for (const link of new Set(links)) css += (await page(at, link)).body;
  return css;
}

async function clientChunks(at: number, html: string) {
  const scripts = [...html.matchAll(/\/_next\/static\/chunks\/[^"]+\.js/g)];
  let js = "";
  for (const script of new Set(scripts.map((match) => match[0])))
    js += (await page(at, script)).body;
  return js;
}

async function assertBase(at: number, env: string) {
  const about = await page(at, "/about");
  assert.match(about.body, /MARK-about\/</);
  assert.doesNotMatch(about.body, /changed/i);
  assert.match(about.body, /Item 3/);
  assert.match(about.body, new RegExp(`ENV:(<!-- -->)?${env}<`));
  assert.match(await clientChunks(at, about.body), /CARD-base/);
  assert.doesNotMatch(await stylesheet(at, about.body), /story-changed/);
  assert.equal((await page(at, "/faq")).status, "200");
  assert.equal((await page(at, "/added")).status, "404");
  assert.equal((await page(at, "/old")).status, "404");
}

async function assertChanged(at: number, env: string) {
  const about = await page(at, "/about");
  assert.match(about.body, /MARK-about-changed\/</);
  assert.match(about.body, /Changed 3/);
  assert.match(about.body, new RegExp(`ENV:(<!-- -->)?${env}<`));
  const js = await clientChunks(at, about.body);
  assert.match(js, /CARD-changed/);
  assert.doesNotMatch(js, /CARD-base/);
  assert.match(await stylesheet(at, about.body), /story-changed/);
  assert.equal((await page(at, "/faq")).status, "404");
  assert.match((await page(at, "/added")).body, /ADDED (<!-- -->)?CFG-changed/);
  assert.equal(
    (await page(at, "/old")).status,
    `307 http://127.0.0.1:${at}/about`,
  );
}

/** Requests every page, as someone browsing the story. */
async function visit(at: number) {
  for (const path of allPages) await page(at, `/${path}`);
}

function epoch() {
  return Math.floor(Date.now() / 1_000);
}

/** Files in the published snapshot of this test's dependency key. */
async function snapshotFiles() {
  const out = await hostShell(
    'docker run --rm -v "$1:/c" busybox:1.37.0 sh -c \'find "/c/$(cat /c/current)" -type f | wc -l\'',
    compileCacheVolume(id),
  );
  return Number(out.trim());
}

async function stop(name: string) {
  await hostShell('docker rm -f "blame-e2e-$2-$1" >/dev/null', name, id);
}

test(
  "a seeded story serves its own code, config and environment",
  { skip: !enabled, timeout: 30 * 60_000 },
  async () => {
    assert.ok(root, "Docker is not available");
    // The first story compiles cold; its cache is taken while it runs.
    await writeStory("source", base);
    const source = await serve("source", "SOURCE");
    await visit(source);
    await assertBase(source, "SOURCE");
    // Taken once the running compiler wrote its cache after the pages.
    assert.equal(
      await captureCompileCache(host, target("source"), {
        writtenAfter: epoch(),
      }),
      true,
    );
    assert.ok((await snapshotFiles()) > 2);

    // A story that changed code and config, with another environment.
    await writeStory("changed", { ...base, ...changes });
    assert.equal(
      (await seedCompileCache(host, target("changed"))).state,
      "seeded",
    );
    const changedAt = epoch();
    const changed = await serve("changed", "CHANGED");
    await visit(changed);
    await assertChanged(changed, "CHANGED");
    await stop("source");

    // The other way: the snapshot now holds the changed story's entries.
    assert.equal(
      await captureCompileCache(host, target("changed"), {
        writtenAfter: changedAt,
      }),
      true,
    );
    await writeStory("plain", base);
    assert.equal(
      (await seedCompileCache(host, target("plain"))).state,
      "seeded",
    );
    const plain = await serve("plain", "");
    await assertBase(plain, "unset");
    // Both still serve their own code side by side.
    await assertChanged(changed, "CHANGED");
    await stop("changed");
    await stop("plain");
  },
);

test(
  "a copy taken while the compiler writes does not break its story",
  { skip: !enabled, timeout: 30 * 60_000 },
  async () => {
    assert.ok(root, "Docker is not available");
    await writeStory("racing", base);
    const racing = await serve("racing", "RACING");
    await visit(racing);
    // Raw copies, with no quiet check, each time the cache changed while
    // the compiler wrote it: each must leave its story correct.
    const copies = await hostShell(
      `last=; stable=0
for i in $(seq 1 240); do
  now="$(find "$1/racing/${cache}" -type f -exec stat -c '%n %s' {} + | sort | md5sum)"
  if [ "$now" != "$last" ]; then
    stable=0; last="$now"
    mkdir -p "$1/torn-$i/.next/dev/cache" && cp -a "$1/racing/${cache}" "$1/torn-$i/.next/dev/cache/" 2>/dev/null
    echo "torn-$i $(find "$1/racing/${cache}" -type f | wc -l)"
  else
    stable=$((stable + 1))
    [ "$stable" -lt 20 ] || [ "$(find "$1/racing/${cache}" -name '*.sst' | wc -l)" = 0 ] || break
  fi
  sleep 0.25
done`,
      root,
    );
    const taken = copies
      .trim()
      .split("\n")
      .map((line) => line.split(" ")[0]!);
    // The first copy holds the empty cache, the last one the finished one.
    const midWrite = taken.slice(1, -1);
    assert.ok(midWrite.length > 0, `no copy during a write: ${copies}`);
    await stop("racing");
    for (const name of [...midWrite.slice(0, 4), taken.at(-1)!]) {
      const env = name.replace("-", "").toUpperCase();
      await writeStory(name, base);
      const torn = await serve(name, env);
      await assertBase(torn, env);
      await stop(name);
    }
  },
);
