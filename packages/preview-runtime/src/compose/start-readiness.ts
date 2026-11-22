import type { PreviewExecutionPlan } from "../domain/execution-plan.js";
import { httpHealthcheckEndpoint } from "./compose-healthcheck.js";
import type { ServiceState } from "./compose-engine.js";
import { endpointAnswers, type EndpointTargets } from "./readiness.js";

// The wait at the end of a start. `docker compose up --wait` returns on
// Docker's own health timer: a healthcheck first runs one `start_interval`
// after the container starts, and each run spawns a process in it, so a
// server that listens after 150 ms is reported at about 1.5 s. The services
// whose healthcheck is the shared HTTP probe are ready when that endpoint
// answers from outside, which costs one request per poll and nothing in the
// container. Every other service keeps Docker's verdict: its healthcheck
// status, or "running" when it has none, like Compose. A reply is an HTTP
// status, so a port forwarder that accepts connections before the app listens
// never makes a service ready; TCP endpoints are never judged from outside.

const inspectIntervalMs = 500;
const firstPollDelayMs = 50;
const maxPollDelayMs = 250;
const requestTimeoutMs = 1_000;

export type StartWait =
  | { outcome: "ready" }
  | { outcome: "failed"; services: ServiceState[] }
  | { outcome: "timeout"; services: ServiceState[] };

export async function waitForServices(input: {
  plan: Pick<PreviewExecutionPlan, "services">;
  serviceIds: string[];
  targets: EndpointTargets;
  inspect: () => Promise<ServiceState[]>;
  timeoutMs: number;
  /** Replaces the request to a published endpoint, for tests. */
  answers?: typeof endpointAnswers;
}): Promise<StartWait> {
  const answers = input.answers ?? endpointAnswers;
  const waiting = new Set(
    input.plan.services
      .filter(({ id }) => input.serviceIds.includes(id))
      .map(({ id }) => id),
  );
  const outside = new Map(
    input.plan.services.flatMap((service) => {
      const endpoint = httpHealthcheckEndpoint(service);
      const target = endpoint && input.targets[`${service.id}:${endpoint.id}`];
      return target && waiting.has(service.id)
        ? [[service.id, { target, path: endpoint.healthcheck?.path ?? "/" }]]
        : [];
    }),
  );
  const deadline = Date.now() + input.timeoutMs;
  let states: ServiceState[] = [];
  let inspectedAt = Number.NEGATIVE_INFINITY;
  let pause = firstPollDelayMs;
  for (;;) {
    const inspectDue = Date.now() - inspectedAt >= inspectIntervalMs;
    const [answered, inspected] = await Promise.all([
      Promise.all(
        [...waiting].map(async (id) => {
          const probe = outside.get(id);
          return probe &&
            (await answers(probe.target, probe.path, requestTimeoutMs))
            ? id
            : undefined;
        }),
      ),
      inspectDue ? input.inspect() : undefined,
    ]);
    if (inspected) {
      states = inspected;
      inspectedAt = Date.now();
    }
    const stateOf = (id: string) => states.find((state) => state.id === id);
    for (const id of answered) {
      if (id && stateOf(id)?.state === "running") waiting.delete(id);
    }
    for (const id of [...waiting]) {
      const state = stateOf(id);
      if (
        state?.state === "running" &&
        (state.health === undefined || state.health === "healthy")
      )
        waiting.delete(id);
    }
    if (!waiting.size) return { outcome: "ready" };
    const failed = [...waiting].flatMap((id) => {
      const state = stateOf(id);
      return state && stopped(state) ? [state] : [];
    });
    if (failed.length) return { outcome: "failed", services: failed };
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        outcome: "timeout",
        services: [...waiting].map(
          (id) => stateOf(id) ?? { id, running: false },
        ),
      };
    }
    await delay(Math.min(pause, remaining));
    pause = Math.min(pause * 2, maxPollDelayMs);
  }
}

// What Compose's wait calls a failure: an unhealthy container, or one that
// exited. A restarting container (the sandbox restarts crashed services) is
// still on its way, as for Compose.
function stopped({ health, state }: ServiceState) {
  return health === "unhealthy" || state === "exited" || state === "dead";
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
