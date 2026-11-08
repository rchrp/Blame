import {
  isPreviewSetupPolicy,
  type PreviewSetupPolicy,
} from "@/lib/preview-setup-decision"
import { readUiMemory, writeUiMemory } from "@/lib/ui-memory"

export const previewSetupPolicyKey = "preview-setup-policy"

export function readPreviewSetupPolicy(): PreviewSetupPolicy {
  return readUiMemory(previewSetupPolicyKey, isPreviewSetupPolicy) ?? "ask"
}

export function rememberPreviewSetupPolicy(policy: PreviewSetupPolicy) {
  writeUiMemory(previewSetupPolicyKey, policy)
}
