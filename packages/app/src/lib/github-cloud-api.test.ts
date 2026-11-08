import assert from "node:assert/strict"
import test from "node:test"
import { CloudApiError, createCloudApi } from "./cloud-api.ts"
import { parseGithubRepositoryInput } from "./github-cloud-api.ts"

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

const github = { available: true, agentAccess: false, repository: null }

test("calls the project's GitHub routes with their methods and bodies", async () => {
  const requests: Array<{ body?: unknown; method: string; url: string }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method: init?.method ?? "GET",
      url: String(input),
    })
    return jsonResponse({ github })
  }
  const api = createCloudApi({
    token: "session",
    url: "https://api.blame.test",
  })

  await api.projectGithub("project/1")
  await api.linkGithubRepository("project/1", {
    installationId: "installation-id",
    owner: "blame",
    name: "app",
  })
  await api.unlinkGithubRepository("project/1")
  await api.setGithubAgentAccess("project/1", true)

  const base = "https://api.blame.test/projects/project%2F1/github"
  assert.deepEqual(requests, [
    { body: undefined, method: "GET", url: base },
    {
      body: { installationId: "installation-id", owner: "blame", name: "app" },
      method: "PUT",
      url: `${base}/repository`,
    },
    { body: undefined, method: "DELETE", url: `${base}/repository` },
    { body: { enabled: true }, method: "PUT", url: `${base}/agent-access` },
  ])
})

test("starts a GitHub connection and lists the installations", async () => {
  const requests: Array<{ method: string; url: string }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ method: init?.method ?? "GET", url: String(input) })
    return requests.length === 1
      ? jsonResponse({ url: "https://github.com/apps/blame", expiresAt: "x" })
      : jsonResponse({ installations: [{ id: "1", accountLogin: "blame" }] })
  }
  const api = createCloudApi({
    token: "session",
    url: "https://api.blame.test",
  })

  assert.equal(
    (await api.githubConnectIntent()).url,
    "https://github.com/apps/blame"
  )
  assert.deepEqual((await api.githubInstallations()).installations, [
    { id: "1", accountLogin: "blame" },
  ])
  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "https://api.blame.test/integrations/github/connect-intents",
    },
    {
      method: "GET",
      url: "https://api.blame.test/integrations/github/installations",
    },
  ])
})

test("keeps the API's message when a repository cannot be linked", async () => {
  const message =
    "The Blame GitHub App installation on blame does not include blame/app. Add the repository to the installation on GitHub."
  globalThis.fetch = async () =>
    jsonResponse(
      { message, code: "E_GITHUB_REPOSITORY_NOT_INSTALLED" },
      { status: 422 }
    )
  const api = createCloudApi({
    token: "session",
    url: "https://api.blame.test",
  })

  await assert.rejects(
    api.linkGithubRepository("project", {
      installationId: "installation-id",
      owner: "blame",
      name: "app",
    }),
    (error) =>
      error instanceof CloudApiError &&
      error.status === 422 &&
      error.message === message
  )
})

test("reads owner/name and pasted GitHub URLs", () => {
  assert.deepEqual(parseGithubRepositoryInput(" blame/app "), {
    owner: "blame",
    name: "app",
  })
  assert.deepEqual(
    parseGithubRepositoryInput("https://github.com/blame/app.git"),
    { owner: "blame", name: "app" }
  )
  assert.deepEqual(parseGithubRepositoryInput("github.com/blame/app/"), {
    owner: "blame",
    name: "app",
  })
})

test("rejects input that is not owner/name", () => {
  assert.equal(parseGithubRepositoryInput(""), undefined)
  assert.equal(parseGithubRepositoryInput("blame"), undefined)
  assert.equal(parseGithubRepositoryInput("blame/app/extra"), undefined)
  assert.equal(parseGithubRepositoryInput("blame /app"), undefined)
})

function jsonResponse(body: unknown, init?: { status?: number }) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: init?.status ?? 200,
  })
}
