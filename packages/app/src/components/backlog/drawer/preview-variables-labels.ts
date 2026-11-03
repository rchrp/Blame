import type {
  PreviewEnvironmentView,
  PreviewVariableView,
} from "@blame/agent-runtime"

// The words of the Variables tab: where a value comes from, and what state
// it is in.

export function variableSourceLabel(variable: PreviewVariableView) {
  const file = variable.file?.split("/").at(-1)
  switch (variable.source) {
    case "blame-service":
      return "Blame: service address"
    case "blame-origin":
      return "Blame: preview origin"
    case "blame-database":
      return "Blame: isolated database"
    case "blame-listen":
      return "Blame: service port"
    case "story":
      return "story override"
    case "project":
      return "project variable"
    case "env-file":
      return `from ${file ?? ".env"}`
    case "env-example":
      // A key the code declares, such as in start/env.ts, has no file value.
      return file && !file.startsWith(".env")
        ? `declared in ${variable.file!.split("/").slice(-2).join("/")}`
        : `from ${file ?? ".env.example"}`
    case "manifest":
      return "setup default"
  }
}

export function variableStatusLabel(variable: PreviewVariableView) {
  switch (variable.status) {
    case "missing":
      return "missing"
    case "placeholder":
      return "placeholder"
    case "removed":
      return "left out"
    case "empty":
      return "empty"
    case "set":
      return undefined
  }
}

/** Needs a person: a key that is missing or still a placeholder. */
export function variableNeedsValue(variable: PreviewVariableView) {
  return (
    !variable.locked &&
    (variable.status === "missing" ||
      variable.status === "placeholder" ||
      (variable.required === true && variable.status === "empty"))
  )
}

export function databaseModeSummary(view: PreviewEnvironmentView) {
  if (view.databaseMode === "compose")
    return {
      title: "Isolated database (Blame)",
      detail:
        "This preview runs its own database. Database settings from your env files are left out.",
    }
  const url = view.services
    .flatMap(({ variables }) => variables)
    .find(({ key }) => key === "DATABASE_URL")
  return {
    title: url?.file
      ? `Your database: DATABASE_URL from ${url.file}`
      : "Your database, from your env files",
    detail:
      "This preview uses your own database settings. Blame renames localhost so the preview reaches your computer.",
  }
}

/** Services whose variables changed since their container started. */
export function changedServices(view: PreviewEnvironmentView) {
  return view.services
    .filter(
      ({ kind, changedSinceStart }) => kind === "service" && changedSinceStart
    )
    .map(({ id }) => id)
}
