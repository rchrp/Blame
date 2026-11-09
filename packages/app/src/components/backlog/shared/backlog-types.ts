import type {
  UserStory,
  UserStoryDraft,
} from "@/components/backlog/data/backlog-data"

export type UserStoryDrawerTab = "user-story" | "preview" | "development"
export type UserStoryDevelopmentTab = "files" | "diff" | "terminal"
export type UserStoryDrawerMode = "create" | "edit" | "view"
export type DrawerAction =
  | "Discard"
  | "Save as Draft"
  | "Send to Dev Agent"
  | "Save Changes"
  | "Dequeue"
  | "Stop Agent"
  | "Request Changes"
  | "Reject"
  | "Approve & Merge"
  | "Open PR"
  | "Approve, Merge & Push"
  | "Close"
  | "Rework as Draft"
  | "Delete Permanently"

export type DrawerTarget = {
  userStory?: UserStory
  mode: UserStoryDrawerMode
  initialDraft?: Partial<Omit<UserStoryDraft, "projectId">>
  initialTab?: UserStoryDrawerTab
  initialDevelopmentTab?: UserStoryDevelopmentTab
  focusComment?: boolean
}

export type OpenDrawer = (target: DrawerTarget) => void
