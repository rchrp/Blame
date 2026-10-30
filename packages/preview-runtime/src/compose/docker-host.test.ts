import assert from "node:assert/strict";
import test from "node:test";
import { errorExcerpt } from "./command-output.js";
import { commandFailureDetail } from "./docker-host.js";

test("preserves short Compose command output", () => {
  assert.equal(
    commandFailureDetail(" warning \n", " result \n"),
    "result\nwarning",
  );
});

test("keeps the end of each stream, with the error last", () => {
  const lines = (name: string) =>
    Array.from({ length: 100 }, (_, index) => `${name} step ${index}`).join(
      "\n",
    );
  const detail = commandFailureDetail(
    `${lines("compose")}\nERR_PNPM_LIFECYCLE postinstall failed`,
    `${lines("install")}\ninstall done`,
  );

  assert.ok(detail.length <= 1_000);
  assert.match(detail, /Compose output truncated/);
  assert.match(detail, /install done\n/);
  assert.match(detail, /ERR_PNPM_LIFECYCLE postinstall failed$/);
});

test("reports the cause of a failed setup, not its terminal decoration", () => {
  // Captured from a cloud preview of a Prisma project (2026-10-30).
  const stdout = [
    "Progress: resolved 551, reused 0, downloaded 551, added 551, done",
    "",
    "╭ Warning ─────────────────────────────────────────────────────╮",
    "│                                                              │",
    "│   Ignored build scripts: @prisma/engines@7.9.1, prisma@7.9.1. │",
    '│   Run "pnpm approve-builds" to pick which dependencies.     │',
    "╰──────────────────────────────────────────────────────────────╯",
    "Done in 11.8s using pnpm v10.33.2",
    "prisma:warn Prisma failed to detect the libssl/openssl version to use.",
    "prisma:warn Prisma failed to detect the libssl/openssl version to use.",
    "Error: request to https://binaries.prisma.sh/schema-engine.gz.sha256 failed, reason: getaddrinfo EAI_AGAIN binaries.prisma.sh",
    "undefined",
    "/workspace/apps/web:",
    " ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command failed with exit code 1: prisma generate",
  ].join("\n");
  const detail = commandFailureDetail("", stdout);
  assert.match(detail, /EAI_AGAIN binaries\.prisma\.sh/);
  assert.match(detail, /^Ignored build scripts/m);
  assert.equal(detail.match(/libssl/g)?.length, 1);
  assert.doesNotMatch(detail, /[╭╰│─]|^undefined$|Progress:/m);
});

test("drops terminal colors, code frames and stack frames", () => {
  // Captured from AdonisJS rejecting a preview environment (2026-10-30).
  const stderr = [
    "Preparing pnpm@12.15.0 for immediate activation...",
    "\u001b[31mℹ EnvValidationException: Validation failed for one or more environment variables\u001b[39m",
    '\u001b[2m◉\u001b[22m - Missing environment variable "DB_HOST"',
    "\u001b[2m ⁃ at \u001b[3mnew EnvValidator\u001b[23m (/workspace/node_modules/env/index.js:127:17)\u001b[22m",
    "   \u001b[2m17\u001b[22m \u001b[2m┃\u001b[22m    \u001b[33mPORT\u001b[0m: Env.schema.number(),",
    "\u001b[31m❯\u001b[39m 14 \u001b[2m┃\u001b[22m export default await Env.create(",
    " Container blame_0d4c-setup-migrate-run-becf Creating ",
    " Container blame_0d4c-setup-migrate-run-becf Created ",
    "Error: ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL",
  ].join("\n");
  assert.equal(
    commandFailureDetail(stderr, ""),
    [
      "ℹ EnvValidationException: Validation failed for one or more environment variables",
      '◉ - Missing environment variable "DB_HOST"',
      "Error: ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL",
    ].join("\n"),
  );
});

test("an exit excerpt keeps the errors when Compose prints them first", () => {
  // Captured from an Electron preview whose binary was never downloaded:
  // Compose printed the container's stderr after its stdout.
  const logs = [
    "desktop-1  | error during start dev server and electron app:",
    "desktop-1  | Error: Electron uninstall",
    "desktop-1  |     at getElectronPath (file:///workspace/node_modules/.pnpm/electron-vite@6.0.0/node_modules/electron-vite/dist/chunks/lib-DoUt4oMD.js:194:19)",
    "desktop-1  | Error: ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL",
    "desktop-1  | ",
    'desktop-1  |   × "pnpm recursive exec" failed in /workspace/packages/desktop',
    "",
    "desktop-1  | ✓ 3 modules transformed.",
    "desktop-1  | out/preload/index.js  27.05 kB",
    "desktop-1  | electron preload scripts built successfully",
  ].join("\n");
  assert.equal(
    errorExcerpt(logs),
    'error during start dev server and electron app: Error: Electron uninstall Error: ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL × "pnpm recursive exec" failed in /workspace/packages/desktop',
  );
});
