import type {
  PreviewManifest,
  ProjectRunConfiguration,
} from "@blame/agent-runtime"

import type { ProjectRunnerControlStatus } from "./project-runner-types"

// One tab of a run's logs: a preview's service, or one of the project's
// apps (and the one-off tasks run beside them, such as an install).
export type RunLogItem = {
  id: string
  label: string
  status?: ProjectRunnerControlStatus
}

const statusRank: Record<ProjectRunnerControlStatus, number> = {
  running: 0,
  starting: 1,
  stopping: 1,
  error: 2,
  stopped: 3,
}

// Running ones first, then the ones starting or stopping, the failed ones
// and the stopped ones; each group keeps its own order.
export function sortRunLogItems<T extends RunLogItem>(items: T[]) {
  return items
    .map((item, index) => ({ index, item }))
    .sort(
      (left, right) =>
        itemRank(left.item) - itemRank(right.item) || left.index - right.index
    )
    .map(({ item }) => item)
}

// Known to be stopped: an unknown status may still have logs coming.
export function runLogItemStopped(item?: RunLogItem) {
  return item?.status === "stopped"
}

// Each service of a preview gets the status of the configuration that runs
// it, along with the services that configuration depends on. Undefined
// while the configurations are unknown.
export function previewServiceStatuses(
  runtime:
    | {
        configurations: ProjectRunConfiguration[]
        statuses: Record<string, ProjectRunnerControlStatus>
      }
    | undefined,
  services: string[],
  manifest?: Pick<PreviewManifest, "devices" | "services">
) {
  if (!runtime) return undefined
  const statuses: Record<string, ProjectRunnerControlStatus> = {}
  for (const service of services) statuses[service] = "stopped"
  for (const configuration of runtime.configurations) {
    const status = runtime.statuses[configuration.id] ?? "stopped"
    if (status === "stopped") continue
    for (const service of configurationServices(configuration, manifest)) {
      const current = statuses[service]
      if (!current || statusRank[status] < statusRank[current])
        statuses[service] = status
    }
  }
  return statuses
}

// The project's apps, with the one-off tasks whose logs show beside them.
export function projectRunLogItems(
  configurations: ProjectRunConfiguration[],
  sessions: {
    configurationId: string
    name: string
    status: ProjectRunnerControlStatus
  }[],
  statusFor: (configurationId: string) => ProjectRunnerControlStatus
): RunLogItem[] {
  const known = new Set(configurations.map(({ id }) => id))
  return sortRunLogItems([
    ...configurations.map((configuration) => ({
      id: configuration.id,
      label: configuration.name,
      status: statusFor(configuration.id),
    })),
    ...sessions
      .filter(({ configurationId }) => !known.has(configurationId))
      .map((session) => ({
        id: session.configurationId,
        label: session.name,
        status: session.status,
      })),
  ])
}

function configurationServices(
  configuration: ProjectRunConfiguration,
  manifest?: Pick<PreviewManifest, "devices" | "services">
) {
  const target = manifest?.devices?.find(
    ({ id }) => id === configuration.previewTarget
  )
  const active = new Set([
    ...configuration.services,
    ...(target?.dependsOn ?? []),
    ...(target?.bindings ?? []).map(({ source }) => source.service),
  ])
  const pending = Array.from(active)
  while (pending.length) {
    const serviceId = pending.shift()
    const service = manifest?.services.find(({ id }) => id === serviceId)
    for (const dependency of [
      ...(service?.dependsOn ?? []),
      ...(service?.bindings ?? []).map(({ source }) => source.service),
    ]) {
      if (active.has(dependency)) continue
      active.add(dependency)
      pending.push(dependency)
    }
  }
  return active
}

function itemRank(item: RunLogItem) {
  return item.status ? statusRank[item.status] : statusRank.stopped
}
