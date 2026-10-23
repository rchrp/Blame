const localDatabaseCredentialKeys = new Set([
  "DATABASE_PASSWORD",
  "DB_PASSWORD",
  "DB_ROOT_PASSWORD",
  "MARIADB_PASSWORD",
  "MARIADB_ROOT_PASSWORD",
  "MONGO_INITDB_ROOT_PASSWORD",
  "MYSQL_PASSWORD",
  "MYSQL_ROOT_PASSWORD",
  "PGPASSWORD",
  "POSTGRES_PASSWORD",
  "POSTGRESQL_PASSWORD",
  "REDIS_PASSWORD",
]);

const databaseUrlKeys = new Set([
  "DATABASE_URL",
  "DB_URL",
  "MONGO_URL",
  "MONGODB_URI",
  "REDIS_URL",
]);

const databaseProtocols = new Set([
  "mariadb:",
  "mongodb:",
  "mysql:",
  "postgres:",
  "postgresql:",
  "redis:",
]);

export function isLocalPreviewDatabaseCredentialKey(key: string) {
  return localDatabaseCredentialKeys.has(key.toUpperCase());
}

export function isDatabaseEnvironmentKey(key: string) {
  const normalized = key.toUpperCase();
  return (
    databaseUrlKeys.has(normalized) ||
    normalized === "PGPASSWORD" ||
    normalized.startsWith("DB_") ||
    normalized.startsWith("MYSQL_") ||
    normalized.startsWith("MARIADB_") ||
    normalized.startsWith("POSTGRES_") ||
    normalized.startsWith("POSTGRESQL_") ||
    normalized.startsWith("MONGO_") ||
    normalized.startsWith("MONGODB_") ||
    normalized.startsWith("REDIS_")
  );
}

export function normalizeLocalPreviewDatabaseEnvironmentValue(
  key: string,
  value: string,
) {
  if (isLocalPreviewDatabaseCredentialKey(key)) return "blame";
  if (!databaseUrlKeys.has(key.toUpperCase())) return value;
  const parsed = localDatabaseUrl(value);
  if (!parsed || !parsed.password) return value;
  parsed.password = "blame";
  return parsed.toString();
}

export function isLocalPreviewDatabaseEnvironmentValue(
  key: string,
  value: string,
) {
  if (isLocalPreviewDatabaseCredentialKey(key)) return value === "blame";
  if (!databaseUrlKeys.has(key.toUpperCase())) return false;
  const parsed = localDatabaseUrl(value);
  return parsed?.password === "blame";
}

function localDatabaseUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (!databaseProtocols.has(parsed.protocol)) return undefined;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(parsed.hostname)) return undefined;
    if (["localhost", "host.docker.internal"].includes(parsed.hostname)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

// Manifest environment values are development values committed with the
// project, so any key name is accepted. A value that looks like a real
// credential is still refused: real secrets never belong in the manifest.
const realCredentialPatterns: { kind: string; pattern: RegExp }[] = [
  { kind: "a private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { kind: "a GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { kind: "a GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "an OpenAI key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: "a Slack token", pattern: /\bxox[bpars]-[A-Za-z0-9-]{16,}\b/ },
  { kind: "a live Stripe key", pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/ },
];

export function previewEnvironmentValueRejection(value: string) {
  for (const { kind, pattern } of realCredentialPatterns) {
    if (pattern.test(value)) return `contains ${kind}`;
  }
  if (externalCredentialUrl(value)) {
    return "embeds credentials for a host outside the preview";
  }
  return undefined;
}

// Credentials in a URL are fine for a service of the preview itself
// (`postgres://app:dev@database/app`), not for an outside host.
function externalCredentialUrl(value: string) {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) return false;
    return !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(parsed.hostname);
  } catch {
    return true;
  }
}
