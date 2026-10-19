import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

// Placeholders shaped like the content they stand in for, so the layout
// does not jump when the data arrives.

export function StoryCardSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col gap-3 rounded-lg border bg-white p-4 dark:bg-neutral-900"
    >
      <div className="flex items-center gap-2">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="ml-auto size-5 rounded-full" />
      </div>
      <Skeleton className="h-4 w-4/5" />
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("h-3", index === lines - 1 ? "w-2/5" : "w-full")}
        />
      ))}
      <div className="flex gap-2 pt-1">
        <Skeleton className="h-6 w-20 rounded-full" />
        <Skeleton className="h-6 w-14 rounded-full" />
      </div>
    </div>
  )
}

export function ConversationSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading conversation"
      className="flex flex-col gap-10"
    >
      <div className="ml-auto flex w-2/3 max-w-md flex-col items-end gap-2">
        <Skeleton className="h-16 w-full rounded-2xl rounded-br-md" />
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-9 w-full rounded-lg" />
        <Skeleton className="h-9 w-full rounded-lg" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    </div>
  )
}

export function SidebarListSkeleton({ rows = 3 }: { rows?: number }) {
  const widths = ["w-4/5", "w-3/5", "w-2/3", "w-1/2"]
  return (
    <div aria-hidden="true" className="flex flex-col gap-2.5 px-2 py-1.5">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("h-3.5", widths[index % widths.length])}
        />
      ))}
    </div>
  )
}
