import assert from "node:assert/strict"
import test from "node:test"

import {
  appliedSetup,
  readableInitializationError,
  setupDraft,
  setupFromJson,
  setupJson,
  type SavedSetup,
} from "./initialization-setup-draft.ts"

function saved(): SavedSetup {
  return {
    previewManifest: {
      confidence: "high",
      project: { root: ".", detectedStack: ["node"], confidence: "high" },
      setup: [
        {
          id: "deps",
          container: { image: "node:22-bookworm" },
          workingDir: "/workspace",
          command: "npm install",
        },
      ],
      services: [
        {
          id: "db",
          kind: "dependency",
          container: { image: "postgres:16-alpine" },
          environment: { POSTGRES_PASSWORD: "blame" },
          endpoints: [{ id: "sql", protocol: "tcp", port: 5432 }],
        },
        {
          id: "web",
          kind: "preview",
          container: { image: "node:22-bookworm" },
          workingDir: "/workspace",
          command: "npm run dev",
          dependsOn: ["db"],
          endpoints: [
            {
              id: "http",
              protocol: "http",
              port: 3000,
              healthcheck: { type: "http", path: "/", timeoutMs: 30_000 },
            },
          ],
        },
      ],
      caches: [],
      risks: [],
      probes: [],
    } as SavedSetup["previewManifest"],
    runConfigurations: [
      {
        id: "web",
        name: "Web",
        command: "npm run dev",
        cwd: ".",
        default: true,
        category: "web",
        services: ["web"],
        previewService: "web",
        scopes: ["web"],
      },
    ],
  }
}

test("an unchanged draft gives back the same setup", () => {
  const setup = saved()
  const applied = appliedSetup(setup, setupDraft(setup))
  assert.equal(applied.previewManifest.services[1]!.command, "npm run dev")
  assert.deepEqual(applied.runConfigurations, setup.runConfigurations)
})

test("applies edited commands, environment and ports", () => {
  const setup = saved()
  const draft = setupDraft(setup)
  draft.setup[0]!.command = "npm install && npm run migrate"
  draft.services[1]!.environment =
    "# comment\nPORT=3000\nAPI_URL=http://api:4000/a=b"
  draft.services[1]!.ports[0]!.port = "4321"
  draft.runConfigurations[0]!.name = "Website"
  const applied = appliedSetup(setup, draft)
  assert.equal(
    applied.previewManifest.setup[0]!.command,
    "npm install && npm run migrate"
  )
  assert.deepEqual(applied.previewManifest.services[1]!.environment, {
    PORT: "3000",
    API_URL: "http://api:4000/a=b",
  })
  assert.equal(applied.previewManifest.services[1]!.endpoints[0]!.port, 4321)
  assert.equal(applied.runConfigurations[0]!.name, "Website")
})

test("names the field to fix", () => {
  const setup = saved()
  const badPort = setupDraft(setup)
  badPort.services[1]!.ports[0]!.port = "99999"
  assert.throws(() => appliedSetup(setup, badPort), /Service web, port http/)
  const badEnvironment = setupDraft(setup)
  badEnvironment.services[0]!.environment = "not an assignment"
  assert.throws(
    () => appliedSetup(setup, badEnvironment),
    /Service db, environment line 1/
  )
  const noCommand = setupDraft(setup)
  noCommand.setup[0]!.command = " "
  assert.throws(() => appliedSetup(setup, noCommand), /Setup task deps/)
})

test("round-trips the JSON editor and checks it", () => {
  const setup = saved()
  assert.equal(
    setupFromJson(setupJson(setup)).previewManifest.services.length,
    2
  )
  assert.throws(() => setupFromJson("{"), /JSON is not valid/)
  const broken = JSON.parse(setupJson(setup))
  broken.runConfigurations[0].services = ["missing"]
  assert.throws(
    () => setupFromJson(JSON.stringify(broken)),
    /starts service missing/
  )
})

test("says initialization errors in plain words", () => {
  assert.equal(
    readableInitializationError(
      "Error invoking remote method 'agent:initializations:run': Error: Initialization result previewManifest must run detected database migrations before starting backend services"
    ),
    "The setup Blame wrote must run detected database migrations before starting backend services."
  )
  assert.equal(
    readableInitializationError(null),
    "Blame could not finish the analysis."
  )
})
