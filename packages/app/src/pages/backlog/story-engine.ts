// Where a story's agent runs, and how a message to an agent reads (quick
// chats use it too). The story service in the engine host runs the story
// (docs/engine-in-the-app.md, "Development stories").

import type {
  EngineLocation,
  EngineMessage,
  StoryWorkspaceMode,
} from "@blame/agent-runtime/engine-protocol"

import type {
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import { codeSelectionLineLabel } from "../../components/backlog/shared/comment-attachment-events.ts"

/**
 * Where a story's worktree is, so its agent runs on the engine next to it. A
 * local-container worktree lives in the Blame Runtime VM on macOS and
 * Windows (on Linux, on the host).
 */
export function storyLocation(
  workspaceMode: StoryWorkspaceMode,
  platformName: string | undefined
): EngineLocation {
  return workspaceMode === "local-container" && platformName !== "linux"
    ? "vm"
    : "host"
}

/**
 * A message to the story's agent: the text, code excerpts quoted in it,
 * and attached files read as the model gets them (images, PDFs, text).
 */
export async function storyMessage(
  text: string,
  codeSelections: UserStoryCodeSelectionAttachment[] | null | undefined,
  files: UserStoryFileAttachment[] | null | undefined,
  readFile: (file: UserStoryFileAttachment) => Promise<string | undefined>
): Promise<EngineMessage> {
  const excerpts = (codeSelections ?? [])
    .filter((excerpt) => excerpt.origin !== "story")
    .map(
      (excerpt) =>
        `${excerpt.path}, ${codeSelectionLineLabel(excerpt).toLowerCase()}:\n\n\`\`\`\n${excerpt.content}\n\`\`\``
    )
  const stories = (codeSelections ?? [])
    .filter((excerpt) => excerpt.origin === "story")
    .map((excerpt) => `Builds on ${excerpt.path}: ${excerpt.content}`)
  const attachments: EngineMessage["attachments"] = []
  for (const file of files ?? []) {
    const data = file.content ?? (await readFile(file))
    if (data)
      attachments.push({
        data,
        mediaType: file.type || "application/octet-stream",
        name: file.name,
      })
  }
  return {
    text: [text.trim(), ...excerpts, ...stories].filter(Boolean).join("\n\n"),
    attachments,
  }
}
