import assert from "node:assert/strict";
import test from "node:test";
import type { ClineCore, CoreSessionConfig } from "@cline/sdk";
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
  newProjectPlanningPrompt,
  newProjectPlanningToolPolicies,
  planNewProject,
  projectPlanReply,
  runNewProjectPlanning,
} from "./new-project-planning.js";
import type { PlanNewProjectInput } from "./types.js";

const input: PlanNewProjectInput = {
  apiConnection: { url: "https://api.test" },
  providerId: "provider",
  modelId: "model",
  cwd: "/parent",
  workspaceRoot: "/parent",
  projectName: "invoices",
  messages: [{ role: "user", text: "An invoice app for freelancers" }],
};
const credential = { apiKey: "test", baseUrl: null };

test("clarification and stack proposals are distinct replies", () => {
  assert.deepEqual(
    projectPlanReply({
      message: "  Will people sign in? ",
      configuration: null,
      notes: "Freelancers",
    }),
    {
      message: "Will people sign in?",
      notes: "Freelancers",
    },
  );
  assert.deepEqual(
    projectPlanReply({
      message: "Use Next.js",
      configuration: defaultNewProjectConfiguration,
    }).configuration,
    defaultNewProjectConfiguration,
  );
  assert.throws(
    () => projectPlanReply({ configuration: defaultNewProjectConfiguration }),
    /explain/,
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

test("the prompt retains the original brief, recent replies and notes with the shared catalog", () => {
  const prompt = JSON.parse(
    newProjectPlanningPrompt({
      ...input,
      notes: "No authentication needed",
      messages: [
        ...input.messages,
        { role: "assistant", text: "How will invoices be stored?" },
        { role: "user", text: "Only locally" },
      ],
    }),
  );
  assert.equal(prompt.messages[0].text, input.messages[0]!.text);
  assert.equal(prompt.messages.at(-1).text, "Only locally");
  assert.equal(prompt.notes, "No authentication needed");
  assert.deepEqual(prompt.availableStack.platform, ["web"]);
  assert.deepEqual(
    prompt.availableStack.frontend.find(
      (item: { value: string }) => item.value === "next",
    ).backend,
    backendOptions("next").map((option) => option.value),
  );
  assert.equal(prompt.projectName, "invoices");
});

test("planning cannot read the parent directory, write files or execute commands", () => {
  const policies = newProjectPlanningToolPolicies();
  for (const name of [
    "read_files",
    "search_codebase",
    "run_commands",
    "editor",
    "apply_patch",
    "read_user_story",
    "ask_question",
    "skills",
    "run_task",
    "finish_task",
  ])
    assert.equal(policies[name]?.enabled, false, name);
  assert.equal(policies.submit_project_stack?.enabled, true);
});

function fakeCore(reply: unknown) {
  return {
    async start(request: { config: CoreSessionConfig; interactive: boolean }) {
      assert.equal(request.interactive, false);
      assert.equal(request.config.enableSpawnAgent, false);
      assert.equal(request.config.cwd, "/parent");
      assert.equal(request.config.extraTools?.length, 1);
      await request.config.extraTools![0]!.execute(reply, {} as never);
      return { sessionId: request.config.sessionId };
    },
  } as unknown as ClineCore;
}

test("a clarification turn then a proposal use the same structured conversation protocol", async () => {
  const question = await planNewProject(
    input,
    fakeCore({
      message: "Do you need accounts?",
      configuration: null,
      notes: "Freelancers",
    }),
    credential,
    "turn-1",
  );
  assert.equal(question.configuration, undefined);
  const result = await planNewProject(
    {
      ...input,
      messages: [
        ...input.messages,
        { role: "assistant", text: question.message },
        { role: "user", text: "Yes" },
      ],
      notes: question.notes,
    },
    fakeCore({
      message: "Next.js fits.",
      configuration: {
        ...defaultNewProjectConfiguration,
        advancedOptions: ["auth"],
      },
    }),
    credential,
    "turn-2",
  );
  assert.equal(result.sessionId, "turn-2");
  assert.deepEqual(result.configuration?.advancedOptions, ["auth"]);
});

test("plain-text fallback never fabricates a ready stack", async () => {
  const core = {
    start: async () => ({ result: { text: "Which users will need this?" } }),
  } as unknown as ClineCore;
  const result = await planNewProject(input, core, credential, "turn-1");
  assert.equal(result.configuration, undefined);
  await assert.rejects(
    planNewProject({ ...input, messages: [] }, core, credential, "turn-2"),
    /Describe/,
  );
  await assert.rejects(
    planNewProject(
      input,
      { start: async () => ({}) } as unknown as ClineCore,
      credential,
      "turn-3",
    ),
    /did not reply/,
  );
});

test("runtime always unsubscribes after a failed planning turn", async () => {
  const events: string[] = [];
  await assert.rejects(
    runNewProjectPlanning(
      { ...input, sessionId: "turn-1" },
      {
        credential: async () => credential,
        core: async () =>
          ({
            start: async () => {
              throw new Error("Provider unavailable");
            },
          }) as unknown as ClineCore,
        subscribe: async (id) => {
          events.push(`subscribe:${id}`);
        },
        unsubscribe: async (id) => {
          events.push(`unsubscribe:${id}`);
        },
        telemetry: { runOperation: async (_input, _name, run) => run() },
      },
    ),
    /Provider unavailable/,
  );
  assert.deepEqual(events, ["subscribe:turn-1", "unsubscribe:turn-1"]);
});
