import * as React from "react"

import { BacklogPage } from "@/pages/backlog/page"
import { BacklogStatusPipPage } from "@/pages/backlog/status-pip-page"
import { ChatPage } from "@/pages/chat/page"
import { QuickChatAgentRunner } from "@/pages/chat/quick-chat-agent-runner"
import { SecurityAuditRecorder } from "@/components/security/security-audit-recorder"
import { GitPage } from "@/pages/git/page"
import { PracticesPage } from "@/pages/practices/page"
import { DeployPage } from "@/pages/deploy/page"
import { InitializationPage } from "@/pages/initialization/page"
import { SecurityPage } from "@/pages/security/page"
import { BacklogStoreProvider } from "@/components/backlog/data/backlog-store"
import { QuickChatStoreProvider } from "@/components/chat/data/quick-chat-store"
import { ConnectScreen } from "@/components/onboarding/connect-screen"
import { AiPreferencesSetupScreen } from "@/components/onboarding/ai-preferences-setup-screen"
import {
  navigate,
  navigationPathname,
  navigationPreviousPathname,
  subscribeToNavigation,
} from "@/components/navigation/navigation"
import {
  CompactLoadingScreen,
  LoadingScreen,
} from "@/components/onboarding/loading-screen"
import {
  useMinimumDuration,
  useRuntimeOfferPending,
} from "@/components/onboarding/onboarding-flow"
import {
  OnboardingStage,
  type OnboardingScreen,
} from "@/components/onboarding/stage/onboarding-stage"
import { PremiumPanel } from "@/pages/premium/page"
import { WhatsNewOnLaunch } from "@/components/updates/whats-new-dialog"
import { isSecondaryWindow } from "@/lib/secondary-window"
import {
  AccountDialog,
  useAccountFlow,
  type AccountFlow,
  type AccountView,
} from "@/components/onboarding/account-dialog"
import { WelcomeScreen } from "@/components/onboarding/welcome-screen"
import { RuntimeSetupScreen } from "@/components/onboarding/runtime-setup-screen"
import { useBlameRuntime } from "@/context/blame-runtime"
import { ProjectInitializationRunner } from "@/components/project-initialization/project-initialization-runner"
import { ProjectCodePracticesRunner } from "@/components/practices/project-code-practices-runner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PersonalizationSync } from "@/lib/use-personalization"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { AppLayout } from "@/layouts/app-layout"
import { SettingsDialog } from "@/pages/settings/page"
import { StarInvite } from "@/components/star-invite/star-invite"
import { AccountClosureReceiptPage } from "@/pages/account-privacy/account-closure-receipt-page"
import {
  getAccountClosureReceipt,
  subscribeToAccountClosureReceipt,
} from "@/lib/account-closure-receipt-storage"
import {
  appWindowRole,
  loadedWindowRole,
  windowAwaitsReplacement,
} from "@/lib/app-window-role"

const settingsPath = "/settings"
const premiumPath = "/premium"
const backlogStatusPipPath = "/backlog-status-pip"
// Long enough for the mark to draw itself and one loading line to be read.
const minimumLoadingMs = 1600
// Fixed for the life of the window: a new role means a new window.
const loadedRole = loadedWindowRole(window.location.search)

const routes = [
  { path: "/backlog", title: "Backlog", element: null },
  {
    path: backlogStatusPipPath,
    title: "Active User Stories",
    element: <BacklogStatusPipPage />,
  },
  { path: "/chat", title: "Chat", element: <ChatPage /> },
  { path: "/git", title: "Git", element: <GitPage /> },
  { path: "/practices", title: "Code Practices", element: <PracticesPage /> },
  {
    path: "/security",
    title: "Security Audit",
    element: <SecurityPage />,
  },
  { path: "/deploy", title: "Deploy", element: <DeployPage /> },
  {
    path: "/initialization",
    title: "Preview Environment",
    element: <InitializationPage />,
  },
]

function resolveRoute(pathname: string) {
  return routes.find((route) => route.path === pathname) ?? routes[0]
}

export function App() {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const projects = useProjects()
  const closureReceipt = React.useSyncExternalStore(
    subscribeToAccountClosureReceipt,
    getAccountClosureReceipt,
    getAccountClosureReceipt
  )
  const pathname = React.useSyncExternalStore(
    subscribeToNavigation,
    navigationPathname,
    () => "/backlog"
  )
  const previousPathname = React.useSyncExternalStore(
    subscribeToNavigation,
    navigationPreviousPathname,
    () => "/backlog"
  )
  const route = resolveRoute(pathname)
  const settingsOpen = pathname === settingsPath
  const premiumOpen = pathname === premiumPath
  const statusPipOpen = pathname === backlogStatusPipPath
  const previousRoute = resolvePreviousRoute(previousPathname)
  // Settings and Premium open over the page that was in front.
  const activeRoute = settingsOpen || premiumOpen ? previousRoute : route
  // The backlog page stays mounted: it runs the agents and the story queue.
  const backlogActive = activeRoute.path === "/backlog"
  const loading = useMinimumDuration(
    auth.status === "loading",
    statusPipOpen ? 0 : minimumLoadingMs
  )
  const runtime = useBlameRuntime()
  const runtimeOfferOpen = useRuntimeOfferPending(runtime.phase)
  const accountFlow = useAccountFlow(premiumOpen)
  const closePremium = () => navigate(previousRoute.path)
  const windowRole = appWindowRole({
    activeProject: projects.activeProject,
    aiPreferences: auth.aiPreferences,
    authStatus: loading ? "loading" : auth.status,
    statusPipOpen,
  })

  React.useEffect(() => {
    if (!windowRole) return
    void platform.windowControls?.setPresentation({
      pathname,
      role: windowRole,
    })
  }, [pathname, platform.windowControls, windowRole])

  function closeSettings(open: boolean) {
    if (!open) navigate(activeRoute.path)
  }

  if (loading && statusPipOpen) return <CompactLoadingScreen />
  if (!loading && auth.status === "unauthenticated" && closureReceipt) {
    return (
      <TooltipProvider>
        <AccountClosureReceiptPage receipt={closureReceipt} />
      </TooltipProvider>
    )
  }
  if (!loading && statusPipOpen) {
    return (
      <TooltipProvider>
        <BacklogStatusPipPage />
      </TooltipProvider>
    )
  }

  if (windowAwaitsReplacement(loadedRole, windowRole)) {
    return (
      <OnboardingStage screen="loading">
        <LoadingScreen />
      </OnboardingStage>
    )
  }

  // Signing in or Premium: a setup step while setup is not finished, a
  // popup over the app after.
  const onboardingScreen = withAccountStep(
    resolveOnboardingScreen({
      activeProject: Boolean(projects.activeProject),
      aiPreferencesMissing: auth.aiPreferences === null,
      authStatus: auth.status,
      loading,
      runtimeOfferOpen,
    }),
    accountFlow.view
  )
  if (onboardingScreen) {
    return (
      <OnboardingStage screen={onboardingScreen}>
        {onboardingElement(onboardingScreen, accountFlow, closePremium)}
      </OnboardingStage>
    )
  }

  return (
    <TooltipProvider>
      <BacklogStoreProvider>
        <QuickChatStoreProvider>
          <QuickChatAgentRunner>
            <ProjectInitializationRunner />
            <ProjectCodePracticesRunner />
            <PersonalizationSync />
            <SecurityAuditRecorder />
            <AppLayout
              pathname={pathname}
              persistent={<BacklogPage active={backlogActive} />}
              persistentActive={backlogActive}
              routeKey={activeRoute.path}
              title={activeRoute.title}
            >
              {backlogActive ? null : activeRoute.element}
            </AppLayout>
            <SettingsDialog open={settingsOpen} onOpenChange={closeSettings} />
            <AccountDialog flow={accountFlow} onPremiumClose={closePremium} />
            <StarInvite />
            {/* Only once the app itself is up: never over loading or onboarding. */}
            <WhatsNewOnLaunch enabled={!isSecondaryWindow()} />
          </QuickChatAgentRunner>
        </QuickChatStoreProvider>
      </BacklogStoreProvider>
    </TooltipProvider>
  )
}

function resolveOnboardingScreen(input: {
  activeProject: boolean
  aiPreferencesMissing: boolean
  authStatus: "authenticated" | "loading" | "unauthenticated"
  loading: boolean
  runtimeOfferOpen: boolean
}): OnboardingScreen | undefined {
  if (input.loading || input.authStatus === "loading") return "loading"
  if (input.authStatus === "unauthenticated") return "connect"
  if (input.aiPreferencesMissing) return "ai-setup"
  if (!input.activeProject && input.runtimeOfferOpen) return "runtime-setup"
  if (!input.activeProject) return "welcome"
  return undefined
}

function withAccountStep(
  screen: OnboardingScreen | undefined,
  view: AccountView | null
): OnboardingScreen | undefined {
  if (!screen || screen === "loading" || !view) return screen
  return view === "sign-in" ? "connect" : "premium"
}

function onboardingElement(
  screen: OnboardingScreen,
  accountFlow: AccountFlow,
  closePremium: () => void
) {
  if (screen === "loading") return <LoadingScreen />
  if (screen === "connect") return <ConnectScreen />
  if (screen === "premium") {
    return (
      <PremiumPanel
        variant="page"
        onLeave={closePremium}
        {...accountFlow.premium}
      />
    )
  }
  if (screen === "ai-setup") return <AiPreferencesSetupScreen />
  if (screen === "runtime-setup") return <RuntimeSetupScreen />
  return <WelcomeScreen />
}

function resolvePreviousRoute(pathname: string) {
  if (pathname === settingsPath) return routes[0]
  return resolveRoute(pathname)
}

export default App
