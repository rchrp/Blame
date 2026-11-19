// How long each of the agent's browser tools may run. Shared by the desktop
// service that runs them and the agent that calls them.

export const previewDevtoolsDefaultTimeoutMs = 15_000;
// No call may hold the browser longer than this, whatever wait the agent
// asks for.
export const previewDevtoolsMaxTimeoutMs = 300_000;
// Room between the browser's own wait and the service's, and between the
// service's and the agent's, so each layer reports its own timeout first.
export const previewDevtoolsTimeoutMarginMs = 5_000;

// Tools that take a `timeout` argument, with the browser's own default:
// 10 s for a navigation, 5 s for a wait.
const waitingTools: Record<string, number> = {
  navigate_page: 10_000,
  wait_for: 5_000,
};

// How long the desktop service lets one call run: the wait the agent asked
// for, up to a fixed ceiling.
export function previewDevtoolsToolTimeoutMs(
  name: string,
  options: { arguments?: Record<string, unknown> } = {},
) {
  const requested = requestedWaitMs(name, options.arguments);
  return Math.min(
    previewDevtoolsMaxTimeoutMs,
    Math.max(
      previewDevtoolsDefaultTimeoutMs,
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
) {
  const defaultMs = waitingTools[name];
  if (defaultMs === undefined) return undefined;
  const timeout = Number(value?.timeout);
  // 0 or no value means the browser's default.
  return Number.isFinite(timeout) && timeout > 0 ? timeout : defaultMs;
}
