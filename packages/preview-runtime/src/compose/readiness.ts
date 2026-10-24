import net from "node:net";
import type {
  PreviewExecutionPlan,
  ProbePlan,
  ServiceEndpointPlan,
} from "../domain/execution-plan.js";
import {
  activeProbes,
  probeEndpoint,
  probeFailureMessage,
  probeStatusAccepted,
  serviceProbeCommand,
} from "../domain/functional-probes.js";
import { ComposeEngineError, type CommandResult } from "./docker-host.js";
import type { EndpointTarget } from "./compose-renderer.js";

// Readiness and functional probes from outside the containers, through the
// published endpoints. The runner reaches them inside the sandbox; the
// desktop reaches the same ports, which the VM forwards to the host.

const readinessStabilityMs = 500;
const readinessPollIntervalMs = 250;

export type EndpointTargets = Record<string, EndpointTarget>;

/** Waits for each service's healthcheck endpoints to answer steadily. */
export async function probeServices(
  plan: Pick<PreviewExecutionPlan, "services">,
  targets: EndpointTargets,
) {
  return Promise.all(
    plan.services.map(async (service) => {
      const endpoints = service.endpoints.filter(
        ({ healthcheck }) => healthcheck,
      );
      if (!endpoints.length)
        return { id: service.id, running: true, healthy: undefined };
      const results = await Promise.all(
        endpoints.map((endpoint) => {
          const target = targets[`${service.id}:${endpoint.id}`];
          if (!target || !endpoint.healthcheck) return false;
          return waitForHealthyEndpoint(target, endpoint.healthcheck);
        }),
      );
      return { id: service.id, running: true, healthy: results.every(Boolean) };
    }),
  );
}

async function waitForHealthyEndpoint(
  target: EndpointTarget,
  healthcheck: NonNullable<ServiceEndpointPlan["healthcheck"]>,
) {
  const deadline = Date.now() + healthcheck.timeoutMs;
  let healthySince: number | undefined;
  do {
    const remaining = Math.max(1, deadline - Date.now());
    const healthy =
      healthcheck.type === "tcp"
        ? !(await tcpFailure(target, Math.min(1_000, remaining)))
        : await endpointAnswers(
            target,
            healthcheck.path ?? "/",
            Math.min(2_000, remaining),
          );
    const now = Date.now();
    if (healthy) {
      healthySince ??= now;
      if (now - healthySince >= readinessStabilityMs) return true;
    } else {
      healthySince = undefined;
    }
    if (now < deadline)
      await delay(Math.min(readinessPollIntervalMs, deadline - now));
  } while (Date.now() < deadline);
  return false;
}

async function endpointAnswers(
  target: EndpointTarget,
  path: string,
  timeoutMs: number,
) {
  try {
    const response = await fetch(
      `http://${target.host}:${target.port}${path}`,
      {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      },
    );
    await response.body?.cancel().catch(() => undefined);
    return probeStatusAccepted(response.status);
  } catch {
    return false;
  }
}

export type ServiceExec = (
  serviceId: string,
  command: string[],
) => Promise<Pick<CommandResult, "exitCode">>;

/**
 * Runs the plan's functional probes once the services are ready. Host
 * probes reach the published endpoint; service probes run inside the `from`
 * container, so they test the same network path as that service. A failing
 * required probe throws FUNCTIONAL_PROBE_FAILED.
 */
export async function runFunctionalProbes(input: {
  plan: PreviewExecutionPlan;
  serviceIds: string[];
  targets: EndpointTargets;
  exec: ServiceExec;
}) {
  const results = [];
  for (const probe of activeProbes(input.plan, input.serviceIds)) {
    const failure = await probeFailure(input, probe);
    if (failure && probe.required) {
      throw new ComposeEngineError(
        "FUNCTIONAL_PROBE_FAILED",
        probeFailureMessage(probe, failure),
        "HEALTHCHECK_FAILED",
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
    const origin = input.plan.services.find(({ id }) => id === probe.from);
    const command = origin && serviceProbeCommand(origin, probe, endpoint);
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
  target: EndpointTarget,
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

function tcpFailure(target: EndpointTarget, timeoutMs: number) {
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

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
