import type {
  PreviewExecutionPlan,
  ProbePlan,
  ServiceEndpointPlan,
  ServiceLaunchPlan,
} from "./execution-plan.js";

// Functional probes check that a running preview really answers, after the
// endpoint healthchecks. Local and cloud previews run them with these rules
// so a manifest passes or fails the same way in both modes.

export const defaultProbeTimeoutMs = 10_000;

// Listed statuses when the manifest gives some, otherwise anything that is
// not a server error: a login redirect or a 404 page still proves the app
// answers.
export function probeStatusAccepted(
  status: number,
  acceptedStatuses: readonly number[] = [],
) {
  return acceptedStatuses.length
    ? acceptedStatuses.includes(status)
    : status < 500;
}

export function probeEndpoint(
  plan: Pick<PreviewExecutionPlan, "services">,
  probe: ProbePlan,
): ServiceEndpointPlan | undefined {
  return plan.services
    .find(({ id }) => id === probe.target.serviceId)
    ?.endpoints.find(({ id }) => id === probe.target.endpointId);
}

// Probes whose target and origin both run in the selected services.
export function activeProbes(
  plan: Pick<PreviewExecutionPlan, "probes">,
  serviceIds?: Iterable<string>,
) {
  if (!serviceIds) return plan.probes;
  const active = new Set(serviceIds);
  return plan.probes.filter(
    (probe) =>
      active.has(probe.target.serviceId) &&
      (probe.from === "host" || active.has(probe.from)),
  );
}

export function probeInternalUrl(
  probe: ProbePlan,
  endpoint: ServiceEndpointPlan,
) {
  return `${endpoint.protocol}://${probe.target.serviceId}:${endpoint.port}${probe.target.path}`;
}

// The command that runs a probe inside the container of `probe.from`, so it
// goes through the same network path as that service. Undefined when the
// container has no runtime we know how to script.
export function serviceProbeCommand(
  service: ServiceLaunchPlan,
  probe: ProbePlan,
  endpoint: ServiceEndpointPlan,
) {
  const javascriptRuntime = serviceJavascriptRuntime(service);
  if (javascriptRuntime) {
    return [javascriptRuntime, "-e", javascriptProbeScript(probe, endpoint)];
  }
  if (serviceUsesPython(service)) {
    return ["python", "-c", pythonProbeScript(probe, endpoint)];
  }
  return undefined;
}

export function probeFailureMessage(probe: ProbePlan, reason: string) {
  const target = `${probe.target.serviceId}:${probe.target.endpointId}`;
  const path = probe.type === "http" ? probe.target.path : "";
  return `Required preview probe ${probe.id} failed on ${target}${path}: ${reason}`;
}

function serviceJavascriptRuntime(service: ServiceLaunchPlan) {
  const image = service.container.image ?? "";
  const command = service.command ?? "";
  if (/(?:^|\/)bun(?::|$)/.test(image) || /\bbun\b/.test(command)) {
    return "bun";
  }
  if (
    /(?:^|\/)node(?::|$)/.test(image) ||
    /\b(?:node|npm|pnpm|yarn)\b/.test(command)
  ) {
    return "node";
  }
  return undefined;
}

function serviceUsesPython(service: ServiceLaunchPlan) {
  return (
    /(?:^|\/)python(?::|$)/.test(service.container.image ?? "") ||
    /\bpython\b/.test(service.command ?? "")
  );
}

// Both scripts encode probeStatusAccepted; functional-probes.test.ts runs
// them against a server to keep the three in agreement.
function javascriptProbeScript(
  probe: ProbePlan,
  endpoint: ServiceEndpointPlan,
) {
  if (probe.type === "tcp") {
    return `const s=require("net").connect(${endpoint.port},${JSON.stringify(probe.target.serviceId)},()=>process.exit(0));s.once("error",()=>process.exit(1));s.setTimeout(${probe.timeoutMs},()=>process.exit(1))`;
  }
  const accepted = JSON.stringify(probe.acceptedStatuses);
  const url = JSON.stringify(probeInternalUrl(probe, endpoint));
  return `const a=${accepted};fetch(${url},{signal:AbortSignal.timeout(${probe.timeoutMs})}).then(r=>process.exit((a.length?a.includes(r.status):r.status<500)?0:1)).catch(()=>process.exit(1))`;
}

function pythonProbeScript(probe: ProbePlan, endpoint: ServiceEndpointPlan) {
  const timeout = Math.ceil(probe.timeoutMs / 1_000);
  if (probe.type === "tcp") {
    return `import socket\nsocket.create_connection((${JSON.stringify(probe.target.serviceId)},${endpoint.port}),${timeout}).close()`;
  }
  return [
    "import sys,urllib.request,urllib.error",
    `accepted=${JSON.stringify(probe.acceptedStatuses)}`,
    `url=${JSON.stringify(probeInternalUrl(probe, endpoint))}`,
    `timeout=${timeout}`,
    "try:\n status=urllib.request.urlopen(url,timeout=timeout).status\nexcept urllib.error.HTTPError as error:\n status=error.code",
    "sys.exit(0 if (status in accepted if accepted else status < 500) else 1)",
  ].join("\n");
}
