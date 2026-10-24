import { publicAssetUrl } from "@/lib/public-asset-url"
import { cn } from "@/lib/utils"

export function BlameLogoMark({ className }: { className?: string }) {
  return (
    <img
      src={publicAssetUrl("web-app-manifest-512x512.png")}
      alt="Blame"
      width={512}
      height={512}
      draggable={false}
      className={cn("object-contain", className)}
    />
  )
}
