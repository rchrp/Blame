import type { ProjectInitializationDatabaseMode } from "@blame/agent-runtime";
import type { PreviewExecutionPlan } from "@blame/preview-runtime";

// A project's database settings follow the database mode chosen at
// initialization. With an isolated database, the preview's own database
// service replaces the developer's settings, which often point at their own
// data (a local server, a tunnel to production). With the project's
// database, the developer's settings are the only ones there are: they are
// kept, and a host on the developer's computer is renamed to one the
// containers reach.

export type PreviewDatabaseMode = ProjectInitializationDatabaseMode;

// Settings that connect to a database, cache or queue.
const databaseEnvironmentKey =
  /^(?:DB|DATABASE|MYSQL|MARIADB|POSTGRES|POSTGRESQL|PG|MONGO|MONGODB|REDIS|MSSQL|SQL)(?:_|$)|^(?:PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|DIRECT_URL)$|_(?:DATABASE_URL|DB_URL|DSN)$/;

export function previewDatabaseEnvironmentKey(key: string) {
  return databaseEnvironmentKey.test(key);
}

const databaseImages =
  /(?:^|\/)(?:postgres|postgis|mysql|mariadb|mongo|mssql\/server|mcr\.microsoft\.com\/mssql)(?::|@|$)/;

/**
 * The saved mode, or the one the manifest shows: an initialization with an
 * isolated database declares a database service, one that uses the
 * project's database has none.
 */
export function previewDatabaseMode(
  plan: Pick<PreviewExecutionPlan, "services">,
  saved?: PreviewDatabaseMode | null,
): PreviewDatabaseMode {
  if (saved === "compose" || saved === "existing") return saved;
  return plan.services.some(
    (service) =>
      service.kind === "dependency" &&
      databaseImages.test(service.container.image ?? ""),
  )
    ? "compose"
    : "existing";
}

const localHosts = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"];
const localUrlHost =
  /(^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/?#]|$)/i;

/**
 * The value with a host on the developer's computer replaced by `alias`, or
 * undefined when it names no such host: a URL such as
 * `postgres://app:secret@127.0.0.1:5432/app`, or a host setting such as
 * `DB_HOST=localhost`.
 */
export function localDatabaseHostRewrite(
  key: string,
  value: string,
  alias: string,
) {
  const quote = /^(["'])(.*)\1$/s.exec(value.trim());
  const inner = quote ? quote[2]! : value.trim();
  let next: string | undefined;
  if (localUrlHost.test(inner)) {
    next = inner.replace(
      localUrlHost,
      (_, prefix: string) => `${prefix}${alias}`,
    );
  } else if (
    /HOST(?:NAME)?$|_SERVER$/.test(key) &&
    localHosts.includes(inner)
  ) {
    next = alias;
  }
  if (next === undefined) return undefined;
  return quote ? `${quote[1]}${next}${quote[1]}` : next;
}
