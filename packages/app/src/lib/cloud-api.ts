import type {
  CloudProject,
  CloudProjectCodePracticeAnalysis,
  CloudProjectInitializationSnapshot,
  CloudSession,
  CloudUser,
  CloudLicense,
  CloudAiPreferences,
  CloudMcpConfiguration,
  CloudMcpServer,
  SaveAiPreferencesInput,
  LoginInput,
  SignupInput,
  SocialAuthProvider,
} from "@/context/cloud-auth"
import type {
  ApiConnection,
  PreviewManifest,
  ProjectCodePracticeResult,
  ProjectRunConfiguration,
  SecurityAudit,
} from "@blame/agent-runtime"
import type {
  CloudAuthRequestClient,
  CloudAuthRequestResponse,
  TelemetryExportSession,
} from "@/context/platform"
import { createDeployCloudApi } from "./deploy-cloud-api.ts"

type CloudApiConnection = ApiConnection & {
  authRequest?: CloudAuthRequestClient["request"]
}

export class CloudApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "CloudApiError"
    this.status = status
  }
}

type DesktopAuthorization = {
  deviceCode: string
  expiresIn: number
  interval: number
  verificationUrl: string
}

type DesktopAuthorizationPoll =
  | { accessToken: string; status: "authenticated" }
  | { status: "pending" }
  | { status: "slow-down" }

type CloudLoginResult =
  | CloudSession
  | "two-factor"
  | {
      authorization: DesktopAuthorization
      status: "email-verification"
    }

const desktopAuthClientId = "blame-desktop"

export type CloudAccountExport = {
  format: "blame-account-export"
  version: number
  generatedAt: string
  account: Record<string, unknown>
  security: Record<string, unknown>
  billing: Record<string, unknown> | null
  settings: Record<string, unknown>
  integrations: Record<string, unknown>
  workspace: Record<string, unknown>
  additionalRecords: Record<string, unknown>
}

export type CloudAccountClosureReceipt = {
  requestId: string
  receiptToken: string | null
  status: string
  requestedAt: string
  activeDeletionDeadline: string
  activeDeletionCompletedAt: string | null
  backupExpirationDeadline: string | null
  statusEndpoint: string
  supportContact: string
}

export function createCloudApi(connection: CloudApiConnection) {
  const baseUrl = connection.url.replace(/\/$/, "")
  const deployApi = createDeployCloudApi(
    <T>(path: string, init?: RequestInit) =>
      request<T>(connection, baseUrl, path, init)
  )

  return {
    ...deployApi,
    async login(input: LoginInput): Promise<CloudLoginResult> {
      let response
      try {
        response = await betterAuthRequest(
          connection,
          baseUrl,
          "/auth/sign-in/email",
          {
            body: JSON.stringify(input),
            method: "POST",
          }
        )
      } catch (error) {
        if (!requiresEmailVerification(error)) throw error
        return {
          authorization: await requestEmailVerification(
            connection,
            baseUrl,
            input.email
          ),
          status: "email-verification" as const,
        }
      }
      if (!twoFactorRequired(response.body)) return cloudSession(response)
      await betterAuthRequest(
        connection,
        baseUrl,
        "/auth/two-factor/send-otp",
        {
          body: JSON.stringify({ trustDevice: false }),
          method: "POST",
        }
      )
      return "two-factor"
    },
    verifyEmailTwoFactor(code: string) {
      return betterAuthSessionRequest(
        connection,
        baseUrl,
        "/auth/two-factor/verify-otp",
        {
          body: JSON.stringify({ code, trustDevice: false }),
          method: "POST",
        }
      )
    },
    resendEmailTwoFactor() {
      return betterAuthRequest(
        connection,
        baseUrl,
        "/auth/two-factor/send-otp",
        {
          body: JSON.stringify({ trustDevice: false }),
          method: "POST",
        }
      ).then(() => undefined)
    },
    async signup(input: SignupInput) {
      const authorization = await requestDesktopAuthorization(
        connection,
        baseUrl,
        "/auth/verify-email"
      )
      await request<unknown>(connection, baseUrl, "/auth/sign-up/email", {
        body: JSON.stringify({
          callbackURL: authorization.verificationUrl,
          email: input.email,
          name: input.fullName ?? input.email.split("@")[0],
          password: input.password,
        }),
        method: "POST",
      })
      return authorization
    },
    requestPasswordReset(email: string) {
      return request<unknown>(
        connection,
        baseUrl,
        "/auth/request-password-reset",
        {
          body: JSON.stringify({ email }),
          method: "POST",
        }
      ).then(() => undefined)
    },
    resetPassword(token: string, newPassword: string) {
      return request<unknown>(connection, baseUrl, "/auth/reset-password", {
        body: JSON.stringify({ token, newPassword }),
        method: "POST",
      }).then(() => undefined)
    },
    async resendVerification(email: string) {
      return requestEmailVerification(connection, baseUrl, email)
    },
    async socialLogin(provider: SocialAuthProvider) {
      return requestDesktopAuthorization(connection, baseUrl, "/auth/desktop", {
        provider,
      })
    },
    pollDesktopLogin(deviceCode: string) {
      return pollDesktopAuthorization(connection, baseUrl, deviceCode)
    },
    exchangeDesktopDeviceToken(token: string) {
      return request<CloudSession>(
        connection,
        baseUrl,
        "/auth/desktop-device-exchange",
        {
          body: JSON.stringify({ token }),
          method: "POST",
        }
      )
    },
    passkeyLogin() {
      return requestDesktopAuthorization(connection, baseUrl, "/auth/passkey")
    },
    exchangeDesktopCode(code: string) {
      return request<CloudSession>(
        connection,
        baseUrl,
        "/auth/desktop-exchange",
        {
          body: JSON.stringify({ code }),
          method: "POST",
        }
      )
    },
    profile() {
      return request<CloudUser>(connection, baseUrl, "/account/profile")
    },
    telemetrySession() {
      return request<unknown>(connection, baseUrl, "/telemetry/session").then(
        cloudTelemetrySession
      )
    },
    exportAccount(password: string) {
      return request<CloudAccountExport>(
        connection,
        baseUrl,
        "/account/export",
        { body: JSON.stringify({ password }), method: "POST" }
      )
    },
    closeAccount(input: { password: string; confirmation: string }) {
      return request<CloudAccountClosureReceipt>(
        connection,
        baseUrl,
        "/account/closure",
        { body: JSON.stringify(input), method: "POST" }
      )
    },
    closureStatus(requestId: string, receiptToken: string) {
      return request<CloudAccountClosureReceipt>(
        connection,
        baseUrl,
        "/account/closure-status",
        { body: JSON.stringify({ requestId, receiptToken }), method: "POST" }
      )
    },
    license() {
      return request<CloudLicense>(connection, baseUrl, "/billing")
    },
    checkout(cycle: "monthly" | "yearly") {
      return request<{ url: string }>(
        connection,
        baseUrl,
        "/billing/checkout",
        {
          body: JSON.stringify({ cycle }),
          method: "POST",
        }
      )
    },
    billingPortal() {
      return request<{ url: string }>(connection, baseUrl, "/billing/portal", {
        method: "POST",
      })
    },
    aiPreferences() {
      return request<unknown>(
        connection,
        baseUrl,
        "/account/ai-preferences"
      ).then(cloudAiPreferences)
    },
    saveAiPreferences(input: SaveAiPreferencesInput) {
      return request<unknown>(connection, baseUrl, "/account/ai-preferences", {
        body: JSON.stringify(input),
        method: "PUT",
      }).then(cloudAiPreferencesRequired)
    },
    mcpConfiguration() {
      return request<unknown>(
        connection,
        baseUrl,
        "/account/mcp-configurations"
      ).then(cloudMcpConfiguration)
    },
    saveMcpConfiguration(servers: CloudMcpServer[]) {
      return request<unknown>(
        connection,
        baseUrl,
        "/account/mcp-configurations",
        {
          body: JSON.stringify({ servers }),
          method: "PUT",
        }
      ).then(cloudMcpConfigurationRequired)
    },
    transcribeAudio(input: { data: string; format: string }) {
      return request<unknown>(connection, baseUrl, "/speech/transcriptions", {
        body: JSON.stringify(input),
        method: "POST",
      }).then(cloudSpeechTranscription)
    },
    projects() {
      return request<unknown>(connection, baseUrl, "/projects").then(
        cloudProjects
      )
    },
    async logout() {
      await request<{ message: string }>(
        connection,
        baseUrl,
        "/account/logout",
        {
          method: "POST",
        }
      ).catch(() => undefined)
      await request<unknown>(connection, baseUrl, "/auth/sign-out", {
        method: "POST",
      }).catch(() => undefined)
    },
    ensureProject(input: {
      name: string
      repositoryFingerprint?: string | null
    }) {
      return request<unknown>(connection, baseUrl, "/projects", {
        body: JSON.stringify(input),
        method: "POST",
      }).then(cloudProject)
    },
    projectInitialization(projectId: string) {
      return request<unknown>(
        connection,
        baseUrl,
        `/projects/${encodeURIComponent(projectId)}/initialization`
      ).then(cloudProjectInitializationSnapshot)
    },
    projectCodePracticeAnalysis(projectId: string) {
      return request<unknown>(
        connection,
        baseUrl,
        `/projects/${encodeURIComponent(projectId)}/code-practice-analysis`
      ).then(cloudProjectCodePracticeAnalysis)
    },
    securityAudits(projectId: string) {
      return request<unknown>(
        connection,
        baseUrl,
        `/projects/${encodeURIComponent(projectId)}/security-audits`
      ).then(cloudSecurityAudits)
    },
    saveSecurityAudit(projectId: string, audit: SecurityAudit) {
      return request<unknown>(
        connection,
        baseUrl,
        `/projects/${encodeURIComponent(projectId)}/security-audits/${encodeURIComponent(audit.id)}`,
        { body: JSON.stringify({ audit }), method: "PUT" }
      ).then(cloudSecurityAudit)
    },
    startProjectCodePracticeAnalysis(
      projectId: string,
      input: { providerId: string; modelId: string }
    ) {
      return projectCodePracticeAnalysisRequest(
        connection,
        baseUrl,
        projectId,
        "start",
        input
      )
    },
    completeProjectCodePracticeAnalysis(
      projectId: string,
      input: {
        clineSessionId?: string | null
        practices: ProjectCodePracticeResult[]
      }
    ) {
      return projectCodePracticeAnalysisRequest(
        connection,
        baseUrl,
        projectId,
        "complete",
        input
      )
    },
    failProjectCodePracticeAnalysis(
      projectId: string,
      input: { clineSessionId?: string | null; error: string }
    ) {
      return projectCodePracticeAnalysisRequest(
        connection,
        baseUrl,
        projectId,
        "fail",
        input
      )
    },
    markProjectCodePracticeAnalysisViewed(projectId: string) {
      return projectCodePracticeAnalysisRequest(
        connection,
        baseUrl,
        projectId,
        "viewed",
        {}
      )
    },
    startProjectInitialization(
      projectId: string,
      input: {
        providerId: string
        modelId: string
        clineSessionId?: string | null
      }
    ) {
      return request<unknown>(
        connection,
        baseUrl,
        `/projects/${encodeURIComponent(projectId)}/initialization/start`,
        { body: JSON.stringify(input), method: "POST" }
      ).then(cloudProjectInitializationSnapshot)
    },
    completeProjectInitialization(
      projectId: string,
      input: {
        clineSessionId?: string | null
        previewManifest: PreviewManifest
        runConfigurations: ProjectRunConfiguration[]
        databaseMode?: "existing" | "compose" | null
      }
    ) {
      return request<unknown>(
        connection,
        baseUrl,
        `/projects/${encodeURIComponent(projectId)}/initialization/complete`,
        { body: JSON.stringify(input), method: "POST" }
      ).then(cloudProjectInitializationSnapshot)
    },
    failProjectInitialization(
      projectId: string,
      input: { clineSessionId?: string | null; error: string }
    ) {
      return request<unknown>(
        connection,
        baseUrl,
        `/projects/${encodeURIComponent(projectId)}/initialization/fail`,
        { body: JSON.stringify(input), method: "POST" }
      ).then(cloudProjectInitializationSnapshot)
    },
    repairProjectInitialization(
      projectId: string,
      input: {
        clineSessionId?: string | null
        previewManifest: PreviewManifest
        runConfigurations: ProjectRunConfiguration[]
        databaseMode?: "existing" | "compose" | null
        reason: string
      }
    ) {
      return request<unknown>(
        connection,
        baseUrl,
        `/projects/${encodeURIComponent(projectId)}/initialization/repair`,
        { body: JSON.stringify(input), method: "POST" }
      ).then(cloudProjectInitializationSnapshot)
    },
  }
}

function cloudProjects(value: unknown) {
  const projects = transformerValue(value)
  if (!Array.isArray(projects)) throw new Error("Unable to read projects.")
  return projects.map(cloudProject)
}

function cloudProject(value: unknown) {
  const project = transformerValue(value)
  if (!isRecord(project)) throw new Error("Unable to read project.")
  if (typeof project.id !== "string") throw new Error("Unable to read project.")
  if (typeof project.name !== "string")
    throw new Error("Unable to read project.")
  return project as CloudProject
}

function cloudProjectInitializationSnapshot(value: unknown) {
  const snapshot = transformerValue(value)
  if (!isRecord(snapshot))
    throw new Error("Unable to read the preview environment.")
  if (!("practices" in snapshot) || !Array.isArray(snapshot.practices)) {
    throw new Error("Unable to read the preview environment.")
  }
  if (
    "initialization" in snapshot &&
    snapshot.initialization !== null &&
    !isRecord(snapshot.initialization)
  ) {
    throw new Error("Unable to read the preview environment.")
  }
  return snapshot as CloudProjectInitializationSnapshot
}

function cloudProjectCodePracticeAnalysis(value: unknown) {
  const analysis = transformerValue(value)
  if (!isRecord(analysis) || typeof analysis.projectId !== "string") {
    throw new Error("Unable to read project code practice analysis.")
  }
  return analysis as CloudProjectCodePracticeAnalysis
}

function cloudSecurityAudits(value: unknown) {
  const audits = transformerValue(value)
  if (!Array.isArray(audits)) throw new Error("Unable to read security audits.")
  return audits.map(cloudSecurityAudit)
}

function cloudSecurityAudit(value: unknown) {
  const audit = transformerValue(value)
  if (
    !isRecord(audit) ||
    audit.version !== 1 ||
    typeof audit.id !== "string" ||
    typeof audit.projectId !== "string" ||
    typeof audit.sequence !== "number" ||
    typeof audit.status !== "string" ||
    !Array.isArray(audit.findings)
  ) {
    throw new Error("Unable to read security audit.")
  }
  return audit as SecurityAudit
}

function projectCodePracticeAnalysisRequest(
  connection: CloudApiConnection,
  baseUrl: string,
  projectId: string,
  action: "start" | "complete" | "fail" | "viewed",
  body: unknown
) {
  return request<unknown>(
    connection,
    baseUrl,
    `/projects/${encodeURIComponent(projectId)}/code-practice-analysis/${action}`,
    { body: JSON.stringify(body), method: "POST" }
  ).then(cloudProjectCodePracticeAnalysis)
}

function cloudAiPreferences(value: unknown) {
  const preferences = transformerValue(value)
  if (preferences === null) return null
  return cloudAiPreferencesRequired(value)
}

function cloudAiPreferencesRequired(value: unknown) {
  const preferences = transformerValue(value)
  if (!isRecord(preferences)) throw new Error("Unable to read AI preferences.")
  if (
    !isRecord(preferences.alternativeModel) ||
    !isRecord(preferences.agentModel)
  ) {
    throw new Error("Unable to read AI preferences.")
  }
  return preferences as CloudAiPreferences
}

function cloudMcpConfiguration(value: unknown) {
  const configuration = transformerValue(value)
  if (configuration === null) return null
  return cloudMcpConfigurationRequired(value)
}

function cloudMcpConfigurationRequired(value: unknown) {
  const configuration = transformerValue(value)
  if (!isRecord(configuration) || !Array.isArray(configuration.servers))
    throw new Error("Unable to read MCP configuration.")
  return configuration as CloudMcpConfiguration
}

function cloudSpeechTranscription(value: unknown) {
  const transcription = transformerValue(value)
  if (!isRecord(transcription) || typeof transcription.text !== "string") {
    throw new Error("Unable to read speech transcription.")
  }
  return { text: transcription.text }
}

function cloudTelemetrySession(value: unknown): TelemetryExportSession {
  const session = transformerValue(value)
  if (!isRecord(session)) throw new Error("Unable to read telemetry session.")
  if (typeof session.endpoint !== "string")
    throw new Error("Unable to read telemetry session.")
  if (typeof session.expiresAt !== "string")
    throw new Error("Unable to read telemetry session.")
  if (typeof session.token !== "string")
    throw new Error("Unable to read telemetry session.")
  return session as TelemetryExportSession
}

async function requestDesktopAuthorization(
  connection: CloudApiConnection,
  baseUrl: string,
  pathname: string,
  parameters?: Record<string, string>
) {
  const result = await request<unknown>(
    connection,
    baseUrl,
    "/auth/device/code",
    {
      body: JSON.stringify({
        client_id: desktopAuthClientId,
        scope: "openid profile email",
      }),
      method: "POST",
    }
  )
  return desktopAuthorization(result, pathname, parameters)
}

async function requestEmailVerification(
  connection: CloudApiConnection,
  baseUrl: string,
  email: string
) {
  const authorization = await requestDesktopAuthorization(
    connection,
    baseUrl,
    "/auth/verify-email"
  )
  await request<unknown>(connection, baseUrl, "/auth/send-verification-email", {
    body: JSON.stringify({
      callbackURL: authorization.verificationUrl,
      email,
    }),
    method: "POST",
  })
  return authorization
}

function requiresEmailVerification(error: unknown) {
  return (
    error instanceof CloudApiError &&
    error.message.toLowerCase().includes("email not verified")
  )
}

function desktopAuthorization(
  value: unknown,
  pathname: string,
  parameters?: Record<string, string>
): DesktopAuthorization {
  if (!isRecord(value)) return invalidDesktopAuthorization()
  const deviceCode = value.device_code
  const verificationUrl = value.verification_uri_complete
  const expiresIn = value.expires_in
  const interval = value.interval
  if (
    typeof deviceCode !== "string" ||
    typeof verificationUrl !== "string" ||
    typeof expiresIn !== "number" ||
    typeof interval !== "number"
  ) {
    return invalidDesktopAuthorization()
  }
  const url = new URL(verificationUrl)
  url.pathname = pathname
  Object.entries(parameters ?? {}).forEach(([name, parameter]) =>
    url.searchParams.set(name, parameter)
  )
  return {
    deviceCode,
    expiresIn,
    interval,
    verificationUrl: url.toString(),
  }
}

function invalidDesktopAuthorization(): never {
  throw new CloudApiError("Sign-in could not be started.", 503)
}

async function pollDesktopAuthorization(
  connection: CloudApiConnection,
  baseUrl: string,
  deviceCode: string
): Promise<DesktopAuthorizationPoll> {
  const response = await cloudFetch(
    connection,
    `${baseUrl}/auth/device/token`,
    {
      body: JSON.stringify({
        client_id: desktopAuthClientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }
  )
  const body = await response.json().catch(() => null)
  if (response.ok) return authenticatedDesktopAuthorization(body)
  const error = deviceAuthorizationError(body)
  if (error === "authorization_pending") return { status: "pending" }
  if (error === "slow_down") return { status: "slow-down" }
  throw new CloudApiError(
    deviceAuthorizationMessage(error, body),
    response.status
  )
}

function authenticatedDesktopAuthorization(
  value: unknown
): DesktopAuthorizationPoll {
  const body = responseData(value)
  if (!isRecord(body) || typeof body.access_token !== "string") {
    throw new CloudApiError("Sign-in could not be completed.", 401)
  }
  return { accessToken: body.access_token, status: "authenticated" }
}

function deviceAuthorizationError(value: unknown) {
  const body = responseData(value)
  if (!isRecord(body) || typeof body.error !== "string") return "unknown"
  return body.error
}

function deviceAuthorizationMessage(error: string, value: unknown) {
  if (error === "expired_token")
    return "This sign-in request expired. Try again."
  if (error === "access_denied") return "This sign-in request was denied."
  if (error === "invalid_grant")
    return "This sign-in request is no longer valid."
  const body = responseData(value)
  if (isRecord(body) && typeof body.error_description === "string") {
    return body.error_description
  }
  return "External sign-in could not be completed."
}

function transformerValue(value: unknown): unknown {
  if (!isRecord(value)) return value
  if ("data" in value) return transformerValue(value.data)
  if (!Array.isArray(value.transformerData)) return value
  return transformerValue(value.transformerData[0])
}

async function request<T>(
  connection: CloudApiConnection,
  baseUrl: string,
  path: string,
  init?: RequestInit
) {
  const headers = new Headers(init?.headers)
  headers.set("Accept", "application/json")
  headers.set("Content-Type", "application/json")
  if (connection.token)
    headers.set("Authorization", `Bearer ${connection.token}`)

  const response = await cloudFetch(connection, `${baseUrl}${path}`, {
    ...init,
    headers,
  })

  if (!response.ok) {
    throw new CloudApiError(await responseMessage(response), response.status)
  }
  if (response.status === 204) return undefined as T
  return responseData(await response.json()) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function responseData(value: unknown) {
  if (!isRecord(value) || !("data" in value)) return value
  return value.data
}

async function betterAuthSessionRequest(
  connection: CloudApiConnection,
  baseUrl: string,
  path: string,
  init: RequestInit
) {
  return cloudSession(await betterAuthRequest(connection, baseUrl, path, init))
}

async function betterAuthRequest(
  connection: CloudApiConnection,
  baseUrl: string,
  path: string,
  init: RequestInit
) {
  const response = await cloudFetch(connection, `${baseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init.headers },
  })
  if (!response.ok)
    throw new CloudApiError(await responseMessage(response), response.status)
  return {
    token: response.headers.get("set-auth-token"),
    body: responseData(await response.json()),
  }
}

async function cloudFetch(
  connection: CloudApiConnection,
  url: string,
  init?: RequestInit
) {
  if (!connection.authRequest || !isCloudAuthUrl(url)) return fetch(url, init)
  if (init?.body !== undefined && typeof init.body !== "string") {
    throw new Error("Unsupported cloud authentication request body.")
  }
  const result = await connection.authRequest({
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
    headers: Object.fromEntries(new Headers(init?.headers)),
    method: init?.method ?? "GET",
    url,
  })
  return cloudAuthResponse(result)
}

function isCloudAuthUrl(value: string) {
  try {
    return /\/auth(?:\/|$)/.test(new URL(value).pathname)
  } catch {
    return false
  }
}

function cloudAuthResponse(result: CloudAuthRequestResponse) {
  return new Response(result.body || null, {
    headers: result.headers,
    status: result.status,
  })
}

function cloudSession(response: { body: unknown; token: string | null }) {
  const body = response.body as {
    token?: string
    user?: {
      id: string
      name: string
      email: string
      image?: string | null
      createdAt: string
      updatedAt: string
    }
  }
  const token = response.token ?? body.token
  if (!token || !body.user)
    throw new CloudApiError("Sign-in could not be completed.", 401)
  const names = body.user.name.trim().split(/\s+/)
  const initials =
    names.length > 1
      ? `${names[0]?.[0] ?? ""}${names.at(-1)?.[0] ?? ""}`.toUpperCase()
      : body.user.email.slice(0, 2).toUpperCase()
  return {
    token,
    user: {
      id: body.user.id,
      fullName: body.user.name || null,
      email: body.user.email,
      createdAt: body.user.createdAt,
      updatedAt: body.user.updatedAt,
      image: body.user.image ?? null,
      initials,
    },
  } satisfies CloudSession
}

function twoFactorRequired(value: unknown) {
  if (!isRecord(value) || value.twoFactorRedirect !== true) return false
  return (
    Array.isArray(value.twoFactorMethods) &&
    value.twoFactorMethods.includes("otp")
  )
}

async function responseMessage(response: Response) {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return `Request failed with status ${response.status}`
  }
  const message = errorResponseMessage(body)
  if (message) return message
  return `Request failed with status ${response.status}`
}

function errorResponseMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.error_description === "string")
    return value.error_description
  if (typeof value.message === "string") return value.message
  if (typeof value.error === "string") return value.error
  if (!Array.isArray(value.errors)) return undefined
  for (const error of value.errors) {
    if (typeof error === "string") return error
    if (isRecord(error) && typeof error.message === "string") {
      return error.message
    }
  }
  return undefined
}
