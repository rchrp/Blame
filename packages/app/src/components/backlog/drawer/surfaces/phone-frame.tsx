import * as React from "react"

export function PhoneFrame({ device, children }: { device: "phone" | "tablet"; children: React.ReactNode }) {
  const element = React.useRef<HTMLDivElement>(null)
  const [scale, setScale] = React.useState(0)
  const width = device === "phone" ? 390 : 820
  const height = device === "phone" ? 844 : 1180
  React.useEffect(() => {
    const node = element.current
    if (!node) return
    const observer = new ResizeObserver(() => setScale(Math.min(1, Math.max(0, (node.clientWidth - 24) / width), Math.max(0, (node.clientHeight - 24) / height))))
    observer.observe(node)
    return () => observer.disconnect()
  }, [width, height])
  return <div className="flex h-full min-h-0 flex-col">
    <div className="border-b px-3 py-2 text-sm text-muted-foreground" title="The native app may differ from this web version.">Web version</div>
    <div ref={element} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/20 p-3">
      <div className="relative shrink-0 overflow-hidden rounded-2xl border bg-background" style={{ width: width * scale, height: height * scale }}>{children}</div>
    </div>
  </div>
}
