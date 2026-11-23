// Full-stack projects whose browser checks depend on more than a running port.
const python = "python:3.12-bookworm";
const node = "node:22-bookworm";
const venv = "/opt/venv";
const pythonCommand = (workingDir, command) => ({ container: { image: python }, workingDir, command });
const installPython = (workingDir) => ({
  id: "python-deps",
  ...pythonCommand(workingDir, `python -m venv ${venv} && ${venv}/bin/pip install -r requirements.txt`),
});
const http = (port, path = "/") => ({
  id: "http", protocol: "http", port, healthcheck: { type: "http", path, timeoutMs: 90_000 },
});
const tcp = (port) => ({ id: "tcp", protocol: "tcp", port, healthcheck: { type: "tcp", timeoutMs: 90_000 } });

function project(detectedStack, setup, services, healthPath, caches = []) {
  return {
    confidence: "high",
    project: { root: ".", confidence: "high", detectedStack },
    setup,
    services,
    caches,
    risks: [],
    probes: [{ id: "health", from: "host", type: "http", target: { service: "web", endpoint: "http", path: healthPath }, acceptedStatuses: [200], required: true }],
  };
}

function config(port, command, services, path = "/", cwd = ".") {
  return [{
    id: "web", name: "Web app", default: true, category: "web", cwd, command,
    services, previewService: "web", scopes: ["."], previewUrl: `http://localhost:${port}${path}`,
  }];
}

const databaseEnv = {
  DJANGO_SETTINGS_MODULE: "settings",
  POSTGRES_HOST: "database",
  POSTGRES_DB: "campaign",
  POSTGRES_USER: "campaign",
  POSTGRES_PASSWORD: "campaign-test",
  REDIS_URL: "redis://redis:6379/0",
};
const manage = (command) => `${venv}/bin/python -m django ${command}`;

const djangoCelery = {
  title: "Django + PostgreSQL migrations + Celery worker on Redis",
  initializationFile: "requirements.txt",
  files: {
    ".gitignore": "__pycache__/\n",
    "requirements.txt": "Django==5.2.8\npsycopg[binary]==3.2.12\ncelery[redis]==5.5.3\n",
    "settings.py": `import os

ROOT_URLCONF = "urls"
SECRET_KEY = "campaign-fixture"
ALLOWED_HOSTS = ["*"]
INSTALLED_APPS = ["django.contrib.contenttypes", "django.contrib.auth"]
DATABASES = {"default": {
    "ENGINE": "django.db.backends.postgresql",
    "HOST": os.environ["POSTGRES_HOST"],
    "NAME": os.environ["POSTGRES_DB"],
    "USER": os.environ["POSTGRES_USER"],
    "PASSWORD": os.environ["POSTGRES_PASSWORD"],
}}
`,
    "jobs.py": `import os

import django
from celery import Celery

django.setup()
from django.contrib.auth.models import Group

celery = Celery("campaign", broker=os.environ["REDIS_URL"])

@celery.task
def write_group():
    Group.objects.get_or_create(name="processed by worker")
`,
    "urls.py": `from django.contrib.auth.models import Group
from django.http import HttpResponse, JsonResponse
from django.urls import path
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST
from jobs import write_group

def status(request):
    return JsonResponse({"processed": Group.objects.filter(name="processed by worker").count()})

@csrf_exempt
@require_POST
def enqueue(request):
    write_group.delay()
    return JsonResponse({"queued": True}, status=202)

def home(request):
    return HttpResponse("""<!doctype html><h1>Django queue v1</h1>
    <button id="enqueue">Run the job</button><output id="status"></output>
    <script>
      async function refresh() {
        const data = await fetch('/status').then(r => r.json());
        document.querySelector('#status').textContent = 'Processed: ' + data.processed;
      }
      document.querySelector('#enqueue').onclick = async () => {
        const reply = await fetch('/enqueue', {method: 'POST'});
        if (!reply.ok) throw new Error('Could not queue job');
      };
      refresh();
      setInterval(refresh, 500);
    </script>""")

urlpatterns = [path("", home), path("status", status), path("enqueue", enqueue)]
`,
  },
  manifest: project(["python", "django", "postgres", "redis", "celery"], [
    installPython("/workspace"),
    { id: "migrate", ...pythonCommand("/workspace", manage("migrate --noinput")), environment: databaseEnv, dependsOn: ["database", "python-deps"] },
  ], [
    { id: "database", kind: "dependency", container: { image: "postgres:17-bookworm" }, environment: databaseEnv, endpoints: [tcp(5432)] },
    { id: "redis", kind: "dependency", container: { image: "redis:7-bookworm" }, endpoints: [tcp(6379)] },
    { id: "jobs", kind: "worker", ...pythonCommand("/workspace", `${venv}/bin/celery -A jobs worker --pool=solo --loglevel=INFO`), environment: databaseEnv, dependsOn: ["migrate", "redis"], endpoints: [] },
    { id: "web", kind: "preview", ...pythonCommand("/workspace", manage("runserver 0.0.0.0:8000")), environment: databaseEnv, dependsOn: ["jobs", "migrate"], endpoints: [http(8000, "/status")] },
  ], "/status", [{ name: "venv", target: venv }]),
  runConfigurations: config(8000, "python -m django runserver", ["web", "jobs", "database", "redis"]),
  page: { path: "/", includes: "Django queue v1" },
  visible: { before: "Django queue v1", after: "Django queue v2" },
  edit: { file: "urls.py", from: "Django queue v1", to: "Django queue v2" },
  browserFlow: { initial: "Processed: 0", click: "#enqueue", result: "Processed: 1" },
};

const viteFastapi = {
  title: "Vite + React in a nested app, with FastAPI and WebSocket",
  initializationFile: "web/package.json",
  subdirs: { web: { install: ["vite@6.4.1", "@vitejs/plugin-react@4.7.0", "react@19.2.0", "react-dom@19.2.0"], scripts: { dev: "vite", build: "vite build" } } },
  files: {
    ".gitignore": "node_modules/\n__pycache__/\ndist/\n",
    "api/requirements.txt": "fastapi==0.115.12\nuvicorn==0.34.3\nwebsockets==15.0.1\n",
    "api/server.py": `from fastapi import FastAPI, WebSocket

app = FastAPI()

@app.get("/health")
def health():
    return {"ready": True}

@app.websocket("/socket")
async def socket(connection: WebSocket):
    await connection.accept()
    message = await connection.receive_text()
    await connection.send_text(f"FastAPI echoed: {message}")
    await connection.close()
`,
    "web/index.html": '<!doctype html><div id="root"></div><script type="module" src="/src.jsx"></script>\n',
    "web/vite.config.js": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/socket": { target: process.env.API_ORIGIN, ws: true } } },
});
`,
    "web/banner.js": 'export const banner = "Multiservice WebSocket v1";\n',
    "web/src.jsx": `import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { banner } from "./banner.js";

function App() {
  const [result, setResult] = useState("Waiting for message");
  function send() {
    const url = new URL("/socket", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.onopen = () => socket.send("campaign");
    socket.onmessage = (event) => setResult(event.data);
    socket.onerror = () => setResult("WebSocket failed");
  }
  return <main><h1>{banner}</h1><button id="send" onClick={send}>Send</button><output>{result}</output></main>;
}

createRoot(document.getElementById("root")).render(<App />);
`,
  },
  manifest: project(["node", "vite", "react", "python", "fastapi"], [
    installPython("/workspace/api"),
    { id: "node-deps", container: { image: node }, workingDir: "/workspace/web", command: "npm install --no-package-lock --no-audit --no-fund" },
  ], [
    { id: "api", kind: "worker", ...pythonCommand("/workspace/api", `${venv}/bin/uvicorn server:app --host 0.0.0.0 --port 8000`), dependsOn: ["python-deps"], endpoints: [http(8000, "/health")] },
    {
      id: "web", kind: "preview", container: { image: node }, workingDir: "/workspace/web",
      command: "npm run dev -- --host 0.0.0.0 --port 5173 --strictPort",
      environment: { API_ORIGIN: "http://api:8000" },
      dependsOn: ["api", "node-deps"], endpoints: [http(5173)],
    },
  ], "/", [{ name: "venv", target: venv }]),
  runConfigurations: config(5173, "npm run dev", ["web", "api"], "/", "web"),
  page: { path: "/", includes: 'id="root"' },
  visible: { before: "Multiservice WebSocket v1", after: "Multiservice WebSocket v2", hot: true },
  edit: { file: "web/banner.js", from: "Multiservice WebSocket v1", to: "Multiservice WebSocket v2" },
  browserFlow: { initial: "Waiting for message", click: "#send", result: "FastAPI echoed: campaign" },
};

const rustImage = "rust:1.88-bookworm";
const rust = (command) => ({ container: { image: rustImage }, workingDir: "/workspace/service", command });
const rustSqlite = {
  title: "Rust + Axum + bundled SQLite in a Cargo workspace",
  initializationFile: "Cargo.toml",
  files: {
    ".gitignore": "target/\n*.sqlite3\n",
    "Cargo.toml": '[workspace]\nmembers = ["service"]\nresolver = "2"\n',
    "service/Cargo.toml": `[package]
name = "campaign-preview"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = "=0.8.4"
rusqlite = { version = "=0.32.1", features = ["bundled"] }
tokio = { version = "=1.45.1", features = ["macros", "net", "rt-multi-thread"] }
`,
    "service/src/main.rs": `use axum::{response::Html, routing::get, Router};
use rusqlite::Connection;

#[tokio::main]
async fn main() {
    let database = Connection::open("campaign.sqlite3").unwrap();
    database.execute_batch(include_str!("../bootstrap.sql")).unwrap();
    let row: String = database.query_row("SELECT message FROM banner", [], |row| row.get(0)).unwrap();
    let app = Router::new()
        .route("/reports/summary", get(move || async move {
            Html(format!("<h1>{row}</h1><p>Rendered by Rust and SQLite</p>"))
        }))
        .route("/health", get(|| async { "ready" }));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
`,
    "service/bootstrap.sql": `CREATE TABLE IF NOT EXISTS banner (message TEXT NOT NULL);
INSERT INTO banner SELECT 'Campaign summary' WHERE NOT EXISTS (SELECT 1 FROM banner);
`,
  },
  manifest: project(["rust", "axum", "sqlite"], [
    { id: "compile", ...rust("cargo build") },
  ], [
    { id: "web", kind: "preview", ...rust("../target/debug/campaign-preview"), dependsOn: ["compile"], endpoints: [http(8080, "/health")] },
  ], "/health", [
    { name: "cargo-registry", target: "/usr/local/cargo/registry" },
    { name: "cargo-target", target: "/workspace/target" },
  ]),
  runConfigurations: config(8080, "cargo run", ["web"], "/reports/summary", "service"),
  page: { path: "/reports/summary", includes: "Campaign summary" },
  expectUrlPath: "/reports/summary",
  visible: { path: "/reports/summary", before: "Rendered by Rust and SQLite" },
};

export const advancedFixtures = {
  "django-celery": djangoCelery,
  "vite-fastapi-ws": viteFastapi,
  "rust-axum-sqlite": rustSqlite,
};
