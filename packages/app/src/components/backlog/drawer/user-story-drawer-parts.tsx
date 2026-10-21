import type {
  DrawerAction,
  UserStoryDrawerMode,
  UserStoryDrawerTab,
} from "@/components/backlog/shared/backlog-types"
import type {
  UserStory,
  UserStoryDraft,
  UserStoryFileAttachment,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import {
  UserStoryTitleCloud,
} from "@/components/backlog/shared/user-story-title-cloud"
import { Input } from "@/components/ui/input"
import * as React from "react"
import { cn } from "@/lib/utils"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import type {
  UserStoryDiffStats,
} from "@/components/backlog/development/user-story-diff-stats"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DrawerSidebar } from "@/components/backlog/drawer/user-story-drawer-sidebar"
import type { ComposerDraft } from "@/components/backlog/drawer/composer-draft-storage"
import type {
  PendingCodeSelectionAttachment,
} from "@/components/backlog/shared/comment-attachment-events"

export const drawerSidebarStorageKey = "blame.app.user-story-drawer-sidebar-open.v1"

export type PendingComposerDraft = {
  draft: ComposerDraft
  key: string
}

export function initialDrawerTab(
  hasDevelopment: boolean,
  hasPreview: boolean,
  focusComment: boolean | undefined,
  initialTab: UserStoryDrawerTab
) {
  if (focusComment || !hasDevelopment) return "user-story"
  if (initialTab === "preview" && !hasPreview) return "user-story"
  return initialTab
}

export function DrawerHeaderTitle({
  mode,
  onTitleChange,
  title,
  titleGenerating,
  userStory,
}: {
  mode: UserStoryDrawerMode
  onTitleChange: (title: string) => void
  title: string
  titleGenerating?: boolean
  userStory?: UserStory
}) {
  return (
    <UserStoryTitleCloud active={titleGenerating} className="block w-full">
      <Input
        value={title}
        onChange={(event) => onTitleChange(event.currentTarget.value)}
        placeholder="User story title"
        readOnly={
          mode !== "create" &&
          userStory?.status !== "backlog" &&
          userStory?.status !== "discarded"
        }
        className="-mx-2 !h-auto rounded-md !border-transparent !bg-transparent px-2 py-1 font-heading !text-3xl leading-tight font-semibold shadow-none hover:!border-transparent focus:!border-transparent focus-visible:!border-transparent focus-visible:!ring-0 active:!border-transparent md:!text-3xl dark:!bg-transparent"
      />
    </UserStoryTitleCloud>
  )
}

export function DrawerBody({
  children,
  fixedSection,
  headerTabsVisible,
  resetKey,
  sidebarOpen,
}: {
  children: React.ReactNode
  fixedSection?: React.ReactNode
  headerTabsVisible: boolean
  resetKey: string
  sidebarOpen: boolean
}) {
  const fixedSectionRef = React.useRef<HTMLDivElement>(null)
  const [fixedSectionHeight, setFixedSectionHeight] = React.useState(0)
  const fixedSectionVisible = Boolean(fixedSection)
  const topPaddingClassName = headerTabsVisible ? "pt-36" : "pt-28"
  const contentClassName = sidebarOpen
    ? cn(
        "mx-auto flex max-w-5xl flex-col gap-6 px-6 lg:mx-0 lg:mr-[26rem]",
        topPaddingClassName
      )
    : cn("flex w-full flex-col gap-6 px-6", topPaddingClassName)
  const fixedSectionClassName = sidebarOpen
    ? "pointer-events-none absolute right-0 bottom-0 left-0 z-20 lg:right-[26rem]"
    : "pointer-events-none absolute right-0 bottom-0 left-0 z-20"
  const fixedSectionContentClassName = "w-full px-6"
  const bottomInset = Math.max(fixedSectionHeight, 24)

  React.useLayoutEffect(() => {
    const section = fixedSectionRef.current
    if (!section || !fixedSectionVisible) return

    const updateHeight = () => {
      const nextHeight = Math.ceil(section.getBoundingClientRect().height)
      setFixedSectionHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight
      )
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(section)
    return () => observer.disconnect()
  }, [fixedSectionVisible])

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <MessageScrollerProvider key={resetKey}>
        <MessageScroller className="h-full">
          <MessageScrollerViewport aria-label="User story details">
            <MessageScrollerContent
              className={contentClassName}
              role="group"
              style={{ paddingBottom: bottomInset }}
            >
              {children}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton
            className="right-6 z-30"
            style={{ bottom: bottomInset + 16 }}
          />
        </MessageScroller>
      </MessageScrollerProvider>
      {fixedSection ? (
        <div ref={fixedSectionRef} className={fixedSectionClassName}>
          <div className={fixedSectionContentClassName}>{fixedSection}</div>
        </div>
      ) : null}
    </div>
  )
}

export function DrawerSidebarIsland({
  diffStats,
  open,
  userStory,
}: {
  diffStats?: UserStoryDiffStats
  open: boolean
  userStory?: UserStory
}) {
  if (!open) return null

  return (
    <div className="absolute top-4 right-4 bottom-16 z-20 h-fit w-[min(20rem,calc(100%-2rem))] overflow-hidden rounded-xl bg-input/40 shadow-xl ring-1 shadow-black/10 ring-foreground/20 backdrop-blur-xl dark:bg-muted">
      <ScrollArea className="h-full min-h-0">
        <DrawerSidebar diffStats={diffStats} userStory={userStory} />
      </ScrollArea>
    </div>
  )
}

export function drawerComposerDraft(input: {
  comment: string
  commentCodeSelectionAttachments: ComposerDraft["codeSelectionAttachments"]
  commentFileAttachments: ComposerDraft["fileAttachments"]
  mode: UserStoryDrawerMode
  summary: string
  summaryCodeSelectionAttachments: ComposerDraft["codeSelectionAttachments"]
  summaryFileAttachments: ComposerDraft["fileAttachments"]
}): ComposerDraft {
  const createMode = input.mode === "create"
  return {
    markdown: createMode ? input.summary : input.comment,
    codeSelectionAttachments: createMode
      ? input.summaryCodeSelectionAttachments
      : input.commentCodeSelectionAttachments,
    fileAttachments: createMode
      ? input.summaryFileAttachments
      : input.commentFileAttachments,
  }
}

export function updatePendingDraftMarkdown(
  pendingDraftRef: React.RefObject<PendingComposerDraft | undefined>,
  enabled: boolean,
  markdown: string
) {
  const pendingDraft = pendingDraftRef.current
  if (!enabled || !pendingDraft) return
  pendingDraft.draft = { ...pendingDraft.draft, markdown }
}

export function createInput(
  action: DrawerAction,
  title: string,
  summary: string,
  codeSelectionAttachments: PendingCodeSelectionAttachment[],
  fileAttachments: UserStoryFileAttachment[] = []
): Omit<UserStoryDraft, "projectId"> {
  return {
    codeSelectionAttachments,
    fileAttachments,
    status: action === "Send to Dev Agent" ? "ready" : "backlog",
    summary,
    title: title.trim() || "Untitled user story",
  }
}

export function actionInput(
  action: DrawerAction,
  title: string,
  summary: string,
  codeSelectionAttachments: PendingCodeSelectionAttachment[],
  fileAttachments: UserStoryFileAttachment[]
): UserStoryUpdate {
  const base = {
    codeSelectionAttachments,
    fileAttachments,
    summary,
    title: title.trim() || "Untitled user story",
  }
  if (action === "Send to Dev Agent") return { ...base, status: "ready" }
  if (action === "Dequeue") return { status: "backlog" }
  if (action === "Stop Agent")
    return {
      agentStatus: null,
      discardedReason: "Stopped by user",
      status: "discarded",
    }
  if (action === "Request Changes")
    return { agentStatus: "Running", status: "in-progress" }
  if (action === "Reject")
    return { discardedReason: "Rejected during review", status: "discarded" }
  if (action === "Rework as Draft")
    return { discardedReason: null, status: "backlog" }
  return base
}

export function createdAtLabel(userStory?: UserStory) {
  if (!userStory?.createdAt) return "New draft"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(userStory.createdAt))
}

export function readSidebarOpen() {
  try {
    return (
      JSON.parse(localStorage.getItem(drawerSidebarStorageKey) ?? "false") ===
      true
    )
  } catch {
    return false
  }
}

export function isSendToDevAgentShortcut(event: KeyboardEvent) {
  return (
    event.key === "Enter" &&
    !event.repeat &&
    !event.altKey &&
    !event.shiftKey &&
    (event.ctrlKey || event.metaKey)
  )
}

export function mergeAttachments<T extends { id: string }>(current: T[], loaded: T[]) {
  const loadedIds = new Set(loaded.map((attachment) => attachment.id))
  const missing = loaded.filter(
    (attachment) => !current.some((item) => item.id === attachment.id)
  )
  if (!missing.length && current.every((item) => loadedIds.has(item.id))) {
    return current
  }
  return [...missing, ...current]
}
