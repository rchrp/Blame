// open_component_preview in a cloud preview: Blame's temporary Vite server
// runs in the sandbox, in a one-off container of a preview service, where
// the story's dependencies are installed. A gateway of its own publishes it
// on a port reserved when the sandbox is created, behind a capability like
// every preview route; the preview's own gateway and routes are untouched.

export const componentPreviewSandbox = {
  // Past the plan's gateway ports (43000 and up, at most 15).
  gatewayPort: 43_900,
  serviceId: "blame-component-preview",
  endpointId: "server",
  // Blame's own Vite installs, for React packages without Vite. The
  // container mounts this sandbox folder at the same path.
  toolkitRoot: "/var/lib/blame/component-preview",
  maximumPublishedPorts: 15,
} as const;

export type ComponentPreviewSandboxStart = {
  // Arguments of `node` in the container: the server script and its options.
  nodeArguments: string[];
  // The port the server listens on in its container, published on the
  // sandbox's loopback for the gateway.
  port: number;
};

// Cursors count the characters already read from each stream.
export type ComponentPreviewSandboxCursor = { stderr: number; stdout: number };

export type ComponentPreviewSandboxOutput = {
  cursor: ComponentPreviewSandboxCursor;
  // Whether the server's container still runs.
  running: boolean;
  stderr: string;
  stdout: string;
};

const maximumArguments = 64;
const maximumArgumentsLength = 512 * 1024;

export function parseComponentPreviewSandboxStart(
  value: unknown,
):
  | { ok: true; value: ComponentPreviewSandboxStart }
  | { ok: false; message: string } {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const { nodeArguments, port } = record;
  if (
    !Array.isArray(nodeArguments) ||
    !nodeArguments.length ||
    nodeArguments.length > maximumArguments ||
    nodeArguments.some(
      (argument) => typeof argument !== "string" || argument.includes("\0"),
    ) ||
    (nodeArguments as string[]).reduce(
      (length, argument) => length + argument.length,
      0,
    ) > maximumArgumentsLength
  )
    return {
      ok: false,
      message: "The component preview server arguments are invalid.",
    };
  if (
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 1_024 ||
    port > 65_535 ||
    port === componentPreviewSandbox.gatewayPort
  )
    return {
      ok: false,
      message: "The component preview server port is invalid.",
    };
  return {
    ok: true,
    value: { nodeArguments: [...(nodeArguments as string[])], port },
  };
}

export function parseComponentPreviewSandboxCursor(
  value: unknown,
): ComponentPreviewSandboxCursor | undefined {
  if (value === undefined) return { stderr: 0, stdout: 0 };
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const valid = (item: unknown): item is number =>
    typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  if (!record || !valid(record.stdout) || !valid(record.stderr))
    return undefined;
  return { stderr: record.stderr, stdout: record.stdout };
}

// The sandbox's published ports with the component preview's, when the
// provider's limit leaves room for it.
export function withComponentPreviewGatewayPort(ports: readonly number[]) {
  if (ports.includes(componentPreviewSandbox.gatewayPort)) return [...ports];
  if (ports.length >= componentPreviewSandbox.maximumPublishedPorts)
    return [...ports];
  return [...ports, componentPreviewSandbox.gatewayPort];
}
