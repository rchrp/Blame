export const previewDevtoolsMcpVersion = "1.8.0";

export const previewDevtoolsEnabledCapabilities = [
  "input",
  "navigation",
  "emulation",
  "performance",
  "network",
  "debugging",
  "memory",
  "vision",
  "structured-content",
  "third-party",
] as const;

export const previewDevtoolsUnavailableCapabilities = [
  {
    capability: "extensions",
    reason:
      "Extensions are not available through the single-page preview proxy.",
  },
  {
    capability: "pwa",
    reason: "Google only supports PWA tools over a pipe connection.",
  },
  {
    capability: "webmcp",
    reason: "WebMCP requires Chrome 150 or newer with WebMCP enabled.",
  },
  {
    capability: "screencast",
    reason: "Screencast requires an external ffmpeg installation.",
  },
] as const;

// The CDP endpoint is appended as --wsEndpoint by the loader that starts
// chrome-devtools-mcp, from an environment variable, so its token never
// appears in the process list.
export function previewDevtoolsServerArgs() {
  return [
    "--no-usage-statistics",
    "--no-performance-crux",
    "--memory-debugging",
    "--experimental-vision",
    "--experimental-structured-content",
    "--category-experimental-third-party",
    // The proxy exposes a single page; routing by page id is on by default.
    "--no-page-id-routing",
    "--redact-network-headers",
  ];
}
