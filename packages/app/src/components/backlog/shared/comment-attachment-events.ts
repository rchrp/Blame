export type CodeSelectionAttachment = {
  content: string
  endLine: number
  // Where the excerpt was selected: a source file unless it says otherwise.
  // A story attached as context keeps its number in path, its title in
  // content and its id in storyId.
  origin?: CodeSelectionOrigin
  path: string
  startLine: number
  storyId?: string
}

export type CodeSelectionOrigin = "code" | "message" | "story"

export type PendingCodeSelectionAttachment = CodeSelectionAttachment & {
  id: string
}

export function codeSelectionLineLabel(attachment: Pick<CodeSelectionAttachment, "endLine" | "startLine">) {
  if (attachment.startLine === attachment.endLine) return `Line ${attachment.startLine}`
  return `Lines ${attachment.startLine}-${attachment.endLine}`
}
