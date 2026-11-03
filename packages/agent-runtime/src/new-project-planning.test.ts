import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultNewProjectConfiguration,
  normalizeNewProjectConfiguration,
  parseNewProjectConfiguration,
  frontendOptions,
  backendOptions,
  uiLibraryOptions,
  databaseOptions,
  ormOptions,
  packageManagerOptions,
} from "./new-project-options.js";
import {
  newProjectStackCatalogPrompt,
  projectStackProposalTool,
} from "./new-project-planning.js";

test("the stack tool accepts a complete catalog configuration", async () => {
  const tool = projectStackProposalTool();
  assert.equal(tool.name, "propose_project_stack");
  assert.deepEqual(
    await tool.execute(
      { configuration: defaultNewProjectConfiguration },
      {} as never,
    ),
    { accepted: true, configuration: defaultNewProjectConfiguration },
  );
  await assert.rejects(
    async () =>
      tool.execute(
        {
          configuration: {
            ...defaultNewProjectConfiguration,
            frontend: "angular",
          },
        },
        {} as never,
      ),
    /frontend|angular/iu,
  );
});

test("rejects invented, unavailable, incomplete and incompatible stack choices", () => {
  for (const patch of [
    { platform: "mobile" },
    { frontend: "angular" },
    { frontend: "vue-vite", uiLibrary: "shadcn" },
    { frontend: "vue-vite", uiLibrary: "nuxt-ui" },
    { styling: "sass" },
    { backend: "fastapi" },
    { database: "none" },
    { database: "mongodb", orm: "drizzle" },
    { packageManager: "pip" },
    { advancedOptions: ["payments"] },
    { advancedOptions: ["toString"] },
    { codeQuality: undefined },
  ])
    assert.throws(
      () =>
        parseNewProjectConfiguration({
          ...defaultNewProjectConfiguration,
          ...patch,
        }),
      JSON.stringify(patch),
    );
  assert.throws(() => parseNewProjectConfiguration(null));
  assert.throws(() => parseNewProjectConfiguration({}));
});

test("accepts the normalized manual choices including forced none fields", () => {
  for (const frontend of frontendOptions) {
    for (const backend of backendOptions(frontend.value)) {
      for (const database of databaseOptions) {
        for (const ui of uiLibraryOptions(frontend.value).filter(
          (item) => !item.disabled || item.value === "none",
        )) {
          const configuration = normalizeNewProjectConfiguration({
            ...defaultNewProjectConfiguration,
            frontend: frontend.value,
            backend: backend.value,
            database: database.value,
            uiLibrary: ui.value,
            orm:
              ormOptions(backend.value, database.value).find(
                (item) => !item.disabled,
              )?.value ?? "none",
            packageManager: packageManagerOptions(backend.value)[0]!.value,
          });
          assert.deepEqual(
            parseNewProjectConfiguration(configuration),
            configuration,
          );
        }
      }
    }
  }
});

test("strips extra fields and de-duplicates advanced options", () => {
  const result = parseNewProjectConfiguration({
    ...defaultNewProjectConfiguration,
    advancedOptions: ["readme", "readme"],
    shellCommand: "invalid",
  });
  assert.deepEqual(result.advancedOptions, ["readme"]);
  assert.equal("shellCommand" in result, false);
});

test("the system prompt names the project and lists the shared catalog", () => {
  const prompt = newProjectStackCatalogPrompt("invoices");
  assert.match(prompt, /<project_name>invoices<\/project_name>/u);
  const catalog = JSON.parse(
    /<available_stack>\n(.*)\n<\/available_stack>/su.exec(prompt)![1]!,
  );
  assert.deepEqual(catalog.platform, ["web"]);
  assert.deepEqual(
    catalog.frontend.find((item: { value: string }) => item.value === "next")
      .backend,
    backendOptions("next").map((option) => option.value),
  );
});
