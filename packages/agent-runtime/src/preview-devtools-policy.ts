// Which browser tools the agent sees, and how long each may run. Shared by
// the desktop service that runs them and the agent that calls them.

export const defaultPreviewDevtoolsTools = [
  "take_snapshot",
  "take_screenshot",
  "click",
  "fill",
  "fill_form",
  "type_text",
  "press_key",
  "hover",
  "drag",
  "wait_for",
  "navigate_page",
  "emulate",
  "resize_page",
  "list_console_messages",
  "get_console_message",
  "list_network_requests",
  "get_network_request",
  "evaluate_script",
  "handle_dialog",
  "upload_file",
] as const;

const slowPreviewDevtoolsTools = new Set([
  "lighthouse_audit",
  "performance_start_trace",
  "performance_stop_trace",
  "take_heapsnapshot",
]);

const defaultTools = new Set<string>(defaultPreviewDevtoolsTools);
export const previewDevtoolsDefaultTimeoutMs = 15_000;
export const previewDevtoolsSlowTimeoutMs = 120_000;
// No call may hold the browser longer than this, whatever the emulated
// slowdown or the wait the agent asks for.
export const previewDevtoolsMaxTimeoutMs = 300_000;
// Room between the browser's own wait and the service's, and between the
// service's and the agent's, so each layer reports its own timeout first.
export const previewDevtoolsTimeoutMarginMs = 5_000;
// Kept for callers that only need the margin above the service.
export const previewDevtoolsAgentMarginMs = previewDevtoolsTimeoutMarginMs;

// The emulation that slows the page down, as chrome-devtools-mcp applies it
// to its own waits.
export type PreviewDevtoolsSlowdown = {
  cpuThrottlingRate?: unknown;
  networkConditions?: unknown;
};

// chrome-devtools-mcp multiplies its waits by these factors.
const networkSlowdown: Record<string, number> = {
  "Fast 4G": 1,
  "Slow 4G": 2.5,
  "Fast 3G": 5,
  "Slow 3G": 10,
};

// Tools that take a `timeout` argument, with the browser's own default
// before slowdown: 10 s for a navigation, 5 s for a wait.
const waitingTools: Record<
  string,
  { cpu: boolean; defaultMs: number; network: boolean }
> = {
  navigate_page: { cpu: true, defaultMs: 10_000, network: true },
  wait_for: { cpu: true, defaultMs: 5_000, network: false },
};

// Advanced tools (performance, Lighthouse, heap snapshots, third-party
// developer tools) are off unless the project enables them.
export function previewDevtoolsToolAllowed(name: string, advanced: boolean) {
  return defaultTools.has(name) || advanced;
}

// How long the desktop service lets one call run. It covers the wait the
// agent asked for and the emulated CPU and network slowdown, which stretch
// every wait inside chrome-devtools-mcp, up to a fixed ceiling.
export function previewDevtoolsToolTimeoutMs(
  name: string,
  options: {
    arguments?: Record<string, unknown>;
    slowdown?: PreviewDevtoolsSlowdown;
  } = {},
) {
  const cpu = cpuSlowdown(options.slowdown);
  const network = networkSlowdownOf(options.slowdown);
  const base = slowPreviewDevtoolsTools.has(name)
    ? previewDevtoolsSlowTimeoutMs
    : previewDevtoolsDefaultTimeoutMs;
  const requested = requestedWaitMs(name, options.arguments, cpu, network);
  return Math.min(
    previewDevtoolsMaxTimeoutMs,
    Math.max(
      base * cpu * network,
      requested === undefined ? 0 : requested + previewDevtoolsTimeoutMarginMs,
    ),
  );
}

// The agent's own limit stays above anything the service may allow, so a
// slow call ends with the service's message, never a silent agent timeout.
export function previewDevtoolsAgentTimeoutMs() {
  return previewDevtoolsMaxTimeoutMs + previewDevtoolsTimeoutMarginMs;
}

// A wait longer than the ceiling is shortened, so the browser gives up
// before the service has to cut the call.
export function previewDevtoolsBoundedArguments(
  name: string,
  value: Record<string, unknown>,
) {
  if (!(name in waitingTools)) return value;
  const limit = previewDevtoolsMaxTimeoutMs - previewDevtoolsTimeoutMarginMs;
  const timeout = Number(value.timeout);
  return Number.isFinite(timeout) && timeout > limit
    ? { ...value, timeout: limit }
    : value;
}

function requestedWaitMs(
  name: string,
  value: Record<string, unknown> | undefined,
  cpu: number,
  network: number,
) {
  const wait = waitingTools[name];
  if (!wait) return undefined;
  const timeout = Number(value?.timeout);
  // 0 or no value means the browser's default, stretched by the slowdown.
  if (Number.isFinite(timeout) && timeout > 0) return timeout;
  return wait.defaultMs * (wait.cpu ? cpu : 1) * (wait.network ? network : 1);
}

function cpuSlowdown(slowdown: PreviewDevtoolsSlowdown | undefined) {
  const rate = Number(slowdown?.cpuThrottlingRate);
  return Number.isFinite(rate) && rate > 1 ? Math.min(rate, 20) : 1;
}

function networkSlowdownOf(slowdown: PreviewDevtoolsSlowdown | undefined) {
  const condition = slowdown?.networkConditions;
  return typeof condition === "string" ? (networkSlowdown[condition] ?? 1) : 1;
}
