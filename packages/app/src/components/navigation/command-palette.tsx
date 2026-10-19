import * as React from "react"
import {
  FolderOpenIcon,
  KeyboardIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  MoonIcon,
  PlusIcon,
  SettingsIcon,
  SunIcon,
  CrownIcon,
} from "lucide-react"

import { backlogColumns } from "@/components/backlog/data/backlog-data"
import { selectBacklogStory } from "@/components/backlog/data/backlog-navigation"
import { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { quickChatSelectedEvent } from "@/components/chat/data/quick-chat-data"
import { useQuickChatStore } from "@/components/chat/data/quick-chat-store"
import { routeShortcuts } from "@/components/navigation/app-shortcuts"
import { navigate } from "@/components/navigation/navigation"
import { useTheme } from "@/components/providers/theme-provider"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { useProjects } from "@/context/projects"
import { modKeyLabel } from "@/lib/keyboard"

export const newUserStoryEvent = "blame:new-user-story"
export const openCommandPaletteEvent = "blame:open-command-palette"

const columnTitles = new Map<string, string>(
  backlogColumns.map((column) => [column.id, column.title])
)

// ⌘K: one search box for stories, conversations, projects, pages and the
// most common actions.
export function CommandPalette({
  onShowShortcuts,
}: {
  onShowShortcuts(): void
}) {
  const [open, setOpen] = React.useState(false)
  const backlog = useBacklogStore()
  const quickChats = useQuickChatStore()
  const projects = useProjects()
  const theme = useTheme()

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || event.altKey || event.shiftKey) return
      if (!(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      setOpen((current) => !current)
    }
    const handleOpen = () => setOpen(true)
    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener(openCommandPaletteEvent, handleOpen)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener(openCommandPaletteEvent, handleOpen)
    }
  }, [])

  function run(action: () => void) {
    setOpen(false)
    // Let the dialog close before the next view takes focus.
    requestAnimationFrame(action)
  }

  const stories = [...backlog.stories].sort((left, right) => right.storyNumber - left.storyNumber)
  const recentProjects = projects.recentProjects.filter(
    (project) => project.path !== projects.activeProject?.path
  )
  const dark = document.documentElement.classList.contains("dark")

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search stories, conversations, projects and actions"
      className="sm:max-w-xl"
    >
      <Command>
      <CommandInput placeholder="Search stories, chats, projects or actions…" />
      <CommandList className="max-h-[min(26rem,60vh)]">
        <CommandEmpty>Nothing found.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem
            value="new user story create"
            onSelect={() =>
              run(() => {
                navigate("/backlog")
                window.setTimeout(() => window.dispatchEvent(new Event(newUserStoryEvent)), 50)
              })
            }
          >
            <PlusIcon /> New user story
          </CommandItem>
          <CommandItem
            value="new chat conversation"
            onSelect={() =>
              run(() => {
                navigate("/chat")
                quickChats.setActiveId(undefined)
                window.dispatchEvent(new Event(quickChatSelectedEvent))
              })
            }
          >
            <MessageSquarePlusIcon /> New chat
          </CommandItem>
          <CommandItem value="settings preferences models" onSelect={() => run(() => navigate("/settings"))}>
            <SettingsIcon /> Settings
            <CommandShortcut>{modKeyLabel},</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="toggle theme dark light mode"
            onSelect={() => run(() => theme.setTheme(dark ? "light" : "dark"))}
          >
            {dark ? <SunIcon /> : <MoonIcon />} Switch to {dark ? "light" : "dark"} theme
            <CommandShortcut>D</CommandShortcut>
          </CommandItem>
          <CommandItem value="keyboard shortcuts help" onSelect={() => run(onShowShortcuts)}>
            <KeyboardIcon /> Keyboard shortcuts
            <CommandShortcut>{modKeyLabel}/</CommandShortcut>
          </CommandItem>
          <CommandItem value="premium billing subscription" onSelect={() => run(() => navigate("/premium"))}>
            <CrownIcon /> Blame Premium
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Go to">
          {routeShortcuts.map((route) => (
            <CommandItem
              key={route.path}
              value={`go to ${route.label}`}
              onSelect={() => run(() => navigate(route.path))}
            >
              {route.label}
              <CommandShortcut>
                {modKeyLabel}
                {route.key}
              </CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
        {stories.length ? (
          <CommandGroup heading="User stories">
            {stories.slice(0, 50).map((story) => (
              <CommandItem
                key={story.id}
                value={`story US-${story.storyNumber} ${story.title}`}
                onSelect={() =>
                  run(() => {
                    navigate("/backlog")
                    selectBacklogStory(story.id)
                  })
                }
              >
                <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
                  US-{story.storyNumber}
                </span>
                <span className="min-w-0 truncate">{story.title}</span>
                <CommandShortcut className="tracking-normal">
                  {columnTitles.get(story.status) ?? story.status}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {quickChats.chats.length ? (
          <CommandGroup heading="Chats">
            {quickChats.chats.slice(0, 30).map((chat) => (
              <CommandItem
                key={chat.id}
                value={`chat ${chat.title} ${chat.id}`}
                onSelect={() =>
                  run(() => {
                    navigate("/chat")
                    quickChats.setActiveId(chat.id)
                    window.dispatchEvent(new Event(quickChatSelectedEvent))
                  })
                }
              >
                <MessageSquareIcon />
                <span className="min-w-0 truncate">{chat.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {recentProjects.length ? (
          <CommandGroup heading="Switch project">
            {recentProjects.slice(0, 8).map((project) => (
              <CommandItem
                key={project.path}
                value={`project ${project.name} ${project.path}`}
                onSelect={() => run(() => void projects.openProject(project.path))}
              >
                <FolderOpenIcon />
                <span className="min-w-0 truncate">{project.name}</span>
                <CommandShortcut className="max-w-48 truncate tracking-normal">
                  {project.path}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
      <div className="flex items-center gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
        <span>↑↓ to move</span>
        <span>↵ to open</span>
        <span>Esc to close</span>
      </div>
      </Command>
    </CommandDialog>
  )
}
