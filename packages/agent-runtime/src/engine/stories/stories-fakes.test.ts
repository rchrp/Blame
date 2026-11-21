// Fakes for the story service's tests (no test of its own): the account's
// API in memory, an engine host with per-session answers, and a ledger file
// saying which stories this computer runs.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineHostMethod } from "../protocol.js";
import type { StoryHostEvent } from "../story-protocol.js";
import { StoryService, type StoryServiceOptions } from "./service.js";

export type Row = Record<string, unknown> & { id: string; projectId: string };
type Request = { method: string; path: string; at: number };

/**
 * The account's API, in memory: stories, their PATCH and DELETE, and the
 * project's environment. `fail` makes requests matching a test answer 500
 * (once, or until stopped); `hold` keeps answers back until released (a
 * held PATCH is applied when released).
 */
export function fakeApi(rows: Row[]) {
  const stories = new Map(rows.map((row) => [row.id, { ...row }]));
  const requests: Request[] = [];
  const failures: Array<{
    matches: (request: Request) => boolean;
    always: boolean;
  }> = [];
  const holds: Array<{
    match: (request: Request) => boolean;
    gate: Promise<void>;
  }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/api\/v1/, "");
    const method = init?.method ?? "GET";
    const request = { method, path, at: Date.now() };
    requests.push(request);
    const json = (value: unknown) =>
      new Response(JSON.stringify({ data: value }), { status: 200 });
    // A list is read when it is asked, whenever it is answered.
    const snapshot =
      path === "/projects/user-stories" && method === "GET"
        ? [...stories.values()]
            .filter((row) => row.projectId === searchParams.get("projectId"))
            .map((row) => ({ ...row }))
        : undefined;
    const held = holds.find((hold) => hold.match(request));
    if (held) await held.gate;
    const failing = failures.findIndex(({ matches }) => matches(request));
    if (failing >= 0) {
      if (!failures[failing]!.always) failures.splice(failing, 1);
      return new Response(JSON.stringify({ message: "unavailable" }), {
        status: 500,
      });
    }
    if (snapshot) return json(snapshot);
    const story = /^\/projects\/user-stories\/([^/]+)$/.exec(path);
    if (story) {
      const row = stories.get(story[1]!);
      if (!row)
        return new Response(JSON.stringify({ message: "Row not found" }), {
          status: 404,
        });
      if (method === "DELETE") {
        stories.delete(row.id);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH")
        Object.assign(row, JSON.parse(String(init!.body)), {
          updatedAt: new Date().toISOString(),
        });
      return json({ ...row });
    }
    if (/^\/projects\/[^/]+\/initialization$/.test(path))
      return json({ initialization: null, practices: [] });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return {
    stories,
    requests,
    fail: (matches: (request: Request) => boolean, always = false) => {
      const failure = { matches, always };
      failures.push(failure);
      return () => failures.splice(failures.indexOf(failure), 1);
    },
    hold(match: (request: Request) => boolean) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      holds.push({ match, gate });
      return release;
    },
    restore: () => (globalThis.fetch = original),
  };
}

export type Status = {
  session: string;
  exists: boolean;
  running: boolean;
  turnRunning?: boolean;
  turns: number;
  models: Array<{ providerId: string; modelId: string; turns: number }>;
  lastOutcome?: { status: string };
  endedTurns?: Array<{
    turn: string;
    outcome: { status: string };
    reply?: string;
  }>;
};

export function runningStatus(session: string): Status {
  return {
    session,
    exists: true,
    running: true,
    turnRunning: true,
    turns: 1,
    models: [],
  };
}

export function endedStatus(
  session: string,
  turns: Array<[string, string, string?]>,
): Status {
  const endedTurns = turns.map(([turn, status, reply]) => ({
    turn,
    outcome: { status },
    ...(reply ? { reply } : {}),
  }));
  return {
    session,
    exists: true,
    running: false,
    turnRunning: false,
    turns: turns.length,
    models: [
      { providerId: "anthropic", modelId: "claude", turns: turns.length },
    ],
    lastOutcome: endedTurns.at(-1)?.outcome,
    endedTurns,
  };
}

/** What a session's `status` does instead of answering. */
export type StatusTrouble = "throw" | "hang";

export function fakeHost() {
  const calls: Array<{ method: EngineHostMethod; input: unknown }> = [];
  const events: StoryHostEvent[] = [];
  const statuses = new Map<string, Status>();
  const troubles = new Map<string, StatusTrouble>();
  const live = new Set<string>();
  const order: string[] = [];
  const removeDelay = { ms: 0 };
  const connection = { url: "http://api.test/api/v1", token: "token" };
  const host = {
    api: () => connection,
    call: async (method: EngineHostMethod, input: unknown) => {
      calls.push({ method, input });
      if (method === "createSession")
        return { session: (input as { session: string }).session, head: 0 };
      if (method === "send") {
        const session = (input as { session: string }).session;
        live.add(session);
        statuses.set(session, runningStatus(session));
        return { turn: "turn", started: true };
      }
      if (method === "running") return [...live];
      if (method === "status")
        return Promise.all(
          (input as { sessions: string[] }).sessions.map(async (session) => {
            const trouble = troubles.get(session);
            if (trouble === "hang") await new Promise(() => undefined);
            if (trouble === "throw") throw new Error("the store is busy");
            return (
              statuses.get(session) ?? {
                session,
                exists: false,
                running: false,
                turns: 0,
                models: [],
              }
            );
          }),
        );
      if (method === "approveAndMerge")
        return {
          baseCommit: "base",
          mergeCommit: "merge",
          push: { status: "skipped" },
          targetBranch: "main",
        };
      return null;
    },
    desktop: {
      checkHostDependencies: async () => ({ ok: true }),
      gitIdentity: async () => ({ available: true, configured: true }),
      createStoryWorktree: async (input: {
        repositoryRoot: string;
        storyId: string;
      }) => {
        order.push(`create ${input.storyId}`);
        return {
          branch: "main",
          targetBranch: "main",
          workspaceMode: "direct" as const,
          worktree: input.repositoryRoot,
        };
      },
      git: async () => "abc123\n",
      prepareStoryTurn: async () => null,
      beginGitFlow: async () => ({
        inVm: false,
        activeWorktrees: [],
        operation: "flow",
      }),
      endGitFlow: async () => null,
      stopStoryRuntime: async () => ({ projectSetupStopped: true }),
      removeStoryWorktree: async (input: { worktree: string }) => {
        await new Promise((resolve) => setTimeout(resolve, removeDelay.ms));
        order.push(`remove ${input.worktree}`);
        return true;
      },
      readWorkspaceFile: async () => '{"repaired":true}',
    },
    emit: (event: StoryHostEvent) => events.push(event),
  };
  return {
    host,
    connection,
    calls,
    events,
    statuses,
    troubles,
    live,
    order,
    removeDelay,
  };
}

export const preferences = {
  agentModel: { providerId: "anthropic", modelId: "claude" },
  runMode: "direct" as const,
  premium: false,
  runtimePhase: "ready",
};

export function sync(
  service: StoryService,
  projects: Array<{ id: string; path: string }>,
  window = "window",
  prefs: Record<string, unknown> = preferences,
) {
  return service.sync({ window, projects, preferences: prefs as never });
}

export function row(
  id: string,
  projectId: string,
  fields: Record<string, unknown> = {},
): Row {
  return {
    id,
    projectId,
    storyNumber: 1,
    title: id,
    summary: `Do ${id}`,
    status: "ready",
    runMode: "direct",
    createdAt: "2026-11-21T10:00:00.000Z",
    ...fields,
  };
}

export function working(session: string, fields: Record<string, unknown> = {}) {
  return {
    status: "in-progress",
    agentStatus: "Running",
    engineSessionId: session,
    workspaceMode: "direct",
    worktree: "/a",
    ...fields,
  };
}

/**
 * A story service whose ledger says this computer runs `owned` (story id →
 * its session, if any) in project "a" at "/a"; each owned session has no
 * turn told yet.
 */
export async function service(
  host: ReturnType<typeof fakeHost>["host"],
  owned: Record<string, string | null> = {},
  options: StoryServiceOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "story-service-"));
  const ledgerFile = join(directory, "stories.json");
  await writeFile(
    ledgerFile,
    JSON.stringify({
      version: 2,
      stories: Object.fromEntries(
        Object.entries(owned).map(([storyId, session]) => [
          storyId,
          { projectId: "a", path: "/a", ...(session ? { session } : {}) },
        ]),
      ),
      sessions: Object.fromEntries(
        Object.values(owned)
          .filter((session): session is string => Boolean(session))
          .map((session) => [session, []]),
      ),
    }),
  );
  const instance = new StoryService(host as never, { ledgerFile, ...options });
  return {
    service: instance,
    ledgerFile,
    async close() {
      instance.stop();
      // A ledger write may still land in the folder.
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 20,
      });
    },
  };
}

export async function settle(
  until: () => boolean,
  what = "the service to settle",
) {
  for (let attempt = 0; attempt < 500 && !until(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(until(), `waited for ${what}`);
}

export const pause = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
