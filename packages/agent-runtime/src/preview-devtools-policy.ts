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
// The agent waits a little longer than the service, so the service's own
// timeout error is what the agent reads.
export const previewDevtoolsAgentMarginMs = 5_000;

// Advanced tools (performance, Lighthouse, heap snapshots, third-party
// developer tools) are off unless the project enables them.
export function previewDevtoolsToolAllowed(name: string, advanced: boolean) {
  return defaultTools.has(name) || advanced;
}

export function previewDevtoolsToolTimeoutMs(name: string) {
  return slowPreviewDevtoolsTools.has(name)
    ? previewDevtoolsSlowTimeoutMs
    : previewDevtoolsDefaultTimeoutMs;
}

export function previewDevtoolsAgentTimeoutMs(name: string) {
  return previewDevtoolsToolTimeoutMs(name) + previewDevtoolsAgentMarginMs;
}
