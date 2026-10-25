import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  applyProjectOverlays,
  createProject,
  initializeGeneratedRepository,
  projectCreationRecipe,
  setNewProjectAgentRuntime,
  validateProjectTarget,
  type ProjectCreationRecipe,
  type NewProjectConfiguration,
} from "./project-creation.ts";
import {
  dockerCompose,
  projectSetupRecipe,
  setupScript,
} from "./project-setup-recipes.ts";

const execFileAsync = promisify(execFile);

const baseConfiguration: NewProjectConfiguration = {
  platform: "web",
  frontend: "next",
  styling: "tailwind",
  uiLibrary: "shadcn",
  backend: "next-api",
  database: "postgresql",
  orm: "prisma",
  packageManager: "pnpm",
  codeQuality: "eslint-prettier",
  advancedOptions: ["envExample", "readme", "blamePreview"],
};

test("rejects path traversal project names", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-new-project-"));

  await assert.rejects(
    () => validateProjectTarget(parent, "../escape"),
    /letters, numbers/,
  );
});

test("rejects non-empty target directories", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-new-project-"));
  const target = join(parent, "taken");
  await mkdir(target);
  await writeFile(join(target, "README.md"), "taken", "utf8");

  await assert.rejects(
    () => validateProjectTarget(parent, "taken"),
    /already exists/,
  );
});

test("rejects existing empty folders and files too", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-existing-project-"));
  await mkdir(join(parent, "empty"));
  await writeFile(join(parent, "file"), "keep this file");
  for (const name of ["empty", "file"]) {
    await assert.rejects(
      validateProjectTarget(parent, name),
      /already exists.*another name or location/,
    );
  }
  assert.equal(await readFile(join(parent, "file"), "utf8"), "keep this file");
});

test("accepts valid parent and project name", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-new-project-"));
  const target = await validateProjectTarget(parent, "valid-app");

  assert.equal(target, join(parent, "valid-app"));
});

test("creates an empty target directory and delegates generation to the AI agent", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-new-project-"));
  let receivedCwd = "";
  let receivedConfiguration: NewProjectConfiguration | undefined;
  setNewProjectAgentRuntime({
    async generate(input) {
      receivedCwd = input.cwd;
      receivedConfiguration = input.configuration;
      const info = await stat(input.cwd);
      assert.equal(info.isDirectory(), true);
      await writeFile(
        join(input.cwd, "package.json"),
        '{"name":"agent-app"}',
        "utf8",
      );
      return {
        path: input.cwd,
        sessionId: input.sessionId ?? "session",
      };
    },
  });

  try {
    const commands: string[] = [];
    const result = await createProject(
      {
        apiConnection: { url: "http://localhost" },
        configuration: baseConfiguration,
        modelId: "model",
        parentPath: parent,
        projectName: "agent-app",
        providerId: "provider",
        runId: "agent-run",
      },
      {
        async runCommand(command) {
          commands.push(command.command);
          await writeFile(
            join(command.cwd, "pnpm-lock.yaml"),
            "lockfileVersion: '9.0'\n",
          );
        },
      },
    );

    assert.equal(receivedCwd, join(parent, "agent-app"));
    assert.equal(receivedConfiguration, baseConfiguration);
    assert.equal(result.path, join(parent, "agent-app"));
    assert.deepEqual(commands, ["pnpm"]);
    assert.match(
      (await runGit(result.path, ["ls-files"])).stdout,
      /pnpm-lock.yaml/,
    );
    const gitRoot = await runGit(result.path, ["rev-parse", "--show-toplevel"]);
    assert.equal(gitRoot.stdout.trim(), await realpath(result.path));
  } finally {
    setNewProjectAgentRuntime(undefined);
  }
});

test("retries a failed dependency installation without regenerating the project", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-retry-project-"));
  let generations = 0;
  let installs = 0;
  setNewProjectAgentRuntime({
    async generate(input) {
      generations += 1;
      await writeFile(join(input.cwd, "package.json"), '{"name":"retry-app"}');
      return { path: input.cwd, sessionId: input.sessionId! };
    },
  });
  const input = {
    apiConnection: { url: "http://localhost" },
    configuration: baseConfiguration,
    modelId: "model",
    parentPath: parent,
    projectName: "retry-app",
    providerId: "provider",
    runId: "install-retry-run",
  };
  const options = {
    async runCommand() {
      installs += 1;
      if (installs === 1) throw new Error("registry unavailable");
    },
  };
  try {
    await assert.rejects(
      createProject(input, options),
      /Dependency installation failed.*registry unavailable.*try again/,
    );
    await assert.rejects(stat(join(parent, "retry-app", ".git")), /ENOENT/);
    const result = await createProject(input, options);
    assert.equal(generations, 1);
    assert.equal(installs, 2);
    assert.equal((await stat(join(result.path, ".git"))).isDirectory(), true);
  } finally {
    setNewProjectAgentRuntime(undefined);
  }
});

test("rejects spaces in project names before running the agent", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-invalid-project-"));
  await assert.rejects(
    validateProjectTarget(parent, "my app"),
    /Replace spaces with dashes/,
  );
});

test("initializes generated projects as independent git repositories", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-new-project-"));
  const target = join(parent, "nested-app");
  await mkdir(target);
  await writeFile(
    join(target, "package.json"),
    '{"name":"nested-app"}',
    "utf8",
  );
  await runGit(parent, ["init"]);
  await runGit(parent, ["add", "--all"]);
  await runGit(parent, ["commit", "-m", "parent"]);

  await initializeGeneratedRepository(target);

  const { stdout } = await runGit(target, ["rev-parse", "--show-toplevel"]);
  assert.equal(stdout.trim(), await realpath(target));
});

test("initial repository commit excludes generated runtime artifacts", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-new-project-"));
  const target = join(parent, "runtime-artifacts-app");
  await mkdir(join(target, "node_modules", "package"), { recursive: true });
  await mkdir(join(target, ".blame", "logs"), { recursive: true });
  await writeFile(
    join(target, "package.json"),
    '{"name":"runtime-artifacts-app"}',
    "utf8",
  );
  await writeFile(
    join(target, "node_modules", "package", "index.js"),
    "module.exports = {}\n",
    "utf8",
  );
  await writeFile(
    join(target, ".blame", "logs", "cline.log"),
    "debug\n",
    "utf8",
  );

  await initializeGeneratedRepository(target);

  const { stdout } = await runGit(target, ["ls-files"]);
  assert.deepEqual(stdout.trim().split("\n"), [".gitignore", "package.json"]);
});

test("creates and extends the root gitignore before the initial commit", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-new-project-"));
  const target = join(parent, "gitignore-app");
  await mkdir(target);
  await writeFile(join(target, ".gitignore"), "dist/\n", "utf8");
  await writeFile(join(target, ".env"), "SECRET=value\n", "utf8");
  await writeFile(join(target, ".env.example"), "SECRET=\n", "utf8");
  await writeFile(
    join(target, "package.json"),
    '{"name":"gitignore-app"}',
    "utf8",
  );

  await initializeGeneratedRepository(target);

  const gitignore = await readFile(join(target, ".gitignore"), "utf8");
  const { stdout } = await runGit(target, ["ls-files"]);
  assert.match(gitignore, /^dist\/$/m);
  assert.match(gitignore, /^\.blame\/$/m);
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
  assert.deepEqual(stdout.trim().split("\n"), [
    ".env.example",
    ".gitignore",
    "package.json",
  ]);
});

test("pins package manager in generated package manifest", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-new-project-"));
  const target = join(parent, "manifest-app");
  await mkdir(target);
  await writeFile(
    join(target, "package.json"),
    '{"name":"manifest-app"}',
    "utf8",
  );

  await initializeGeneratedRepository(target);
  const recipe = projectCreationRecipe(baseConfiguration, target);
  await applyProjectOverlays(target, recipe.overlays, baseConfiguration);

  const parsed = JSON.parse(
    await readFile(join(target, "package.json"), "utf8"),
  );
  assert.equal(parsed.packageManager, "pnpm@10.33.2");
  assert.deepEqual(parsed.pnpm.onlyBuiltDependencies, [
    "@prisma/client",
    "@prisma/engines",
    "esbuild",
    "prisma",
    "sharp",
    "unrs-resolver",
  ]);
});

test("builds Next.js recipe with selected package manager and overlays", () => {
  const recipe = projectCreationRecipe(
    { ...baseConfiguration, packageManager: "npm" },
    "/tmp/my-app",
  );

  assert.equal(recipe.scaffold.command, "npm");
  assert.deepEqual(recipe.scaffold.args.slice(0, 3), [
    "create",
    "next-app@latest",
    "my-app",
  ]);
  assert.equal(recipe.installs[0]?.command, "npm");
  assert.equal(
    recipe.overlays.some((overlay) =>
      overlay.path.endsWith(".blame/preview.json"),
    ),
    true,
  );
});

test("scaffolds uppercase project names with npm-safe directory names", () => {
  const recipe = projectCreationRecipe(baseConfiguration, "/tmp/BlameTest");

  assert.equal(recipe.scaffoldTarget, "/tmp/blame-test");
  assert.deepEqual(recipe.scaffold.args.slice(0, 3), [
    "create",
    "next-app",
    "blame-test",
  ]);
});

test("builds Vite recipe for React templates", () => {
  const recipe = projectCreationRecipe(
    { ...baseConfiguration, frontend: "react-vite", backend: "hono" },
    "/tmp/react-app",
  );

  assert.equal(recipe.scaffold.command, "pnpm");
  assert.deepEqual(recipe.scaffold.args, [
    "create",
    "vite",
    "react-app",
    "--template",
    "react-ts",
  ]);
});

test("maps advanced options to generated files", () => {
  const recipe = projectCreationRecipe(
    {
      ...baseConfiguration,
      advancedOptions: [
        "docker",
        "dockerCompose",
        "e2eTests",
        "githubActions",
        "monorepo",
        "unitTests",
      ],
    },
    "/tmp/full-app",
  );

  assert.deepEqual(recipe.overlays.map((overlay) => overlay.path).sort(), [
    "/tmp/full-app/.github/workflows/ci.yml",
    "/tmp/full-app/Dockerfile",
    "/tmp/full-app/docker-compose.yml",
    "/tmp/full-app/pnpm-workspace.yaml",
    "/tmp/full-app/src/blame.generated.test.ts",
    "/tmp/full-app/tests/preview.spec.ts",
  ]);
});

test("advanced scripts and TypeScript alias options update project files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-new-project-"));
  const target = join(parent, "advanced-app");
  await mkdir(target);
  await writeFile(
    join(target, "package.json"),
    JSON.stringify({ name: "advanced-app" }),
    "utf8",
  );
  await writeFile(join(target, "tsconfig.json"), "{}", "utf8");

  await applyProjectOverlays(
    target,
    projectCreationRecipe(
      {
        ...baseConfiguration,
        advancedOptions: [
          "standardScripts",
          "typescriptAlias",
          "unitTests",
          "e2eTests",
        ],
      },
      target,
    ).overlays,
    {
      ...baseConfiguration,
      advancedOptions: [
        "standardScripts",
        "typescriptAlias",
        "unitTests",
        "e2eTests",
      ],
    },
  );

  const packageJson = JSON.parse(
    await readFile(join(target, "package.json"), "utf8"),
  );
  const tsconfig = JSON.parse(
    await readFile(join(target, "tsconfig.json"), "utf8"),
  );
  assert.equal(packageJson.scripts.dev, "next dev");
  assert.equal(packageJson.scripts.test, "vitest run");
  assert.equal(packageJson.scripts.e2e, "playwright test");
  assert.deepEqual(tsconfig.compilerOptions.paths["@/*"], ["./src/*"]);
});

test("TypeScript alias option accepts JSONC tsconfig files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-new-project-"));
  const target = join(parent, "jsonc-app");
  await mkdir(target);
  await writeFile(join(target, "package.json"), '{"name":"jsonc-app"}', "utf8");
  await writeFile(
    join(target, "tsconfig.json"),
    [
      "{",
      "  // generated framework tsconfig",
      '  "files": [],',
      '  "references": [{"path": "./.nuxt/tsconfig.app.json"}],',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  await applyProjectOverlays(target, [], {
    ...baseConfiguration,
    advancedOptions: ["typescriptAlias"],
  });

  const tsconfig = JSON.parse(
    await readFile(join(target, "tsconfig.json"), "utf8"),
  );
  assert.deepEqual(tsconfig.compilerOptions.paths["@/*"], ["./src/*"]);
});

test("monorepo option updates workspace metadata", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-new-project-"));
  const target = join(parent, "monorepo-app");
  await mkdir(target);
  await writeFile(
    join(target, "package.json"),
    '{"name":"monorepo-app"}',
    "utf8",
  );

  const configuration: NewProjectConfiguration = {
    ...baseConfiguration,
    advancedOptions: ["monorepo"],
  };

  await applyProjectOverlays(
    target,
    projectCreationRecipe(configuration, target).overlays,
    configuration,
  );

  const packageJson = JSON.parse(
    await readFile(join(target, "package.json"), "utf8"),
  );
  assert.deepEqual(packageJson.workspaces, ["apps/*", "packages/*"]);
  assert.equal(
    await readFile(join(target, "pnpm-workspace.yaml"), "utf8"),
    "packages:\n  - apps/*\n  - packages/*\n",
  );
});

test("disabled advanced scripts option does not synthesize standard scripts", async () => {
  const parent = await mkdtemp(join(tmpdir(), "blame-new-project-"));
  const target = join(parent, "plain-app");
  await mkdir(target);
  await writeFile(join(target, "package.json"), '{"name":"plain-app"}', "utf8");

  await applyProjectOverlays(target, [], {
    ...baseConfiguration,
    advancedOptions: [],
  });

  const packageJson = JSON.parse(
    await readFile(join(target, "package.json"), "utf8"),
  );
  assert.deepEqual(packageJson.scripts, {});
});

test("builds Blame initialization defaults without AI analysis", () => {
  assert.doesNotMatch(
    setupScript(baseConfiguration),
    /\b(?:npm|pnpm|yarn|bun|corepack)\b/,
  );
  assert.match(setupScript(baseConfiguration), /set -euo pipefail/);
  assert.doesNotMatch(setupScript(baseConfiguration), /command -v docker/);
  assert.match(setupScript(baseConfiguration), /COMPOSE_PROJECT_NAME/);
  assert.match(setupScript(baseConfiguration), /cp \.env\.example \.env/);
  assert.match(dockerCompose(baseConfiguration), /blame\.preview: "true"/);
  assert.match(
    dockerCompose(baseConfiguration),
    /blame\.preview\.protocol: "http"/,
  );
  assert.match(dockerCompose(baseConfiguration), /blame\.preview\.path: "\/"/);
  assert.match(dockerCompose(baseConfiguration), /-H 0\.0\.0\.0/);
  assert.match(dockerCompose(baseConfiguration), /node:22-bookworm-slim/);
  assert.doesNotMatch(dockerCompose(baseConfiguration), /node:22-alpine/);
  assert.match(dockerCompose(baseConfiguration), /node-modules-init:/);
  assert.match(dockerCompose(baseConfiguration), /chown -R 0:0/);
  assert.match(
    dockerCompose(baseConfiguration),
    /\[ ! -e \.\/node_modules\/\.bin\/next \]/,
  );
  assert.match(
    dockerCompose(baseConfiguration),
    /blame_node_modules:\/workspace\/node_modules/,
  );
  assert.match(dockerCompose(baseConfiguration), /corepack pnpm install/);
  assert.match(
    dockerCompose(baseConfiguration),
    /corepack pnpm exec prisma generate/,
  );
  assert.doesNotMatch(dockerCompose(baseConfiguration), /"pnpm install/);
  assert.match(
    dockerCompose(baseConfiguration),
    /\.\/node_modules\/\.bin\/next dev -H 0\.0\.0\.0/,
  );
  assert.doesNotMatch(dockerCompose(baseConfiguration), /pnpm run dev -- -H/);
  assert.doesNotMatch(
    dockerCompose(baseConfiguration),
    /user: "\$\{BLAME_HOST_UID\}:\$\{BLAME_HOST_GID\}"/,
  );
  assert.match(dockerCompose(baseConfiguration), /- "127\.0\.0\.1::3000"/);
  assert.doesNotMatch(dockerCompose(baseConfiguration), /3000:3000/);
  assert.match(
    dockerCompose(baseConfiguration),
    /\$\{BLAME_PROJECT_ROOT\}:\/workspace/,
  );
});

test("builds Vite preview host arguments for Blame initialization", () => {
  const compose = dockerCompose({
    ...baseConfiguration,
    frontend: "react-vite",
  });

  assert.match(compose, /--host 0\.0\.0\.0/);
  assert.match(compose, /\.\/node_modules\/\.bin\/vite --host 0\.0\.0\.0/);
  assert.match(compose, /- "127\.0\.0\.1::5173"/);
  assert.doesNotMatch(compose, /5173:5173/);
});

test("builds database services for SQL and document databases", () => {
  assert.match(dockerCompose(baseConfiguration), /image: postgres:17-alpine/);
  assert.doesNotMatch(dockerCompose(baseConfiguration), /5432:5432/);
  assert.match(
    dockerCompose({ ...baseConfiguration, database: "mysql" }),
    /image: mysql:9/,
  );
  assert.doesNotMatch(
    dockerCompose({ ...baseConfiguration, database: "mysql" }),
    /3306:3306/,
  );
  assert.match(
    dockerCompose({ ...baseConfiguration, database: "mongodb", orm: "none" }),
    /image: mongo:8/,
  );
  assert.doesNotMatch(
    dockerCompose({ ...baseConfiguration, database: "mongodb", orm: "none" }),
    /27017:27017/,
  );
});

test("builds FastAPI service with Python package manager setup", () => {
  const configuration: NewProjectConfiguration = {
    ...baseConfiguration,
    backend: "fastapi",
    frontend: "vue-vite",
    orm: "sqlalchemy",
    packageManager: "uv",
  };
  const recipe = projectSetupRecipe(configuration);

  assert.match(recipe.setupScript, /pip install uv && uv sync/);
  assert.match(
    recipe.setupScript,
    /if \[ -f alembic\.ini \]; then uv run alembic upgrade head; fi/,
  );
  assert.match(recipe.dockerCompose, /api:/);
  assert.match(recipe.dockerCompose, /python:3\.13-slim/);
  assert.match(recipe.dockerCompose, /uvicorn api\.main:app/);
  assert.match(recipe.dockerCompose, /NEXT_PUBLIC_API_URL|VITE_API_URL/);
  assert.doesNotMatch(recipe.dockerCompose, /8000:8000/);
});

test("builds Node API services for Hono Fastify and NestJS", () => {
  for (const backend of ["hono", "fastify", "nest"] as const) {
    const compose = dockerCompose({
      ...baseConfiguration,
      backend,
      frontend: "react-vite",
    });

    assert.match(compose, /api:/);
    assert.doesNotMatch(compose, /4000:4000/);
    assert.match(compose, /dev:api/);
    assert.match(compose, /while \[ ! -e \.\/node_modules\/\.bin\/vite \]/);
    assert.match(compose, /VITE_API_URL: "http:\/\/localhost:4000"/);
  }
});

test("builds package-manager specific setup commands", () => {
  assert.doesNotMatch(
    setupScript({ ...baseConfiguration, packageManager: "npm" }),
    /npm install/,
  );
  assert.doesNotMatch(
    setupScript({ ...baseConfiguration, packageManager: "bun" }),
    /bun install/,
  );
  assert.match(
    setupScript({
      ...baseConfiguration,
      backend: "fastapi",
      packageManager: "poetry",
    }),
    /poetry install/,
  );
});

test("builds container-safe package manager commands", () => {
  assert.match(
    dockerCompose(baseConfiguration),
    /corepack prepare pnpm@10\.33\.2 --activate/,
  );
  assert.match(dockerCompose(baseConfiguration), /corepack pnpm install/);
  assert.match(
    dockerCompose(baseConfiguration),
    /\[ ! -e \.\/node_modules\/\.bin\/next \]/,
  );
  assert.match(
    dockerCompose({ ...baseConfiguration, packageManager: "yarn" }),
    /corepack yarn install/,
  );
  assert.match(
    dockerCompose({ ...baseConfiguration, packageManager: "npm" }),
    /npm install/,
  );
  assert.match(
    dockerCompose({ ...baseConfiguration, packageManager: "bun" }),
    /oven\/bun:1/,
  );
});

test("guards ORM setup commands until config files exist", () => {
  assert.doesNotMatch(setupScript(baseConfiguration), /prisma generate/);
  assert.match(
    dockerCompose(baseConfiguration),
    /if \[ -f prisma\/schema\.prisma \].+corepack pnpm exec prisma generate; fi/,
  );
  assert.doesNotMatch(dockerCompose(baseConfiguration), /npx prisma generate/);
  assert.match(
    dockerCompose({ ...baseConfiguration, orm: "drizzle" }),
    /if \[ -f drizzle\.config\.ts \].+corepack pnpm exec drizzle-kit generate; fi/,
  );
});

const matrixCases: Array<{
  name: string;
  configuration: NewProjectConfiguration;
  expected: {
    compose: RegExp[];
    devDependencies?: string[];
    dependencies?: string[];
    overlays?: string[];
    scaffold: string[];
    scaffoldIncludes?: string[];
    setup: RegExp[];
    target?: string;
  };
}> = [
  {
    name: "Next.js + Tailwind + shadcn + Next API + PostgreSQL + Prisma + pnpm",
    configuration: baseConfiguration,
    expected: {
      compose: [
        /- "127\.0\.0\.1::3000"/,
        /postgres:17-alpine/,
        /DATABASE_URL: "postgresql:\/\/blame:blame@database:5432\/blame"/,
      ],
      dependencies: ["@prisma/client", "pg"],
      devDependencies: ["prisma", "shadcn"],
      overlays: [".env.example", "README.md", ".blame/preview.json"],
      scaffold: ["pnpm", "create", "next-app", "matrix-next"],
      scaffoldIncludes: ["--tailwind", "--eslint", "--use-pnpm"],
      setup: [/COMPOSE_PROJECT_NAME/, /cp \.env\.example \.env/],
      target: "/tmp/matrix-next",
    },
  },
  {
    name: "React Vite + DaisyUI + Hono + SQLite + Drizzle + Biome",
    configuration: {
      ...baseConfiguration,
      backend: "hono",
      codeQuality: "biome",
      database: "sqlite",
      frontend: "react-vite",
      orm: "drizzle",
      styling: "tailwind",
      uiLibrary: "daisyui",
    },
    expected: {
      compose: [
        /- "127\.0\.0\.1::5173"/,
        /api:/,
        /DATABASE_URL: "file:.\/dev.db"/,
      ],
      dependencies: ["better-sqlite3", "daisyui", "drizzle-orm", "hono"],
      devDependencies: ["@biomejs/biome", "drizzle-kit"],
      overlays: [".env.example", "README.md", ".blame/preview.json"],
      scaffold: [
        "pnpm",
        "create",
        "vite",
        "matrix-react",
        "--template",
        "react-ts",
      ],
      setup: [/COMPOSE_PROJECT_NAME/, /cp \.env\.example \.env/],
      target: "/tmp/matrix-react",
    },
  },
  {
    name: "Nuxt + Nuxt UI + Nitro + PostgreSQL",
    configuration: {
      ...baseConfiguration,
      backend: "nitro",
      database: "postgresql",
      frontend: "nuxt",
      orm: "none",
      uiLibrary: "nuxt-ui",
    },
    expected: {
      compose: [/- "127\.0\.0\.1::3000"/, /postgres:17-alpine/],
      dependencies: ["@nuxt/ui", "pg"],
      overlays: [".env.example", "README.md", ".blame/preview.json"],
      scaffold: [
        "pnpm",
        "create",
        "nuxt",
        "matrix-nuxt",
        "--template",
        "minimal",
        "--no-install",
        "--packageManager=pnpm",
        "--gitInit=false",
        "--modules=",
      ],
      setup: [/COMPOSE_PROJECT_NAME/, /cp \.env\.example \.env/],
      target: "/tmp/matrix-nuxt",
    },
  },
  {
    name: "Vue Vite + PrimeVue + FastAPI + PostgreSQL + SQLAlchemy + uv",
    configuration: {
      ...baseConfiguration,
      backend: "fastapi",
      database: "postgresql",
      frontend: "vue-vite",
      orm: "sqlalchemy",
      packageManager: "uv",
      uiLibrary: "primevue",
    },
    expected: {
      compose: [
        /- "127\.0\.0\.1::5173"/,
        /api:/,
        /postgres:17-alpine/,
        /uvicorn api\.main:app/,
      ],
      dependencies: ["pg", "primevue"],
      overlays: [
        ".env.example",
        "README.md",
        ".blame/preview.json",
        "api/main.py",
        "pyproject.toml",
      ],
      scaffold: [
        "npm",
        "create",
        "vite@latest",
        "matrix-vue",
        "--template",
        "vue-ts",
      ],
      setup: [/pip install uv && uv sync/, /uv run alembic upgrade head/],
      target: "/tmp/matrix-vue",
    },
  },
  {
    name: "SvelteKit + shadcn-svelte + SQLite + Drizzle",
    configuration: {
      ...baseConfiguration,
      backend: "none",
      database: "sqlite",
      frontend: "sveltekit",
      orm: "drizzle",
      uiLibrary: "shadcn-svelte",
    },
    expected: {
      compose: [/- "127\.0\.0\.1::5173"/, /DATABASE_URL: "file:.\/dev.db"/],
      dependencies: ["better-sqlite3", "drizzle-orm"],
      devDependencies: ["drizzle-kit", "shadcn-svelte"],
      overlays: [".env.example", "README.md", ".blame/preview.json"],
      scaffold: [
        "pnpm",
        "dlx",
        "sv",
        "create",
        "matrix-svelte",
        "--template",
        "minimal",
        "--types",
        "ts",
        "--no-add-ons",
        "--no-install",
        "--no-dir-check",
        "--no-download-check",
      ],
      setup: [/COMPOSE_PROJECT_NAME/, /cp \.env\.example \.env/],
      target: "/tmp/matrix-svelte",
    },
  },
  {
    name: "React Vite + no backend + no DB + no ORM",
    configuration: {
      ...baseConfiguration,
      backend: "none",
      database: "none",
      frontend: "react-vite",
      orm: "none",
      uiLibrary: "none",
    },
    expected: {
      compose: [/- "127\.0\.0\.1::5173"/],
      overlays: [".env.example", "README.md", ".blame/preview.json"],
      scaffold: [
        "pnpm",
        "create",
        "vite",
        "matrix-empty",
        "--template",
        "react-ts",
      ],
      setup: [/COMPOSE_PROJECT_NAME/, /cp \.env\.example \.env/],
      target: "/tmp/matrix-empty",
    },
  },
];

for (const item of matrixCases) {
  test(`matrix recipe: ${item.name}`, () => {
    const recipe = projectCreationRecipe(
      item.configuration,
      item.expected.target ?? "/tmp/matrix-project",
    );
    const setup = projectSetupRecipe(item.configuration);

    assertScaffold(recipe, item.expected.scaffold);
    assertScaffoldContains(recipe, item.expected.scaffoldIncludes ?? []);
    assertPackages(recipe, item.expected.dependencies ?? [], false);
    assertPackages(recipe, item.expected.devDependencies ?? [], true);
    assertOverlays(recipe, item.expected.overlays ?? []);
    for (const pattern of item.expected.setup)
      assert.match(setup.setupScript, pattern);
    for (const pattern of item.expected.compose)
      assert.match(setup.dockerCompose, pattern);
  });
}

test("matrix recipe: npm-safe scaffold target keeps final path for uppercase names", () => {
  const recipe = projectCreationRecipe(baseConfiguration, "/tmp/BlameMatrix");

  assert.equal(recipe.scaffoldTarget, "/tmp/blame-matrix");
  assertScaffold(recipe, ["pnpm", "create", "next-app", "blame-matrix"]);
});

function assertScaffold(recipe: ProjectCreationRecipe, expected: string[]) {
  assert.deepEqual(
    [recipe.scaffold.command, ...recipe.scaffold.args].slice(
      0,
      expected.length,
    ),
    expected,
  );
}

function assertScaffoldContains(
  recipe: ProjectCreationRecipe,
  expectedItems: string[],
) {
  const command = [recipe.scaffold.command, ...recipe.scaffold.args];
  for (const item of expectedItems) {
    assert.equal(
      command.includes(item),
      true,
      `${item} should be in scaffold command`,
    );
  }
}

function assertPackages(
  recipe: ProjectCreationRecipe,
  expectedPackages: string[],
  dev: boolean,
) {
  const args = recipe.installs.flatMap((install) => install.args);
  for (const packageName of expectedPackages) {
    assert.equal(
      args.includes(packageName),
      true,
      `${packageName} should be installed${dev ? " as dev dependency" : ""}`,
    );
  }
}

function assertOverlays(
  recipe: ProjectCreationRecipe,
  expectedPaths: string[],
) {
  const paths = recipe.overlays.map((overlay) => overlay.path);
  for (const path of expectedPaths) {
    assert.equal(
      paths.some((overlayPath) => overlayPath.endsWith(path)),
      true,
      `${path} overlay should exist`,
    );
  }
}

function runGit(cwd: string, args: string[]) {
  return execFileAsync(
    "git",
    ["-c", "user.name=Blame", "-c", "user.email=blame@example.local", ...args],
    { cwd },
  );
}
