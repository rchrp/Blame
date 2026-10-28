import type { ProbePlan, ServiceLaunchPlan } from "../domain/execution-plan.js";
import { serviceProbeCommand } from "../domain/functional-probes.js";

export type ComposeHealthcheck = {
  test: string[];
  interval: string;
  timeout: string;
  retries: number;
  start_period: string;
  start_interval: string;
};

const checkTimeoutMs = 4_000;

// One readiness rule for every target: an HTTP endpoint is ready when it
// answers without a server error, a TCP endpoint when it accepts a
// connection. Known databases use their own client, which only answers once
// the real server listens on TCP (their entrypoints first run a temporary,
// socket-only server). Otherwise the container's own runtime runs the shared
// probe script. A container with neither gets no healthcheck: the engine
// still probes its published port from outside.
export function serviceHealthcheck(
  service: ServiceLaunchPlan,
): ComposeHealthcheck | undefined {
  if (service.surface?.type === "display" && service.id === service.surface.sidecarServiceId) return timing(["CMD", "python3", "-c", "import socket; socket.create_connection((\"127.0.0.1\",6080),2).close()"], 30000);
  const declared = service.endpoints.find(({ healthcheck }) => healthcheck);
  const startMs = Math.max(declared?.healthcheck?.timeoutMs ?? 60_000, 10_000);
  const known = knownServiceCheck(service);
  if (known) return timing(["CMD-SHELL", known], startMs);
  if (!declared?.healthcheck) return undefined;
  const probe: ProbePlan = {
    id: `${service.id}-health`,
    from: service.id,
    target: {
      serviceId: service.id,
      endpointId: declared.id,
      path: declared.healthcheck.path ?? "/",
    },
    type: declared.healthcheck.type,
    acceptedStatuses: [],
    timeoutMs: checkTimeoutMs,
    required: true,
  };
  const command = serviceProbeCommand(service, probe, declared, "127.0.0.1");
  return command ? timing(["CMD", ...command], startMs) : undefined;
}

// Docker checks every second while the service starts, so a dependent
// service starts as soon as its dependency is ready, then every 10 seconds.
function timing(test: string[], startMs: number): ComposeHealthcheck {
  return {
    test,
    interval: "10s",
    timeout: `${Math.ceil(checkTimeoutMs / 1_000) + 1}s`,
    retries: 3,
    start_period: `${Math.ceil(startMs / 1_000)}s`,
    start_interval: "1s",
  };
}

function knownServiceCheck(service: ServiceLaunchPlan) {
  if (service.command) return undefined;
  const image = service.container.image ?? "";
  if (imageNamed(image, "mariadb")) {
    return "mariadb-admin ping -h 127.0.0.1 --silent || mysqladmin ping -h 127.0.0.1 --silent";
  }
  // `ping` exits 0 whenever the server answers, even when it refuses the
  // anonymous login, so no password is needed.
  if (imageNamed(image, "mysql"))
    return "mysqladmin ping -h 127.0.0.1 --silent";
  if (imageNamed(image, "postgres") || imageNamed(image, "postgis")) {
    return "pg_isready -h 127.0.0.1 -q";
  }
  if (imageNamed(image, "redis") || imageNamed(image, "valkey")) {
    return "redis-cli -h 127.0.0.1 ping || valkey-cli -h 127.0.0.1 ping";
  }
  if (imageNamed(image, "mongo")) {
    return `mongosh --quiet --eval "db.adminCommand('ping')"`;
  }
  return undefined;
}

export function imageNamed(image: string, name: string) {
  return new RegExp(`(?:^|/)${name}(?::|@|$)`).test(image);
}
