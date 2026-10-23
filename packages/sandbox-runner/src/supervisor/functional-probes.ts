import net from "node:net";
import {
  activeProbes,
  probeEndpoint,
  probeFailureMessage,
  probeStatusAccepted,
  serviceProbeCommand,
  type PreviewExecutionPlan,
  type ProbePlan,
  type ServiceEndpointPlan,
} from "@blame/preview-runtime";
import { runnerError } from "../protocol/runner-errors.js";

// Runs the manifest's functional probes once the services are ready, with
// the rules local previews use. Host probes reach the service directly from
// the runner; service probes run inside the `from` container, so they test
// the same network path as that service.

export type ServiceExec = (
  serviceId: string,
  command: string[],
) => Promise<{ exitCode: number }>;

export async function runFunctionalProbes(input: {
  plan: PreviewExecutionPlan;
  serviceIds: string[];
  targets: Record<string, { host: string; port: number }>;
  exec: ServiceExec;
}) {
  const results = [];
  for (const probe of activeProbes(input.plan, input.serviceIds)) {
    const failure = await probeFailure(input, probe);
    if (failure && probe.required) {
      throw runnerError(
        "FUNCTIONAL_PROBE_FAILED",
        probeFailureMessage(probe, failure),
      );
    }
    results.push({ id: probe.id, passed: !failure });
  }
  return results;
}

async function probeFailure(
  input: Parameters<typeof runFunctionalProbes>[0],
  probe: ProbePlan,
): Promise<string | undefined> {
  const endpoint = probeEndpoint(input.plan, probe);
  if (!endpoint) return "unknown endpoint";
  if (probe.from !== "host") {
    const consumer = input.plan.services.find(({ id }) => id === probe.from);
    const command = consumer && serviceProbeCommand(consumer, probe, endpoint);
    if (!command) return `no supported runtime in ${probe.from}`;
    const result = await input.exec(probe.from, command);
    return result.exitCode === 0
      ? undefined
      : `check from ${probe.from} failed`;
  }
  const target = input.targets[`${probe.target.serviceId}:${endpoint.id}`];
  if (!target) return "target is not running";
  return probe.type === "tcp"
    ? tcpFailure(target, probe.timeoutMs)
    : httpFailure(target, endpoint, probe);
}

async function httpFailure(
  target: { host: string; port: number },
  endpoint: ServiceEndpointPlan,
  probe: ProbePlan,
) {
  const protocol = endpoint.protocol === "https" ? "https" : "http";
  try {
    const response = await fetch(
      `${protocol}://${target.host}:${target.port}${probe.target.path}`,
      { signal: AbortSignal.timeout(probe.timeoutMs) },
    );
    await response.body?.cancel().catch(() => undefined);
    return probeStatusAccepted(response.status, probe.acceptedStatuses)
      ? undefined
      : `status ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : "request failed";
  }
}

function tcpFailure(target: { host: string; port: number }, timeoutMs: number) {
  return new Promise<string | undefined>((resolve) => {
    const socket = net.connect(target.port, target.host);
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(undefined);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve("connection timed out");
    });
    socket.once("error", (error) => resolve(error.message));
  });
}
