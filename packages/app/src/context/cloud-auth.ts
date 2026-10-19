import * as React from "react"

import type {
  ApiConnection,
  PreviewManifest,
  ProjectRunConfiguration,
} from "@blame/agent-runtime"
import type { ReasoningSelection } from "@blame/agent-runtime"

export type CloudUser = {
  id: string
  fullName: string | null
  email: string
  createdAt: string
  updatedAt: string
  initials: string
  // Profile photo from a Google, GitHub or Microsoft sign-in.
  image?: string | null
}

export type CloudSession = {
  user: CloudUser
  token: string
}

export type CloudLicense = {
  licensed: boolean
  status: string
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
}

export type CloudAiModelPreference = {
  providerId: string
  modelId: string
  credentialLabel: string | null
  reasoningEffort: ReasoningSelection | null
}

export type CloudAiPreferences = {
  alternativeModel: CloudAiModelPreference
  agentModel: CloudAiModelPreference
  createdAt: string
  updatedAt: string | null
}

export type CloudMcpServer = {
  command?: string
  disabled: boolean
  name: string
  timeout?: number
  transport: "stdio" | "streamableHttp" | "sse"
  url?: string
}

export type CloudMcpConfiguration = {
  createdAt: string
  servers: CloudMcpServer[]
  updatedAt: string | null
}

export type CloudProject = {
  id: string
  userId: string
  repositoryFingerprint: string | null
  name: string
  createdAt: string
  updatedAt: string | null
}

export type CloudProjectInitializationStatus =
  | "pending"
  | "running"
  | "done"
  | "error"

export type CloudProjectCodePracticeAnalysisStatus =
  | "pending"
  | "running"
  | "done"
  | "error"

export type CloudProjectCodePracticeKey =
  | "coding_style"
  | "unit_tests"
  | "layered_architecture"
  | "commit_message_convention"

export type CloudProjectInitialization = {
  projectId: string
  status: CloudProjectInitializationStatus
  step: string
  clineSessionId: string | null
  agentProviderId: string | null
  agentModelId: string | null
  previewManifest: PreviewManifest | null
  runConfigurations: ProjectRunConfiguration[]
  databaseMode: "existing" | "compose" | null
  error: string | null
  repairReason: string | null
  createdAt: string
  updatedAt: string | null
}

export type CloudProjectCodePractice = {
  id: string
  projectId: string
  practice: CloudProjectCodePracticeKey
  detected: boolean
  enabled: boolean
  comment: string
  createdAt: string
  updatedAt: string | null
}

export type CloudProjectCodePracticeAnalysis = {
  projectId: string
  status: CloudProjectCodePracticeAnalysisStatus
  clineSessionId: string | null
  agentProviderId: string | null
  agentModelId: string | null
  error: string | null
  viewedAt: string | null
  createdAt: string
  updatedAt: string | null
}

export type CloudProjectInitializationSnapshot = {
  initialization: CloudProjectInitialization | null
  practices: CloudProjectCodePractice[]
}

export type LoginInput = {
  email: string
  password: string
}

export type LoginResult = "authenticated" | "email-verification" | "two-factor"

export type SignupInput = LoginInput & {
  fullName: string | null
  passwordConfirmation: string
}

export type CloudAuthContextValue = {
  status: "loading" | "authenticated" | "unauthenticated"
  apiConnection: ApiConnection
  aiPreferences?: CloudAiPreferences | null
  mcpConfiguration?: CloudMcpConfiguration | null
  license?: CloudLicense
  user?: CloudUser
  token?: string
  error?: string
  login(input: LoginInput): Promise<LoginResult>
  verifyEmailTwoFactor(code: string): Promise<void>
  resendEmailTwoFactor(): Promise<void>
  signup(input: SignupInput): Promise<void>
  requestPasswordReset(email: string): Promise<void>
  resetPassword(token: string, password: string): Promise<void>
  resendVerification(email: string): Promise<void>
  socialLogin(provider: SocialAuthProvider): Promise<void>
  passkeyLogin(): Promise<void>
  saveAiPreferences(input: SaveAiPreferencesInput): Promise<void>
  saveMcpConfiguration(servers: CloudMcpServer[]): Promise<void>
  refreshAiPreferences(): Promise<void>
  refreshLicense(): Promise<CloudLicense | undefined>
  startCheckout(cycle: "monthly" | "yearly"): Promise<void>
  openBillingPortal(): Promise<void>
  logout(): Promise<void>
}

export type SocialAuthProvider = "github" | "google" | "microsoft"

export type SaveAiPreferencesInput = {
  alternativeModel: CloudAiModelPreference
  agentModel: CloudAiModelPreference
}

export const CloudAuthContext = React.createContext<
  CloudAuthContextValue | undefined
>(undefined)

export function useCloudAuth() {
  const context = React.useContext(CloudAuthContext)
  if (!context)
    throw new Error("useCloudAuth must be used within CloudAuthProvider")
  return context
}
