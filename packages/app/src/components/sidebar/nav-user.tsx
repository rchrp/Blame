import { UserAvatar } from "@/components/shared/user-avatar"
import { Badge } from "@/components/ui/badge"
import { SidebarUpdateButton } from "@/components/updates/sidebar-update-button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  EllipsisVerticalIcon,
  CircleUserRoundIcon,
  CreditCardIcon,
  LogOutIcon,
} from "lucide-react"
import { toast } from "sonner"
import { type CloudUser, useCloudAuth } from "@/context/cloud-auth"
import { navigate } from "@/components/navigation/navigation"
import { openSettings } from "@/pages/settings/settings-section"

export function NavUser({
  onLogout,
  user,
}: {
  onLogout: () => Promise<void>
  user: CloudUser
}) {
  const { isMobile } = useSidebar()
  const auth = useCloudAuth()
  const name = user.fullName || user.email
  const premium = auth.license?.licensed === true

  // Subscribers manage billing in Stripe; others see the Premium offer.
  function openBilling() {
    if (!premium) return navigate("/premium")
    void auth.openBillingPortal().catch((error: unknown) => {
      toast.error("Billing could not open", {
        description: error instanceof Error ? error.message : undefined,
        position: "bottom-right",
      })
    })
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem className="flex min-w-0 items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="min-w-0 flex-1 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <UserAvatar
                email={user.email}
                image={user.image}
                initials={user.initials}
                name={user.fullName}
                seed={user.id}
              />
              <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium">{name}</span>
                  {premium ? <PremiumBadge /> : null}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              </div>
              <EllipsisVerticalIcon className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <UserAvatar
                  email={user.email}
                  image={user.image}
                  initials={user.initials}
                  name={user.fullName}
                  seed={user.id}
                />
                <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">{name}</span>
                    {premium ? <PremiumBadge /> : null}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => openSettings("account")}>
                <CircleUserRoundIcon />
                Account
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openBilling}>
                <CreditCardIcon />
                Billing
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void onLogout()}>
              <LogOutIcon />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <SidebarUpdateButton />
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function PremiumBadge() {
  return <Badge className="h-4 px-1.5 text-[10px] leading-none">Premium</Badge>
}
