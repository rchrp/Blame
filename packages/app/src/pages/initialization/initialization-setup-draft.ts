import type {
  PreviewManifest,
  ProjectRunConfiguration,
} from "@blame/agent-runtime"
import {
  compilePreviewManifest,
  parsePreviewManifest,
} from "@blame/preview-runtime"

// The editable part of a project's preview setup, as text fields: what
// people change by hand (images, commands, environment, ports, run
// commands). Everything else in the manifest is kept as it is.

/** The repair reason that marks a setup edited by hand. */
export const manualEditReason = "Edited in Blame"

export type SetupDraft = {
  runConfigurations: { id: string; name: string; command: string }[]
  services: DraftContainer[]
  setup: DraftContainer[]
}

export type DraftContainer = {
  id: string
  /** Empty when the container is built from the project's Dockerfile. */
  image: string
  command: string
  /** One KEY=value per line. */
  environment: string
  ports: { endpointId: string; port: string }[]
}

export type SavedSetup = {
  previewManifest: PreviewManifest
  runConfigurations: ProjectRunConfiguration[]
}

export function setupDraft(setup: SavedSetup): SetupDraft {
  return {
    runConfigurations: setup.runConfigurations.map(({ id, name, command }) => ({
      id,
      name,
      command,
    })),
    services: setup.previewManifest.services.map((service) => ({
      id: service.id,
      image: service.container.image ?? "",
      command: service.command ?? "",
      environment: environmentText(service.environment),
      ports: service.endpoints.map(({ id, port }) => ({
        endpointId: id,
        port: String(port),
      })),
    })),
    setup: setup.previewManifest.setup.map((task) => ({
      id: task.id,
      image: task.container.image ?? "",
      command: task.command,
      environment: environmentText(task.environment),
      ports: [],
    })),
  }
}

/**
 * Applies the draft to the saved setup and checks the result the way Blame
 * will run it. Throws a message that names the field to fix.
 */
export function appliedSetup(saved: SavedSetup, draft: SetupDraft): SavedSetup {
  const manifest = saved.previewManifest
  const services = manifest.services.map((service) => {
    const edit = draft.services.find(({ id }) => id === service.id)
    if (!edit) return service
    const where = `Service ${service.id}`
    const command = edit.command.trim()
    return {
      ...service,
      container: editedContainer(service.container, edit.image, where),
      ...(command ? { command } : { command: undefined }),
      environment: parseEnvironmentText(edit.environment, where),
      endpoints: service.endpoints.map((endpoint) => {
        const port = edit.ports.find(
          ({ endpointId }) => endpointId === endpoint.id
        )
        return port
          ? {
              ...endpoint,
              port: parsePort(port.port, `${where}, port ${endpoint.id}`),
            }
          : endpoint
      }),
    }
  })
  const setup = manifest.setup.map((task) => {
    const edit = draft.setup.find(({ id }) => id === task.id)
    if (!edit) return task
    const where = `Setup task ${task.id}`
    const command = edit.command.trim()
    if (!command) throw new Error(`${where}: the command is required.`)
    return {
      ...task,
      container: editedContainer(task.container, edit.image, where),
      command,
      environment: parseEnvironmentText(edit.environment, where),
    }
  })
  const runConfigurations = saved.runConfigurations.map((configuration) => {
    const edit = draft.runConfigurations.find(
      ({ id }) => id === configuration.id
    )
    if (!edit) return configuration
    const name = edit.name.trim()
    const command = edit.command.trim()
    const where = `Run configuration ${configuration.id}`
    if (!name) throw new Error(`${where}: the name is required.`)
    if (!command) throw new Error(`${where}: the command is required.`)
    if (/[\r\n]/.test(command))
      throw new Error(`${where}: the command must fit on one line.`)
    return { ...configuration, name, command }
  })
  return checkedSetup({
    previewManifest: withoutUndefined({ ...manifest, services, setup }),
    runConfigurations,
  })
}

/** Parses and checks a setup written as JSON in the editor. */
export function setupFromJson(text: string): SavedSetup {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `The JSON is not valid: ${error instanceof Error ? error.message : "parse error"}.`
    )
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "The JSON must be an object with previewManifest and runConfigurations."
    )
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.runConfigurations))
    throw new Error("runConfigurations must be a list.")
  return checkedSetup({
    previewManifest: record.previewManifest as PreviewManifest,
    runConfigurations: record.runConfigurations as ProjectRunConfiguration[],
  })
}

export function setupJson(setup: SavedSetup) {
  return JSON.stringify(
    {
      previewManifest: setup.previewManifest,
      runConfigurations: setup.runConfigurations,
    },
    null,
    2
  )
}

function checkedSetup(setup: SavedSetup): SavedSetup {
  const previewManifest = parsePreviewManifest(setup.previewManifest)
  compilePreviewManifest(previewManifest)
  const services = new Set(previewManifest.services.map(({ id }) => id))
  for (const configuration of setup.runConfigurations) {
    const missing = configuration.services.find((id) => !services.has(id))
    if (missing)
      throw new Error(
        `Run configuration ${configuration.id} starts service ${missing}, which the setup does not define.`
      )
  }
  return { previewManifest, runConfigurations: setup.runConfigurations }
}

function editedContainer(
  container: PreviewManifest["services"][number]["container"],
  image: string,
  where: string
) {
  if (container.build) return container
  const value = image.trim()
  if (!value) throw new Error(`${where}: the image is required.`)
  if (/\s/.test(value))
    throw new Error(`${where}: the image name cannot contain spaces.`)
  return { ...container, image: value }
}

export function environmentText(environment?: Record<string, string>) {
  return Object.entries(environment ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
}

export function parseEnvironmentText(text: string, where: string) {
  const environment: Record<string, string> = {}
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) return
    const separator = trimmed.indexOf("=")
    const key = separator > 0 ? trimmed.slice(0, separator).trim() : ""
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error(
        `${where}, environment line ${index + 1}: write it as KEY=value.`
      )
    environment[key] = trimmed.slice(separator + 1)
  })
  return environment
}

function parsePort(value: string, where: string) {
  const port = Number(value.trim())
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${where}: use a whole number from 1 to 65535.`)
  return port
}

function withoutUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * An initialization error in plain words: no IPC wrapper, no internal
 * field names.
 */
export function readableInitializationError(error: string | null) {
  if (!error) return "Blame could not finish the analysis."
  const message = error
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^(?:Error:\s*)+/, "")
    .replace(
      /^Initialization result previewManifest /,
      "The setup Blame wrote "
    )
    .replace(/^Initialization result /, "The analysis result ")
    .trim()
  return /[.!?]$/.test(message) ? message : `${message}.`
}
