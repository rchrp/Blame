import { Button } from "@/components/ui/button"

export function SurfaceUnavailable({
  title = "Unavailable here",
  message,
  action,
  onAction,
}: {
  title?: string
  message: string
  action?: string
  onAction?: () => void
}) {
  return (
    <div
      className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-8 text-center"
      role="status"
    >
      <h3 className="font-heading text-lg font-semibold">{title}</h3>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {action && onAction && (
        <Button variant="outline" onClick={onAction}>
          {action}
        </Button>
      )}
    </div>
  )
}
