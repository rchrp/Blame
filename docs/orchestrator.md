# The orchestrator

An orchestrator is an agent a person talks to that never writes code: it
breaks a goal into user stories, starts them itself, picks a model for each,
sleeps while their agents work, wakes when they are finished, and then
approves and merges, requests changes on, or rejects each one. It replaces
Plan Mode, which only proposed stories.

This is the contract of the build. The engine side and the screen are built
against it in parallel; a slice that needs to depart from it changes this
file in the same commit. `docs/engine-in-the-app.md` says how the app runs
agents on the engine; this file only adds what the orchestrator needs.

## Decisions (owner, 2026-11-21)

- Plan Mode is deleted, not extended.
- One conversation per **epic**: a goal, an integration branch, a budget. A
  project can have several epics, and several can run at once.
- The orchestrator creates and starts the stories itself. It is free to
  prepare a chain of dependent stories in advance, to start agents one at a
  time after each result, or to mix both. Nothing forces a chain.
- It decides itself, from each story's end report, to approve and merge, to
  request changes, or to reject.
- A story the harness verified is merged into the **epic's branch**. `main`
  (the epic's target branch) only moves when the person approves the epic.
- It can **never** approve a story whose checks failed: the engine host
  refuses, whatever the prompt says.
- It picks a model by intent (cheaper, balanced, smarter), inside the range
  and the providers the person allows. The interface stays simple.
- It sleeps while the agents it started work, and is woken, never polling.
- There is no cap on how many agents work at once.

## What exists

| piece | where |
| --- | --- |
| A story's whole life in the engine host: create, queue, start, messages, pause, approve and merge, discard, the event of each ended turn | `EngineHost.stories` (`engine/stories/service.ts`), `engine/story-protocol.ts`; "Development stories" in `docs/engine-in-the-app.md` |
| A queued story waits for the stories in `startsAfter` and never starts if one was discarded or deleted; its first run uses `requestedModel` | `engine/stories/queue.ts`, `start.ts` |
| Story fields `startsAfter`, `modelIntent`, `requestedModel`, `epicId`; the `epics` resource | `packages/api` (`epics_controller.ts`, `story_links.ts`) |
| An intent turned into a model of the smart ranking, and the next model up | `engine/model-intent.ts` |
| A turn that only ends through a result the host accepts | completion contracts, "Tasks" in `docs/engine-in-the-app.md` |
| A tool call the person allows or denies | "Approvals" in `docs/engine-in-the-app.md` |

## The epic

An epic is a row of the API's `epics` (`title`, `goal`, `status`, `branch`,
`targetBranch`, `engineSessionId`, `settings`, `mergedAt`, `mergeCommit`).

- `targetBranch`: the branch the epic merges into at the end; the project
  folder's current branch when the epic is created.
- `branch`: `epic/<slug>`, created from `targetBranch` by the host when the
  conversation's session is created, and written to the epic then. Every
  story of the epic has `epicId` and `targetBranch = epic.branch`, so the
  existing Approve & Merge lands it there and a later story's worktree
  starts from what was merged.
- `status`: `active` while the conversation can go on; `paused` after Pause
  all (no story starts, the orchestrator is not woken); `completed` once the
  epic's branch is merged into `targetBranch`; `discarded`.
- `settings` (a JSON object the screen writes, the host reads on every turn):

| key | meaning |
| --- | --- |
| `orchestratorModel` | The model the orchestrator itself runs on (`providerId`, `modelId`, `credentialLabel?`, `reasoning?`). |
| `modelRange` | `{ min, max }` from 0 (cheapest) to 1 (smartest): the slice of the smart ranking stories may use. Default the whole scale. |
| `providers` | The providers stories may use; empty means all the connected ones. |
| `hiddenModels` | The models the person hid in the model selector (it keeps them per project on this computer; the screen copies them here). |
| `budgetMicroUsd` | What the epic may spend, stories and orchestrator together. Absent: no budget. |
| `askBeforeLaunch` | True: starting stories and approving a merge wait for the person's Allow. Default false. |

## The conversation

An `orchestrator` purpose (`engine/purposes/orchestrator.ts`), one session
per epic, its id in `epic.engineSessionId`. The `plan` purpose, its prompt,
`PlanSettings` and what only it used are deleted in the same slice.

- **Workspace**: the project folder, read only. Harness tools `search_code`
  and `read_code` only: no `edit_code`, no `run_task`. It also gets the
  conversation tools Plan Mode had (web research, story history, attachments,
  read-only GitHub, the person's MCP servers and skills), and not
  `propose_user_stories`.
- **Settings** the renderer sends with each message (`OrchestratorSettings`):
  the workspace, `projectId`, `epicId`, the context cap and the
  personalization. The host reads the epic and its `settings` itself.
- **How a turn ends**: a completion contract whose result is the client tool
  `end_turn`. A reply that stops in text is corrected by the engine, as for
  a story.

### Tools

Every tool that acts takes a `reason`, one sentence the screen shows as the
decision log. A refusal is the call's error, with what to do instead.

| tool | does | the host refuses when |
| --- | --- | --- |
| `epic_board` | The epic's stories as they are now: status, what each waits for, its model, turns, cost, and what is left of the budget. | |
| `create_stories` | Creates stories (`title`, `brief`, `startsAfter` by key or id, `intent`, `hold?`) with the epic's id and branch, resolves each intent to `requestedModel` (`resolveModelIntent` with the epic's range, providers and hidden models, the account's agent model as fallback), and queues them unless `hold`. Answers each story's id, number and model. | the budget is spent; a dependency is unknown or closes a cycle |
| `update_story` | Changes the brief, the dependencies or the intent of a story that has not started; queues one that was held. | the story started |
| `story_report` | One story's end report: the last turn's outcome, whether the harness verified it or which check failed, the agent's reply, the files changed against its base, turns, cost and model. | |
| `message_story` | Sends the agent a message: an answer to its question, or a request for changes (`kind`). `escalate: true` runs that turn on the next model up (`escalateModel`). | the story is not this epic's; a fourth request for changes on the same story; the budget is spent |
| `approve_story` | Approve & Merge into the epic's branch. | the story is not in review; its last turn did not end `completed` (the harness did not accept its `finish_task`) |
| `reject_story` | Discards the story and its worktree. | |
| `end_turn` | Ends the turn: `wait` (sleep until woken), `ask` (a question for the person, with options), or `finish` (a summary of the epic for the person's review). | `wait` while no story of the epic works or can start; `finish` while a story of the epic is neither merged into the epic's branch nor discarded |

With `askBeforeLaunch`, `create_stories` (unless every story is held),
`update_story` when it queues, and `approve_story` need the person's
approval through the engine's approval request.

### Waking

The host listens to `stories.onTurnEnded`. For a story with an `epicId`, it
sends the epic's session one message when:

- no story of the epic is working any more, or
- the story that ended is one another story of the epic starts after.

A message arriving while the orchestrator's turn runs is queued by the
engine. The message is the host's, not the person's: the transcript shows
it as an event, never as something the person wrote. It carries each story
whose turn ended since the orchestrator last heard of it (id, number, title,
outcome, verified or the failing check, the first lines of the reply) and
the board's counts; the orchestrator calls `story_report` for more.

Each ended turn of an epic's story is reported exactly once, across a quit:
the story service tells an ended turn once, and what was already reported
is kept with the epic. Nothing is sent while the epic is `paused` or the
orchestrator's last turn ended with `ask`; it is sent when the epic resumes
or the person answers.

## The screen

- **Sidebar**: an Orchestrator entry at the top of the main navigation,
  above Backlog, with the project's epics under it (a dot for its state:
  working, needs you, done) and New epic. The Plan Mode button, its dialog
  and `use-plan-mode.ts` are deleted; `propose_user_stories` and its cards
  stay for stories and quick chats.
- **An epic's page**: the conversation on one side (the engine transcript,
  with each tool call as a decision row: what, on which story, the reason)
  and the epic's board on the other, grouped by what the person owes: Needs
  you, Working, Queued (with the wait reason), In the epic branch, Rejected.
  A story opens in the existing drawer.
- **Header**: the epic's title and branch, spend against the budget, Pause
  all, and the settings above (the range is the smart slider with two
  handles; providers; the orchestrator's model; ask before launching).
- The screen reads and writes epics through the API, stories through the
  backlog store filtered by `epicId`, and the queue's wait reasons through
  the story service's events.

## Slices

1. **Engine**: the purpose, the tools, the waking, the epic's branch, the
   budget refusals, the removal of the `plan` purpose.
2. **Screen**: the sidebar entry, the epic page, the settings, the removal
   of Plan Mode's interface.
3. **Epic review**: checks on the epic's branch after each merge, a preview
   of the epic's branch, and the person's merge of the epic into its target
   (or a pull request).
4. **Later**: agent checks admitted by free memory, an atomic claim so two
   computers never start the same story, previews prepared without a window
   showing the project, a structured question in `finish_task`.
