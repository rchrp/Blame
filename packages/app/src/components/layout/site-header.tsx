import * as React from "react"
import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react"

import { usePlatform, type WindowControlsClient } from "@/context/platform"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { ProjectRunnerButton } from "@/components/backlog/board/project-runner-button"

const siteHeaderBlurMask = {
  maskImage: "linear-gradient(to bottom, black 5%, transparent 72%)",
  WebkitMaskImage: "linear-gradient(to bottom, black 5%, transparent 72%)",
} satisfies React.CSSProperties

export function SiteHeader({ title }: { title: string }) {
  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-20 pb-10 md:pb-12">
      <div
        aria-hidden="true"
        className="absolute inset-0 backdrop-blur-xl"
        style={siteHeaderBlurMask}
      />
      <div className="pointer-events-auto relative flex h-(--header-height) items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
        <div className="flex min-w-0 flex-1 items-center gap-1 px-4 lg:gap-2 lg:px-6">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mx-2 my-auto data-[orientation=vertical]:h-4"
          />
          <h1 className="truncate text-base font-medium">{title}</h1>
          <div className="ml-auto">
            <ProjectRunnerButton />
          </div>
        </div>
      </div>
    </header>
  )
}

export function WindowControls({
  className,
  showMaximize = true,
  ...props
}: React.ComponentProps<"div"> & { showMaximize?: boolean }) {
  const platform = usePlatform()

  if (!platform.windowControls) return null

  return (
    <WindowControlsButtons
      className={className}
      controls={platform.windowControls}
      showMaximize={showMaximize}
      {...props}
    />
  )
}

function WindowControlsButtons({
  className,
  controls,
  showMaximize,
  ...props
}: {
  className?: string
  controls: WindowControlsClient
  showMaximize: boolean
} & React.ComponentProps<"div">) {
  const [maximized, setMaximized] = React.useState(false)

  React.useEffect(() => {
    let mounted = true
    void controls.isMaximized().then((value) => {
      if (mounted) setMaximized(value)
    })
    const removeListener = controls.onMaximized(setMaximized)
    return () => {
      mounted = false
      removeListener()
    }
  }, [controls])

  return (
    <div className={cn("flex items-center gap-1", className)} {...props}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="Minimize"
        aria-label="Minimize"
        onClick={() => void controls.minimize()}
      >
        <MinusIcon />
      </Button>
      {showMaximize ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={maximized ? "Restore" : "Maximize"}
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={() => void controls.toggleMaximize()}
        >
          {maximized ? <CopyIcon /> : <SquareIcon />}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="Close"
        aria-label="Close"
        onClick={controls.close}
      >
        <XIcon />
      </Button>
    </div>
  )
}
