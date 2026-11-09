import {
  saveStoryContextLimit,
  storyContextLimit,
} from "@/components/backlog/data/story-context-limit"
import { replaceFileAttachments } from "./user-story-attachment-files"
import * as React from "react"
import type { PullRequestAvailability } from "@blame/agent-runtime"
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
import { PullRequestLink } from "@/components/backlog/drawer/pull-request-link"
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
  isEditable,
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
} from "@/components/backlog/drawer/composer-draft-storage"
import {
  readTitleDraft,
  useDrawerComposerDraft,
} from "@/components/backlog/drawer/use-drawer-composer-draft"
import {
  recallDrawerTabs,
  useDrawerTabMemory,
} from "@/components/backlog/drawer/use-drawer-tab-memory"
import {
  type CodeSelectionAttachment,
  type PendingCodeSelectionAttachment,
} from "@/components/backlog/shared/comment-attachment-events"
import { storyAcceptsExcerpts } from "@/components/backlog/shared/excerpt-model"
import { ExcerptTargetProvider } from "@/components/backlog/shared/selection-excerpt-actions"
import { Button } from "@/components/ui/button"
import {
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs"
import { SlidingTabsList, slidingTabsTrigger, TabReadyIcon } from "@/components/backlog/drawer/sliding-tabs-list"
import { cn } from "@/lib/utils"
import { isBoolean, useUiMemory } from "@/lib/ui-memory"
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
import type { Ambition } from "@/lib/personalization"
import { createUserStoryCommentSubmission } from "./user-story-comment-submission"
import {
  actionInput,
  createdAtLabel,
  createInput,
  DrawerBody,
  drawerHeaderSoftBlurMask,
  drawerHeaderStrongBlurMask,
  DrawerHeaderTitle,
  initialDrawerTab,
  isSendToDevAgentShortcut,
  mergeAttachments,
  updatePendingDraftMarkdown,
} from "./user-story-drawer-parts"

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
  onCheckPullRequest,
  onCreateUserStory,
  onCreateUserStoryComment,
  onDeleteUserStory,
  onOpenDrawer,
  onOpenPullRequest,
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
  onApproveAndMerge: (
    story: UserStory,
    options?: { push?: boolean }
  ) => Promise<UserStory>
  onCheckPullRequest?: () => Promise<PullRequestAvailability>
  onCreateUserStory: (
    input: Omit<UserStoryDraft, "projectId">,
    contextLimit?: number
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
  onOpenPullRequest: (story: UserStory) => Promise<UserStory>
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
  const summaryEditable = isEditable(mode, status, userStory)
  // Direct stories run in the project folder without a managed preview.
  const hasPreview = status === "in-progress" || status === "in-review"
  // A story working in the project folder previews the project's own app.
  const directPreview = userStory?.workspaceMode === "direct"
  const statsExpandable = Boolean(
    mode !== "create" &&
      status !== "backlog" &&
      (status === "in-progress" || userStory?.clineSessionId || userStory?.agentUsage)
  )
  // Opening a story on its default tab brings back the tab it was left on.
  const [rememberedTabs] = React.useState(() =>
    mode !== "create" && userStory && initialTab === "user-story" && !focusComment
      ? recallDrawerTabs(userStory.id)
      : undefined
  )
  const [previewReady, setPreviewReady] = React.useState(false)
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
  // The native preview is drawn above the page, so it cannot follow the
  // drawer's closing slide: it is hidden as soon as the drawer starts closing.
  const previewVisible = open && tab === "preview"
  const drawerWidth = useStoryDrawerWidth()
  const rememberedStoryId = mode === "create" ? undefined : userStory?.id
  useDrawerTabMemory(rememberedStoryId, tab, developmentTab)
  const [summaryCodeSelectionAttachments, setSummaryCodeSelectionAttachments] =
    React.useState<PendingCodeSelectionAttachment[]>(
      mode === "create"
        ? // An excerpt sent to a new story joins the draft already started.
          mergeAttachments(
            storedDraft?.codeSelectionAttachments ?? [],
            initialDraft?.codeSelectionAttachments ?? []
          )
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
  const [targetBranch, setTargetBranch] = React.useState<string | null>(
    userStory?.targetBranch ?? null
  )
  const [ambition, setAmbition] = React.useState<Ambition | null>(
    userStory?.ambition ?? null
  )
  const [commentSubmission] = React.useState(createUserStoryCommentSubmission)
  // The stats panel opens in full; it can fold into a small pill.
  const [statsExpanded, setStatsExpanded] = useUiMemory(
    "story-drawer.stats-expanded",
    true,
    isBoolean
  )
  const statsShownExpanded = statsExpandable && statsExpanded
  const contextLimitKey = userStory?.id ?? draftStorageKey
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
  const syncedStoryTitleRef = React.useRef(userStory?.title ?? "")
  const commentValueRef = React.useRef(comment)
  const hasCommentDraft = Boolean(
    comment.trim() ||
      commentCodeSelectionAttachments.length ||
      commentFileAttachments.length
  )
  const summaryRef = React.useRef<HTMLDivElement>(null)
  const commentRef = React.useRef<HTMLDivElement>(null)
  const { clearComposerDraft, pendingComposerDraftRef } =
    useDrawerComposerDraft({
      comment,
      commentCodeSelectionAttachments,
      commentFileAttachments,
      draftStorageKey,
      mode,
      summary,
      summaryCodeSelectionAttachments,
      summaryFileAttachments,
      title,
      titleDraftKey,
    })

  React.useEffect(() => {
    if (!focusComment) return
    const frame = requestAnimationFrame(() => {
      const target = commentRef.current ?? summaryRef.current
      target
        ?.querySelector<HTMLElement>("[data-markdown-editor-input='true']")
        ?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [focusComment])

  React.useEffect(() => {
    if (mode === "create") return
    const storyTitle = userStory?.title ?? ""
    // A title that changes behind the drawer (generated, renamed elsewhere)
    // replaces the one shown, unless the user has typed their own.
    const frame = requestAnimationFrame(() => {
      const previousStoryTitle = syncedStoryTitleRef.current
      syncedStoryTitleRef.current = storyTitle
      setTitle((current) =>
        titleGenerating || current === previousStoryTitle ? storyTitle : current
      )
    })
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
    const requestChangesAvailable =
      mode !== "create" && status === "in-review" && hasCommentDraft
    if (!open || (!sendToDevAgentAvailable && !requestChangesAvailable)) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !isSendToDevAgentShortcut(event)) return
      event.preventDefault()
      void handleAction(requestChangesAvailable ? "Request Changes" : "Send to Dev Agent")
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  })

  // An excerpt goes to the request while the story has no conversation yet,
  // to the next comment once it has one.
  const attachExcerptAsContext = React.useCallback(
    (excerpt: CodeSelectionAttachment) => {
      const targetSummary = summaryEditable || status === "ready"
      const updateAttachments = targetSummary
        ? setSummaryCodeSelectionAttachments
        : setCommentCodeSelectionAttachments
      const targetRef = targetSummary ? summaryRef : commentRef
      setTab("user-story")
      updateAttachments((current) => [
        ...current,
        { ...excerpt, id: crypto.randomUUID() },
      ])
      requestAnimationFrame(() => {
        targetRef.current
          ?.querySelector<HTMLElement>("[data-markdown-editor-input='true']")
          ?.focus()
      })
    },
    [setTab, status, summaryEditable]
  )

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
    [mode, pendingComposerDraftRef]
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
    [mode, pendingComposerDraftRef]
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
        hasCommentDraft={hasCommentDraft}
        loadingAction={pendingAction}
        mode={mode}
        status={status}
        onAction={handleDrawerAction}
        onCheckPullRequest={onCheckPullRequest}
        onDeleteUserStory={onDeleteUserStory}
        onOpenDrawer={onOpenDrawer}
        onReject={onReject}
        reviewDiffEmpty={reviewDiffEmpty}
        onStopAgent={onStopAgent}
        story={userStory}
      />
    ),
    [
      hasCommentDraft,
      handleDrawerAction,
      mode,
      onCheckPullRequest,
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
    <ExcerptTargetProvider
      attachAsContext={
        storyAcceptsExcerpts(status) ? attachExcerptAsContext : undefined
      }
    >
      <DrawerContent
        // Round on every corner with a full border: in Chromium, without them
        // the header's masked blur loses its fade and cuts the thread.
        className="overflow-hidden rounded-xl border bg-[oklch(1_0_0)] text-foreground outline-none data-[vaul-drawer-direction=right]:w-[min(var(--story-drawer-width,90rem),calc(100vw-1rem))] data-[vaul-drawer-direction=right]:sm:max-w-none dark:bg-[oklch(0.16_0_0)]"
        overlayClassName="bg-black/30 dark:bg-black/50"
        style={drawerWidth.style}
      >
        <DrawerResizeHandle onWidthChange={drawerWidth.setWidth} />
        {mode !== "create" ? <StoryStatusGlow status={status} /> : null}
        {tab === "user-story" && statsExpandable && (
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
              tab === "user-story" &&
                (statsShownExpanded
                  ? "lg:pr-[23rem]"
                  : "pt-20 sm:pt-6 sm:pr-[20rem]")
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
                  {userStory?.pullRequestUrl ? (
                    <PullRequestLink url={userStory.pullRequestUrl} />
                  ) : null}
                </div>
              </DrawerDescription>
            </div>
            {hasDevelopment && (
              <SlidingTabsList className="mt-2 min-w-100" value={tab}>
                <TabsTrigger className={slidingTabsTrigger} value="user-story">
                  <BookOpenIcon />
                  User Story
                </TabsTrigger>
                {hasPreview && (
                  <TabsTrigger className={slidingTabsTrigger} value="preview">
                    <TabReadyIcon ready={previewReady}><AppWindowIcon /></TabReadyIcon>
                    Preview
                  </TabsTrigger>
                )}
                <TabsTrigger className={slidingTabsTrigger} value="development">
                  <CodeIcon />
                  Code
                </TabsTrigger>
              </SlidingTabsList>
            )}
          </DrawerHeader>
          <TabsContent value="user-story" className="min-h-0 overflow-hidden">
            <DrawerBody
              resetKey={userStory?.id ?? mode}
              fixedSection={
                <UserStoryFixedSection
                  actions={drawerActionButtons}
                  ambition={ambition}
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
                  onCommentFileAttachmentsReplace={(replacements) => setCommentFileAttachments((current) => replaceFileAttachments(current, replacements))}
                  onCommentSubmit={handleCommentSubmit}
                  onCommentSendNow={handleCommentSendNow}
                  onAmbitionChange={changeAmbition}
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
              headerStacked={!statsShownExpanded}
              sidebarOpen={statsShownExpanded}
            >
              <UserStoryContent
                ambition={ambition}
                loadChangedFileDiffs={loadChangedFileDiffs}
                mode={mode}
                onAmbitionChange={changeAmbition}
                onCommentUndo={handleCommentUndo}
                onSummaryCodeSelectionAttachmentRemove={
                  removeSummaryCodeSelectionAttachment
                }
                onSummaryFileAttachmentRemove={removeSummaryFileAttachment}
                onSummaryFileAttachmentsAdd={addSummaryFileAttachments}
                  onSummaryFileAttachmentsReplace={(replacements) => setSummaryFileAttachments((current) => replaceFileAttachments(current, replacements))}
                onSummaryChange={handleSummaryChange}
                onSummaryOptimize={
                  onOptimizeUserStory ? handleSummaryOptimize : undefined
                }
                onFileLinkClick={handleOpenDevelopmentFile}
                onChangedFileClick={handleOpenDevelopmentDiff}
                onRunModeChange={changeRunMode}
                runMode={runMode}
                onTargetBranchChange={changeTargetBranch}
                targetBranch={targetBranch}
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
                // The toolbar starts where the story's thread does.
                hasDevelopment ? "pt-32" : "pt-24"
              )}
            >
              {directPreview ? (
                <DirectStoryPreview
                  storyId={userStory.id}
                  visible={previewVisible}
                  onCapture={handlePreviewCapture}
                  onReadyChange={setPreviewReady}
                />
              ) : (
                <UserStoryPreview
                  setupInitializing={setupInitializing}
                  userStory={userStory}
                  visible={previewVisible}
                  onRunConfigurationChange={handlePreviewRunConfigurationChange}
                  onCapture={handlePreviewCapture}
                  onReadyChange={setPreviewReady}
                />
              )}
            </TabsContent>
          )}
          {hasDevelopment && (
            <TabsContent
              value="development"
              className="min-h-0 overflow-hidden pt-32"
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
        {tab === "user-story" && (
          <StoryStatsIsland
            diffStats={diffStats}
            contextLimitKey={contextLimitKey}
            expanded={statsShownExpanded}
            preparing={!statsExpandable}
            source={userStory}
            useEditorModel={summaryEditable}
            onExpand={() => setStatsExpanded(true)}
          />
        )}
        {tab !== "user-story" && (
          <div className="pointer-events-none absolute right-4 bottom-4 z-20 p-0">
            {drawerActionButtons}
          </div>
        )}
      </DrawerContent>
    </ExcerptTargetProvider>
  )

  // Applies right away to an existing story; a new one takes it on create.
  function changeRunMode(next: StoryRunMode) {
    setRunMode(next)
    if (mode !== "create" && userStory)
      void onUpdateUserStory(userStory, { runMode: next })
  }

  // Like the run mode; the first run locks it with the story's worktree.
  function changeTargetBranch(next: string) {
    setTargetBranch(next)
    if (mode !== "create" && userStory)
      void onUpdateUserStory(userStory, { targetBranch: next })
  }

  // Kept with the story, and told to its agent from the next turn on.
  function changeAmbition(next: Ambition | null) {
    setAmbition(next)
    if (mode !== "create" && userStory)
      void onUpdateUserStory(userStory, { ambition: next })
  }

  async function handleAction(action: DrawerAction) {
    if (pendingAction || commentSubmission.pending) return
    if (action === "Close") return onCancel()
    if (action === "Discard") return discardUserStory()
    if (action === "Request Changes") return submitComment()
    setPendingAction(action)
    try {
      if (mode === "create") {
        await onCreateUserStory(
          {
            ...createInput(
              action,
              title,
              summaryValueRef.current,
              summaryCodeSelectionAttachments,
              summaryFileAttachments
            ),
            runMode: runMode ?? readStoryRunMode(),
            targetBranch,
            ambition,
          },
          storyContextLimit(contextLimitKey)
        )
        saveStoryContextLimit(contextLimitKey, undefined)
        clearComposerDraft()
      }
      if (mode !== "create" && userStory) {
        if (action === "Approve & Merge") {
          await onApproveAndMerge(userStory)
        } else if (action === "Merge without Push") {
          await onApproveAndMerge(userStory, { push: false })
        } else if (action === "Open PR") {
          await onOpenPullRequest(userStory)
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
      clearCommentComposer()
      return
    }
    setPendingAction("Request Changes")
    let composerCleared = false
    // Empty the editor as soon as the comment shows in the conversation, so
    // the message is not duplicated while the agent starts.
    const clearComposerOnce = () => {
      composerCleared = true
      clearCommentComposer()
    }
    try {
      const submitted = await commentSubmission.submit({
        story: userStory,
        input: {
          body,
          codeSelectionAttachments: commentCodeSelectionAttachments,
          fileAttachments: commentFileAttachments,
        },
        createComment: (input) => onCreateUserStoryComment(userStory, input),
        onCommentSaved: clearComposerOnce,
        requestChanges: (createdComment) =>
          onRequestChanges(
            userStory,
            body,
            createdComment.id,
            createdComment.codeSelectionAttachments,
            createdComment.fileAttachments
          ),
      })
      if (!submitted) {
        if (composerCleared) {
          restoreCommentComposer(
            currentComment,
            commentCodeSelectionAttachments,
            commentFileAttachments
          )
        }
        return
      }
      if (!composerCleared) clearComposerOnce()
    } catch (error) {
      if (composerCleared) {
        restoreCommentComposer(
          currentComment,
          commentCodeSelectionAttachments,
          commentFileAttachments
        )
      }
      toast.error("Unable to send comment", {
        description: error instanceof Error ? error.message : String(error),
        position: "bottom-right",
      })
    } finally {
      setPendingAction(undefined)
    }
  }

  function clearCommentComposer() {
    clearComposerDraft()
    commentValueRef.current = ""
    setComment("")
    setCommentCodeSelectionAttachments([])
    setCommentFileAttachments([])
    setCommentEditorKey((key) => key + 1)
  }

  function restoreCommentComposer(
    body: string,
    codeSelectionAttachments: typeof commentCodeSelectionAttachments,
    fileAttachments: typeof commentFileAttachments
  ) {
    commentValueRef.current = body
    setComment(body)
    setCommentCodeSelectionAttachments(codeSelectionAttachments)
    setCommentFileAttachments(fileAttachments)
    setCommentEditorKey((key) => key + 1)
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
