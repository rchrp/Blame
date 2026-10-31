// A scripted agent run that walks through the five Light Semantic Harness
// primitives on one small user story. Illustrative content, not a recording.

export const harnessStory = "Stop retrying a failed upload after five attempts";

export type DiffLine = {
  text: string;
  type: "add" | "context" | "hunk" | "remove";
};

export type TraceBody =
  | {
      kind: "hits";
      hits: { code: string; kind: string; location: string }[];
    }
  | { kind: "code"; lines: string[]; startLine: number }
  | { kind: "diff"; lines: DiffLine[]; refused: string }
  | { kind: "terminal"; binding: string; lines: string[] }
  | { kind: "checks"; checks: { detail: string; label: string }[] };

export type TraceStep = {
  body: TraceBody;
  guard: string;
  guardLabel: string;
  summary: string;
  target: string;
  title: string;
  tool: string;
};

export const harnessSteps: TraceStep[] = [
  {
    tool: "search_code",
    title: "Finds code by its structure",
    summary: "1 declaration, 2 references",
    guardLabel: "Syntax-aware navigation",
    guard:
      "Search reads the syntax tree and the TypeScript project, so the agent lands on the real declaration, not on every comment and string that mentions it.",
    target: "uploadWithRetry",
    body: {
      kind: "hits",
      hits: [
        {
          kind: "function",
          location: "src/upload/retry.ts:12",
          code: "export async function uploadWithRetry(file, opts)",
        },
        {
          kind: "reference",
          location: "src/upload/queue.ts:31",
          code: "await uploadWithRetry(next, policy)",
        },
        {
          kind: "reference",
          location: "src/upload/form.tsx:58",
          code: "uploadWithRetry(file, { maxAttempts })",
        },
      ],
    },
  },
  {
    tool: "read_code",
    title: "Reads before it writes",
    summary: "Lines 12–22",
    guardLabel: "Read coverage required",
    guard:
      "Every read is recorded with the exact version of the file it saw. The agent can only change code it has actually read, in that version.",
    target: "src/upload/retry.ts#uploadWithRetry",
    body: {
      kind: "code",
      startLine: 12,
      lines: [
        "export async function uploadWithRetry(file: File, opts: RetryOptions) {",
        "  let attempt = 0",
        "  while (true) {",
        "    try {",
        "      return await send(file)",
        "    } catch (error) {",
        "      attempt += 1",
        "      await wait(backoff(attempt))",
        "    }",
        "  }",
        "}",
      ],
    },
  },
  {
    tool: "edit_code",
    title: "Edits that can’t clobber your code",
    summary: "+3 −1, one edit refused",
    guardLabel: "Guarded, atomic edits",
    guard:
      "Edits target a declaration and must match the text the agent read. An unread or stale target is refused, and the agent goes back to read it.",
    target: "src/upload/retry.ts",
    body: {
      kind: "diff",
      refused: "queue.ts has not been read. Edit refused.",
      lines: [
        { type: "hunk", text: "@@ -12,2 +12,3 @@" },
        {
          type: "context",
          text: "export async function uploadWithRetry(file: File, opts: RetryOptions) {",
        },
        { type: "add", text: "  const maxAttempts = opts.maxAttempts ?? 5" },
        { type: "context", text: "  let attempt = 0" },
        { type: "hunk", text: "@@ -18,2 +19,3 @@" },
        { type: "context", text: "      attempt += 1" },
        { type: "remove", text: "      await wait(backoff(attempt))" },
        { type: "add", text: "      if (attempt >= maxAttempts) throw error" },
        { type: "add", text: "      await wait(backoff(attempt))" },
      ],
    },
  },
  {
    tool: "run_task",
    title: "Exit code 0 is not a pass",
    summary: "14 passed, 0 failed",
    guardLabel: "Evidence bound to each run",
    guard:
      "Test results are tied to the run and the source revision that produced them. A failing test stays failed, even behind a script that exits 0.",
    target: "pnpm vitest run src/upload",
    body: {
      kind: "terminal",
      binding: "Report bound to this run and to source revision a41c9e2",
      lines: [
        "✓ src/upload/retry.test.ts (9 tests)",
        "✓ src/upload/queue.test.ts (5 tests)",
        "",
        "Test Files  2 passed (2)",
        "     Tests  14 passed (14)",
      ],
    },
  },
  {
    tool: "finish_task",
    title: "Done means verified",
    summary: "Verified",
    guardLabel: "Checked on the final source",
    guard:
      "Before handing back, the agent reruns the required checks on the final code. If one is missing or stale, the work is delivered as unverified, with the reason.",
    target: "the task",
    body: {
      kind: "checks",
      checks: [
        { label: "Typecheck", detail: "Passed on the final source" },
        { label: "Tests in src/upload", detail: "14 passed after the last edit" },
        {
          label: "Changed files",
          detail: "retry.ts and queue.ts, each read before editing",
        },
      ],
    },
  },
];
