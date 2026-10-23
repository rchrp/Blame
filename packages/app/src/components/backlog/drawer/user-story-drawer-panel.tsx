import * as React from "react"
import { toast } from "sonner"
import { mergeDraftSummary } from "@/components/backlog/data/user-story-context"
import {
  AppWindowIcon,
  BookOpenIcon,
  CodeIcon,
  Maximize2Icon,
  Minimize2Icon,
  XIcon,
} from "lucide-react"

import type {
  BacklogColumnId,
  UserStory,
  UserStoryComment,
  UserStoryDraft,
  UserStoryFileAttachment,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import type {
  RejectChoice,
  StopAgentChoice,
} from "@/components/backlog/actions/story-action-dialogs"
import { ColumnStatusBadge } from "@/components/backlog/shared/backlog-status-badge"
import type {
  DrawerAction,
  OpenDrawer,
  UserStoryDevelopmentTab,
  UserStoryDrawerMode,
  UserStoryDrawerTab,
} from "@/components/backlog/shared/backlog-types"
import { DevelopmentContent } from "@/components/backlog/drawer/user-story-development"
import {
  useDevelopmentWorkspace,
  type VcsFileDiff,
} from "@/components/backlog/development/development-workspace"
import {
  loadAgentRunDiffs,
  } from "@/components/chat/agent-run-diffs"
import { usePlatform } from "@/context/platform"
import type { UserStoryDiffStats } from "@/components/backlog/development/user-story-diff-stats"
import { DrawerActions } from "@/components/backlog/drawer/user-story-drawer-actions"
import {
  drawerActions,
  hasDevelopmentTab,
  normalizeDevelopmentTab,
} from "@/components/backlog/drawer/user-story-drawer-helpers"
import {
  UserStoryContent,
  UserStoryFixedSection,
} from "@/components/backlog/drawer/user-story-drawer-sections"
import type { AgentConversationUserMessageUndo } from "@/components/chat/agent-conversation"
import { UserStoryPreview } from "@/components/backlog/drawer/user-story-preview"
import {
  fileAttachment,
  pendingFileAttachments,
} from "@/components/backlog/drawer/user-story-attachment-files"
import {
  composerDraftStorageKey,
  readComposerDraft,
  removeComposerDraft,
  writeComposerDraft,
} from "@/components/backlog/drawer/composer-draft-storage"
import {
  codeSelectionAttachmentEvent,
  type CodeSelectionAttachment,
  type PendingCodeSelectionAttachment,
} from "@/components/backlog/shared/comment-attachment-events"
import { Button } from "@/components/ui/button"
import {
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  isBoolean,
  recallForItem,
  rememberForItem,
  useUiMemory,
} from "@/lib/ui-memory"
import { StoryStatsIsland } from "@/components/backlog/drawer/user-story-drawer-sidebar"
import { DirectStoryPreview } from "@/components/backlog/drawer/direct-story-preview"
import { StoryStatusGlow } from "@/components/backlog/drawer/story-status-glow"
import {
  DrawerResizeHandle,
  useStoryDrawerWidth,
} from "@/components/backlog/drawer/drawer-resize-handle"
import { useLatestCallback } from "@/lib/use-latest-callback"
import {
  queueComment,
  requestQueuedDelivery,
} from "@/pages/backlog/comment-queue"
import { readStoryRunMode, type StoryRunMode } from "@/lib/runtime-preference"
import { createUserStoryCommentSubmission } from "./user-story-comment-submission"
import {
  actionInput,
  createdAtLabel,
  createInput,
  DrawerBody,
  drawerComposerDraft,
  DrawerHeaderTitle,
  initialDrawerTab,
  isSendToDevAgentShortcut,
  mergeAttachments,
  type PendingComposerDraft,
  updatePendingDraftMarkdown,
} from "./user-story-drawer-parts"
const composerDraftPersistDelayMs = 500
const drawerHeaderSoftBlurMask = {
  maskImage:
    "linear-gradient(to bottom, black 0%, black 60%, transparent 100%)",
  WebkitMaskImage:
    "linear-gradient(to bottom, black 0%, black 60%, transparent 100%)",
} satisfies React.CSSProperties
const drawerHeaderStrongBlurMask = {
  maskImage: "linear-gradient(to bottom, black 0%, transparent 72%)",
  WebkitMaskImage: "linear-gradient(to bottom, black 0%, transparent 72%)",
} satisfies React.CSSProperties

export function UserStoryDrawerPanel({
  diffStats,
  focusComment,
  initialDevelopmentTab,
  initialDraft,
  initialTab,
  mode,
  open,
  onCancel,
  onApproveAndMerge,
  onCreateUserStory,
  onCreateUserStoryComment,
  onDeleteUserStory,
  onOpenDrawer,
  onOptimizeUserStory,
  onRequestChanges,
  onReject,
  onStopAgent,
  onUndoUserStoryComment,
  onUpdateUserStory,
  reviewDiffEmpty,
  setupInitializing,
  status,
  titleGenerating,
  userStory,
}: {
  diffStats?: UserStoryDiffStats
  focusComment?: boolean
  initialDevelopmentTab: UserStoryDevelopmentTab
  initialDraft?: Partial<Omit<UserStoryDraft, "projectId">>
  initialTab: UserStoryDrawerTab
  mode: UserStoryDrawerMode
  open: boolean
  onCancel: () => void
  onApproveAndMerge: (story: UserStory) => Promise<UserStory>
  onCreateUserStory: (
    input: Omit<UserStoryDraft, "projectId">
  ) => Promise<UserStory>
  onCreateUserStoryComment: (
    story: UserStory,
    input: Pick<
      UserStoryComment,
      "body" | "codeSelectionAttachments" | "fileAttachments"
    >
  ) => Promise<UserStoryComment>
  onDeleteUserStory: (story: UserStory) => Promise<void>
  onOpenDrawer: OpenDrawer
  onOptimizeUserStory?: (input: {
    summary: string
    title: string
  }) => Promise<string>
  onRequestChanges: (
    story: UserStory,
    feedback: string,
    commentId: string,
    codeSelectionAttachments: UserStoryComment["codeSelectionAttachments"],
    fileAttachments: UserStoryComment["fileAttachments"]
  ) => Promise<UserStory | undefined>
  onReject: (story: UserStory, choice: RejectChoice) => Promise<UserStory>
  onStopAgent: (story: UserStory, choice: StopAgentChoice) => Promise<UserStory>
  onUndoUserStoryComment: (
    story: UserStory,
    target: AgentConversationUserMessageUndo
  ) => Promise<UserStory>
  onUpdateUserStory: (
    story: UserStory,
    input: UserStoryUpdate
  ) => Promise<UserStory>
  reviewDiffEmpty?: boolean
  setupInitializing?: boolean
  status: BacklogColumnId
  titleGenerating?: boolean
  userStory?: UserStory
}) {
  const draftStorageKey = composerDraftStorageKey(
    userStory?.projectId ?? "project",
    "backlog",
    userStory?.id
  )
  const storedDraft = React.useMemo(
    () => readComposerDraft(localStorage, draftStorageKey),
    [draftStorageKey]
  )
  const hasDevelopment = hasDevelopmentTab(status)
  // Direct stories run in the project folder without a managed preview.
  const hasPreview = status === "in-progress" || status === "in-review"
  // A story working in the project folder previews the project's own app.
  const directPreview = userStory?.workspaceMode === "direct"
  const sidebarAvailable = Boolean(
    mode !== "create" && (userStory?.clineSessionId || userStory?.agentUsage)
  )
  // Opening a story on its default tab brings back the tab it was left on.
  const [rememberedTabs] = React.useState(() =>
    mode !== "create" && userStory && initialTab === "user-story" && !focusComment
      ? recallForItem(drawerTabsMemoryKey, userStory.id, isRememberedDrawerTabs)
      : undefined
  )
  const [tabChoice, setTab] = React.useState<UserStoryDrawerTab>(
    initialDrawerTab(
      hasDevelopment,
      hasPreview,
      focusComment,
      rememberedTabs?.tab ?? initialTab
    )
  )
  const [developmentTabChoice, setDevelopmentTab] =
    React.useState<UserStoryDevelopmentTab>(
      normalizeDevelopmentTab(
        status,
        rememberedTabs?.developmentTab ?? initialDevelopmentTab
      )
    )
  // The drawer stays open while the story changes status: a tab the new
  // status does not have falls back to the story.
  const tab = initialDrawerTab(hasDevelopment, hasPreview, false, tabChoice)
  const developmentTab = normalizeDevelopmentTab(status, developmentTabChoice)
  const drawerWidth = useStoryDrawerWidth()
  const rememberedStoryId = mode === "create" ? undefined : userStory?.id
  React.useEffect(() => {
    if (!rememberedStoryId) return
    rememberForItem(drawerTabsMemoryKey, rememberedStoryId, {
      developmentTab,
      tab,
    })
  }, [developmentTab, rememberedStoryId, tab])
  const [summaryCodeSelectionAttachments, setSummaryCodeSelectionAttachments] =
    React.useState<PendingCodeSelectionAttachment[]>(
      mode === "create"
        ? (storedDraft?.codeSelectionAttachments ??
            initialDraft?.codeSelectionAttachments ??
            [])
        : (userStory?.codeSelectionAttachments ?? [])
    )
  const [summaryFileAttachments, setSummaryFileAttachments] = React.useState<
    UserStoryFileAttachment[]
  >(
    mode === "create"
      ? (storedDraft?.fileAttachments ?? initialDraft?.fileAttachments ?? [])
      : (userStory?.fileAttachments ?? [])
  )
  const [commentCodeSelectionAttachments, setCommentCodeSelectionAttachments] =
    React.useState<PendingCodeSelectionAttachment[]>(
      mode === "create" ? [] : (storedDraft?.codeSelectionAttachments ?? [])
    )
  const [commentFileAttachments, setCommentFileAttachments] = React.useState<
    UserStoryFileAttachment[]
  >(mode === "create" ? [] : (storedDraft?.fileAttachments ?? []))
  const [commentEditorKey, setCommentEditorKey] = React.useState(0)
  const [developmentFileTarget, setDevelopmentFileTarget] = React.useState<{
    diffs?: VcsFileDiff[]
    id: string
    path: string
  }>()
  const developmentWorkspace = useDevelopmentWorkspace(
    userStory,
    false,
    tab === "development"
  )
  const developmentWorkspaceRoot = developmentWorkspace.root
  const platform = usePlatform()
  const loadChangedFileDiffs = React.useCallback(
    (sessionId: string, checkpointRunCount: number, diffEndRef: string) => {
      if (!developmentWorkspaceRoot) return Promise.resolve([])
      return loadAgentRunDiffs({
        checkpointRunCount,
        diffEndRef,
        platform,
        root: developmentWorkspaceRoot,
        sessionId,
      })
    },
    [developmentWorkspaceRoot, platform]
  )
  const [pendingAction, setPendingAction] = React.useState<DrawerAction>()
  const [runMode, setRunMode] = React.useState<StoryRunMode | null>(
    userStory?.runMode ?? null
  )
  const [commentSubmission] = React.useState(createUserStoryCommentSubmission)
  // The stats panel opens in full; it can fold into a small pill.
  const [statsExpanded, setStatsExpanded] = useUiMemory(
    "story-drawer.stats-expanded",
    true,
    isBoolean
  )
  const titleDraftKey = `${draftStorageKey}:title`
  const [title, setTitle] = React.useState(
    mode === "create"
      ? (readTitleDraft(titleDraftKey) ?? initialDraft?.title ?? "")
      : (userStory?.title ?? "")
  )
  const [summary, setSummary] = React.useState(
    mode === "create"
      ? mergeDraftSummary(storedDraft?.markdown, initialDraft?.summary)
      : (userStory?.summary ?? "")
  )
  const [comment, setComment] = React.useState(
    mode === "create" ? "" : (storedDraft?.markdown ?? "")
  )
  const summaryValueRef = React.useRef(summary)
  const commentValueRef = React.useRef(comment)
  const summaryRef = React.useRef<HTMLDivElement>(null)
  const commentRef = React.useRef<HTMLDivElement>(null)
  const pendingComposerDraftRef = React.useRef<
    PendingComposerDraft | undefined
  >(undefined)
  const composerDraftRemovedRef = React.useRef(false)

  // A new story's title survives closing the drawer, like its description.
  React.useEffect(() => {
    if (mode !== "create") return
    const timer = window.setTimeout(() => {
      try {
        if (title.trim()) localStorage.setItem(titleDraftKey, title)
        else localStorage.removeItem(titleDraftKey)
      } catch {
        return
      }
    }, composerDraftPersistDelayMs)
    return () => window.clearTimeout(timer)
  }, [mode, title, titleDraftKey])

  React.useEffect(() => {
    const draft = drawerComposerDraft({
      comment,
      commentCodeSelectionAttachments,
      commentFileAttachments,
      mode,
      summary,
      summaryCodeSelectionAttachments,
      summaryFileAttachments,
    })
    pendingComposerDraftRef.current = { draft, key: draftStorageKey }
    composerDraftRemovedRef.current = false
    const timer = window.setTimeout(() => {
      writeComposerDraft(localStorage, draftStorageKey, draft)
    }, composerDraftPersistDelayMs)
    return () => window.clearTimeout(timer)
  }, [
    comment,
    commentCodeSelectionAttachments,
    commentFileAttachments,
    draftStorageKey,
    mode,
    summary,
    summaryCodeSelectionAttachments,
    summaryFileAttachments,
  ])

  React.useEffect(
    () => () => {
      const pending = pendingComposerDraftRef.current
      if (!pending || composerDraftRemovedRef.current) return
      writeComposerDraft(localStorage, pending.key, pending.draft)
    },
    []
  )

  React.useEffect(() => {
    if (!focusComment) return
    const frame = requestAnimationFrame(() => {
      commentRef.current
        ?.querySelector<HTMLElement>("[data-markdown-editor-input='true']")
        ?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [focusComment])

  React.useEffect(() => {
    if (mode === "create") return
    if (!titleGenerating) return
    const frame = requestAnimationFrame(() => setTitle(userStory?.title ?? ""))
    return () => cancelAnimationFrame(frame)
  }, [mode, titleGenerating, userStory?.title])

  React.useEffect(() => {
    if (mode === "create") return
    const frame = requestAnimationFrame(() => {
      setSummaryCodeSelectionAttachments((current) =>
        mergeAttachments(current, userStory?.codeSelectionAttachments ?? [])
      )
      setSummaryFileAttachments((current) =>
        mergeAttachments(current, userStory?.fileAttachments ?? [])
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [mode, userStory?.codeSelectionAttachments, userStory?.fileAttachments])

  React.useEffect(() => {
    const sendToDevAgentAvailable = drawerActions(mode, status).includes(
      "Send to Dev Agent"
    )
    if (!open || !sendToDevAgentAvailable) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isSendToDevAgentShortcut(event)) return
      event.preventDefault()
      void handleAction("Send to Dev Agent")
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  })

  React.useEffect(() => {
    const addCodeSelectionAttachment = (event: Event) => {
      const targetSummary = status === "backlog" || status === "ready"
      const updateAttachments = targetSummary
        ? setSummaryCodeSelectionAttachments
        : setCommentCodeSelectionAttachments
      const targetRef = targetSummary ? summaryRef : commentRef
      setTab("user-story")
      updateAttachments((current) => [
        ...current,
        {
          ...(event as CustomEvent<CodeSelectionAttachment>).detail,
          id: crypto.randomUUID(),
        },
      ])
      requestAnimationFrame(() => {
        targetRef.current
          ?.querySelector<HTMLElement>("[data-markdown-editor-input='true']")
          ?.focus()
      })
    }
    window.addEventListener(
      codeSelectionAttachmentEvent,
      addCodeSelectionAttachment
    )
    return () => {
      window.removeEventListener(
        codeSelectionAttachmentEvent,
        addCodeSelectionAttachment
      )
    }
  }, [status])

  const pendingSummaryFileAttachments = React.useMemo(
    () => pendingFileAttachments(summaryFileAttachments),
    [summaryFileAttachments]
  )
  const pendingCommentFileAttachments = React.useMemo(
    () => pendingFileAttachments(commentFileAttachments),
    [commentFileAttachments]
  )
  const removeSummaryCodeSelectionAttachment = React.useCallback(
    (id: string) =>
      setSummaryCodeSelectionAttachments((current) =>
        current.filter((attachment) => attachment.id !== id)
      ),
    []
  )
  const removeSummaryFileAttachment = React.useCallback(
    (id: string) =>
      setSummaryFileAttachments((current) =>
        current.filter((attachment) => attachment.id !== id)
      ),
    []
  )
  const addSummaryFileAttachments = React.useCallback(
    (attachments: UserStoryFileAttachment[]) =>
      setSummaryFileAttachments((current) => [...current, ...attachments]),
    []
  )
  const removeCommentCodeSelectionAttachment = React.useCallback(
    (id: string) =>
      setCommentCodeSelectionAttachments((current) =>
        current.filter((attachment) => attachment.id !== id)
      ),
    []
  )
  const removeCommentFileAttachment = React.useCallback(
    (id: string) =>
      setCommentFileAttachments((current) =>
        current.filter((attachment) => attachment.id !== id)
      ),
    []
  )
  const addCommentFileAttachments = React.useCallback(
    (attachments: UserStoryFileAttachment[]) =>
      setCommentFileAttachments((current) => [...current, ...attachments]),
    []
  )
  const handleSummaryChange = React.useCallback(
    (nextSummary: string) => {
      summaryValueRef.current = nextSummary
      updatePendingDraftMarkdown(
        pendingComposerDraftRef,
        mode === "create",
        nextSummary
      )
      setSummary(nextSummary)
    },
    [mode]
  )
  const handleCommentChange = React.useCallback(
    (nextComment: string) => {
      commentValueRef.current = nextComment
      updatePendingDraftMarkdown(
        pendingComposerDraftRef,
        mode !== "create",
        nextComment
      )
      setComment(nextComment)
    },
    [mode]
  )
  const handleDrawerAction = useLatestCallback((action: DrawerAction) => {
    void handleAction(action)
  })
  const handleCommentSubmit = useLatestCallback(() => {
    void submitComment()
  })
  // ⌘↵ while the agent works: queue the comment and send it right away.
  const handleCommentSendNow = useLatestCallback(() => {
    void submitComment(true)
  })
  const handleCommentUndo = useLatestCallback(undoCommentMessage)
  const handleOpenDevelopmentFile = useLatestCallback(openDevelopmentFile)
  const handleOpenDevelopmentDiff = useLatestCallback(openDevelopmentDiff)
  const handlePreviewRunConfigurationChange = useLatestCallback(
    (runConfigurationId: string, previewUrl?: string) => {
      if (!userStory) return
      void onUpdateUserStory(userStory, {
        previewUrl: previewUrl ?? null,
        runConfigurationId,
      })
    }
  )
  const handlePreviewCapture = useLatestCallback((file: File) => {
    void addPreviewCaptureAttachment(file)
    setTab("user-story")
    requestAnimationFrame(() => {
      commentRef.current
        ?.querySelector<HTMLElement>("[data-markdown-editor-input='true']")
        ?.focus()
    })
  })
  const handleSummaryOptimize = useLatestCallback((nextSummary: string) =>
    onOptimizeUserStory
      ? onOptimizeUserStory({ summary: nextSummary, title })
      : Promise.resolve(nextSummary)
  )
  const drawerActionButtons = React.useMemo(
    () => (
      <DrawerActions
        loadingAction={pendingAction}
        mode={mode}
        status={status}
        onAction={handleDrawerAction}
        onDeleteUserStory={onDeleteUserStory}
        onOpenDrawer={onOpenDrawer}
        onReject={onReject}
        reviewDiffEmpty={reviewDiffEmpty}
        onStopAgent={onStopAgent}
        story={userStory}
      />
    ),
    [
      handleDrawerAction,
      mode,
      onDeleteUserStory,
      onOpenDrawer,
      onReject,
      onStopAgent,
      pendingAction,
      reviewDiffEmpty,
      status,
      userStory,
    ]
  )

  return (
    <DrawerContent
      className="inset-y-2 right-2 h-[calc(100svh-1rem)] overflow-hidden rounded-xl border bg-[oklch(1_0_0)] text-foreground data-[vaul-drawer-direction=right]:w-[min(var(--story-drawer-width,90rem),calc(100vw-1rem))] data-[vaul-drawer-direction=right]:sm:max-w-none dark:bg-[oklch(0.16_0_0)]"
      style={drawerWidth.style}
    >
      <DrawerResizeHandle onWidthChange={drawerWidth.setWidth} />
      {mode !== "create" ? <StoryStatusGlow status={status} /> : null}
      {tab === "user-story" && sidebarAvailable && (
        <Button
          type="button"
          className="absolute top-6 right-16 z-30 border bg-background/90 shadow-sm"
          size="icon-sm"
          variant="outline"
          onClick={() => setStatsExpanded((expanded) => !expanded)}
          aria-label={
            statsExpanded ? "Minimize agent stats" : "Show agent stats"
          }
          title={statsExpanded ? "Minimize" : "Expand"}
        >
          {statsExpanded ? <Minimize2Icon /> : <Maximize2Icon />}
        </Button>
      )}
      <DrawerClose asChild>
        <Button
          className="absolute top-6 right-6 z-30 border bg-background/90 shadow-sm"
          size="icon-sm"
          variant="outline"
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
      </DrawerClose>
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as UserStoryDrawerTab)}
        className="relative min-h-0 flex-1 gap-0 overflow-hidden"
      >
        <DrawerHeader
          className={cn(
            // The blur spans the whole width, under the stats panel too;
            // only the title and tabs keep clear of it.
            "absolute top-0 right-0 left-0 isolate z-[15] gap-4 overflow-hidden px-6 pt-6 pr-14 pb-6 transition-[padding] duration-500 ease-out",
            // Lined up with the story's thread (px-8), clear of the panel.
            tab === "user-story" && "pl-8",
            tab === "user-story" &&
              sidebarAvailable &&
              (statsExpanded ? "lg:pr-[23rem]" : "pr-[14.5rem]")
          )}
        >
          <div
            className="absolute inset-0 -z-10 bg-popover/20 backdrop-blur-sm"
            style={drawerHeaderSoftBlurMask}
          />
          <div
            className="absolute inset-0 -z-10 bg-popover/20 backdrop-blur-2xl backdrop-saturate-150"
            style={drawerHeaderStrongBlurMask}
          />
          <div className="min-w-0 flex-1">
            <DrawerTitle asChild>
              <DrawerHeaderTitle
                mode={mode}
                title={title}
                titleGenerating={titleGenerating}
                userStory={userStory}
                onTitleChange={setTitle}
              />
            </DrawerTitle>
            <DrawerDescription asChild>
              <div className="flex flex-wrap items-center gap-2">
                <ColumnStatusBadge status={status} />
                <span>{userStory?.owner ?? "Product"} created this</span>
                <span>{createdAtLabel(userStory)}</span>
              </div>
            </DrawerDescription>
          </div>
          {hasDevelopment && (
            <TabsList className="mt-2 min-w-100">
              <TabsTrigger value="user-story">
                <BookOpenIcon />
                User Story
              </TabsTrigger>
              {hasPreview && (
                <TabsTrigger value="preview">
                  <AppWindowIcon />
                  Preview
                </TabsTrigger>
              )}
              <TabsTrigger value="development">
                <CodeIcon />
                Code
              </TabsTrigger>
            </TabsList>
          )}
        </DrawerHeader>
        <TabsContent value="user-story" className="min-h-0 overflow-hidden">
          <DrawerBody
            resetKey={userStory?.id ?? mode}
            fixedSection={
              <UserStoryFixedSection
                actions={drawerActionButtons}
                commentCodeSelectionAttachments={
                  commentCodeSelectionAttachments
                }
                commentFileAttachments={pendingCommentFileAttachments}
                comment={comment}
                commentEditorKey={commentEditorKey}
                commentRef={commentRef}
                commentSubmitting={pendingAction === "Request Changes"}
                mode={mode}
                onCommentChange={handleCommentChange}
                onCommentCodeSelectionAttachmentRemove={
                  removeCommentCodeSelectionAttachment
                }
                onCommentFileAttachmentRemove={removeCommentFileAttachment}
                onCommentFileAttachmentsAdd={addCommentFileAttachments}
                onCommentSubmit={handleCommentSubmit}
                onCommentSendNow={handleCommentSendNow}
                onAgentPause={
                  userStory
                    ? () => void onStopAgent(userStory, "pause")
                    : undefined
                }
                onFileLinkClick={handleOpenDevelopmentFile}
                status={status}
                userStory={userStory}
              />
            }
            headerTabsVisible={hasDevelopment}
            sidebarOpen={sidebarAvailable && statsExpanded}
          >
            <UserStoryContent
              loadChangedFileDiffs={loadChangedFileDiffs}
              mode={mode}
              onCommentUndo={handleCommentUndo}
              onSummaryCodeSelectionAttachmentRemove={
                removeSummaryCodeSelectionAttachment
              }
              onSummaryFileAttachmentRemove={removeSummaryFileAttachment}
              onSummaryFileAttachmentsAdd={addSummaryFileAttachments}
              onSummaryChange={handleSummaryChange}
              onSummaryOptimize={
                onOptimizeUserStory ? handleSummaryOptimize : undefined
              }
              onFileLinkClick={handleOpenDevelopmentFile}
              onChangedFileClick={handleOpenDevelopmentDiff}
              onRunModeChange={changeRunMode}
              runMode={runMode}
              status={status}
              summary={summary}
              summaryCodeSelectionAttachments={summaryCodeSelectionAttachments}
              summaryFileAttachments={pendingSummaryFileAttachments}
              summaryRef={summaryRef}
              userStory={userStory}
            />
          </DrawerBody>
        </TabsContent>
        {hasPreview && (
          <TabsContent
            forceMount
            value="preview"
            className={cn(
              "min-h-0 overflow-hidden",
              tab !== "preview" && "hidden",
              hasDevelopment ? "pt-36" : "pt-28"
            )}
          >
            {directPreview ? (
              <DirectStoryPreview
                visible={tab === "preview"}
                onCapture={handlePreviewCapture}
              />
            ) : (
              <UserStoryPreview
                setupInitializing={setupInitializing}
                userStory={userStory}
                visible={tab === "preview"}
                onRunConfigurationChange={handlePreviewRunConfigurationChange}
                onCapture={handlePreviewCapture}
              />
            )}
          </TabsContent>
        )}
        {hasDevelopment && (
          <TabsContent
            value="development"
            className="min-h-0 overflow-hidden pt-36"
          >
            <DevelopmentContent
              key={developmentFileTarget?.id ?? "development"}
              diffStats={diffStats}
              initialDiffPath={
                developmentTab === "diff"
                  ? developmentFileTarget?.path
                  : undefined
              }
              initialFilePath={developmentFileTarget?.path}
              selectedDiffs={developmentFileTarget?.diffs}
              status={status}
              tab={developmentTab}
              userStory={userStory}
              onTabChange={setDevelopmentTab}
            />
          </TabsContent>
        )}
      </Tabs>
      {tab === "user-story" && sidebarAvailable && (
        <StoryStatsIsland
          diffStats={diffStats}
          expanded={statsExpanded}
          userStory={userStory}
          onExpand={() => setStatsExpanded(true)}
        />
      )}
      {tab !== "user-story" && (
        <div className="pointer-events-none absolute right-4 bottom-4 z-20 p-0">
          {drawerActionButtons}
        </div>
      )}
    </DrawerContent>
  )

  // Applies right away to an existing story; a new one takes it on create.
  function changeRunMode(next: StoryRunMode) {
    setRunMode(next)
    if (mode !== "create" && userStory)
      void onUpdateUserStory(userStory, { runMode: next })
  }

  async function handleAction(action: DrawerAction) {
    if (pendingAction || commentSubmission.pending) return
    if (action === "Close") return onCancel()
    if (action === "Discard") return discardUserStory()
    if (action === "Request Changes") return submitComment()
    setPendingAction(action)
    try {
      if (mode === "create") {
        await onCreateUserStory({
          ...createInput(
            action,
            title,
            summaryValueRef.current,
            summaryCodeSelectionAttachments,
            summaryFileAttachments
          ),
          runMode: runMode ?? readStoryRunMode(),
        })
        clearComposerDraft()
      }
      if (mode !== "create" && userStory) {
        if (action === "Approve & Merge") {
          await onApproveAndMerge(userStory)
        } else {
          await onUpdateUserStory(
            userStory,
            actionInput(
              action,
              title,
              summaryValueRef.current,
              summaryCodeSelectionAttachments,
              summaryFileAttachments
            )
          )
        }
      }
      // The drawer stays open on the story as it moves on.
    } finally {
      setPendingAction(undefined)
    }
  }

  async function discardUserStory() {
    if (!userStory) return onCancel()
    setPendingAction("Discard")
    try {
      await onDeleteUserStory(userStory)
      onCancel()
    } finally {
      setPendingAction(undefined)
    }
  }

  function openDevelopmentFile(path: string) {
    setDevelopmentFileTarget({ id: crypto.randomUUID(), path })
    setDevelopmentTab("files")
    setTab("development")
  }

  function openDevelopmentDiff(path: string, diffs: VcsFileDiff[]) {
    setDevelopmentFileTarget({ diffs, id: crypto.randomUUID(), path })
    setDevelopmentTab("diff")
    setTab("development")
  }

  async function addPreviewCaptureAttachment(file: File) {
    const attachment = await fileAttachment(file)
    setCommentFileAttachments((current) => [...current, attachment])
  }

  async function submitComment(sendNow = false) {
    if (!userStory || pendingAction || commentSubmission.pending) return
    const hasCommentAttachments =
      commentCodeSelectionAttachments.length > 0 ||
      commentFileAttachments.length > 0
    const currentComment = commentValueRef.current
    const body =
      currentComment.trim() || (hasCommentAttachments ? "Attached files." : "")
    if (!body && !hasCommentAttachments) return
    // The agent is working: the comment waits for it (or "Send now").
    if (status === "in-progress" && userStory.agentStatus === "Running") {
      const queued = queueComment({
        body,
        codeSelectionAttachments: commentCodeSelectionAttachments,
        fileAttachments: commentFileAttachments,
        storyId: userStory.id,
      })
      if (sendNow) requestQueuedDelivery(userStory.id, queued.id)
      clearComposerDraft()
      commentValueRef.current = ""
      setComment("")
      setCommentCodeSelectionAttachments([])
      setCommentFileAttachments([])
      setCommentEditorKey((key) => key + 1)
      return
    }
    setPendingAction("Request Changes")
    try {
      const submitted = await commentSubmission.submit({
        story: userStory,
        input: {
          body,
          codeSelectionAttachments: commentCodeSelectionAttachments,
          fileAttachments: commentFileAttachments,
        },
        createComment: (input) => onCreateUserStoryComment(userStory, input),
        requestChanges: (createdComment) =>
          onRequestChanges(
            userStory,
            body,
            createdComment.id,
            createdComment.codeSelectionAttachments,
            createdComment.fileAttachments
          ),
      })
      if (!submitted) return
      clearComposerDraft()
      commentValueRef.current = ""
      setComment("")
      setCommentCodeSelectionAttachments([])
      setCommentFileAttachments([])
      setCommentEditorKey((key) => key + 1)
    } catch (error) {
      toast.error("Unable to send comment", {
        description: error instanceof Error ? error.message : String(error),
        position: "bottom-right",
      })
    } finally {
      setPendingAction(undefined)
    }
  }

  function clearComposerDraft() {
    composerDraftRemovedRef.current = true
    removeComposerDraft(localStorage, draftStorageKey)
    try {
      localStorage.removeItem(titleDraftKey)
    } catch {
      return
    }
  }

  async function undoCommentMessage(target: AgentConversationUserMessageUndo) {
    if (!userStory) return
    const comment = target.comment
    await onUndoUserStoryComment(userStory, target)
    commentValueRef.current = comment.body
    setComment(comment.body)
    setCommentCodeSelectionAttachments(comment.codeSelectionAttachments ?? [])
    setCommentFileAttachments(comment.fileAttachments ?? [])
    setCommentEditorKey((key) => key + 1)
    setTab("user-story")
    requestAnimationFrame(() => {
      commentRef.current
        ?.querySelector<HTMLElement>("[data-markdown-editor-input='true']")
        ?.focus()
    })
  }
}

function readTitleDraft(key: string) {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

const drawerTabsMemoryKey = "story-drawer-tabs"
const drawerTabs = new Set<string>(["user-story", "preview", "development"])
const developmentTabs = new Set<string>(["files", "diff", "terminal"])

function isRememberedDrawerTabs(value: unknown): value is {
  developmentTab: UserStoryDevelopmentTab
  tab: UserStoryDrawerTab
} {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    typeof record.tab === "string" &&
    drawerTabs.has(record.tab) &&
    typeof record.developmentTab === "string" &&
    developmentTabs.has(record.developmentTab)
  )
}
