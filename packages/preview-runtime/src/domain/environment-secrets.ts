// The environment a cloud preview gets from the developer's computer: the
// same resolved variables a local preview has, sent with the session and
// kept encrypted, never in the plan or the code upload. Keys of `variables`
// are Compose service names (`setup-<task>` for a setup task); `files` are
// env files the services read, relative to the workspace.

export type PreviewEnvironmentSecrets = {
  variables: Record<string, Record<string, string>>;
  files: Array<{ path: string; content: string }>;
};

const maximumBytes = 512 * 1024;
const variableKey = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const serviceName = /^[a-z0-9][a-z0-9_.-]{0,62}$/i;

/** The secrets as sent, or an error saying what is wrong with them. */
export function parsePreviewEnvironmentSecrets(
  value: unknown,
): PreviewEnvironmentSecrets {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("environment must be an object");
  if (JSON.stringify(value).length > maximumBytes)
    throw new Error("environment is too large");
  const record = value as Record<string, unknown>;
  const variables: PreviewEnvironmentSecrets["variables"] = {};
  for (const [service, entries] of Object.entries(
    objectValue(record.variables, "environment.variables"),
  )) {
    if (!serviceName.test(service))
      throw new Error(`environment service ${service} is invalid`);
    variables[service] = {};
    for (const [key, entry] of Object.entries(
      objectValue(entries, `environment.variables.${service}`),
    )) {
      if (!variableKey.test(key) || typeof entry !== "string")
        throw new Error(`environment variable ${key} is invalid`);
      variables[service]![key] = entry;
    }
  }
  const files = Array.isArray(record.files) ? record.files : [];
  return {
    variables,
    files: files.map((file) => {
      const entry = objectValue(file, "environment file");
      if (
        typeof entry.path !== "string" ||
        typeof entry.content !== "string" ||
        !safeRelativePath(entry.path)
      )
        throw new Error("environment file is invalid");
      return { path: entry.path, content: entry.content };
    }),
  };
}

export function safeRelativePath(path: string) {
  return (
    Boolean(path) &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path
      .split("/")
      .some((part) => part === ".." || part === "" || part === ".git")
  );
}

function objectValue(value: unknown, name: string) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
