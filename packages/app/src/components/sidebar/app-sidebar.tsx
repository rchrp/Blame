import * as React from "react"

import { NavMain } from "@/components/sidebar/nav-main"
import { NavSecondary } from "@/components/sidebar/nav-secondary"
import { NavUser } from "@/components/sidebar/nav-user"
import { ProjectSelector } from "@/components/sidebar/project-selector"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { useCloudAuth } from "@/context/cloud-auth"
import { useCodePracticeAnalysis } from "@/components/practices/data/use-code-practice-analysis"
import { useSecurityAudits } from "@/components/security/data/use-security-audits"
import { useProjectInitialization } from "@/components/project-initialization/use-project-initialization"
import {
  BoxesIcon,
  CircleHelpIcon,
  ClipboardCheckIcon,
  CloudUploadIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  SearchIcon,
  Settings2Icon,
  ShieldCheckIcon,
  Table2Icon,
} from "lucide-react"

const data = {
  navMain: [
    {
      title: "Backlog",
      url: "/backlog",
      icon: <Table2Icon />,
    },
    {
      title: "Chat",
      url: "/chat",
      icon: <MessageCircleIcon />,
    },
    {
      title: "Git",
      url: "/git",
      icon: <GitBranchIcon />,
    },
  ],
  navSecondary: [
    {
      title: "Settings",
      url: "/settings",
      icon: <Settings2Icon />,
    },
    {
      title: "Get Help",
      url: "/help",
      icon: <CircleHelpIcon />,
    },
    {
      title: "Search",
      url: "/search",
      icon: <SearchIcon />,
    },
  ],
  project: [
    {
      title: "Code Practices",
      url: "/practices",
      icon: <ClipboardCheckIcon />,
    },
    {
      title: "Security Audit",
      url: "/security",
      icon: <ShieldCheckIcon />,
    },
    {
      title: "Deploy",
      url: "/deploy",
      icon: <CloudUploadIcon />,
    },
    {
      title: "Initialization",
      url: "/initialization",
      icon: <BoxesIcon />,
    },
  ],
}

export function AppSidebar({
  pathname,
  ...props
}: React.ComponentProps<typeof Sidebar> & { pathname: string }) {
  const auth = useCloudAuth()
  const codePracticeAnalysis = useCodePracticeAnalysis()
  const securityAudits = useSecurityAudits()
  const initialization = useProjectInitialization()
  const projectItems = data.project.map((item) =>
    item.url === "/practices"
      ? { ...item, status: codePracticeAnalysisStatus(codePracticeAnalysis) }
      : item.url === "/initialization"
        ? { ...item, status: initializationStatus(initialization) }
        : item.url === "/security" && securityAudits.running
          ? {
              ...item,
              status: (
                <LoaderCircleIcon
                  aria-label="Security audit in progress"
                  className="size-3.5 animate-spin text-muted-foreground"
                />
              ),
            }
          : item
  )

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <ProjectSelector />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} pathname={pathname} />
        <NavMain items={projectItems} label="Project" pathname={pathname} />
        <NavSecondary
          items={data.navSecondary}
          pathname={pathname}
          className="mt-auto"
        />
      </SidebarContent>
      <SidebarFooter>
        {auth.user ? <NavUser user={auth.user} onLogout={auth.logout} /> : null}
      </SidebarFooter>
    </Sidebar>
  )
}

function initializationStatus(
  initialization: ReturnType<typeof useProjectInitialization>
) {
  if (initialization?.availability === "running")
    return (
      <LoaderCircleIcon
        aria-label="Project initialization in progress"
        className="size-3.5 animate-spin text-muted-foreground"
      />
    )
  if (initialization?.availability !== "unavailable") return undefined
  return (
    <span
      aria-label="Project initialization needs attention"
      className="size-2 rounded-full bg-amber-500"
    />
  )
}

function codePracticeAnalysisStatus(
  analysis: ReturnType<typeof useCodePracticeAnalysis>
) {
  if (
    !analysis ||
    analysis.status === "pending" ||
    analysis.status === "running"
  ) {
    return (
      <LoaderCircleIcon
        aria-label="Code practices analysis in progress"
        className="size-3.5 animate-spin text-muted-foreground"
      />
    )
  }
  if (analysis.status !== "done" || analysis.viewedAt) return undefined
  return (
    <span
      aria-label="New code practices analysis"
      className="size-2 rounded-full bg-blue-500"
    />
  )
}
