import * as React from "react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { CloudAuthContext } from "@/context/cloud-auth"
import { cn } from "@/lib/utils"

// One look for people everywhere in the app: their sign-in photo (Google,
// GitHub, Microsoft) or, without one, their initials on a color that stays
// the same for them.

const fallbackColors = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-lime-600",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-sky-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-fuchsia-500",
]

export function avatarColor(seed: string) {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return fallbackColors[Math.abs(hash) % fallbackColors.length]!
}

export function avatarInitials(name: string | null | undefined, email?: string) {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean)
  if (words.length > 1) return `${words[0]![0]}${words.at(-1)![0]}`.toUpperCase()
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (email ?? "?").slice(0, 2).toUpperCase()
}

export function UserAvatar({
  className,
  email,
  image,
  initials,
  name,
  seed,
  size,
}: {
  className?: string
  email?: string
  image?: string | null
  initials?: string
  name?: string | null
  // Picks the fallback color; the user id or email keeps it stable.
  seed?: string
  size?: React.ComponentProps<typeof Avatar>["size"]
}) {
  const label = name || email || "User"
  return (
    <Avatar size={size} className={className} aria-label={label}>
      {image ? (
        <AvatarImage alt={label} referrerPolicy="no-referrer" src={image} />
      ) : null}
      <AvatarFallback
        className={cn(
          "font-medium text-white",
          avatarColor(seed ?? email ?? label)
        )}
      >
        {initials || avatarInitials(name, email)}
      </AvatarFallback>
    </Avatar>
  )
}

// The signed-in person, or `fallbackName` when nobody is signed in.
export function CurrentUserAvatar({
  fallbackName,
  ...props
}: Omit<
  React.ComponentProps<typeof UserAvatar>,
  "email" | "image" | "initials" | "name" | "seed"
> & { fallbackName?: string }) {
  const auth = React.useContext(CloudAuthContext)
  const user = auth?.status === "authenticated" ? auth.user : undefined
  if (!user) return <UserAvatar name={fallbackName} {...props} />
  return (
    <UserAvatar
      email={user.email}
      image={user.image}
      initials={user.initials}
      name={user.fullName}
      seed={user.id}
      {...props}
    />
  )
}
