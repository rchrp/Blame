import assert from "node:assert/strict"
import test from "node:test"
import { CloudApiError, createCloudApi } from "./cloud-api.ts"

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test("starts an email OTP challenge after a valid password", async () => {
  const requests: Array<{ init?: RequestInit; url: string }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ init, url: String(input) })
    if (requests.length === 1) {
      return jsonResponse({
        twoFactorRedirect: true,
        twoFactorMethods: ["otp"],
      })
    }
    return jsonResponse({ status: true })
  }

  const result = await createCloudApi({ url: "https://api.blame.test" }).login({
    email: "ada@example.com",
    password: "correct horse battery staple",
  })

  assert.equal(result, "two-factor")
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://api.blame.test/auth/sign-in/email",
      "https://api.blame.test/auth/two-factor/send-otp",
    ]
  )
  assert.ok(
    requests.every((request) => request.init?.credentials === "include")
  )
})

test("uses the desktop transport for authentication requests", async () => {
  const requests: Array<{ body?: string; url: string }> = []
  globalThis.fetch = async () => {
    throw new Error(
      "Browser fetch should not be used for desktop authentication."
    )
  }
  const authRequest = async (input: { body?: string; url: string }) => {
    requests.push(input)
    return {
      body: JSON.stringify(
        requests.length === 1
          ? { twoFactorRedirect: true, twoFactorMethods: ["otp"] }
          : { status: true }
      ),
      headers: { "content-type": "application/json" },
      status: 200,
    }
  }

  const result = await createCloudApi({
    authRequest,
    url: "https://api.blame.test",
  }).login({
    email: "ada@example.com",
    password: "correct horse battery staple",
  })

  assert.equal(result, "two-factor")
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://api.blame.test/auth/sign-in/email",
      "https://api.blame.test/auth/two-factor/send-otp",
    ]
  )
})

test("creates a cloud session after email OTP verification", async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      token: "session-token",
      user: {
        id: "user-id",
        name: "Ada Lovelace",
        email: "ada@example.com",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
    })

  const session = await createCloudApi({
    url: "https://api.blame.test",
  }).verifyEmailTwoFactor("123456")

  assert.equal(session.token, "session-token")
  assert.equal(session.user.initials, "AL")
})

test("pairs an unverified password sign-in with the desktop device", async () => {
  const requests: Array<{ init?: RequestInit; url: string }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ init, url: String(input) })
    if (requests.length === 1) {
      return jsonResponse({ message: "Email not verified" }, { status: 403 })
    }
    return requests.length === 2
      ? jsonResponse(deviceAuthorizationResponse())
      : jsonResponse({ status: true })
  }

  const result = await createCloudApi({
    url: "https://api.blame.test",
  }).login({
    email: "ada@example.com",
    password: "correct horse battery staple",
  })

  assert.equal(typeof result, "object")
  if (typeof result !== "object" || !("status" in result)) return
  assert.equal(result.status, "email-verification")
  assert.equal(
    result.authorization.verificationUrl,
    "https://blame.so/auth/verify-email?user_code=ABCD2345"
  )
  assert.equal(
    JSON.parse(String(requests[2]?.init?.body)).callbackURL,
    result.authorization.verificationUrl
  )
})

test("starts social sign-in with a device authorization URL", async () => {
  let request: { init?: RequestInit; url: string } | undefined
  globalThis.fetch = async (input, init) => {
    request = { init, url: String(input) }
    return jsonResponse(deviceAuthorizationResponse())
  }

  const authorization = await createCloudApi({
    url: "https://api.blame.test",
  }).socialLogin("google")

  assert.equal(request?.url, "https://api.blame.test/auth/device/code")
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    client_id: "blame-desktop",
    scope: "openid profile email",
  })
  assert.equal(
    authorization.verificationUrl,
    "https://blame.so/auth/desktop?user_code=ABCD2345&provider=google"
  )
})

test("starts passkey sign-in with a device authorization URL", async () => {
  globalThis.fetch = async () => jsonResponse(deviceAuthorizationResponse())

  const authorization = await createCloudApi({
    url: "https://api.blame.test",
  }).passkeyLogin()

  assert.equal(
    authorization.verificationUrl,
    "https://blame.so/auth/passkey?user_code=ABCD2345"
  )
})

test("pairs signup verification with the desktop device", async () => {
  const requests: Array<{ init?: RequestInit; url: string }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ init, url: String(input) })
    return requests.length === 1
      ? jsonResponse(deviceAuthorizationResponse())
      : jsonResponse({ status: true })
  }

  const authorization = await createCloudApi({
    url: "https://api.blame.test",
  }).signup({
    email: "ada@example.com",
    fullName: "Ada Lovelace",
    password: "correct horse battery staple",
    passwordConfirmation: "correct horse battery staple",
  })

  assert.equal(
    authorization.verificationUrl,
    "https://blame.so/auth/verify-email?user_code=ABCD2345"
  )
  assert.equal(requests[1]?.url, "https://api.blame.test/auth/sign-up/email")
  assert.equal(
    JSON.parse(String(requests[1]?.init?.body)).callbackURL,
    authorization.verificationUrl
  )
})

test("polls device authorization until its one-time token is ready", async () => {
  let requestCount = 0
  globalThis.fetch = async () => {
    requestCount += 1
    if (requestCount === 1) {
      return jsonResponse(
        {
          error: "authorization_pending",
          error_description: "Authorization is pending",
        },
        { status: 400 }
      )
    }
    return jsonResponse({ access_token: "raw-session-token" })
  }
  const api = createCloudApi({ url: "https://api.blame.test" })

  assert.deepEqual(await api.pollDesktopLogin("secure-device-code"), {
    status: "pending",
  })
  assert.deepEqual(await api.pollDesktopLogin("secure-device-code"), {
    accessToken: "raw-session-token",
    status: "authenticated",
  })
})

test("reports structured API validation errors", async () => {
  let request: RequestInit | undefined
  globalThis.fetch = async (_input, init) => {
    request = init
    return jsonResponse(
      {
        errors: [
          {
            code: "E_RUN_CONFIGURATION_INVALID",
            message: "Run configuration is invalid",
          },
        ],
      },
      { status: 422 }
    )
  }

  await assert.rejects(
    createCloudApi({
      token: "session-token",
      url: "https://api.blame.test",
    }).completeProjectInitialization("project-id", {
      previewManifest: {
        confidence: "high",
        project: { root: "." },
        setup: [],
        services: [],
        caches: [],
        risks: [],
        probes: [],
      },
      runConfigurations: [],
    }),
    (error: unknown) =>
      error instanceof CloudApiError &&
      error.status === 422 &&
      error.message === "Run configuration is invalid"
  )
  assert.deepEqual(JSON.parse(String(request?.body)), {
    previewManifest: {
      confidence: "high",
      project: { root: "." },
      setup: [],
      services: [],
      caches: [],
      risks: [],
      probes: [],
    },
    runConfigurations: [],
  })
})

test("transcribes audio through the authenticated speech endpoint", async () => {
  let request: { init?: RequestInit; url: string } | undefined
  globalThis.fetch = async (input, init) => {
    request = { init, url: String(input) }
    return jsonResponse({ text: "Voice prompt" })
  }

  const result = await createCloudApi({
    token: "session-token",
    url: "https://api.blame.test",
  }).transcribeAudio({ data: "dm9pY2U=", format: "webm" })

  assert.equal(result.text, "Voice prompt")
  assert.equal(request?.url, "https://api.blame.test/speech/transcriptions")
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    data: "dm9pY2U=",
    format: "webm",
  })
  assert.equal(
    new Headers(request?.init?.headers).get("Authorization"),
    "Bearer session-token"
  )
})

test("loads and saves security audit snapshots in the project cloud API", async () => {
  const requests: Array<{ init?: RequestInit; url: string }> = []
  const audit = {
    findings: [],
    id: "audit-id",
    projectId: "project-id",
    sequence: 4,
    status: "mapping",
    version: 1,
  }
  globalThis.fetch = async (input, init) => {
    requests.push({ init, url: String(input) })
    return jsonResponse(requests.length === 1 ? [audit] : audit)
  }
  const api = createCloudApi({
    token: "session-token",
    url: "https://api.blame.test",
  })

  assert.deepEqual(await api.securityAudits("project-id"), [audit])
  assert.deepEqual(
    await api.saveSecurityAudit("project-id", audit as never),
    audit
  )
  assert.equal(
    requests[1]?.url,
    "https://api.blame.test/projects/project-id/security-audits/audit-id"
  )
  assert.equal(requests[1]?.init?.method, "PUT")
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { audit })
  assert.ok(
    requests.every(
      (request) =>
        new Headers(request.init?.headers).get("Authorization") ===
        "Bearer session-token"
    )
  )
})

function deviceAuthorizationResponse() {
  return {
    device_code: "secure-device-code",
    expires_in: 600,
    interval: 5,
    user_code: "ABCD2345",
    verification_uri: "https://blame.so/auth/desktop",
    verification_uri_complete:
      "https://blame.so/auth/desktop?user_code=ABCD2345",
  }
}

function jsonResponse(
  body: unknown,
  init?: { headers?: HeadersInit; status?: number }
) {
  const headers = new Headers(init?.headers)
  headers.set("content-type", "application/json")
  return new Response(JSON.stringify(body), {
    headers,
    status: init?.status ?? 200,
  })
}
