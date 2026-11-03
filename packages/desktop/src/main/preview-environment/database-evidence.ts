import { readFile, readdir, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseEnvEntries } from "./dotenv.ts";

// Whether a project uses a database, from what its files show: an ORM or a
// driver among its dependencies, database settings in its env files, a
// database service in its Compose files, migrations or a schema. Blame asks
// which database a preview should use only when one of these is found, and
// the dialog says which.

const maximumDepth = 4;
const maximumFiles = 400;
const maximumFileBytes = 256 * 1024;

const skippedDirectories = new Set([
  ".git",
  ".blame",
  ".claude",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
]);

const evidenceFile =
  /^(?:package\.json|requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|Gemfile|composer\.json|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml|\.env(?:\..+)?|schema\.prisma|drizzle\.config\.\w+|alembic\.ini|ormconfig\.\w+|knexfile\.\w+)$/;

const migrationDirectory =
  /(?:^|\/)(?:migrations|db\/migrate|alembic|database\/migrations)$/;

/** Reads the project's evidence files and lists what they show. */
export async function projectDatabaseEvidence(root: string) {
  const files: Record<string, string> = {};
  const directories: string[] = [];
  await collect(root, "", 0, files, directories);
  return { evidence: databaseEvidence(files, directories) };
}

async function collect(
  root: string,
  relative: string,
  depth: number,
  files: Record<string, string>,
  directories: string[],
) {
  if (depth > maximumDepth || Object.keys(files).length >= maximumFiles) return;
  const entries = await readdir(join(root, relative), {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries) {
    const path = relative ? posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) continue;
      if (migrationDirectory.test(path)) directories.push(path);
      await collect(root, path, depth + 1, files, directories);
    } else if (entry.isFile() && evidenceFile.test(entry.name)) {
      const absolute = join(root, path);
      const size = (await stat(absolute).catch(() => undefined))?.size ?? 0;
      if (size > maximumFileBytes) continue;
      files[path] = await readFile(absolute, "utf8").catch(() => "");
    }
  }
}

const javascriptPackages: Array<[RegExp, string]> = [
  [/^(?:prisma|@prisma\/client)$/, "Prisma"],
  [/^drizzle-orm$/, "Drizzle"],
  [/^typeorm$/, "TypeORM"],
  [/^sequelize$/, "Sequelize"],
  [/^mongoose$/, "Mongoose"],
  [/^mongodb$/, "the MongoDB driver"],
  [/^knex$/, "Knex"],
  [/^@adonisjs\/lucid$/, "AdonisJS Lucid"],
  [/^@mikro-orm\/core$/, "MikroORM"],
  [/^kysely$/, "Kysely"],
  [
    /^(?:pg|postgres|@neondatabase\/serverless|@vercel\/postgres)$/,
    "a PostgreSQL driver",
  ],
  [/^(?:mysql|mysql2|mariadb|@planetscale\/database)$/, "a MySQL driver"],
  [/^@supabase\/supabase-js$/, "Supabase"],
];

const otherManifests: Array<[RegExp, RegExp, string]> = [
  [
    /(?:requirements[\w.-]*\.txt|pyproject\.toml|Pipfile)$/,
    /^\s*["']?django\b/im,
    "Django",
  ],
  [
    /(?:requirements[\w.-]*\.txt|pyproject\.toml|Pipfile)$/,
    /\bsqlalchemy\b/i,
    "SQLAlchemy",
  ],
  [
    /(?:requirements[\w.-]*\.txt|pyproject\.toml|Pipfile)$/,
    /\b(?:psycopg2?|asyncpg)\b/i,
    "a PostgreSQL driver",
  ],
  [
    /(?:requirements[\w.-]*\.txt|pyproject\.toml|Pipfile)$/,
    /\b(?:pymongo|motor)\b/i,
    "the MongoDB driver",
  ],
  [
    /(?:requirements[\w.-]*\.txt|pyproject\.toml|Pipfile)$/,
    /\b(?:mysqlclient|pymysql)\b/i,
    "a MySQL driver",
  ],
  [
    /Gemfile$/,
    /^\s*gem\s+["'](?:pg|mysql2|activerecord|mongoid)["']/m,
    "a Ruby database gem",
  ],
  [
    /composer\.json$/,
    /"(?:laravel\/framework|doctrine\/orm|illuminate\/database)"/,
    "a PHP ORM (Eloquent or Doctrine)",
  ],
  [
    /go\.mod$/,
    /\b(?:gorm\.io\/gorm|github\.com\/lib\/pq|github\.com\/jackc\/pgx|github\.com\/go-sql-driver\/mysql|go\.mongodb\.org\/mongo-driver)\b/,
    "a Go database driver",
  ],
  [
    /Cargo\.toml$/,
    /^\s*(?:sqlx|diesel|sea-orm|tokio-postgres|mongodb)\s*=/m,
    "a Rust database crate",
  ],
  [
    /(?:pom\.xml|build\.gradle(?:\.kts)?)$/,
    /\b(?:postgresql|mysql-connector|spring-boot-starter-data-jpa|hibernate-core)\b/,
    "a Java database library",
  ],
];

const databaseEnvKey =
  /^(?:DATABASE_URL|DB_HOST|DB_CONNECTION|DB_DATABASE|POSTGRES_(?:URL|HOST|PRISMA_URL)|MYSQL_HOST|MONGODB_URI|MONGO_URL)$/;

const databaseImage =
  /(?:^|\/)(?:postgres|postgis|mysql|mariadb|mongo)(?::|@|$)/;

// Example and test folders say less about the project than its own code.
const secondaryPath =
  /(?:^|\/)(?:__tests__|tests?|test-fixtures|fixtures?|examples?|samples?|demos?|templates?)(?:\/|$)/;

/** What the files show, in words, the most telling first. */
export function databaseEvidence(
  files: Record<string, string>,
  directories: string[] = [],
) {
  const found = new Map<string, number>();
  const add = (rank: number, path: string, text: string) => {
    const score = rank + (secondaryPath.test(path) ? 10 : 0);
    found.set(text, Math.min(found.get(text) ?? score, score));
  };
  for (const [path, content] of Object.entries(files)) {
    const name = path.split("/").at(-1)!;
    if (/compose(?:\.[\w-]+)?\.ya?ml$/.test(name))
      for (const service of databaseServices(content))
        add(0, path, `a ${service} service in ${path}`);
    if (name === "package.json") {
      for (const dependency of packageDependencies(content))
        for (const [pattern, label] of javascriptPackages)
          if (pattern.test(dependency)) add(1, path, `${label} in ${path}`);
    }
    for (const [file, pattern, label] of otherManifests)
      if (file.test(name) && pattern.test(content))
        add(1, path, `${label} in ${path}`);
    if (name === "schema.prisma") add(2, path, `a Prisma schema in ${path}`);
    if (/^drizzle\.config\./.test(name))
      add(2, path, `a Drizzle config in ${path}`);
    if (name.startsWith(".env"))
      for (const { key } of parseEnvEntries(content))
        if (databaseEnvKey.test(key)) add(4, path, `${key} in ${path}`);
  }
  for (const directory of directories)
    add(3, directory, `migrations in ${directory}`);
  return [...found]
    .sort((left, right) => left[1] - right[1])
    .map(([text]) => text);
}

function packageDependencies(content: string) {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "peerDependencies"].flatMap(
      (field) =>
        parsed[field] && typeof parsed[field] === "object"
          ? Object.keys(parsed[field] as object)
          : [],
    );
  } catch {
    return [];
  }
}

function databaseServices(content: string) {
  try {
    const parsed = parseYaml(content) as {
      services?: Record<string, { image?: unknown }>;
    };
    return Object.entries(parsed?.services ?? {}).flatMap(([id, service]) =>
      typeof service?.image === "string" && databaseImage.test(service.image)
        ? [`${id} (${service.image})`]
        : [],
    );
  } catch {
    return [];
  }
}
