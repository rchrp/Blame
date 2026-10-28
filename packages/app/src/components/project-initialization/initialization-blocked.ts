// An analysis the agent stopped because something outside the repository
// and the setup blocks it. The runtime writes it as
// "Initialization blocked [category]: summary\nWhat you can do: action",
// and the app saves that text as the initialization's error.

export type BlockedInitialization = {
  category: string
  title: string
  summary: string
  userAction: string
  evidence?: string
}

const titles: Record<string, string> = {
  missing_secret: "A secret is missing",
  private_dependency: "A private dependency is out of reach",
  unavailable_image: "A container image is unavailable",
  unsupported_stack: "This project can't run in containers",
  repository_problem: "The repository needs a fix first",
  blame_problem: "Blame can't set up this project yet",
}

export function blockedInitialization(
  error: string | null | undefined
): BlockedInitialization | undefined {
  const match = error?.match(
    /Initialization blocked \[([a-z_]+)\]: ([\s\S]*?)\nWhat you can do: ([\s\S]*?)(?:\nEvidence: ([\s\S]*))?$/
  )
  if (!match) return undefined
  const [, category, summary, userAction, evidence] = match
  return {
    category: category!,
    title: titles[category!] ?? "The analysis is blocked",
    summary: summary!.trim(),
    userAction: userAction!.trim(),
    ...(evidence?.trim() ? { evidence: evidence.trim() } : {}),
  }
}
