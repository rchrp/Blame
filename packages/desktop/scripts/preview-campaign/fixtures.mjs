// Projects the preview campaign runs, with the preview setup an initialization
// agent would write for each (manifest + run configurations). Each fixture
// carries what the scenarios check: the page that must load, the file an edit
// changes and the text that proves the edit reached the preview.
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const NODE = "node:22-bookworm";
const PYTHON = "python:3.13-bookworm";

const http = (port, path = "/", timeoutMs = 90_000) => ({
  id: "http",
  protocol: "http",
  port,
  healthcheck: { type: "http", path, timeoutMs },
});

const node = (extra) => ({ container: { image: NODE }, workingDir: "/workspace", ...extra });

const manifest = (parts) => ({
  confidence: "high",
  project: { root: ".", detectedStack: ["node"], confidence: "high" },
  caches: [],
  risks: [],
  probes: [],
  ...parts,
});

const webConfig = (service, url, services = [service], id = "web") => ({
  id,
  name: "Web app",
  command: "npm run dev",
  cwd: ".",
  default: true,
  category: "web",
  services,
  previewService: service,
  scopes: ["."],
  previewUrl: url,
});

function expressServer({ port = "Number(process.env.PORT ?? 3000)", extra = "", host = "0.0.0.0", delayMs = 0, banner = "v1" }) {
  return `import express from "express";
const app = express();
const startedAt = Date.now();
${extra}
app.get("/health", (_req, res) => res.json({ ok: true, uptime: Date.now() - startedAt }));
app.get("/", (_req, res) => res.send("<h1>Campaign express ${banner}</h1>"));
const listen = () => app.listen(${port}, "${host}", () => console.log("listening on", ${port}));
${delayMs ? `setTimeout(listen, ${delayMs});` : "listen();"}
`;
}

const viteFiles = (name, extraMain = "") => ({
  "index.html": `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n`,
  "src/main.jsx": `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n${extraMain}createRoot(document.getElementById("root")).render(<App />);\n`,
  "src/App.jsx": `export default function App() {\n  return <h1>Campaign ${name} v1</h1>;\n}\n`,
  "vite.config.js": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()], server: { host: "0.0.0.0", watch: { usePolling: false } } });\n`,
});

const deps = (command = "npm install --no-package-lock") => ({
  id: "deps",
  ...node({ command }),
});

export const fixtures = {
  "vite-react": {
    title: "Vite + React (npm)",
    install: ["vite", "@vitejs/plugin-react", "react", "react-dom"],
    scripts: { dev: "vite", build: "vite build" },
    files: { ...viteFiles("vite"), ".gitignore": "node_modules\ndist\n" },
    manifest: manifest({
      project: { root: ".", detectedStack: ["node", "vite", "react"], confidence: "high" },
      setup: [deps()],
      services: [
        {
          id: "web",
          kind: "preview",
          ...node({ command: "npm run dev -- --host 0.0.0.0 --port 5173" }),
          endpoints: [http(5173)],
          production: { build: "npm run build", command: "npx vite preview --host 0.0.0.0 --port 5173 --strictPort" },
        },
      ],
      probes: [{ id: "app", from: "host", type: "http", target: { service: "web", endpoint: "http" } }],
    }),
    runConfigurations: [webConfig("web", "http://localhost:5173")],
    page: { path: "/", includes: "<div id=\"root\">" },
    edit: { file: "src/App.jsx", from: "vite v1", to: "vite v2", served: "/src/App.jsx", includes: "vite v2" },
    visible: { before: "Campaign vite v1", after: "Campaign vite v2", hot: true },
  },

  "next-app": {
    title: "Next.js app router (npm)",
    install: ["next", "react", "react-dom"],
    scripts: { dev: "next dev", build: "next build", start: "next start" },
    files: {
      "app/layout.jsx": `export default function Layout({ children }) {\n  return (<html><body>{children}</body></html>);\n}\n`,
      "app/page.jsx": `import Counter from "./counter";\nexport default function Page() {\n  return (<main><h1>Campaign next v1</h1><Counter /></main>);\n}\n`,
      "app/counter.jsx": `"use client";\nimport { useState } from "react";\nexport default function Counter() {\n  const [n, setN] = useState(0);\n  return <button onClick={() => setN(n + 1)}>count {n}</button>;\n}\n`,
      "app/api/health/route.js": `export function GET() {\n  return Response.json({ ok: true });\n}\n`,
      "app/about/page.jsx": `export default function About() {\n  return <p>About page v1</p>;\n}\n`,
      ".gitignore": "node_modules\n.next\n",
    },
    manifest: manifest({
      project: { root: ".", detectedStack: ["node", "next"], confidence: "high" },
      setup: [deps()],
      services: [
        {
          id: "web",
          kind: "preview",
          ...node({ command: "npm run dev -- -H 0.0.0.0 -p 3000" }),
          endpoints: [http(3000)],
          production: { build: "npm run build", command: "npm run start -- -H 0.0.0.0 -p 3000" },
        },
      ],
      probes: [
        { id: "health", from: "host", type: "http", target: { service: "web", endpoint: "http", path: "/api/health" }, acceptedStatuses: [200] },
      ],
    }),
    runConfigurations: [webConfig("web", "http://localhost:3000")],
    page: { path: "/", includes: "Campaign next v1" },
    edit: { file: "app/page.jsx", from: "next v1", to: "next v2", served: "/", includes: "next v2" },
    visible: { before: "Campaign next v1", after: "Campaign next v2", hot: true },
  },

  "express-api": {
    title: "Express API alone (npm, node --watch)",
    install: ["express"],
    scripts: { dev: "node --watch server.js" },
    files: { "server.js": expressServer({}), ".gitignore": "node_modules\n" },
    manifest: manifest({
      setup: [deps()],
      services: [
        {
          id: "api",
          kind: "preview",
          ...node({ command: "npm run dev" }),
          endpoints: [http(3000, "/health")],
        },
      ],
      probes: [{ id: "health", from: "host", type: "http", target: { service: "api", endpoint: "http", path: "/health" }, acceptedStatuses: [200] }],
    }),
    runConfigurations: [webConfig("api", "http://localhost:3000")],
    page: { path: "/", includes: "Campaign express v1" },
    edit: { file: "server.js", from: "express v1", to: "express v2", served: "/", includes: "express v2" },
  },

  "express-postgres": {
    title: "Express + PostgreSQL + migrate/seed setup tasks",
    install: ["express", "pg"],
    scripts: { dev: "node --watch server.js", migrate: "node migrate.js" },
    files: {
      ".gitignore": "node_modules\n",
      "migrate.js": `import pg from "pg";\nconst client = new pg.Client({ connectionString: process.env.DATABASE_URL });\nawait client.connect();\nawait client.query("create table if not exists users (id serial primary key, name text not null)");\nconst { rows } = await client.query("select count(*)::int as n from users");\nif (rows[0].n === 0) await client.query("insert into users (name) values ('Ada'), ('Grace')");\nawait client.end();\nconsole.log("migrated");\n`,
      "server.js": expressServer({
        extra: `import pg from "pg";\nconst pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });\napp.get("/users", async (_req, res) => {\n  const { rows } = await pool.query("select name from users order by id");\n  res.json(rows.map((row) => row.name));\n});`,
      }).replace(
        'import express from "express";',
        'import express from "express";',
      ),
    },
    manifest: manifest({
      project: { root: ".", detectedStack: ["node", "postgres"], confidence: "high" },
      setup: [
        deps(),
        {
          id: "migrate",
          ...node({
            command: "node migrate.js",
            environment: { DATABASE_URL: "postgresql://blame:blame@database:5432/blame" },
            dependsOn: ["database"],
          }),
        },
      ],
      services: [
        {
          id: "database",
          kind: "dependency",
          container: { image: "postgres:17-bookworm" },
          environment: { POSTGRES_USER: "blame", POSTGRES_PASSWORD: "blame", POSTGRES_DB: "blame" },
          endpoints: [{ id: "postgres", protocol: "tcp", port: 5432, healthcheck: { type: "tcp", timeoutMs: 60_000 } }],
        },
        {
          id: "api",
          kind: "preview",
          ...node({
            command: "npm run dev",
            environment: { DATABASE_URL: "postgresql://blame:blame@database:5432/blame" },
            dependsOn: ["database"],
          }),
          endpoints: [http(3000, "/health")],
        },
      ],
      probes: [{ id: "users", from: "host", type: "http", target: { service: "api", endpoint: "http", path: "/users" }, acceptedStatuses: [200] }],
    }),
    runConfigurations: [webConfig("api", "http://localhost:3000", ["api", "database"])],
    page: { path: "/users", includes: "Ada" },
    edit: { file: "migrate.js", from: "unused", to: "unused", served: "/users", includes: "Ada", skipEdit: true },
  },

  "flask-redis": {
    title: "Flask + Redis (pip, venv cache)",
    files: {
      "requirements.txt": "flask==3.1.0\nredis==5.2.1\n",
      "app.py": `import os\nimport redis\nfrom flask import Flask\napp = Flask(__name__)\nr = redis.Redis(host=os.environ["REDIS_HOST"], port=6379)\n@app.route("/")\ndef index():\n    return f"<h1>Campaign flask v1</h1><p>visits {r.incr('visits')}</p>"\n@app.route("/health")\ndef health():\n    return {"ok": True}\n`,
      ".gitignore": "__pycache__\n",
    },
    manifest: manifest({
      project: { root: ".", detectedStack: ["python", "flask", "redis"], confidence: "high" },
      caches: [{ name: "venv", target: "/opt/venv" }],
      setup: [
        {
          id: "deps",
          container: { image: PYTHON },
          workingDir: "/workspace",
          command: "python -m venv /opt/venv && /opt/venv/bin/pip install -r requirements.txt",
        },
      ],
      services: [
        {
          id: "redis",
          kind: "dependency",
          container: { image: "redis:7-bookworm" },
          endpoints: [{ id: "redis", protocol: "tcp", port: 6379, healthcheck: { type: "tcp", timeoutMs: 30_000 } }],
        },
        {
          id: "web",
          kind: "preview",
          container: { image: PYTHON },
          workingDir: "/workspace",
          command: "/opt/venv/bin/flask --app app run --host 0.0.0.0 --port 5000 --debug",
          environment: { REDIS_HOST: "redis" },
          dependsOn: ["redis"],
          endpoints: [http(5000, "/health")],
        },
      ],
      probes: [{ id: "app", from: "host", type: "http", target: { service: "web", endpoint: "http" } }],
    }),
    runConfigurations: [webConfig("web", "http://localhost:5000", ["web", "redis"])],
    page: { path: "/", includes: "Campaign flask v1" },
    edit: { file: "app.py", from: "flask v1", to: "flask v2", served: "/", includes: "flask v2" },
    visible: { before: "Campaign flask v1", after: "Campaign flask v2", hot: false },
  },

  "web-api-binding": {
    title: "Vite web + Express API with a browser binding",
    subdirs: {
      api: { install: ["express", "cors"], scripts: { dev: "node --watch server.js" } },
      web: { install: ["vite", "@vitejs/plugin-react", "react", "react-dom"], scripts: { dev: "vite" } },
    },
    files: {
      "api/server.js": expressServer({
        extra: `import cors from "cors";\napp.use(cors());\napp.get("/message", (_req, res) => res.json({ message: "hello from api" }));`,
      }),
      ".gitignore": "node_modules\n",
      ...Object.fromEntries(
        Object.entries(
          viteFiles("binding", `const apiUrl = import.meta.env.VITE_API_URL;\nfetch(apiUrl + "/message").then((r) => r.json()).then((m) => (document.title = m.message));\n`),
        ).map(([path, content]) => [`web/${path}`, content]),
      ),
    },
    manifest: manifest({
      project: { root: ".", detectedStack: ["node", "vite", "express"], confidence: "high" },
      setup: [
        deps("cd api && npm install --no-package-lock && cd ../web && npm install --no-package-lock"),
      ],
      services: [
        {
          id: "api",
          kind: "worker",
          ...node({ workingDir: "/workspace/api", command: "npm run dev", environment: { PORT: "3333" } }),
          endpoints: [http(3333, "/health")],
        },
        {
          id: "web",
          kind: "preview",
          ...node({ workingDir: "/workspace/web", command: "npm run dev -- --host 0.0.0.0 --port 5173" }),
          endpoints: [http(5173)],
          dependsOn: ["api"],
          bindings: [
            { target: { type: "environment", key: "VITE_API_URL" }, source: { service: "api", endpoint: "http" }, exposure: "browser", format: "url" },
          ],
        },
      ],
      probes: [{ id: "api", from: "host", type: "http", target: { service: "api", endpoint: "http", path: "/message" }, acceptedStatuses: [200] }],
    }),
    runConfigurations: [webConfig("web", "http://localhost:5173", ["web", "api"])],
    page: { path: "/", includes: "<div id=\"root\">" },
    edit: { file: "web/src/App.jsx", from: "binding v1", to: "binding v2", served: "/src/App.jsx", includes: "binding v2" },
    visible: { before: "Campaign binding v1", after: "Campaign binding v2", hot: true, title: "hello from api" },
  },

  // --- failures a user can run into: each must end in a clear, final state.
  "broken-install": {
    title: "A dependency that does not exist",
    install: ["express"],
    scripts: { dev: "node server.js" },
    files: { "server.js": expressServer({}), ".gitignore": "node_modules\n" },
    afterInstall: { dependencies: { "@blame-campaign/does-not-exist-xyz": "^9.9.9" } },
    manifest: manifest({
      setup: [deps()],
      services: [{ id: "api", kind: "preview", ...node({ command: "npm run dev" }), endpoints: [http(3000, "/health", 20_000)] }],
    }),
    runConfigurations: [webConfig("api", "http://localhost:3000")],
    expectFailure: { includes: /install|deps|404|not found|E404/i },
  },
  "crash-on-start": {
    title: "A server that throws at startup",
    install: ["express"],
    scripts: { dev: "node server.js" },
    files: {
      "server.js": `import express from "express";\nif (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");\nexpress().listen(3000, "0.0.0.0");\n`,
      ".gitignore": "node_modules\n",
    },
    manifest: manifest({
      setup: [deps()],
      services: [{ id: "api", kind: "preview", ...node({ command: "npm run dev" }), endpoints: [http(3000, "/health", 20_000)] }],
    }),
    runConfigurations: [webConfig("api", "http://localhost:3000")],
    expectFailure: { includes: /SESSION_SECRET|exited|crash|unhealthy/i },
  },
  "wrong-port": {
    title: "The server listens on another port than the manifest",
    install: ["express"],
    scripts: { dev: "node server.js" },
    files: { "server.js": expressServer({ port: 4000 }), ".gitignore": "node_modules\n" },
    manifest: manifest({
      setup: [deps()],
      services: [{ id: "api", kind: "preview", ...node({ command: "npm run dev" }), endpoints: [http(3000, "/health", 15_000)] }],
    }),
    runConfigurations: [webConfig("api", "http://localhost:3000")],
    expectFailure: { includes: /ready|health|timed out|3000|unhealthy|did not/i },
  },
  "loopback-only": {
    title: "The server binds 127.0.0.1 inside its container",
    install: ["express"],
    scripts: { dev: "node server.js" },
    files: { "server.js": expressServer({ host: "127.0.0.1" }), ".gitignore": "node_modules\n" },
    manifest: manifest({
      setup: [deps()],
      services: [{ id: "api", kind: "preview", ...node({ command: "npm run dev" }), endpoints: [http(3000, "/health", 15_000)] }],
    }),
    runConfigurations: [webConfig("api", "http://localhost:3000")],
    expectFailure: { includes: /ready|health|timed out|3000|unhealthy|reach|did not/i },
  },
  "slow-start": {
    title: "A server that takes 25 s to listen",
    install: ["express"],
    scripts: { dev: "node server.js" },
    files: { "server.js": expressServer({ delayMs: 25_000 }), ".gitignore": "node_modules\n" },
    manifest: manifest({
      setup: [deps()],
      services: [{ id: "api", kind: "preview", ...node({ command: "npm run dev" }), endpoints: [http(3000, "/health", 90_000)] }],
    }),
    runConfigurations: [webConfig("api", "http://localhost:3000")],
    page: { path: "/", includes: "Campaign express v1" },
  },
  "probe-fails": {
    title: "A required functional probe that gets a 500",
    install: ["express"],
    scripts: { dev: "node server.js" },
    files: {
      "server.js": expressServer({ extra: `app.get("/api/data", (_req, res) => res.status(500).json({ error: "db down" }));` }),
      ".gitignore": "node_modules\n",
    },
    manifest: manifest({
      setup: [deps()],
      services: [{ id: "api", kind: "preview", ...node({ command: "npm run dev" }), endpoints: [http(3000, "/health", 30_000)] }],
      probes: [{ id: "data", from: "host", type: "http", target: { service: "api", endpoint: "http", path: "/api/data" }, acceptedStatuses: [200], required: true }],
    }),
    runConfigurations: [webConfig("api", "http://localhost:3000")],
    expectFailure: { includes: /probe|data|500|functional/i },
  },
};


// Fixtures built from another one, with a different manifest or extra files.
const nextWithHealthPath = structuredClone(fixtures["next-app"].manifest);
nextWithHealthPath.services[0].endpoints[0].healthcheck.path = "/api/health";
fixtures["next-healthpath"] = {
  ...fixtures["next-app"],
  title: "Next.js whose healthcheck path is /api/health (the preview must still open on /)",
  manifest: nextWithHealthPath,
  expectUrlPath: "/",
};

const envManifest = structuredClone(fixtures["express-api"].manifest);
envManifest.services[0].endpoints[0].healthcheck.path = "/health";
fixtures["env-file"] = {
  ...fixtures["express-api"],
  title: "Express reading a git-ignored .env.local of the project folder",
  files: {
    ...fixtures["express-api"].files,
    "server.js": expressServer({ extra: `try { process.loadEnvFile(".env.local"); } catch {}\napp.get("/env", (_req, res) => res.json({ greeting: process.env.GREETING ?? null }));` }),
    ".gitignore": "node_modules\n.env.local\n",
  },
  untracked: { ".env.local": "GREETING=hello-from-env-file\n" },
  manifest: envManifest,
  page: { path: "/env", includes: "hello-from-env-file" },
  edit: undefined,
};

// Nine pages that import heavy client libraries: the compile load of a real app.
const heavyPages = Object.fromEntries(
  Array.from({ length: 9 }, (_, index) => [
    `app/p${index}/page.jsx`,
    `"use client";\nimport { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";\nimport { Camera, Home, Settings } from "lucide-react";\nimport { format } from "date-fns";\nimport { z } from "zod";\nconst schema = z.object({ n: z.number() });\nconst data = Array.from({ length: 12 }, (_, i) => ({ x: i, y: schema.parse({ n: i * ${index + 1} }).n }));\nexport default function Page() {\n  return (\n    <main>\n      <h1>Heavy page ${index} v1</h1>\n      <p>{format(new Date(0), "yyyy")}</p>\n      <Camera /><Home /><Settings />\n      <ResponsiveContainer width="100%" height={200}>\n        <LineChart data={data}><CartesianGrid /><XAxis dataKey="x" /><YAxis /><Tooltip /><Line dataKey="y" /></LineChart>\n      </ResponsiveContainer>\n    </main>\n  );\n}\n`,
  ]),
);
fixtures["next-heavy"] = {
  ...fixtures["next-app"],
  title: "Next.js with nine pages of heavy client libraries (recharts, lucide, date-fns, zod)",
  install: ["next", "react", "react-dom", "recharts", "lucide-react", "date-fns", "zod"],
  files: { ...fixtures["next-app"].files, ...heavyPages },
  extraPages: Array.from({ length: 9 }, (_, index) => `/p${index}`),
  edit: { file: "app/p0/page.jsx", from: "page 0 v1", to: "page 0 v2", served: "/p0", includes: "page 0 v2" },
  visible: { path: "/p0", before: "Heavy page 0 v1", after: "Heavy page 0 v2", hot: true },
};

// A pnpm workspace: an internal package built to dist, imported by the web app.
fixtures["pnpm-monorepo"] = {
  title: "pnpm workspace with an internal package built to dist (corepack)",
  pnpm: true,
  files: {
    "package.json": JSON.stringify({ name: "campaign-monorepo", private: true, packageManager: "pnpm@9.15.4", scripts: { dev: "pnpm --filter web dev" } }, null, 2) + "\n",
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    ".gitignore": "node_modules\ndist\n",
    "packages/shared/package.json": JSON.stringify({ name: "@campaign/shared", version: "1.0.0", type: "module", main: "dist/index.js", exports: { ".": "./dist/index.js" }, scripts: { build: "node build.mjs" } }, null, 2) + "\n",
    "packages/shared/build.mjs": `import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("dist", { recursive: true });\nwriteFileSync("dist/index.js", 'export const greeting = "shared v1";\\n');\n`,
    "packages/web/package.json": JSON.stringify({ name: "web", version: "1.0.0", private: true, type: "module", scripts: { dev: "vite" }, dependencies: { "@campaign/shared": "workspace:*" } }, null, 2) + "\n",
    ...Object.fromEntries(
      Object.entries(viteFiles("monorepo", `import { greeting } from "@campaign/shared";\ndocument.title = greeting;\n`)).map(([path, content]) => [`packages/web/${path}`, content]),
    ),
  },
  pnpmAdd: [{ cwd: "packages/web", args: ["vite", "@vitejs/plugin-react", "react", "react-dom"] }],
  manifest: manifest({
    project: { root: ".", detectedStack: ["node", "pnpm", "vite"], confidence: "high" },
    setup: [
      deps("corepack prepare pnpm@9.15.4 --activate && corepack pnpm install && corepack pnpm --filter @campaign/shared run build"),
    ],
    services: [
      {
        id: "web",
        kind: "preview",
        ...node({
          workingDir: "/workspace/packages/web",
          command: "corepack prepare pnpm@9.15.4 --activate && corepack pnpm dev --host 0.0.0.0 --port 5173",
        }),
        endpoints: [http(5173)],
      },
    ],
  }),
  runConfigurations: [webConfig("web", "http://localhost:5173")],
  page: { path: "/", includes: "<div id=\"root\">" },
  edit: { file: "packages/web/src/App.jsx", from: "monorepo v1", to: "monorepo v2", served: "/src/App.jsx", includes: "monorepo v2" },
  visible: { before: "Campaign monorepo v1", after: "Campaign monorepo v2", hot: true, title: "shared v1" },
};


// Other frameworks and languages: each has its own start flags and its own quirks.
const frameworkWeb = (id, port, command, extra = {}) => ({
  id,
  kind: "preview",
  ...node({ command }),
  endpoints: [http(port)],
  ...extra,
});

fixtures["astro"] = {
  title: "Astro (npm)",
  install: ["astro"],
  scripts: { dev: "astro dev", build: "astro build", preview: "astro preview" },
  files: {
    "astro.config.mjs": `import { defineConfig } from "astro/config";\nexport default defineConfig({});\n`,
    "src/pages/index.astro": `---\nconst title = "Campaign astro v1";\n---\n<html><body><h1>{title}</h1></body></html>\n`,
    ".gitignore": "node_modules\ndist\n.astro\n",
  },
  manifest: manifest({
    project: { root: ".", detectedStack: ["node", "astro"], confidence: "high" },
    setup: [deps()],
    services: [frameworkWeb("web", 4321, "npm run dev -- --host 0.0.0.0 --port 4321", { production: { build: "npm run build", command: "npm run preview -- --host 0.0.0.0 --port 4321" } })],
  }),
  runConfigurations: [webConfig("web", "http://localhost:4321")],
  page: { path: "/", includes: "Campaign astro v1" },
  edit: { file: "src/pages/index.astro", from: "astro v1", to: "astro v2", served: "/", includes: "astro v2" },
  visible: { before: "Campaign astro v1", after: "Campaign astro v2", hot: false },
};

fixtures["sveltekit"] = {
  title: "SvelteKit (npm)",
  install: ["@sveltejs/kit", "@sveltejs/vite-plugin-svelte", "svelte", "vite"],
  scripts: { dev: "vite dev", build: "vite build", preview: "vite preview" },
  files: {
    "vite.config.js": `import { sveltekit } from "@sveltejs/kit/vite";\nimport { defineConfig } from "vite";\nexport default defineConfig({ plugins: [sveltekit()] });\n`,
    "src/app.html": `<!doctype html>\n<html><head>%sveltekit.head%</head><body><div style="display: contents">%sveltekit.body%</div></body></html>\n`,
    "src/routes/+page.svelte": `<h1>Campaign svelte v1</h1>\n`,
    ".gitignore": "node_modules\n.svelte-kit\n",
  },
  manifest: manifest({
    project: { root: ".", detectedStack: ["node", "svelte", "vite"], confidence: "high" },
    setup: [deps()],
    services: [frameworkWeb("web", 5173, "npm run dev -- --host 0.0.0.0 --port 5173 --strictPort", { production: { build: "npm run build", command: "npm run preview -- --host 0.0.0.0 --port 5173 --strictPort" } })],
  }),
  runConfigurations: [webConfig("web", "http://localhost:5173")],
  page: { path: "/", includes: "Campaign svelte v1" },
  edit: { file: "src/routes/+page.svelte", from: "svelte v1", to: "svelte v2", served: "/", includes: "svelte v2" },
  visible: { before: "Campaign svelte v1", after: "Campaign svelte v2", hot: true },
};

fixtures["nuxt"] = {
  title: "Nuxt (npm)",
  install: ["nuxt", "vue", "vue-router"],
  scripts: { dev: "nuxt dev", build: "nuxt build" },
  files: {
    "nuxt.config.ts": `export default defineNuxtConfig({ compatibilityDate: "2025-01-01", devtools: { enabled: false }, telemetry: false });\n`,
    "app.vue": `<template><h1>Campaign nuxt v1</h1></template>\n`,
    ".gitignore": "node_modules\n.nuxt\n.output\n",
  },
  manifest: manifest({
    project: { root: ".", detectedStack: ["node", "nuxt", "vue"], confidence: "high" },
    setup: [deps()],
    services: [frameworkWeb("web", 3000, "npm run dev -- --host 0.0.0.0 --port 3000", { environment: { NUXT_TELEMETRY_DISABLED: "1" } })],
  }),
  runConfigurations: [webConfig("web", "http://localhost:3000")],
  page: { path: "/", includes: "Campaign nuxt v1" },
  edit: { file: "app.vue", from: "nuxt v1", to: "nuxt v2", served: "/", includes: "nuxt v2" },
  visible: { before: "Campaign nuxt v1", after: "Campaign nuxt v2", hot: true },
};

// A project whose setup also writes into the worktree (so it is not a plain
// install): a story that skipped it would start without the file and answer
// 500 on /generated.
fixtures["setup-writes"] = {
  title: "Setup that generates a file the server needs",
  install: ["express"],
  scripts: { dev: "node server.js" },
  files: {
    "server.js": expressServer({
      extra: `import { readFileSync } from "node:fs";\napp.get("/generated", (_req, res) => res.send(readFileSync("generated.txt", "utf8")));`,
    }),
    "gen.mjs": `import { writeFileSync } from "node:fs";\nwriteFileSync("generated.txt", "generated by setup\\n");\n`,
    ".gitignore": "node_modules\ngenerated.txt\n",
  },
  manifest: manifest({
    setup: [deps("npm install --no-package-lock && node gen.mjs")],
    services: [{ id: "api", kind: "preview", ...node({ command: "npm run dev" }), endpoints: [http(3000, "/health")] }],
  }),
  runConfigurations: [webConfig("api", "http://localhost:3000")],
  page: { path: "/generated", includes: "generated by setup" },
  edit: { skipEdit: true },
};

// What `nuxi init` writes: a postinstall that generates .nuxt in the worktree.
fixtures["nuxt-postinstall"] = {
  ...fixtures["nuxt"],
  title: "Nuxt with the postinstall script nuxt prepare",
  scripts: { dev: "nuxt dev", build: "nuxt build", postinstall: "nuxt prepare" },
};

fixtures["go-http"] = {
  title: "Go net/http (golang image, go run)",
  files: {
    "go.mod": "module campaign\n\ngo 1.24\n",
    "main.go": `package main\n\nimport (\n\t"fmt"\n\t"net/http"\n)\n\nfunc main() {\n\thttp.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<h1>Campaign go v1</h1>") })\n\thttp.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") })\n\thttp.ListenAndServe("0.0.0.0:8080", nil)\n}\n`,
  },
  manifest: manifest({
    project: { root: ".", detectedStack: ["go"], confidence: "high" },
    setup: [{ id: "deps", container: { image: "golang:1.24-bookworm" }, workingDir: "/workspace", command: "go mod download" }],
    services: [{ id: "web", kind: "preview", container: { image: "golang:1.24-bookworm" }, workingDir: "/workspace", command: "go run .", endpoints: [http(8080, "/health", 120_000)] }],
  }),
  runConfigurations: [webConfig("web", "http://localhost:8080")],
  page: { path: "/", includes: "Campaign go v1" },
  edit: undefined,
};

fixtures["php-builtin"] = {
  title: "PHP built-in server (php image)",
  files: {
    "public/index.php": `<h1>Campaign php v1</h1><?php echo "<p>" . phpversion() . "</p>";\n`,
    "public/health.php": `<?php echo "ok";\n`,
  },
  manifest: manifest({
    project: { root: ".", detectedStack: ["php"], confidence: "high" },
    setup: [],
    services: [{ id: "web", kind: "preview", container: { image: "php:8.4-cli-bookworm" }, workingDir: "/workspace", command: "php -S 0.0.0.0:8000 -t public", endpoints: [http(8000, "/health.php")] }],
  }),
  runConfigurations: [webConfig("web", "http://localhost:8000")],
  page: { path: "/", includes: "Campaign php v1" },
  edit: { file: "public/index.php", from: "php v1", to: "php v2", served: "/", includes: "php v2" },
};


// ---- the situations real projects bring: odd names, other branches, size, other tools.
const expressBase = fixtures["express-api"];
fixtures["odd-path"] = {
  ...expressBase,
  title: "A project folder with spaces, an accent, an apostrophe, parentheses, & and $",
  dirName: "My Café App's Project (v2) & co $HOME",
};
// One odd character class at a time, to name the one that breaks.
for (const [slug, dirName] of Object.entries({
  space: "My Project",
  accent: "Café",
  apostrophe: "O'Brien app",
  parens: "app (v2)",
  ampersand: "R&D tools",
  dollar: "cost $HOME app",
  hash: "issue #12 fix",
  unicode: "项目 проект",
  percent: "100% done",
  brackets: "app [staging] {x}",
  semicolon: "a;b",
}))
  fixtures[`odd-path-${slug}`] = { ...expressBase, title: `A project folder named ${JSON.stringify(dirName)}`, dirName };
fixtures["odd-title"] = {
  ...expressBase,
  title: "A story whose title is full of shell and path characters",
  storyTitle: "Fix \"login\" <b>flow</b> — user's 🚀 café `$(whoami)` ../../etc \\ ; rm -rf / # " + "very long ".repeat(30),
};
fixtures["develop-branch"] = {
  ...expressBase,
  title: "A story targeting `develop`, which differs from `main`",
  targetBranch: "develop",
  extraBranch: { name: "develop", replace: [["server.js", "express v1", "express develop-v1"]] },
  page: { path: "/", includes: "Campaign express develop-v1" },
  edit: undefined,
};
fixtures["master-branch"] = {
  ...expressBase,
  title: "A repository whose default branch is master",
  initialBranch: "master",
};
fixtures["big-repo"] = {
  ...expressBase,
  title: "A repository with 40 000 tracked files and ~150 MB",
  bulk: { files: 40_000, megabytes: 150 },
};
fixtures["yarn-app"] = {
  title: "Yarn classic through corepack",
  yarn: true,
  install: ["express"],
  files: { "server.js": expressServer({}), ".gitignore": "node_modules\n" },
  scripts: { dev: "node --watch server.js" },
  manifest: manifest({
    setup: [deps("corepack prepare yarn@1.22.22 --activate && corepack yarn install --non-interactive")],
    services: [{ id: "api", kind: "preview", ...node({ command: "corepack prepare yarn@1.22.22 --activate && corepack yarn dev" }), endpoints: [http(3000, "/health")] }],
  }),
  runConfigurations: [webConfig("api", "http://localhost:3000")],
  page: { path: "/", includes: "Campaign express v1" },
  edit: { file: "server.js", from: "express v1", to: "express v2", served: "/", includes: "express v2" },
};
fixtures["next-prisma-mysql"] = {
  title: "Next.js + Prisma 6 + MySQL (generate, db push, seed)",
  install: ["next", "react", "react-dom", "@prisma/client@6"],
  devInstall: ["prisma@6"],
  scripts: { dev: "next dev", build: "next build", start: "next start", "db:push": "prisma db push --skip-generate", seed: "node prisma/seed.mjs" },
  files: {
    ".gitignore": "node_modules\n.next\n",
    "prisma/schema.prisma": `generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "mysql"\n  url      = env("DATABASE_URL")\n}\n\nmodel User {\n  id   Int    @id @default(autoincrement())\n  name String\n}\n`,
    "prisma/seed.mjs": `import { PrismaClient } from "@prisma/client";\nconst prisma = new PrismaClient();\nif ((await prisma.user.count()) === 0) await prisma.user.createMany({ data: [{ name: "Ada" }, { name: "Grace" }] });\nawait prisma.$disconnect();\nconsole.log("seeded");\n`,
    "lib/db.js": `import { PrismaClient } from "@prisma/client";\nconst globalForPrisma = globalThis;\nexport const prisma = globalForPrisma.prisma ?? new PrismaClient();\nif (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;\n`,
    "app/layout.jsx": `export default function Layout({ children }) {\n  return (<html><body>{children}</body></html>);\n}\n`,
    "app/page.jsx": `import { prisma } from "../lib/db";\nexport const dynamic = "force-dynamic";\nexport default async function Page() {\n  const users = await prisma.user.findMany({ orderBy: { id: "asc" } });\n  return (<main><h1>Campaign prisma v1</h1><ul>{users.map((user) => (<li key={user.id}>{user.name}</li>))}</ul></main>);\n}\n`,
    "app/api/health/route.js": `export function GET() {\n  return Response.json({ ok: true });\n}\n`,
  },
  manifest: (() => {
    const databaseUrl = "mysql://blame:blame@database:3306/blame";
    return manifest({
      project: { root: ".", detectedStack: ["node", "next", "prisma", "mysql"], confidence: "high" },
      setup: [
        deps("npm install --no-package-lock && npx prisma generate"),
        { id: "migrate", ...node({ command: "npx prisma db push --skip-generate", environment: { DATABASE_URL: databaseUrl }, dependsOn: ["database"] }) },
        { id: "seed", ...node({ command: "node prisma/seed.mjs", environment: { DATABASE_URL: databaseUrl }, dependsOn: ["database"] }) },
      ],
      services: [
        {
          id: "database",
          kind: "dependency",
          container: { image: "mysql:8.4" },
          environment: { MYSQL_ROOT_PASSWORD: "blame", MYSQL_DATABASE: "blame", MYSQL_USER: "blame", MYSQL_PASSWORD: "blame" },
          endpoints: [{ id: "mysql", protocol: "tcp", port: 3306, healthcheck: { type: "tcp", timeoutMs: 120_000 } }],
        },
        {
          id: "web",
          kind: "preview",
          ...node({ command: "npm run dev -- -H 0.0.0.0 -p 3000", environment: { DATABASE_URL: databaseUrl }, dependsOn: ["database"] }),
          endpoints: [http(3000, "/api/health", 120_000)],
        },
      ],
      probes: [{ id: "home", from: "host", type: "http", target: { service: "web", endpoint: "http", path: "/" }, acceptedStatuses: [200] }],
    });
  })(),
  runConfigurations: [webConfig("web", "http://localhost:3000", ["web", "database"])],
  page: { path: "/", includes: "Ada" },
  edit: { file: "app/page.jsx", from: "prisma v1", to: "prisma v2", served: "/", includes: "prisma v2" },
  visible: { before: "Campaign prisma v1", after: "Campaign prisma v2", hot: true },
};

/** Writes a fixture project (once) and commits it: a git repository with a lockfile. */
export async function writeFixture(root, name) {
  const fixture = fixtures[name];
  const directory = join(root, fixture.dirName ?? name);
  if (await stat(join(directory, ".git")).then(() => true, () => false)) return directory;
  await rm(directory, { force: true, recursive: true });
  if (fixture.pnpm) {
    for (const [path, content] of Object.entries(fixture.files)) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), content);
    }
    for (const step of fixture.pnpmAdd ?? [])
      await run("corepack", ["pnpm@9.15.4", "add", ...step.args, "--lockfile-only", "--ignore-scripts"], { cwd: join(directory, step.cwd) });
    await run("corepack", ["pnpm@9.15.4", "install", "--lockfile-only", "--ignore-scripts"], { cwd: directory });
    return commitFixture(directory, fixture);
  }
  const parts = fixture.subdirs ?? { ".": { install: fixture.install ?? [], scripts: fixture.scripts ?? {} } };
  for (const [path, content] of Object.entries(fixture.files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  for (const [sub, part] of Object.entries(parts)) {
    if (!part.install?.length && !part.scripts) continue;
    const base = join(directory, sub);
    await mkdir(base, { recursive: true });
    await writeFile(
      join(base, "package.json"),
      JSON.stringify({ name: `campaign-${name}-${sub === "." ? "app" : sub}`, version: "1.0.0", private: true, type: "module", scripts: part.scripts ?? {} }, null, 2) + "\n",
    );
    if (part.install?.length)
      await run("npm", ["install", ...part.install, "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: base });
    if (fixture.devInstall?.length && sub === ".")
      await run("npm", ["install", "-D", ...fixture.devInstall, "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: base });
  }
  if (fixture.yarn) await run("corepack", ["yarn@1.22.22", "install", "--ignore-scripts", "--mode", "update-lockfile"], { cwd: directory }).catch(() => run("corepack", ["yarn@1.22.22", "generate-lock-entry"], { cwd: directory }).catch(() => undefined));
  if (fixture.afterInstall?.dependencies) {
    const path = join(directory, "package.json");
    const current = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
    current.dependencies = { ...current.dependencies, ...fixture.afterInstall.dependencies };
    await writeFile(path, JSON.stringify(current, null, 2) + "\n");
  }
  return commitFixture(directory, fixture);
}

async function commitFixture(directory, fixture) {
  const git = (...args) => run("git", args, { cwd: directory, maxBuffer: 64 * 1024 * 1024 });
  const commit = (message) => git("-c", "user.name=Campaign", "-c", "user.email=campaign@example.com", "commit", "-q", "-m", message);
  await git("init", "-q", "-b", fixture.initialBranch ?? "main");
  if (fixture.bulk) {
    // Many small files and a few big ones, as a real repository grows.
    const per = Math.ceil(fixture.bulk.files / 200);
    const chunk = "x".repeat(2048);
    for (let folder = 0; folder < 200; folder += 1) {
      const base = join(directory, "bulk", `d${folder}`);
      await mkdir(base, { recursive: true });
      await Promise.all(Array.from({ length: per }, (_, index) => writeFile(join(base, `f${index}.txt`), `${folder}-${index}\n${chunk}`)));
    }
    const big = Buffer.alloc(1024 * 1024, 7);
    for (let index = 0; index < Math.max(1, Math.floor(fixture.bulk.megabytes / 10)); index += 1)
      await writeFile(join(directory, `bulk/big${index}.bin`), Buffer.concat(Array.from({ length: 10 }, () => big)));
  }
  await git("add", "-A");
  await commit("Initial commit");
  if (fixture.extraBranch) {
    await git("checkout", "-q", "-b", fixture.extraBranch.name);
    for (const [file, from, to] of fixture.extraBranch.replace ?? []) {
      const path = join(directory, file);
      await writeFile(path, (await readFile(path, "utf8")).replace(from, to));
    }
    await git("add", "-A");
    await commit("Develop changes");
    await git("checkout", "-q", fixture.initialBranch ?? "main");
  }
  for (const [path, content] of Object.entries(fixture.untracked ?? {})) await writeFile(join(directory, path), content);
  return directory;
}
