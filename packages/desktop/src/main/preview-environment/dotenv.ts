import { posix } from "node:path";

// Reading env files the way dotenv loaders do, and telling apart the values
// a person must still fill in or keep secret.

export type EnvEntry = { key: string; value: string };

export const envTemplateSuffixes = [".example", ".sample", ".template"];

/** The entries of an env file, last one winning, without quotes or comments. */
export function parseEnvEntries(content: string): EnvEntry[] {
  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    entries.set(match[1]!, envValue(match[2]!));
  }
  return [...entries].map(([key, value]) => ({ key, value }));
}

function envValue(raw: string) {
  const trimmed = raw.trim();
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(trimmed);
  if (quoted) {
    return quoted[1] === '"'
      ? quoted[2]!.replace(/\\n/g, "\n").replace(/\\"/g, '"')
      : quoted[2]!;
  }
  return trimmed.replace(/\s+#.*$/, "");
}

export function runtimeEnvFileName(name: string) {
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return !envTemplateSuffixes.some((suffix) => name.endsWith(suffix));
}

export function templateEnvFileName(name: string) {
  if (!name.startsWith(".env")) return false;
  return envTemplateSuffixes.some((suffix) => name.endsWith(suffix));
}

// The files a development server loads, the most specific first, as
// Next.js, Vite and dotenv-flow do with NODE_ENV=development.
const developmentFiles = [
  ".env.development.local",
  ".env.local",
  ".env.development",
  ".env",
];

/** Rank of a runtime env file for a development server; -1 if not loaded. */
export function developmentEnvFileRank(name: string) {
  return developmentFiles.indexOf(name);
}

/** The directory an env file belongs to, `.` for the project root. */
export function envFileDirectory(relativePath: string) {
  return posix.dirname(relativePath);
}

/** Whether `directory` is `ancestor` or below it. */
export function withinDirectory(directory: string, ancestor: string) {
  return (
    ancestor === "." ||
    directory === ancestor ||
    directory.startsWith(`${ancestor}/`)
  );
}

const placeholderPatterns = [
  /^<[^>]*>$/,
  /^\[[^\]]*\]$/,
  /^(?:x{3,}|\*{3,}|\.{3,}|-+)$/i,
  /^(?:change[-_ ]?me|changeme|replace[-_ ]?me|todo|tbd|fixme|placeholder)$/i,
  /^(?:your|my|insert|enter|put|add)[-_ ](?:own[-_ ])?[a-z0-9_-]+/i,
  /[-_ ](?:here|goes[-_ ]here)$/i,
];

/** A value an example file left for the developer to fill in. */
export function placeholderEnvValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return placeholderPatterns.some((pattern) => pattern.test(trimmed));
}

const secretKey =
  /PASSWORD|PASSWD|PWD$|SECRET|TOKEN(?!S)|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH_?KEY|APP_KEY|SIGNING|SALT|COOKIE|SESSION_KEY|_DSN$|^DSN$|WEBHOOK|ENCRYPTION|CLIENT_KEY|CERT|CSC_LINK|_P8|_PEM$/i;

/** Whether a value should never be shown in full. */
export function secretEnvVariable(key: string, value: string) {
  if (secretKey.test(key)) return true;
  // A long opaque string, such as a token or an encoded certificate.
  if (
    value.length >= 32 &&
    /^[A-Za-z0-9+/=_-]+$/.test(value) &&
    /\d/.test(value) &&
    /[A-Za-z]/.test(value)
  )
    return true;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/i.test(value)) return true;
  return /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[bpars]-/.test(
    value,
  );
}

/**
 * A value as the UI shows it. A URL keeps its host and only hides its
 * password, so people can still see which database a preview uses.
 */
export function maskedEnvValue(key: string, value: string) {
  if (!value || !secretEnvVariable(key, value)) return { value, masked: false };
  const url = /^([a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:)([^\s/@]+)(@.*)$/i.exec(
    value,
  );
  if (url) return { value: `${url[1]}••••••${url[3]}`, masked: true };
  return { value: "••••••••", masked: true };
}
