import * as React from "react"

import {
  CloudAuthContext,
  type CloudAiPreferences,
  type CloudSession,
  type CloudMcpConfiguration,
  type CloudMcpServer,
  type CloudLicense,
  type LoginInput,
  type LoginResult,
  type SaveAiPreferencesInput,
  type SignupInput,
  type WorkspaceMode,
} from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import {
  readCloudSession,
  removeCloudSession,
  writeCloudSession,
} from "@/context/cloud-auth-storage"
import { createCloudApi } from "@/lib/cloud-api"
import { useCloudTelemetry } from "@/context/cloud-telemetry"
import { defaultCloudApiUrl } from "@/context/cloud-api-origin"
import { transferLocalWorkspace } from "@/context/local-workspace"

const defaultApiUrl = defaultCloudApiUrl(
  import.meta.env.VITE_CLOUD_API_URL,
  import.meta.env.DEV
)

type SessionState = {
  status: "authenticated"
  mode: WorkspaceMode
  // The API holding this workspace: the account's, or the local one.
  apiUrl: string
  session: CloudSession
  aiPreferences: CloudAiPreferences | null
  mcpConfiguration: CloudMcpConfiguration | null
  license?: CloudLicense
}

type CloudAuthState =
  | { status: "loading" }
  // Only where no local API runs, such as the web build.
  | { status: "unauthenticated"; error?: string }
  | SessionState

type SignInState = { open: boolean; error?: string; transferring?: boolean }

/**
 * The workspace session. It is chosen here and nowhere else: a Blame account
 * when one is signed in, otherwise the API the desktop runs on this computer.
 * Both serve the same API, so the rest of the app only sees a connection and
 * what the session offers.
 */
export function CloudAuthProvider({ children }: { children: React.ReactNode }) {
  const platform = usePlatform()
  const [state, setState] = React.useState<CloudAuthState>({
    status: "loading",
  })
  const [signIn, setSignIn] = React.useState<SignInState>({ open: false })
  const accountUrl = platform.api?.url ?? defaultApiUrl
  const session = state.status === "authenticated" ? state : undefined
  const token = session?.session.token
  const account = session?.mode === "account"
  const apiConnection = React.useMemo(
    () => ({ url: session?.apiUrl ?? accountUrl, token }),
    [accountUrl, session?.apiUrl, token]
  )
  const apiForToken = React.useCallback(
    (sessionToken?: string) =>
      createCloudApi({
        authRequest: platform.auth?.request,
        token: sessionToken,
        url: accountUrl,
      }),
    [accountUrl, platform.auth]
  )
  // Sign-in requests always go to the account API.
  const accountApi = React.useMemo(() => apiForToken(), [apiForToken])
  const sessionApi = React.useMemo(
    () => createCloudApi({ ...apiConnection }),
    [apiConnection]
  )
  useCloudTelemetry(platform.telemetry, apiConnection, account)

  React.useEffect(() => {
    if (!platform.previewRuntime) return
    if (account && token)
      void platform.previewRuntime.configure({ url: accountUrl, token })
    else void platform.previewRuntime.disconnect()
  }, [account, accountUrl, platform.previewRuntime, token])

  React.useEffect(() => {
    if (!platform.deploy) return
    if (account && token)
      void platform.deploy.configure({ url: accountUrl, token })
    else void platform.deploy.disconnect()
  }, [account, accountUrl, platform.deploy, token])

  const openLocalSession = React.useCallback(async (): Promise<
    CloudAuthState
  > => {
    if (!platform.localApi) return { status: "unauthenticated" }
    const local = await platform.localApi.session()
    const api = createCloudApi(local)
    return hydrateSession(api, { token: local.token, user: await api.profile() }, {
      mode: "local",
      apiUrl: local.url,
    })
  }, [platform.localApi])

  const localConnection = React.useCallback(async () => {
    if (!platform.localApi) return undefined
    return platform.localApi.session()
  }, [platform.localApi])

  React.useEffect(() => {
    let alive = true
    const stored = readCloudSession()
    const restore = stored
      ? hydrateSession(apiForToken(stored.token), stored, {
          mode: "account",
          apiUrl: accountUrl,
          refreshProfile: true,
        })
          .then((restored) => {
            writeCloudSession(restored.session)
            return restored
          })
          .catch(() => {
            void platform.mcp?.detachCloud(stored.user.id)
            removeCloudSession()
            return openLocalSession()
          })
      : openLocalSession()
    void restore
      .catch(
        (error): CloudAuthState => ({
          status: "unauthenticated",
          error: errorMessage(error, "Blame could not open your workspace."),
        })
      )
      .then((next) => {
        if (alive) setState(next)
      })
    return () => {
      alive = false
    }
  }, [accountUrl, apiForToken, openLocalSession, platform.mcp])

  const failSignIn = React.useCallback((error: unknown, fallback: string) => {
    const message = errorMessage(error, fallback)
    setSignIn((current) => ({ ...current, error: message, transferring: false }))
    setState((current) =>
      current.status === "authenticated"
        ? current
        : { status: "unauthenticated", error: message }
    )
  }, [])

  /**
   * Switches to the account: moves the local workspace into it first, so
   * nothing built without an account is left behind.
   */
  const adoptAccount = React.useCallback(
    async (accountSession: CloudSession) => {
      const next = await hydrateSession(
        apiForToken(accountSession.token),
        accountSession,
        { mode: "account", apiUrl: accountUrl }
      )
      const local = await localConnection()
      if (local) {
        setSignIn((current) => ({ ...current, transferring: true }))
        await transferLocalWorkspace(local, {
          url: accountUrl,
          token: accountSession.token,
        })
      }
      writeCloudSession(next.session)
      setState(next)
      setSignIn({ open: false })
    },
    [accountUrl, apiForToken, localConnection]
  )

  React.useEffect(() => {
    if (!platform.auth) return
    const unsubscribe = platform.auth.onCallback((result) => {
      if (result.error) {
        if (result.error === "email_verified") return
        failSignIn(
          undefined,
          "External sign-in was not completed. Please try again."
        )
        return
      }
      if (!result.code) return
      setSignIn((current) => ({ ...current, error: undefined }))
      void apiForToken()
        .exchangeDesktopCode(result.code)
        .then(adoptAccount)
        .catch((error) =>
          failSignIn(error, "External sign-in could not be completed.")
        )
    })
    platform.auth.ready()
    return unsubscribe
  }, [adoptAccount, apiForToken, failSignIn, platform.auth])

  const completeDesktopAuthorization = React.useCallback(
    async (authorization: DesktopAuthorization) => {
      const deviceToken = await waitForDesktopAuthorization(
        accountApi,
        authorization
      )
      await adoptAccount(await accountApi.exchangeDesktopDeviceToken(deviceToken))
    },
    [accountApi, adoptAccount]
  )

  const watchEmailVerification = React.useCallback(
    (authorization: DesktopAuthorization) => {
      void completeDesktopAuthorization(authorization).catch((error) =>
        failSignIn(error, "External sign-in could not be completed.")
      )
    },
    [completeDesktopAuthorization, failSignIn]
  )

  const login = React.useCallback(
    async (input: LoginInput): Promise<LoginResult> => {
      const result = await accountApi.login(input)
      if (result === "two-factor") return result
      if ("authorization" in result) {
        watchEmailVerification(result.authorization)
        return "email-verification"
      }
      await adoptAccount(result)
      return "authenticated"
    },
    [accountApi, adoptAccount, watchEmailVerification]
  )

  const verifyEmailTwoFactor = React.useCallback(
    async (code: string) => {
      await adoptAccount(await accountApi.verifyEmailTwoFactor(code))
    },
    [accountApi, adoptAccount]
  )

  const resendEmailTwoFactor = React.useCallback(
    () => accountApi.resendEmailTwoFactor(),
    [accountApi]
  )

  const signup = React.useCallback(
    async (input: SignupInput) => {
      const authorization = await accountApi.signup(input)
      watchEmailVerification(authorization)
    },
    [accountApi, watchEmailVerification]
  )

  const requestPasswordReset = React.useCallback(
    (email: string) => accountApi.requestPasswordReset(email),
    [accountApi]
  )
  const resetPassword = React.useCallback(
    (resetToken: string, password: string) =>
      accountApi.resetPassword(resetToken, password),
    [accountApi]
  )
  const resendVerification = React.useCallback(
    async (email: string) => {
      const authorization = await accountApi.resendVerification(email)
      watchEmailVerification(authorization)
    },
    [accountApi, watchEmailVerification]
  )

  const openExternalUrl = React.useCallback(
    (url: string) => {
      if (platform.openExternalLink) platform.openExternalLink(url)
      else window.open(url, "_blank", "noopener,noreferrer")
    },
    [platform]
  )

  const socialLogin = React.useCallback(
    async (provider: "github" | "google" | "microsoft") => {
      const authorization = await accountApi.socialLogin(provider)
      openExternalUrl(authorization.verificationUrl)
      await completeDesktopAuthorization(authorization)
    },
    [accountApi, completeDesktopAuthorization, openExternalUrl]
  )
  const passkeyLogin = React.useCallback(async () => {
    const authorization = await accountApi.passkeyLogin()
    openExternalUrl(authorization.verificationUrl)
    await completeDesktopAuthorization(authorization)
  }, [accountApi, completeDesktopAuthorization, openExternalUrl])

  const updateSession = React.useCallback(
    (update: Partial<SessionState>) =>
      setState((current) =>
        current.status === "authenticated" ? { ...current, ...update } : current
      ),
    []
  )

  const refreshAiPreferences = React.useCallback(async () => {
    if (!token) return
    updateSession({ aiPreferences: await sessionApi.aiPreferences() })
  }, [sessionApi, token, updateSession])

  const saveAiPreferences = React.useCallback(
    async (input: SaveAiPreferencesInput) => {
      if (!token) return
      updateSession({
        aiPreferences: await sessionApi.saveAiPreferences(input),
      })
    },
    [sessionApi, token, updateSession]
  )

  const refreshLicense = React.useCallback(async () => {
    if (!account || !token) return
    const license = await sessionApi.license()
    updateSession({ license })
    return license
  }, [account, sessionApi, token, updateSession])

  React.useEffect(() => {
    if (!platform.billing || !account) return
    const unsubscribe = platform.billing.onRefreshLicense(() => {
      void refreshLicense()
    })
    platform.billing.ready()
    return unsubscribe
  }, [account, platform.billing, refreshLicense])

  const startCheckout = React.useCallback(
    async (cycle: "monthly" | "yearly") => {
      openExternalUrl((await sessionApi.checkout(cycle)).url)
    },
    [openExternalUrl, sessionApi]
  )

  const openBillingPortal = React.useCallback(async () => {
    openExternalUrl((await sessionApi.billingPortal()).url)
  }, [openExternalUrl, sessionApi])

  const saveMcpConfiguration = React.useCallback(
    async (servers: CloudMcpServer[]) => {
      if (!token) return
      updateSession({
        mcpConfiguration: await sessionApi.saveMcpConfiguration(servers),
      })
    },
    [sessionApi, token, updateSession]
  )

  /** Leaves the account and goes back to the workspace on this computer. */
  const logout = React.useCallback(async () => {
    if (!session || session.mode !== "account") return
    try {
      await sessionApi.logout().catch(() => undefined)
      await platform.mcp?.detachCloud(session.session.user.id)
    } catch {
      return
    } finally {
      removeCloudSession()
      setState({ status: "loading" })
      setState(
        await openLocalSession().catch(
          (): CloudAuthState => ({ status: "unauthenticated" })
        )
      )
    }
  }, [openLocalSession, platform.mcp, session, sessionApi])

  const openSignIn = React.useCallback(() => setSignIn({ open: true }), [])
  const closeSignIn = React.useCallback(() => setSignIn({ open: false }), [])

  return (
    <CloudAuthContext.Provider
      value={{
        apiConnection,
        aiPreferences: session?.aiPreferences,
        mcpConfiguration: session?.mcpConfiguration,
        license: session?.license,
        mode: session?.mode,
        error:
          state.status === "unauthenticated" ? state.error : signIn.error,
        signIn,
        openSignIn,
        closeSignIn,
        login,
        passkeyLogin,
        logout,
        openBillingPortal,
        refreshAiPreferences,
        refreshLicense,
        requestPasswordReset,
        resendEmailTwoFactor,
        resendVerification,
        resetPassword,
        saveAiPreferences,
        saveMcpConfiguration,
        signup,
        socialLogin,
        startCheckout,
        status: state.status,
        token,
        user: session?.session.user,
        verifyEmailTwoFactor,
      }}
    >
      {children}
    </CloudAuthContext.Provider>
  )
}

async function waitForDesktopAuthorization(
  api: ReturnType<typeof createCloudApi>,
  authorization: {
    deviceCode: string
    expiresIn: number
    interval: number
  }
) {
  const expiresAt = Date.now() + authorization.expiresIn * 1_000
  let interval = Math.max(authorization.interval, 1) * 1_000
  while (Date.now() < expiresAt) {
    await wait(interval)
    const result = await api.pollDesktopLogin(authorization.deviceCode)
    if (result.status === "authenticated") return result.accessToken
    if (result.status === "slow-down") interval += 5_000
  }
  throw new Error("This sign-in request expired. Try again.")
}

type DesktopAuthorization = {
  deviceCode: string
  expiresIn: number
  interval: number
  verificationUrl: string
}

function wait(duration: number) {
  return new Promise((resolve) => window.setTimeout(resolve, duration))
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

const unavailableLicense: CloudLicense = {
  licensed: false,
  status: "unavailable",
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
}

async function hydrateSession(
  api: ReturnType<typeof createCloudApi>,
  session: CloudSession,
  options: { mode: WorkspaceMode; apiUrl: string; refreshProfile?: boolean }
): Promise<SessionState> {
  const user = options.refreshProfile ? await api.profile() : session.user
  // Licenses come with accounts: the local API has no billing.
  const [license, aiPreferences, mcpConfiguration] = await Promise.all([
    options.mode === "account"
      ? api.license().catch(() => unavailableLicense)
      : undefined,
    api.aiPreferences().catch(() => null),
    api.mcpConfiguration().catch(() => null),
  ])
  return {
    status: "authenticated",
    mode: options.mode,
    apiUrl: options.apiUrl,
    session: { ...session, user },
    aiPreferences,
    mcpConfiguration,
    license,
  }
}
