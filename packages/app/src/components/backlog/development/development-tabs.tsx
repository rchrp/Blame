import type {
  FileContent,
  VcsFileDiff,
} from "@/components/backlog/development/development-workspace"
import { FileCode2Icon, GitPullRequestIcon } from "lucide-react"

import { DevelopmentFileIcon } from "@/components/backlog/development/development-file-icon"
import { DevelopmentFileView } from "@/components/backlog/development/development-file-view"
import { DevelopmentReview } from "@/components/backlog/development/development-review"
import {
  filename,
  type DevelopmentFileTab,
} from "@/components/backlog/development/development-workspace"
import type { AttachedTab } from "@/components/backlog/shared/attached-tabs"

// The open files of the Code tab, as tabs set on the editor: the review of
// all changes first, in the Changes view.
export function developmentEditorTabs(
  mode: "files" | "diff",
  tabs: DevelopmentFileTab[],
  changes: number
): AttachedTab[] {
  return [
    ...(mode === "diff"
      ? [
          {
            id: "review",
            icon: <GitPullRequestIcon className="size-4 shrink-0" />,
            label: changes ? `Review · ${changes}` : "Review",
          },
        ]
      : []),
    ...tabs.map((tab) => ({
      id: tab.path,
      closable: true,
      icon: (
        <DevelopmentFileIcon
          className="shrink-0"
          node={{ path: tab.path, type: "file" }}
        />
      ),
      label: filename(tab.path),
      title: tab.path,
    })),
  ]
}

export function DevelopmentEditorContent({
  active,
  diffByPath,
  diffs,
  initialReviewFilePath,
  mode,
  onOpenFile,
  readFile,
  reloadKey,
  reviewLoading,
}: {
  active: string
  diffByPath: Map<string, VcsFileDiff>
  diffs: VcsFileDiff[]
  initialReviewFilePath?: string
  mode: "files" | "diff"
  onOpenFile: (path: string) => void
  readFile: (path: string) => Promise<FileContent | undefined>
  reloadKey: number
  reviewLoading: boolean
}) {
  if (mode === "diff" && active === "review")
    return (
      <DevelopmentReview
        diffs={diffs}
        initialOpenFilePath={initialReviewFilePath}
        loading={reviewLoading}
        onOpenFile={onOpenFile}
      />
    )
  if (!active || active === "empty" || active === "review")
    return <NoOpenFile />
  return (
    <DevelopmentFileView
      key={active}
      diff={diffByPath.get(active)}
      path={active}
      readFile={readFile}
      reloadKey={reloadKey}
    />
  )
}

function NoOpenFile() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <FileCode2Icon className="size-8 text-muted-foreground" />
      <div className="space-y-1">
        <h3 className="font-heading text-lg font-semibold">No file open</h3>
        <p className="max-w-xs text-sm text-pretty text-muted-foreground">
          Pick one in the tree, or search for it above.
        </p>
      </div>
    </div>
  )
}
