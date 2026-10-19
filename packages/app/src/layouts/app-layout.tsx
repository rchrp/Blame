import * as React from "react"

import { SiteHeader, WindowControls } from "@/components/layout/site-header"
import {
  KeyboardShortcutsDialog,
  useAppShortcuts,
} from "@/components/navigation/app-shortcuts"
import { CommandPalette } from "@/components/navigation/command-palette"
import { AppSidebar } from "@/components/sidebar/app-sidebar"
import { useQuickChatStore } from "@/components/chat/data/quick-chat-store"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { useProjects } from "@/context/projects"
import { projectColorValue } from "@/lib/projects"
import { useAppActivity } from "@/layouts/use-app-activity"
import { isBoolean, useUiMemory } from "@/lib/ui-memory"

const windowShellGraceMs = 1000
const windowShellHeightPx = 48

export function AppLayout({
  children,
  pathname,
  routeKey,
  title,
}: {
  children: React.ReactNode
  pathname: string
  // Changes only when the page itself changes (not for dialogs over it).
  routeKey: string
  title: string
}) {
  const shortcuts = useAppShortcuts()
  useAppActivity()
  const [sidebarOpen, setSidebarOpen] = useUiMemory(
    "sidebar-open",
    true,
    isBoolean
  )
  const projects = useProjects()
  const quickChats = useQuickChatStore()
  const haloColor = projectColorValue(projects.activeProject?.color)
  const headerTitle =
    pathname === "/chat" ? (quickChats.activeChat?.title ?? title) : title
  const [windowShellOpen, setWindowShellOpen] = React.useState(false)
  const closeTimerRef = React.useRef<number | undefined>(undefined)
  const openedAtRef = React.useRef(0)
  const pointerYRef = React.useRef(0)

  const closeWindowShellIfPointerOutside = React.useCallback(() => {
    const elapsedTime = window.performance.now() - openedAtRef.current
    if (elapsedTime < windowShellGraceMs) return
    if (pointerYRef.current <= windowShellHeightPx) return
    setWindowShellOpen(false)
  }, [])

  const openWindowShell = React.useCallback(
    (event: React.MouseEvent) => {
      window.clearTimeout(closeTimerRef.current)
      pointerYRef.current = event.clientY
      openedAtRef.current = window.performance.now()
      setWindowShellOpen(true)
      closeTimerRef.current = window.setTimeout(() => {
        closeWindowShellIfPointerOutside()
      }, windowShellGraceMs)
    },
    [closeWindowShellIfPointerOutside]
  )

  React.useEffect(() => {
    return () => window.clearTimeout(closeTimerRef.current)
  }, [])

  React.useEffect(() => {
    if (!windowShellOpen) return
    const handleMouseMove = (event: MouseEvent) => {
      pointerYRef.current = event.clientY
      closeWindowShellIfPointerOutside()
    }
    window.addEventListener("mousemove", handleMouseMove)
    return () => window.removeEventListener("mousemove", handleMouseMove)
  }, [closeWindowShellIfPointerOutside, windowShellOpen])

  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
      className="relative isolate overflow-hidden bg-transparent"
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 16)",
        } as React.CSSProperties
      }
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed top-0 left-0 z-0 h-72 w-96 -translate-x-24 -translate-y-28 blur-3xl"
        style={{
          background: `radial-gradient(circle at center, ${haloColor} 0%, transparent 68%)`,
          opacity: 0.42,
        }}
      />
      <AppSidebar pathname={pathname} variant="inset" />
      <div
        data-window-shell-bar
        data-open={windowShellOpen}
        className="absolute top-0 right-0 left-0 z-2"
        onMouseEnter={openWindowShell}
      >
        {windowShellOpen ? <div data-window-shell-drag /> : null}
        <WindowControls
          className="absolute top-2 right-3 z-1 transition-[opacity,transform] duration-200 ease-in-out"
          data-window-shell-controls
        />
      </div>
      <SidebarInset
        data-window-shell-inset
        className="z-[1] min-w-0 overflow-hidden"
      >
        <SiteHeader title={headerTitle} />
        <div
          key={routeKey}
          className="page-enter flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {children}
        </div>
      </SidebarInset>
      <KeyboardShortcutsDialog
        open={shortcuts.helpOpen}
        onOpenChange={shortcuts.setHelpOpen}
      />
      <CommandPalette onShowShortcuts={() => shortcuts.setHelpOpen(true)} />
    </SidebarProvider>
  )
}
