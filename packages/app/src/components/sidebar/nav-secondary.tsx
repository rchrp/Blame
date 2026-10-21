"use client"

import * as React from "react"

import { MailIcon, UsersRoundIcon } from "lucide-react"

import { AppLink } from "@/components/navigation/app-link"
import { openCommandPaletteEvent } from "@/components/navigation/command-palette"
import { Kbd } from "@/components/ui/kbd"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePlatform } from "@/context/platform"
import { communityUrl, supportEmailUrl } from "@/lib/help-links"
import { modKeyLabel } from "@/lib/keyboard"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export function NavSecondary({
  items,
  pathname,
  ...props
}: {
  items: {
    title: string
    url: string
    icon: React.ReactNode
  }[]
  pathname: string
} & React.ComponentPropsWithoutRef<typeof SidebarGroup>) {
  return (
    <SidebarGroup {...props}>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              {item.url === "/search" ? (
                // Search opens the command palette instead of a page.
                <SidebarMenuButton
                  onClick={() =>
                    window.dispatchEvent(new Event(openCommandPaletteEvent))
                  }
                >
                  {item.icon}
                  <span>{item.title}</span>
                  <Kbd className="ml-auto bg-transparent">{modKeyLabel}K</Kbd>
                </SidebarMenuButton>
              ) : item.url === "/help" ? (
                <HelpMenu icon={item.icon} title={item.title} />
              ) : (
                <SidebarMenuButton asChild isActive={pathname === item.url}>
                  <AppLink href={item.url}>
                    {item.icon}
                    <span>{item.title}</span>
                  </AppLink>
                </SidebarMenuButton>
              )}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

// Help leads out of the app: the community, or an email to support.
function HelpMenu({ icon, title }: { icon: React.ReactNode; title: string }) {
  const platform = usePlatform()
  const open = (url: string) => {
    if (platform.openExternalLink) platform.openExternalLink(url)
    else window.open(url, "_blank", "noopener,noreferrer")
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton className="data-[state=open]:bg-sidebar-accent">
          {icon}
          <span>{title}</span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56" side="right">
        <DropdownMenuItem onSelect={() => open(communityUrl)}>
          <UsersRoundIcon />
          <div className="grid">
            <span>Community</span>
            <span className="text-xs text-muted-foreground">
              Questions and ideas on GitHub
            </span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open(supportEmailUrl)}>
          <MailIcon />
          <div className="grid">
            <span>Contact support</span>
            <span className="text-xs text-muted-foreground">
              support@blame.so
            </span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
