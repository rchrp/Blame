import type {
  EpicProblem,
  EpicState,
} from "@blame/agent-runtime/engine-protocol"

// The epic's own problems, as the host reports them (EpicState.problems),
// each with what the person can do about it. Every one shows: a failed turn
// must not hide a lost branch.

export type EpicProblemNotice = {
  kind: EpicProblem["kind"]
  message: string
  action: string
}

const actions: Record<EpicProblem["kind"], string> = {
  "kept-file":
    "Check that this computer's disk has room and that Blame may write to its folder, then reopen the project.",
  turn: "Write to the orchestrator to let it try again, or choose another model in the epic's settings.",
  wake: "Write to the orchestrator: it reads the board and goes on.",
  branch:
    "Bring the epic's branch back (from another clone, or git reflog), or reject the stories that need it. Nothing of the epic starts until then.",
}

export function epicProblems(
  state: Pick<EpicState, "conversation" | "error" | "problems"> | undefined
): EpicProblemNotice[] {
  if (!state) return []
  const problems: EpicProblem[] = state.problems?.length
    ? state.problems
    : // A host before `problems`: its one sentence, read by the state it came with.
      state.error
      ? [
          {
            kind: state.conversation === "failed" ? "turn" : "wake",
            message: state.error,
          },
        ]
      : []
  return problems.map((problem) => ({
    ...problem,
    action: actions[problem.kind],
  }))
}
