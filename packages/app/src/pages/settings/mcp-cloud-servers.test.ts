import assert from "node:assert/strict"
import test from "node:test"

import {
  canSync,
  cloudServerFor,
  describeMissing,
  nextCloudServers,
  sameCloudServers,
} from "./mcp-cloud-servers.ts"
import type { McpServerConfig } from "../../context/platform.ts"

const oauth = { configured: false, supported: false }

function stdio(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    args: ["-y", "@dokploy/mcp"],
    command: "npx",
    disabled: false,
    env: { DOKPLOY_TOKEN: "fake-token" },
    name: "Dokploy",
    oauth,
    requiresLocalSetup: false,
    transport: "stdio",
    ...overrides,
  }
}

test("by default only the shape and the names of what stays here go up", () => {
  const entry = cloudServerFor(stdio())
  assert.equal(entry.command, "npx")
  assert.deepEqual(entry.localParts, { args: true, env: ["DOKPLOY_TOKEN"] })
  assert.equal(entry.secrets, undefined)
  assert.doesNotMatch(JSON.stringify(entry), /fake-token|@dokploy/)
})

test("secrets go up only for a server the person chose to sync with them", () => {
  const entry = cloudServerFor(stdio({ syncSecrets: true }))
  assert.deepEqual(entry.secrets, {
    args: ["-y", "@dokploy/mcp"],
    env: { DOKPLOY_TOKEN: "fake-token" },
  })
  assert.equal(entry.secretsSynced, true)
  assert.deepEqual(entry.localParts, {})
})

test("turning secret sync off tells the account to forget them", () => {
  const entry = cloudServerFor(stdio(), { forgetSecrets: true })
  assert.equal(entry.secretsSynced, false)
  assert.equal(entry.secrets, undefined)
})

test("a server kept on this device is never uploaded, and its copy is dropped", () => {
  const next = nextCloudServers({
    current: [cloudServerFor(stdio())],
    local: [stdio({ sync: "device" })],
    dropped: ["Dokploy"],
  })
  assert.deepEqual(next, [])
})

test("a device-only server does not remove another device's account copy", () => {
  const theirs = cloudServerFor(stdio())
  const next = nextCloudServers({
    current: [theirs],
    local: [stdio({ sync: "device" })],
  })
  assert.deepEqual(next, [theirs])
})

test("switching back to the account uploads the server again", () => {
  const next = nextCloudServers({
    current: [],
    local: [stdio({ sync: "account" })],
  })
  assert.equal(next.length, 1)
  assert.equal(next[0].name, "Dokploy")
})

test("an account entry waiting for setup here is kept as it is", () => {
  const waiting = {
    ...cloudServerFor(stdio()),
    localParts: { env: ["DOKPLOY_TOKEN"] },
  }
  const next = nextCloudServers({
    current: [waiting],
    local: [
      stdio({
        args: undefined,
        env: undefined,
        requiresLocalSetup: true,
        disabled: true,
      }),
    ],
  })
  assert.deepEqual(next, [waiting])
})

test("a removal or a rename drops the old entry and nothing else", () => {
  const other = { ...cloudServerFor(stdio()), name: "Other" }
  const next = nextCloudServers({
    current: [cloudServerFor(stdio()), other],
    local: [stdio({ name: "Renamed" })],
    dropped: ["Dokploy"],
  })
  assert.deepEqual(next.map((entry) => entry.name).sort(), ["Other", "Renamed"])
})

test("an address with a key in it cannot leave the device", () => {
  const remote = {
    transport: "streamableHttp" as const,
    url: "https://mcp.example.com/?token=fake",
  }
  assert.equal(canSync(remote).ok, false)
  assert.equal(canSync({ ...remote, url: "https://mcp.example.com/" }).ok, true)
  const next = nextCloudServers({
    current: [],
    local: [stdio({ ...remote, command: undefined, name: "Remote" })],
  })
  assert.deepEqual(next, [])
})

test("the prompt names what is missing, never values", () => {
  assert.equal(
    describeMissing({ args: true, env: ["DOKPLOY_TOKEN"] }),
    "its arguments, DOKPLOY_TOKEN"
  )
  assert.equal(describeMissing(undefined), "its arguments and secrets")
})

test("two lists with the same content in another order are the same", () => {
  const a = cloudServerFor(stdio())
  const b = { ...cloudServerFor(stdio()), name: "Other" }
  assert.equal(
    sameCloudServers([a, b], [b, { ...a, timeout: undefined }]),
    true
  )
  assert.equal(sameCloudServers([a], [a, b]), false)
  assert.equal(sameCloudServers([a], [{ ...a, disabled: true }]), false)
})
