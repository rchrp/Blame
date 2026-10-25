export type ProjectPlatform =
  | "web"
  | "backend"
  | "desktop"
  | "mobile"
  | "cli"
  | "package";

export type FrontendFramework =
  | "next"
  | "react-vite"
  | "nuxt"
  | "vue-vite"
  | "sveltekit"
  | "none";

export type StylingOption =
  | "tailwind"
  | "css-modules"
  | "sass"
  | "vanilla-css"
  | "none";

export type UiLibrary =
  | "shadcn"
  | "radix"
  | "mantine"
  | "mui"
  | "ant-design"
  | "daisyui"
  | "nuxt-ui"
  | "primevue"
  | "vuetify"
  | "naive-ui"
  | "shadcn-svelte"
  | "skeleton"
  | "melt-ui"
  | "flowbite-svelte"
  | "none";

export type BackendFramework =
  | "next-api"
  | "nest"
  | "hono"
  | "fastify"
  | "fastapi"
  | "nitro"
  | "none";

export type DatabaseOption =
  | "postgresql"
  | "mysql"
  | "sqlite"
  | "mongodb"
  | "none";

export type OrmOption =
  | "prisma"
  | "drizzle"
  | "kysely"
  | "sqlalchemy"
  | "sqlmodel"
  | "none";

export type PackageManager =
  | "pnpm"
  | "npm"
  | "yarn"
  | "bun"
  | "uv"
  | "poetry"
  | "pip";

export type CodeQualityOption =
  | "biome"
  | "eslint-prettier"
  | "eslint"
  | "prettier"
  | "none";

export type AdvancedProjectOption =
  | "docker"
  | "dockerCompose"
  | "monorepo"
  | "auth"
  | "unitTests"
  | "e2eTests"
  | "githubActions"
  | "envExample"
  | "readme"
  | "typescriptAlias"
  | "standardScripts"
  | "blamePreview";

export type NewProjectConfiguration = {
  platform: ProjectPlatform;
  frontend: FrontendFramework;
  styling: StylingOption;
  uiLibrary: UiLibrary;
  backend: BackendFramework;
  database: DatabaseOption;
  orm: OrmOption;
  packageManager: PackageManager;
  codeQuality: CodeQualityOption;
  advancedOptions: AdvancedProjectOption[];
};

export type NewProjectOption<T extends string> = {
  value: T;
  label: string;
  description: string;
  disabled?: boolean;
  recommended?: boolean;
};

export const defaultAdvancedOptions: AdvancedProjectOption[] = [
  "envExample",
  "readme",
  "typescriptAlias",
  "standardScripts",
  "blamePreview",
];

export const defaultNewProjectConfiguration: NewProjectConfiguration = {
  platform: "web",
  frontend: "next",
  styling: "tailwind",
  uiLibrary: "shadcn",
  backend: "next-api",
  database: "postgresql",
  orm: "prisma",
  packageManager: "pnpm",
  codeQuality: "eslint-prettier",
  advancedOptions: defaultAdvancedOptions,
};

export const platformOptions: NewProjectOption<ProjectPlatform>[] = [
  {
    value: "web",
    label: "Application web",
    description: "Frontend, full-stack app, or web service ready for Blame.",
  },
  {
    value: "backend",
    label: "Service backend",
    description: "API or service template. Available later.",
    disabled: true,
  },
  {
    value: "desktop",
    label: "Application desktop",
    description: "Electron, Tauri, or native desktop. Available later.",
    disabled: true,
  },
  {
    value: "mobile",
    label: "Application mobile",
    description: "Mobile app template. Available later.",
    disabled: true,
  },
  {
    value: "cli",
    label: "CLI / Script",
    description: "Command line tool or automation script. Available later.",
    disabled: true,
  },
  {
    value: "package",
    label: "Librairie / Package",
    description: "Reusable package template. Available later.",
    disabled: true,
  },
];

export const frontendOptions: NewProjectOption<FrontendFramework>[] = [
  {
    value: "next",
    label: "Next.js",
    description: "React full-stack framework with App Router.",
    recommended: true,
  },
  {
    value: "react-vite",
    label: "React + Vite",
    description: "Client app with fast Vite tooling.",
  },
  {
    value: "nuxt",
    label: "Nuxt",
    description: "Vue full-stack framework powered by Nitro.",
  },
  {
    value: "vue-vite",
    label: "Vue + Vite",
    description: "Vue client app with Vite.",
  },
  {
    value: "sveltekit",
    label: "SvelteKit",
    description: "Full-stack Svelte application.",
  },
  {
    value: "none",
    label: "None",
    description: "No frontend generated.",
  },
];

export const stylingOptions: NewProjectOption<StylingOption>[] = [
  {
    value: "tailwind",
    label: "Tailwind CSS",
    description: "Utility-first styling.",
    recommended: true,
  },
  {
    value: "css-modules",
    label: "CSS Modules",
    description: "Scoped CSS files.",
  },
  {
    value: "sass",
    label: "Sass",
    description: "SCSS syntax and variables.",
  },
  {
    value: "vanilla-css",
    label: "Vanilla CSS",
    description: "Plain global CSS.",
  },
  {
    value: "none",
    label: "None",
    description: "No styling setup.",
  },
];

export const databaseOptions: NewProjectOption<DatabaseOption>[] = [
  {
    value: "postgresql",
    label: "PostgreSQL",
    description: "Default relational database.",
    recommended: true,
  },
  {
    value: "mysql",
    label: "MySQL",
    description: "Relational database.",
  },
  {
    value: "sqlite",
    label: "SQLite",
    description: "Local SQL database.",
  },
  {
    value: "mongodb",
    label: "MongoDB",
    description: "Document database.",
  },
  {
    value: "none",
    label: "None",
    description: "No database setup.",
  },
];

export const advancedOptionLabels: Record<AdvancedProjectOption, string> = {
  docker: "Docker",
  dockerCompose: "docker-compose",
  monorepo: "Monorepo",
  auth: "Auth",
  unitTests: "Tests unitaires",
  e2eTests: "Tests e2e",
  githubActions: "CI GitHub Actions",
  envExample: ".env.example",
  readme: "README généré",
  typescriptAlias: "Alias TypeScript",
  standardScripts: "Scripts dev/build/lint/test",
  blamePreview: "Preview locale compatible Blame",
};

export function uiLibraryOptions(
  frontend: FrontendFramework,
): NewProjectOption<UiLibrary>[] {
  if (frontend === "next" || frontend === "react-vite") {
    return [
      option("shadcn", "shadcn/ui", "Composable UI with Tailwind.", true),
      option("radix", "Radix UI", "Accessible primitives."),
      option("mantine", "Mantine", "React component library."),
      option("mui", "MUI", "Material UI components."),
      option("ant-design", "Ant Design", "Enterprise React components."),
      option("daisyui", "DaisyUI", "Tailwind component classes."),
      option("none", "None", "No UI library."),
    ];
  }

  if (frontend === "nuxt" || frontend === "vue-vite") {
    return [
      option(
        "nuxt-ui",
        "Nuxt UI",
        "Nuxt-first UI library.",
        frontend === "nuxt",
      ),
      option(
        "primevue",
        "PrimeVue",
        "Vue component library.",
        frontend === "vue-vite",
      ),
      option("vuetify", "Vuetify", "Material Vue components."),
      option("naive-ui", "Naive UI", "Vue component library."),
      option("daisyui", "DaisyUI", "Tailwind component classes."),
      option("none", "None", "No UI library."),
    ].map((item) => ({
      ...item,
      disabled: item.value === "nuxt-ui" && frontend !== "nuxt",
    }));
  }

  if (frontend === "sveltekit") {
    return [
      option(
        "shadcn-svelte",
        "shadcn-svelte",
        "Svelte components with Tailwind.",
        true,
      ),
      option("skeleton", "Skeleton", "Svelte UI toolkit."),
      option("melt-ui", "Melt UI", "Svelte headless builders."),
      option(
        "flowbite-svelte",
        "Flowbite Svelte",
        "Tailwind Svelte components.",
      ),
      option("daisyui", "DaisyUI", "Tailwind component classes."),
      option("none", "None", "No UI library."),
    ];
  }

  return [option("none", "None", "No UI library.", false, true)];
}

export function backendOptions(
  frontend: FrontendFramework,
): NewProjectOption<BackendFramework>[] {
  if (frontend === "next") {
    return [
      option(
        "next-api",
        "Next.js API / Server Actions",
        "Route handlers and server actions.",
        true,
      ),
      option("nest", "NestJS", "Structured Node backend."),
      option("hono", "Hono", "Small TypeScript web framework."),
      option("none", "None", "No backend."),
    ];
  }

  if (
    frontend === "react-vite" ||
    frontend === "vue-vite" ||
    frontend === "sveltekit"
  ) {
    return [
      option("hono", "Hono", "Small TypeScript web framework.", true),
      option("fastify", "Fastify", "Fast Node backend."),
      option("nest", "NestJS", "Structured Node backend."),
      option("fastapi", "FastAPI", "Python API backend."),
      option("none", "None", "No backend."),
    ];
  }

  if (frontend === "nuxt") {
    return [
      option("nitro", "Nitro server", "Nuxt server API.", true),
      option("nest", "NestJS", "Structured Node backend."),
      option("fastapi", "FastAPI", "Python API backend."),
      option("none", "None", "No backend."),
    ];
  }

  return [
    option("hono", "Hono", "Small TypeScript web framework.", true),
    option("fastify", "Fastify", "Fast Node backend."),
    option("nest", "NestJS", "Structured Node backend."),
    option("fastapi", "FastAPI", "Python API backend."),
    option("none", "None", "No backend."),
  ];
}

export function ormOptions(
  backend: BackendFramework,
  database: DatabaseOption,
): NewProjectOption<OrmOption>[] {
  if (database === "none" || backend === "none") {
    return [option("none", "None", "No ORM.", false, true)];
  }

  if (backend === "fastapi") {
    return [
      option("sqlalchemy", "SQLAlchemy + Alembic", "Python SQL toolkit.", true),
      option("sqlmodel", "SQLModel", "Pydantic-friendly SQL models."),
      option("none", "None", "No ORM."),
    ];
  }

  return [
    option("prisma", "Prisma", "Classic SaaS ORM.", database !== "mongodb"),
    {
      ...option("drizzle", "Drizzle", "Lightweight SQL-first ORM."),
      disabled: !["postgresql", "mysql", "sqlite"].includes(database),
    },
    {
      ...option("kysely", "Kysely", "Typed SQL query builder."),
      disabled: database === "mongodb",
    },
    option("none", "None", "No ORM."),
  ];
}

export function packageManagerOptions(
  backend: BackendFramework,
): NewProjectOption<PackageManager>[] {
  if (backend === "fastapi") {
    return [
      option("uv", "uv", "Fast Python package manager.", true),
      option("poetry", "poetry", "Python dependency manager."),
      option("pip", "pip", "Standard Python installer."),
    ];
  }

  return [
    option("pnpm", "pnpm", "Fast Node package manager.", true),
    option("npm", "npm", "Standard Node package manager."),
    option("yarn", "yarn", "Yarn package manager."),
    option("bun", "bun", "Bun runtime and package manager."),
  ];
}

export function codeQualityOptions(
  frontend: FrontendFramework,
  backend: BackendFramework,
): NewProjectOption<CodeQualityOption>[] {
  return [
    option(
      "biome",
      "Biome",
      "Modern linting and formatting.",
      backend !== "nest" && frontend !== "next",
    ),
    option(
      "eslint-prettier",
      "ESLint + Prettier",
      "Standard framework linting.",
      backend === "nest" || frontend === "next",
    ),
    option("eslint", "ESLint only", "Linting without formatter."),
    option("prettier", "Prettier only", "Formatting only."),
    option("none", "None", "No quality tooling."),
  ];
}

export function normalizeNewProjectConfiguration(
  configuration: NewProjectConfiguration,
): NewProjectConfiguration {
  const frontend =
    configuration.platform === "web" ? configuration.frontend : "none";
  const uiLibrary = normalizeUiLibrary(frontend, configuration.uiLibrary);
  const styling = normalizeStyling(frontend, uiLibrary, configuration.styling);
  const backend = normalizeBackend(frontend, configuration.backend);
  const database = configuration.database;
  const orm = normalizeOrm(backend, database, configuration.orm);
  const packageManager = normalizePackageManager(
    backend,
    configuration.packageManager,
  );
  const codeQuality = normalizeCodeQuality(
    frontend,
    backend,
    configuration.codeQuality,
  );

  return {
    ...configuration,
    frontend,
    styling,
    uiLibrary,
    backend,
    database,
    orm,
    packageManager,
    codeQuality,
  };
}

export function requiresTailwind(uiLibrary: UiLibrary) {
  return ["shadcn", "shadcn-svelte", "daisyui"].includes(uiLibrary);
}

export function recommendedUiLibrary(frontend: FrontendFramework): UiLibrary {
  if (frontend === "nuxt") return "nuxt-ui";
  if (frontend === "vue-vite") return "primevue";
  if (frontend === "sveltekit") return "shadcn-svelte";
  if (frontend === "next" || frontend === "react-vite") return "shadcn";
  return "none";
}

export function recommendedBackend(
  frontend: FrontendFramework,
): BackendFramework {
  if (frontend === "next") return "next-api";
  if (frontend === "nuxt") return "nitro";
  if (frontend === "none") return "hono";
  return "hono";
}

export function optionLabel<T extends string>(
  options: NewProjectOption<T>[],
  value: T,
) {
  return options.find((item) => item.value === value)?.label ?? value;
}

function normalizeUiLibrary(frontend: FrontendFramework, uiLibrary: UiLibrary) {
  const available = uiLibraryOptions(frontend).filter((item) => !item.disabled);
  if (available.some((item) => item.value === uiLibrary)) return uiLibrary;
  return recommendedUiLibrary(frontend);
}

function normalizeStyling(
  frontend: FrontendFramework,
  uiLibrary: UiLibrary,
  styling: StylingOption,
) {
  if (frontend === "none") return "none";
  if (requiresTailwind(uiLibrary)) return "tailwind";
  return styling;
}

function normalizeBackend(
  frontend: FrontendFramework,
  backend: BackendFramework,
) {
  const available = backendOptions(frontend).filter((item) => !item.disabled);
  if (available.some((item) => item.value === backend)) return backend;
  return recommendedBackend(frontend);
}

function normalizeOrm(
  backend: BackendFramework,
  database: DatabaseOption,
  orm: OrmOption,
) {
  const available = ormOptions(backend, database).filter(
    (item) => !item.disabled,
  );
  if (available.some((item) => item.value === orm)) return orm;
  return available.find((item) => item.recommended)?.value ?? "none";
}

function normalizePackageManager(
  backend: BackendFramework,
  packageManager: PackageManager,
) {
  const available = packageManagerOptions(backend);
  if (available.some((item) => item.value === packageManager))
    return packageManager;
  return backend === "fastapi" ? "uv" : "pnpm";
}

function normalizeCodeQuality(
  frontend: FrontendFramework,
  backend: BackendFramework,
  codeQuality: CodeQualityOption,
) {
  const available = codeQualityOptions(frontend, backend);
  if (available.some((item) => item.value === codeQuality)) return codeQuality;
  return backend === "nest" || frontend === "next"
    ? "eslint-prettier"
    : "biome";
}

function option<T extends string>(
  value: T,
  label: string,
  description: string,
  recommended = false,
  disabled = false,
): NewProjectOption<T> {
  return { value, label, description, recommended, disabled };
}

/** The same choices power the wizard, the planner schema and reply validation. */
export function newProjectConfigurationChoices(
  configuration: NewProjectConfiguration,
) {
  return {
    platform: platformOptions,
    frontend: frontendOptions,
    styling: stylingOptions,
    uiLibrary: uiLibraryOptions(configuration.frontend),
    backend: backendOptions(configuration.frontend),
    database: databaseOptions,
    orm: ormOptions(configuration.backend, configuration.database),
    packageManager: packageManagerOptions(configuration.backend),
    codeQuality: codeQualityOptions(
      configuration.frontend,
      configuration.backend,
    ),
  };
}

export function parseNewProjectConfiguration(
  value: unknown,
): NewProjectConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The agent must provide a complete project configuration.");
  const input = value as Record<string, unknown>;
  const fields = Object.keys(
    newProjectConfigurationChoices(defaultNewProjectConfiguration),
  );
  if (fields.some((field) => typeof input[field] !== "string"))
    throw new Error("The agent returned an incomplete project configuration.");
  if (
    !Array.isArray(input.advancedOptions) ||
    input.advancedOptions.some(
      (option) =>
        typeof option !== "string" ||
        !Object.hasOwn(advancedOptionLabels, option),
    )
  )
    throw new Error("The agent selected an unsupported advanced option.");
  // Rebuild the object so only known fields can reach project generation.
  const configuration = Object.fromEntries([
    ...fields.map((field) => [field, input[field]]),
    ["advancedOptions", [...new Set(input.advancedOptions)]],
  ]) as NewProjectConfiguration;
  const choices = newProjectConfigurationChoices(configuration);
  for (const [field, options] of Object.entries(choices)) {
    const selected = configuration[field as keyof typeof choices];
    if (
      !options.some(
        (option) =>
          option.value === selected &&
          (!option.disabled ||
            (options.length === 1 && option.value === "none")),
      )
    )
      throw new Error(
        `The agent selected an unavailable ${field}: ${selected}.`,
      );
  }
  const normalized = normalizeNewProjectConfiguration(configuration);
  if (
    fields.some(
      (field) =>
        normalized[field as keyof typeof choices] !==
        configuration[field as keyof typeof choices],
    )
  )
    throw new Error(
      "The agent selected incompatible stack options. Please ask it to revise its proposal.",
    );
  return configuration;
}
