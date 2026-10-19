import * as React from "react"

import { BacklogPage } from "@/pages/backlog/page"
import { BacklogStatusPipPage } from "@/pages/backlog/status-pip-page"
import { ChatPage } from "@/pages/chat/page"
import { GitPage } from "@/pages/git/page"
import { PracticesPage } from "@/pages/practices/page"
import { DeployPage } from "@/pages/deploy/page"
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
  usePremiumOfferPending,
} from "@/components/onboarding/onboarding-flow"
import {
  OnboardingStage,
  type OnboardingScreen,
} from "@/components/onboarding/stage/onboarding-stage"
import { PremiumOfferScreen, PremiumScreen } from "@/pages/premium/page"
import { WelcomeScreen } from "@/components/onboarding/welcome-screen"
import { ProjectInitializationRunner } from "@/components/project-initialization/project-initialization-runner"
import { ProjectCodePracticesRunner } from "@/components/practices/project-code-practices-runner"
import { UpdateStartupNotifier } from "@/components/updates/update-startup-notifier"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { AppLayout } from "@/layouts/app-layout"
import { SettingsDialog } from "@/pages/settings/page"
import { AccountPrivacyPage } from "@/pages/account-privacy/page"
import { AccountClosureReceiptPage } from "@/pages/account-privacy/account-closure-receipt-page"
import {
  getAccountClosureReceipt,
  subscribeToAccountClosureReceipt,
} from "@/lib/account-closure-receipt-storage"
import { appWindowRole } from "@/lib/app-window-role"

const settingsPath = "/settings"
const premiumPath = "/premium"
const accountPrivacyPath = "/account/privacy"
const backlogStatusPipPath = "/backlog-status-pip"
// Long enough for the mark to draw itself and one loading line to be read.
const minimumLoadingMs = 1600

const routes = [
  { path: "/backlog", title: "Backlog", element: <BacklogPage /> },
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
    path: "/data-library",
    title: "Data Library",
    element: <RoutePage title="Data Library" />,
  },
  {
    path: "/reports",
    title: "Reports",
    element: <RoutePage title="Reports" />,
  },
  {
    path: "/word-assistant",
    title: "Word Assistant",
    element: <RoutePage title="Word Assistant" />,
  },
  { path: "/help", title: "Get Help", element: <RoutePage title="Get Help" /> },
  { path: "/search", title: "Search", element: <RoutePage title="Search" /> },
]

function resolveRoute(pathname: string) {
  return routes.find((route) => route.path === pathname) ?? routes[0]
}

function RoutePage({ title }: { title: string }) {
  return (
    <div className="flex flex-1 flex-col gap-4 px-4 pt-[calc(var(--header-height)+1rem)] pb-4 lg:px-6 lg:pt-[calc(var(--header-height)+1.5rem)] lg:pb-6">
      <div className="rounded-lg border bg-card p-6 text-card-foreground">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Cette page est branchee sur sa route.
        </p>
      </div>
    </div>
  )
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
  const accountPrivacyOpen = pathname === accountPrivacyPath
  const statusPipOpen = pathname === backlogStatusPipPath
  const previousRoute = resolvePreviousRoute(previousPathname)
  const activeRoute = settingsOpen ? previousRoute : route
  const loading = useMinimumDuration(
    auth.status === "loading",
    statusPipOpen ? 0 : minimumLoadingMs
  )
  const premiumOfferPending = usePremiumOfferPending()
  const premiumOfferOpen =
    premiumOfferPending &&
    auth.status === "authenticated" &&
    auth.aiPreferences !== null &&
    auth.license?.licensed !== true
  const windowRole = appWindowRole({
    activeProject: projects.activeProject,
    accountPrivacyOpen,
    aiPreferences: auth.aiPreferences,
    authStatus: loading ? "loading" : auth.status,
    premiumOpen: premiumOpen || premiumOfferOpen,
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
        <Toaster />
      </TooltipProvider>
    )
  }
  if (!loading && accountPrivacyOpen && auth.status === "authenticated") {
    return (
      <TooltipProvider>
        <AccountPrivacyPage />
        <Toaster />
      </TooltipProvider>
    )
  }
  if (!loading && statusPipOpen) {
    return (
      <TooltipProvider>
        <BacklogStatusPipPage />
        <Toaster />
      </TooltipProvider>
    )
  }

  const onboardingScreen = resolveOnboardingScreen({
    activeProject: Boolean(projects.activeProject),
    aiPreferencesMissing: auth.aiPreferences === null,
    authStatus: auth.status,
    loading,
    premiumOfferOpen,
    premiumOpen,
  })
  if (onboardingScreen) {
    return (
      <OnboardingStage screen={onboardingScreen}>
        {onboardingElement(onboardingScreen)}
      </OnboardingStage>
    )
  }

  return (
    <TooltipProvider>
      <BacklogStoreProvider>
        <QuickChatStoreProvider>
          <ProjectInitializationRunner />
          <ProjectCodePracticesRunner />
          <UpdateStartupNotifier />
          <AppLayout
            pathname={pathname}
            routeKey={activeRoute.path}
            title={activeRoute.title}
          >
            {activeRoute.element}
          </AppLayout>
          <SettingsDialog open={settingsOpen} onOpenChange={closeSettings} />
          <Toaster />
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
  premiumOfferOpen: boolean
  premiumOpen: boolean
}): OnboardingScreen | undefined {
  if (input.loading || input.authStatus === "loading") return "loading"
  if (input.authStatus === "unauthenticated") return "connect"
  if (input.premiumOpen) return "premium"
  if (input.aiPreferencesMissing) return "ai-setup"
  if (input.premiumOfferOpen) return "premium-offer"
  if (!input.activeProject) return "welcome"
  return undefined
}

function onboardingElement(screen: OnboardingScreen) {
  if (screen === "loading") return <LoadingScreen />
  if (screen === "connect") return <ConnectScreen />
  if (screen === "premium") return <PremiumScreen />
  if (screen === "ai-setup") return <AiPreferencesSetupScreen />
  if (screen === "premium-offer") return <PremiumOfferScreen />
  return <WelcomeScreen />
}

function resolvePreviousRoute(pathname: string) {
  if (pathname === settingsPath) return routes[0]
  return resolveRoute(pathname)
}

export default App
