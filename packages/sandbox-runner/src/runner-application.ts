import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import type {
  PreviewExecutionPlan,
  PreviewSessionState,
  RuntimeObservation,
  RuntimeSelection,
} from "@blame/preview-runtime";
import type {
  RunnerPreviewStartResult,
  RunnerRequest,
} from "./protocol/runner-contract.js";
import { runnerHandshake } from "./protocol/runner-contract.js";
import { runnerError } from "./protocol/runner-errors.js";
import {
  readRuntimeState,
  writeRuntimeState,
  type RunnerRuntimeState,
} from "./runtime-state.js";
import { runtimePaths } from "./runtime-paths.js";
import { ComposeSupervisor } from "./supervisor/compose-supervisor.js";
import { normalizeRuntimeSelection } from "./supervisor/runtime-selection.js";
import { probeServices } from "./supervisor/service-probes.js";
import { GatewaySupervisor } from "./gateway/gateway-supervisor.js";
import { importSourceArtifact } from "./workspace/source-importer.js";
import { liveSourceImportAllowed } from "./workspace/source-import-policy.js";
import { refreshWorkspacePreservingWarmCaches } from "./workspace/warm-cache.js";
import {
  acknowledgeSourceDelta,
  prepareSourceDelta,
  uploadSourceDelta,
} from "./workspace/source-exporter.js";
import {
  checkpointChangeJournal,
  readChangeJournal,
} from "./workspace/change-journal.js";
import { processLogEvents } from "./logs/log-multiplexer.js";
import { measureRunnerPhase } from "./performance-measure.js";

const compose = new ComposeSupervisor();
const gateway = new GatewaySupervisor();

export class RunnerApplication {
  async dispatch(request: RunnerRequest): Promise<unknown> {
    switch (request.operation) {
      case "handshake":
        return handshake();
      case "resume-host":
        return this.resumeHost(request.sessionId, request.generation);
      case "prepare-engine":
        return this.prepare(request);
      case "start-preview":
        return this.startPreview(request);
      case "warm-baseline":
        return this.warmBaseline(request);
      case "sanitize-snapshot":
        return this.sanitizeSnapshot();
      case "start-services":
        return this.start(request.selection);
      case "stop-services":
        return this.stop();
      case "inspect":
        return this.inspect(request.probeServices);
      case "endpoints":
        return this.endpoints();
      case "logs":
        return this.logs(request.cursor, request.serviceId);
      case "source-import":
        return this.importSource(request);
      case "source-export-prepare":
        return prepareSourceDelta(request.artifactId, request.revision);
      case "source-export-upload":
        return uploadSourceDelta(request.artifactId, request.upload);
      case "source-export-ack":
        return acknowledgeSourceDelta(request.revision);
      case "exec":
        return this.exec(request);
    }
  }

  private async resumeHost(sessionId: string, generation: number) {
    const state = await readRuntimeState();
    resumeRuntimeState(state, sessionId, generation);
    await writeRuntimeState(state);
    return { generation };
  }

  private async prepare(
    request: Extract<RunnerRequest, { operation: "prepare-engine" }>,
  ) {
    assertExecutionPlan(request.plan);
    if (!request.sessionId || !Number.isSafeInteger(request.generation)) {
      throw runnerError(
        "INVALID_SESSION_CONTEXT",
        "Runner session context is invalid.",
      );
    }
    if (
      request.plan.networking.gatewayListeners.length &&
      !request.capabilityPublicKey?.includes("BEGIN PUBLIC KEY")
    ) {
      throw runnerError(
        "GATEWAY_KEY_MISSING",
        "Preview gateway verification key is missing.",
      );
    }
    const state = await readRuntimeState();
    if (state.running)
      throw runnerError(
        "ENGINE_RUNNING",
        "Stop services before changing the plan.",
      );
    await compose.prepare(request.plan, request.browserBindingUrls ?? {});
    if (request.capabilityPublicKey) {
      await writeFile(
        runtimePaths.capabilityPublicKey,
        request.capabilityPublicKey,
        {
          mode: 0o600,
          flush: true,
        },
      );
    }
    await writeFile(runtimePaths.plan, JSON.stringify(request.plan), {
      mode: 0o600,
      flush: true,
    });
    await writeRuntimeState({
      ...state,
      plan: request.plan,
      prepared: true,
      running: false,
      browserBindingUrls: request.browserBindingUrls ?? {},
      routeIds: request.routeIds ?? {},
      sessionId: request.sessionId,
      generation: request.generation!,
    });
    return { prepared: true };
  }

  private async startPreview(
    request: Extract<RunnerRequest, { operation: "start-preview" }>,
  ): Promise<RunnerPreviewStartResult> {
    await this.prepare({ ...request, operation: "prepare-engine" });
    await this.start(request.selection);
    return {
      observation: await this.inspect(true),
      endpoints: await this.endpoints(),
    };
  }

  private async start(requestedSelection: RuntimeSelection) {
    const state = await requiredPreparedState();
    if (state.running) return { running: true };
    const selection = normalizeRuntimeSelection(
      state.plan!,
      requestedSelection,
    );
    await compose.start(state.plan!, selection);
    state.selection = selection;
    try {
      const routes = await this.gatewayRoutes(state);
      if (routes.length) {
        await gateway.start({
          publicKeyPem: await readFile(
            runtimePaths.capabilityPublicKey,
            "utf8",
          ),
          routes,
        });
      }
    } catch (error) {
      await compose.stop().catch(() => undefined);
      state.selection = undefined;
      throw error;
    }
    state.running = true;
    state.endpointRevision += 1;
    await writeRuntimeState(state);
    return { running: true };
  }

  private async warmBaseline(
    request: Extract<RunnerRequest, { operation: "warm-baseline" }>,
  ) {
    assertExecutionPlan(request.plan);
    const state = await readRuntimeState();
    if (state.running)
      throw runnerError("ENGINE_RUNNING", "Baseline engine is running.");
    await compose.prepare(request.plan, baselineBindingUrls(request.plan));
    await compose.warm(request.plan);
    let serviceCachesWarmed = false;
    try {
      await compose.start(request.plan, {
        configurationId: "baseline-warmup",
        serviceIds: request.plan.services.map(({ id }) => id),
      });
      const targets = await compose.targets();
      const probes = await measureRunnerPhase("baseline.readiness", () =>
        probeServices(request.plan, targets),
      );
      serviceCachesWarmed = probes.every(
        ({ running, healthy }) => running && healthy !== false,
      );
    } catch {
      serviceCachesWarmed = false;
    } finally {
      await compose.stop();
    }
    const { cachePaths: warmCachePaths } =
      await refreshWorkspacePreservingWarmCaches(async () => {
        await importSourceArtifact(request.source);
      });
    await writeFile(runtimePaths.plan, JSON.stringify(request.plan), {
      mode: 0o600,
      flush: true,
    });
    await writeRuntimeState({
      ...state,
      plan: request.plan,
      prepared: true,
      running: false,
      browserBindingUrls: baselineBindingUrls(request.plan),
      routeIds: {},
      sessionId: request.sessionId,
      generation: request.generation,
    });
    return { prepared: true, serviceCachesWarmed, warmCachePaths };
  }

  private async sanitizeSnapshot() {
    const state = await readRuntimeState();
    await gateway.stop().catch(() => undefined);
    await compose.stop().catch(() => undefined);
    await compose.shutdownEngine();
    await Promise.all([
      rm(runtimePaths.capabilityPublicKey, { force: true }),
      rm(runtimePaths.gatewayConfig, { force: true }),
      rm(runtimePaths.requestDirectory, { recursive: true, force: true }),
      rm("/var/log/blame", { recursive: true, force: true }),
      rm(runtimePaths.exports, { recursive: true, force: true }),
    ]);
    await writeRuntimeState(sanitizeRuntimeStateForSnapshot(state));
    return { sanitized: true };
  }

  private async stop() {
    const state = await readRuntimeState();
    if (!state.running) return { running: false };
    await gateway.stop();
    await compose.stop();
    state.running = false;
    state.selection = undefined;
    await checkpointChangeJournal();
    await writeRuntimeState(state);
    return { running: false };
  }

  private async inspect(
    shouldProbeServices = true,
  ): Promise<RuntimeObservation> {
    const state = await readRuntimeState();
    let services: RuntimeObservation["services"] = [];
    if (state.plan && state.running) {
      const targets = await this.targets(state);
      const processState = await compose.inspect(state.plan);
      const selectedIds = new Set(state.selection?.serviceIds ?? []);
      const readinessPlan = {
        ...state.plan,
        services: state.plan.services.filter(({ id }) => selectedIds.has(id)),
      };
      const probes = shouldProbeServices
        ? await measureRunnerPhase("preview.readiness", () =>
            probeServices(readinessPlan, targets),
          )
        : [];
      services = processState.map((service) => ({
        ...service,
        healthy:
          service.running &&
          (!shouldProbeServices ||
            probes.find(({ id }) => id === service.id)?.healthy !== false),
      }));
    }
    const journalRevision = await readChangeJournal()
      .then(({ revision }) => String(revision))
      .catch(() => "0");
    return {
      host: "running",
      engine: state.running ? "running" : state.prepared ? "stopped" : "idle",
      generation: state.generation,
      services,
      journalRevision,
      handshake: handshake(),
    };
  }

  private async endpoints() {
    const state = await requiredPreparedState();
    const targets = await this.targets(state);
    const routes = selectedGatewayListeners(state).map((listener) => {
      const target = targets[`${listener.serviceId}:${listener.endpointId}`];
      if (!target)
        throw runnerError(
          "ENDPOINT_TARGET_MISSING",
          "Endpoint target is missing.",
        );
      return {
        routeId: requiredRouteId(
          state,
          listener.serviceId,
          listener.endpointId,
        ),
        serviceId: listener.serviceId,
        endpointId: listener.endpointId,
        protocol: "http" as const,
        logicalPort: listener.logicalPort,
        targetHost: target.host,
        targetPort: target.port,
        sandboxPort: listener.sandboxPort,
        basePathMode: listener.basePathMode,
        externallyCompatible: !state.plan!.networking.integratedPreviewRequired,
      };
    });
    return {
      revision: state.endpointRevision,
      primaryRouteId:
        routes.find(
          ({ serviceId, endpointId }) =>
            serviceId === state.selection?.primaryRoute?.serviceId &&
            endpointId === state.selection?.primaryRoute?.endpointId,
        )?.routeId ??
        routes[0]?.routeId ??
        "",
      routes,
      supportsWebSocket: true,
      integratedPreviewRequired:
        state.plan!.networking.integratedPreviewRequired,
      incompatibilityReasons: state.plan!.networking.incompatibilityReasons,
    };
  }

  private async logs(cursor?: string, serviceId?: string) {
    const state = await readRuntimeState();
    const serviceIds = serviceId
      ? [serviceId]
      : (state.plan?.services.map(({ id }) => id) ?? []);
    if (
      serviceIds.some(
        (id) => !state.plan?.services.some((service) => service.id === id),
      )
    ) {
      throw runnerError(
        "INVALID_LOG_SERVICE",
        "Requested log service is not part of the plan.",
      );
    }
    const runtimeState: PreviewSessionState = {
      host: "running",
      engine: state.running ? "running" : "stopped",
      preview: state.running ? "ready" : "closed",
      agent: "idle",
      sync: "clean",
    };
    return processLogEvents({
      sessionId: state.sessionId,
      serviceIds,
      cursor,
      serviceId,
      state: runtimeState,
    });
  }

  private async importSource(
    request: Extract<RunnerRequest, { operation: "source-import" }>,
  ) {
    const state = await readRuntimeState();
    if (state.running && !liveSourceImportAllowed(request.source))
      throw runnerError(
        "ENGINE_RUNNING",
        "Only an incremental workspace delta can be imported while services are running.",
      );
    if (request.preserveWarmCaches && request.source.mode !== "delta") {
      return (
        await refreshWorkspacePreservingWarmCaches(() =>
          importSourceArtifact(request.source),
        )
      ).result;
    }
    return importSourceArtifact(request.source);
  }

  private async exec(request: Extract<RunnerRequest, { operation: "exec" }>) {
    const cwd = await realpath(request.cwd).catch(() => "");
    if (
      cwd !== runtimePaths.workspace &&
      !cwd.startsWith(`${runtimePaths.workspace}/`)
    ) {
      throw runnerError(
        "WORKSPACE_ACCESS_DENIED",
        "Command working directory is outside /workspace.",
      );
    }
    if (
      Object.keys(request.environment ?? {}).some((key) =>
        /(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL|AUTH|SESSION_KEY)$/i.test(
          key,
        ),
      )
    ) {
      throw runnerError(
        "RAW_SECRET_REJECTED",
        "Secret-looking command environment values require the credential broker.",
      );
    }
    const result = await executeProjectCommand({ ...request, cwd });
    await checkpointChangeJournal();
    return result;
  }

  private async targets(
    state: Awaited<ReturnType<typeof requiredPreparedState>>,
  ) {
    return compose.targets();
  }

  private async gatewayRoutes(
    state: Awaited<ReturnType<typeof requiredPreparedState>>,
  ) {
    const targets = await this.targets(state);
    return selectedGatewayListeners(state).map((listener) => {
      const target = targets[`${listener.serviceId}:${listener.endpointId}`];
      if (!target)
        throw runnerError(
          "ENDPOINT_TARGET_MISSING",
          "Endpoint target is missing.",
        );
      return {
        sessionId: state.sessionId,
        routeId: requiredRouteId(
          state,
          listener.serviceId,
          listener.endpointId,
        ),
        serviceId: listener.serviceId,
        endpointId: listener.endpointId,
        generation: state.generation,
        logicalPort: listener.logicalPort,
        sandboxPort: listener.sandboxPort,
        targetHost: target.host,
        targetPort: target.port,
      };
    });
  }
}

export function sanitizeRuntimeStateForSnapshot(
  state: RunnerRuntimeState,
): RunnerRuntimeState {
  return {
    ...state,
    running: false,
    endpointRevision: 0,
    browserBindingUrls: {},
    routeIds: {},
    sessionId: "",
    generation: 0,
    selection: undefined,
  };
}

export function resumeRuntimeState(
  state: RunnerRuntimeState,
  sessionId: string,
  generation: number,
) {
  const adoptsSanitizedSnapshot = !state.sessionId && state.generation === 0;
  if (
    !sessionId ||
    !Number.isSafeInteger(generation) ||
    generation < (adoptsSanitizedSnapshot ? 0 : 1) ||
    (state.sessionId && state.sessionId !== sessionId) ||
    generation < state.generation
  ) {
    throw runnerError(
      "INVALID_SESSION_CONTEXT",
      "Runner resume context is invalid.",
    );
  }
  if (state.plan && state.plan.version !== 2) {
    throw runnerError(
      "STALE_EXECUTION_PLAN",
      "The persisted preview plan is obsolete and the session must be recreated.",
    );
  }
  state.sessionId = sessionId;
  state.generation = generation;
  state.running = false;
  state.selection = undefined;
  return state;
}

function selectedGatewayListeners(
  state: Awaited<ReturnType<typeof requiredPreparedState>>,
) {
  const selected = state.selection?.serviceIds;
  return selected
    ? state.plan!.networking.gatewayListeners.filter(({ serviceId }) =>
        selected.includes(serviceId),
      )
    : state.plan!.networking.gatewayListeners;
}

function requiredRouteId(
  state: Awaited<ReturnType<typeof requiredPreparedState>>,
  serviceId: string,
  endpointId: string,
) {
  const routeId = state.routeIds[`${serviceId}:${endpointId}`];
  if (!routeId)
    throw runnerError("ROUTE_ID_MISSING", "Preview route identity is missing.");
  return routeId;
}

function handshake() {
  return runnerHandshake({
    clineSdkVersion: process.env.BLAME_CLINE_SDK_VERSION ?? "0.0.95",
    runnerVersion: process.env.BLAME_RUNNER_VERSION ?? "0.2.17",
    imageDigest: process.env.BLAME_RUNNER_IMAGE_DIGEST ?? "unconfigured",
    capabilities: {
      dockerCompose: true,
      sharedLoopback: true,
      snapshots: true,
      persistentFilesystem: true,
      publicHttpIngress: true,
      webSockets: true,
      networkPolicy: true,
      credentialBroker: false,
      bidirectionalSync: true,
      maxPublishedPorts: 15,
    },
  });
}

async function requiredPreparedState() {
  const state = await readRuntimeState();
  if (!state.prepared || !state.plan) {
    throw runnerError("ENGINE_NOT_PREPARED", "Preview engine is not prepared.");
  }
  return state;
}

function baselineBindingUrls(plan: PreviewExecutionPlan) {
  const urls: Record<string, string> = {};
  for (const service of plan.services) {
    for (const binding of service.bindings) {
      if (binding.exposure !== "browser") continue;
      urls[`${binding.sourceServiceId}:${binding.sourceEndpointId}`] =
        `https://baseline.invalid/${binding.sourceServiceId}/${binding.sourceEndpointId}`;
    }
  }
  return urls;
}

function assertExecutionPlan(value: PreviewExecutionPlan) {
  if (
    !value ||
    value.version !== 2 ||
    value.workspaceRoot !== "/workspace" ||
    !Array.isArray(value.services) ||
    !Array.isArray(value.setup) ||
    !Array.isArray(value.probes) ||
    !value.environmentPlan ||
    !value.networking ||
    value.networking.gatewayListeners.length > 15
  ) {
    throw runnerError("INVALID_PLAN", "Preview execution plan is invalid.");
  }
  const ids = new Set<string>();
  for (const service of value.services) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(service.id) ||
      ids.has(service.id)
    ) {
      throw runnerError(
        "INVALID_PLAN",
        "Preview service ID is invalid or duplicated.",
      );
    }
    ids.add(service.id);
  }
}

async function executeProjectCommand(
  request: Extract<RunnerRequest, { operation: "exec" }>,
) {
  const identity = await projectIdentity();
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        "prlimit",
        [
          "--nproc=512:512",
          "--nofile=4096:4096",
          "--fsize=104857600:104857600",
          "--",
          request.command,
          ...request.args,
        ],
        {
          cwd: request.cwd,
          env: {
            HOME: "/home/blame-project",
            PATH: "/usr/local/bin:/usr/bin:/bin",
            ...(request.environment ?? {}),
          },
          uid: identity.uid,
          gid: identity.gid,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      const append = (current: string, chunk: Buffer) =>
        `${current}${chunk.toString("utf8")}`.slice(-2 * 1024 * 1024);
      child.stdout.on("data", (chunk) => (stdout = append(stdout, chunk)));
      child.stderr.on("data", (chunk) => (stderr = append(stderr, chunk)));
      let timedOut = false;
      const timeout = setTimeout(
        () => {
          timedOut = true;
          if (child.pid) signalProcessGroup(child.pid, "SIGKILL");
        },
        Math.max(1, Math.min(request.timeoutMs ?? 10 * 60_000, 10 * 60_000)),
      );
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          ...(timedOut || signal ? { timedOut } : {}),
        });
      });
    },
  );
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

async function projectIdentity() {
  const value = async (flag: string) => {
    const result = await executeSimple("id", [flag, "blame-project"]);
    return Number(result.trim());
  };
  return { uid: await value("-u"), gid: await value("-g") };
}

function executeSimple(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} failed.`)),
    );
  });
}
