import * as React from "react"

import { MarkdownEditor } from "@/components/backlog/drawer/markdown-editor"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"

// A specialist's own conversation: the request from the lead agent, then its
// reasoning, tool calls and messages, ending with its answer. The steps
// themselves are rendered by the caller with the regular conversation items.
export function SpecialistThreadDialog({
  avatar,
  children,
  name,
  onOpenChange,
  open,
  request,
  status,
}: {
  avatar: React.ReactNode
  children: React.ReactNode
  name: string
  onOpenChange(open: boolean): void
  open: boolean
  request?: string
  status: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(85vh,56rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="flex-row items-center gap-3 border-b px-5 py-4 text-left">
          {avatar}
          <div className="grid min-w-0 gap-0.5">
            <DialogTitle className="truncate text-base">{name}</DialogTitle>
            <DialogDescription className="truncate">{status}</DialogDescription>
          </div>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-6 py-6 pr-14 pl-16">
            {request ? (
              <section className="grid gap-1.5" aria-label="Request from the lead agent">
                <span className="text-xs font-medium text-muted-foreground">
                  Asked by the lead agent
                </span>
                <div className="rounded-2xl bg-muted/60 ring-1 ring-foreground/10 [&>div]:bg-transparent [&>div]:p-0 [&>div]:shadow-none [&>div]:ring-0">
                  <MarkdownEditor
                    markdown={request}
                    minHeight="min-h-0"
                    placeholder=""
                    readOnly
                  />
                </div>
              </section>
            ) : null}
            {children}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
