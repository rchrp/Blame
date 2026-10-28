import type { SavedSetup } from "./initialization-setup-draft"

// The containers a story's preview starts, in the order Blame starts them:
// the services a setup task waits for, then the setup tasks, then the
// other services. Containers in the same step start together.

export type StartNode =
  | {
      type: "service"
      id: string
      kind: "preview" | "dependency" | "worker"
      port?: number
    }
  | { type: "task"; id: string }
  | { type: "device"; id: string; kind: "ios" | "android" }

type Service = SavedSetup["previewManifest"]["services"][number]

export function startOrder(setup: SavedSetup): StartNode[][] {
  const manifest = setup.previewManifest
  const services = new Map(manifest.services.map((item) => [item.id, item]))
  const tasks = new Map(manifest.setup.map((item) => [item.id, item]))

  const early = new Set<string>()
  const markEarly = (id: string) => {
    if (early.has(id) || !services.has(id)) return
    early.add(id)
    serviceNeeds(services.get(id)!).forEach(markEarly)
  }
  manifest.setup.forEach((task) => task.dependsOn?.forEach(markEarly))

  const started = startedServices(setup, services)
  const late = [...started].filter((id) => !early.has(id))
  const serviceNode = (id: string): StartNode => {
    const service = services.get(id)!
    return {
      type: "service",
      id,
      kind: service.kind,
      port: service.endpoints[0]?.port,
    }
  }
  const neededServices = (id: string) => serviceNeeds(services.get(id)!)

  return [
    ...steps([...early], neededServices).map((step) => step.map(serviceNode)),
    ...steps([...tasks.keys()], (id) => tasks.get(id)?.dependsOn ?? []).map(
      (step) => step.map((id): StartNode => ({ type: "task", id }))
    ),
    ...steps(late, neededServices).map((step) => step.map(serviceNode)),
    ...(manifest.devices?.length ? [manifest.devices.map((d): StartNode => ({ type: "device", id: d.id, kind: d.platform }))] : []),
  ]
}

/**
 * Splits ids into steps: each one starts once what it needs among these ids
 * has started. A cycle ends in one last step rather than looping.
 */
function steps(ids: string[], needs: (id: string) => string[]) {
  const pending = new Set(ids)
  const result: string[][] = []
  while (pending.size) {
    const ready = [...pending].filter((id) =>
      needs(id).every((need) => need === id || !pending.has(need))
    )
    const step = ready.length ? ready : [...pending]
    step.forEach((id) => pending.delete(id))
    result.push(step)
  }
  return result
}

/** The services the default run configuration starts, with what they need. */
function startedServices(setup: SavedSetup, services: Map<string, Service>) {
  const configuration =
    setup.runConfigurations.find((item) => item.default) ??
    setup.runConfigurations[0]
  const roots = configuration?.services.length
    ? configuration.services
    : [...services.keys()]
  const started = new Set<string>()
  const visit = (id: string) => {
    if (started.has(id) || !services.has(id)) return
    started.add(id)
    serviceNeeds(services.get(id)!).forEach(visit)
  }
  roots.forEach(visit)
  // Keep the manifest's order, which is the order people read it in.
  return new Set([...services.keys()].filter((id) => started.has(id)))
}

/** What a service waits for: its dependencies and the servers it calls. */
function serviceNeeds(service: Service) {
  return [
    ...new Set([
      ...(service.dependsOn ?? []),
      ...(service.bindings ?? [])
        .filter(({ exposure }) => exposure === "server")
        .map(({ source }) => source.service),
    ]),
  ]
}
