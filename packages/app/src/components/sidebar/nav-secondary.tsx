"use client"

import * as React from "react"

import { AppLink } from "@/components/navigation/app-link"
import { openCommandPaletteEvent } from "@/components/navigation/command-palette"
import { Kbd } from "@/components/ui/kbd"
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
                  onClick={() => window.dispatchEvent(new Event(openCommandPaletteEvent))}
                >
                  {item.icon}
                  <span>{item.title}</span>
                  <Kbd className="ml-auto bg-transparent">{modKeyLabel}K</Kbd>
                </SidebarMenuButton>
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
