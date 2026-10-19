import { OpenProjectEmptyState } from "@/components/shared/open-project-empty-state"
import { ConversationSkeleton } from "@/components/shared/skeletons"

export function QuickChatStatus({
  error,
  loading,
  projectPath,
}: {
  error?: string
  loading: boolean
  projectPath?: string
}) {
  if (!projectPath) {
    return (
      <OpenProjectEmptyState description="Open a project to chat with an agent about its code." />
    )
  }
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    )
  }
  if (!loading) return null
  return <ConversationSkeleton />
}
