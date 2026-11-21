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
| The orchestrator's engine side (slice 1): the purpose, its tools and refusals, the epic's branch, the waking, the spend | `engine/purposes/orchestrator.ts`, `engine/orchestrator/`, `engine/orchestrator-protocol.ts`, `prompt/orchestrator-agent-system.txt`; proven by `engine/orchestrator.e2e.test.ts` |

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
  - The slug is the title's words, lowercase, joined by dashes (40
    characters at most); a name another branch or epic of the project
    already has, or one git cannot make beside an existing branch (`epic`
    leaves no room for `epic/…`, `epic/x/y` none for `epic/x`), gets
    `-2`, `-3`…, and `epic-<slug>` when a branch is named `epic`
    (`orchestrator/branch.ts`). Two epics made at once in one folder take
    turns, so they never share a name.
  - `git branch <branch> <targetBranch>`: nothing is checked out, so the
    project folder and its branch never move. A folder on no branch (a
    detached HEAD) is refused. The name is kept on this computer first,
    then written to the epic (branch, target, session), then made; a
    missing branch is made again before stories are created or queued: a
    quit between two steps leaves a name the next call makes, never a
    branch no epic names.
  - **The branch is the one this host made.** A branch the API names that
    this computer did not keep is refused (at `createSession`), and so is
    one equal to the target. Nothing starts or merges once the API's
    branch differs from the kept one.
  - `createSession` is refused when the epic already names a session the
    engine has; a session it names that was never created is replaced. A
    config is built only for the epic's own session.
- `status`: `active` while the conversation can go on; `paused` after Pause
  all; `completed` once the epic's branch is merged into `targetBranch`;
  `discarded`. A status this build does not know is read as `paused`: never
  free to run.
- **Pause all is the host's** (`orchestrator/pause.ts`). The screen writes
  the status to the API and calls `epicChanged` (the host also reads every
  epic it runs each minute). When it reads `paused`, the host pauses the
  agents of the epic's stories at work (and one whose start was in flight,
  once it runs) and cuts the orchestrator's own turn, and keeps which;
  nothing starts and nothing wakes it meanwhile. When it reads `active`
  again, exactly those agents resume (each still paused where the pause
  left it) and the orchestrator's cut turn goes on (a `resumed` wake). The
  turns the pause cut are not news: no wake tells them. A story the person
  paused by hand, or a turn the person stopped, stays as it is through a
  pause and a resume. A story that ends otherwise meanwhile is told once
  the epic resumes.
  - What the pause means to stop is written before it acts (`pausing`:
    the stories at work, those whose start was in flight, whether it cuts
    the turn), and every step runs again safely, so a failure or a quit
    part way is taken up by the next look; `paused` once everything it
    meant to stop is stopped; `resuming`, also written ahead, while those
    resume. A quit while paused keeps all of it.
  - A story the person acts on from a window while the epic is paused (a
    message, a pause, a resume, a discard, back to the backlog) is theirs
    from then on: the resume leaves it as it is.
  - A pause's cut and its resume never count against the three resumes in
    a row after cuts.
  - `epicChanged` answers whether the pause took: `EpicState.pause` is
    `{ phase: "pausing" | "paused", error? }` while the API says `paused`,
    with the reason when the host could not stop something or could not
    look (the project not read yet, another account, the engine not
    answering, in which case `epicChanged` fails saying so).
  - Resuming with the budget spent resumes the agents the pause stopped:
    running agents are not stopped by the budget (the owner's rule today),
    only new starts and messages are refused.
- `settings` (a JSON object the screen writes, the host reads on every turn):

| key | meaning |
| --- | --- |
| `orchestratorModel` | The model the orchestrator itself runs on (`providerId`, `modelId`, `credentialLabel?`, `reasoning?`). |
| `modelRange` | `{ min, max }` from 0 (cheapest) to 1 (smartest): the slice of the smart ranking stories may use. Default the whole scale. |
| `providers` | The providers stories may use; empty means all the connected ones. |
| `hiddenModels` | The models the person hid in the model selector (it keeps them per project on this computer; the screen copies them here). |
| `budgetMicroUsd` | What the epic may spend, stories and orchestrator together. Absent: no budget. |
| `askBeforeLaunch` | True: starting stories and approving a merge wait for the person's Allow. Default false. |

The host reads `settings` again for each message it builds a config for,
each tool call that needs it and each approval, so a change applies from
the next call on.

## The conversation

An `orchestrator` purpose (`engine/purposes/orchestrator.ts`), one session
per epic, its id in `epic.engineSessionId`. The `plan` purpose, its prompt,
`PlanSettings` and what only it used are deleted once the screen no longer
uses them (the screen slice removes Plan Mode's interface first).

- **Workspace**: the project folder, read only. Harness tools `search_code`
  and `read_code` only: no `edit_code`, no `run_task`. It also gets the
  conversation tools Plan Mode had (web research, story history, attachments,
  read-only GitHub, the person's MCP servers and skills), and not
  `propose_user_stories`.
- **Settings** the renderer sends with each message (`OrchestratorSettings`
  in `engine/orchestrator-protocol.ts`): the workspace, `projectId`,
  `epicId`, `model`, the context cap and the personalization. The host reads
  the epic and its `settings` itself. `model` is the orchestrator's model as
  the window shows it (the epic's `orchestratorModel`, else the account's
  agent model): the epic's own setting wins when it has one, the window's is
  the fallback. (A departure: every purpose's settings carry a `model`, and
  the app reads it.) The host keeps the last settings a window sent for the
  epic, to write to the conversation itself after a restart.
- **Prompt** (`prompt/orchestrator-agent-system.txt`): the epic's title,
  goal, branch and target, and how to work: it never codes; a brief stands
  alone; independent work in parallel, tightly coupled steps in one story;
  decisions two stories share are taken in their briefs; a story is judged
  from the harness's verdict and the files changed; it asks only for a
  choice of approach, a vague request or a missing access; it answers in
  the person's language.
- **How a turn ends**: a completion contract whose result is the client tool
  `end_turn` (`max_corrections: 2`). A reply that stops in text is corrected
  by the engine, as for a story; a refused `end_turn` goes back as the
  call's error. A turn that still does not end through it ends
  `contract_unmet`, and the epic shows `failed` (see "What the screen
  reads").
- **Where it runs**: on the computer that created its session (the host
  keeps the epics it runs in `<userData>/orchestrator-epics.json`, each with
  the API it was created through). The epic's queued stories start only
  there: the computer that runs a story is the one told of its turns.
- **What is kept is never dropped because the API does not show the
  epic** (a 404: another account, another deployment): the pending turns,
  what was heard, the counts, the merged stories' cost, the settings and
  the branch stay, the epic's stories are held, and all of it applies again
  once that account shows the epic. An epic is forgotten only once the API
  reads it `discarded`. Another API's epics are not looked at.
- **The kept file is never written over when it cannot be read.** A file
  that is not there starts empty; one that cannot be read (a disk or
  permission error) holds everything: every epic story waits (`unknown`),
  the epic's state shows the error, and it is read again on the next look.
  One that reads but is not JSON is set aside (`.corrupt-<time>`), and an
  epic whose conversation this computer's engine has (`session/list`, never
  Blame's database) is found again (`Orchestrator.adopt`): its entry is
  built from the API and the conversation's records, whose prompt names
  the branch this host made (it must be the epic's), whose config gives the
  folder and the model, and whose `message_story` calls give the counts.
  The merged stories' cost and what was heard are lost then (a turn may be
  told twice).
- **What is kept of a story goes only once it is merged or rejected** (its
  heard and pending turns): no cap evicts anything else, however long the
  epic.
- **The queue's gate** (`orchestrator/gate.ts`): a queued story of an epic
  waits with the reason `{ kind: "epic", epicId, hold }`, `hold` being
  `paused` (paused or over), `budget` (spent, from the spend kept on disk,
  so from the first start after a launch), `elsewhere` (its conversation
  runs on another computer), `direct` (no working preview environment),
  `branch` (its branch is gone, see below) or `unknown` (not read yet). Its
  card says so. Only the epic's own stories are looked at again, and only
  when its gate changed: no other story's backoff is touched.
- **A lost branch**: each look checks the epic's branch. While no story was
  merged into it, it is made again from the target; once one was, it never
  is (later stories would build without that work and a summary would be
  false): the epic holds (`hold: "branch"`), its state says the branch is
  gone, and `create_stories` and `update_story` refuse until the person
  restores it. `update_story` with `queue` makes a queued story's branch
  back too, not only a held one's.
- **An epic's story never runs Direct**: when the project's preview
  environment broke after the story was created (or Direct is its run
  mode), `stories/start.ts` makes it wait with `hold: "direct"` instead of
  running in the person's folder on its branch.

### Tools

Every tool that acts takes a `reason`, one sentence the screen shows as the
decision log. A refusal is the call's error, read by both: its first
sentence says what happened in plain words for the person (the screen shows
it as "Refused: …"), and what the orchestrator should do comes after. A
story is named by its id or its number (`US-004`); a story of another epic
or none is refused by every tool. The inputs are `OrchestratorToolInputs`
(`engine/orchestrator-protocol.ts`); each answers JSON the model reads.

| tool | input | does | the host refuses when |
| --- | --- | --- | --- |
| `epic_board` | none | The epic (title, status, branch, target), each story (id, number, title, status or `working`, `paused`, what a queued one waits for in words and `needsPerson` when only the person can start it, intent, model, turns, last turn's outcome and verdict, cost, changes requested), the board's counts and the spend. Its last ended turn counts as heard. | |
| `create_stories` | `reason`, `stories: [{ key, title, brief, startsAfter?, intent, hold? }]` | Creates the stories with the epic's id, its branch as their target, `modelIntent`, the `requestedModel` its intent resolves to (`resolveModelIntent` with the epic's range, providers and hidden models, the account's agent model as fallback) and the person's run mode (Local Container when it is Direct); queued unless `hold`. Ordered so a story comes after those of the call it starts after. Answers each story's key, id, number, model and whether it is queued or held. | the budget is spent; a key is missing or repeated; a dependency is neither a key of the call nor a story of the epic, or is rejected; the keys close a cycle; the project has no working preview environment (its stories would run Direct, in the project folder on its branch, not on the epic's branch) unless every story is held; no model can be chosen; nothing ranks in the epic's range and the account's agent model is on a provider the epic does not allow, or hidden |
| `update_story` | `reason`, `storyId`, `title?`, `brief?`, `startsAfter?` (ids, replaces the list), `intent?`, `queue?` | Changes a story not started (in the backlog or queued); a new intent resolves its model again; `queue` queues a held one. | the story started; a dependency is not another story of the epic; `queue` with the budget spent or no working preview environment |
| `story_report` | `storyId` | The last turn's outcome, `verified` (its `finish_task` was accepted) or the `failingChecks`, the error, the agent's whole reply, the files changed against its base (`git diff --name-status` in its worktree plus untracked files, or base to merge once merged), turns, model, cost, changes requested. A story this computer does not run says its outcome is unknown here. The turn it shows counts as heard. | |
| `message_story` | `reason`, `storyId`, `kind: "answer" \| "changes"`, `message`, `escalate?` | Sends the agent the message (a paused or reviewed story works again). A message to a story in review is a request for changes whatever its `kind`. `escalate` runs the turn on the next model up (`escalateModel` from its last model, in the epic's range); the story keeps it. Answers the requests and messages left. | the budget is spent; a fourth request for changes on the story; a seventh message of any kind to it (the counts are kept on this computer, counted before the message goes); `escalate` when it already runs on the top of the range |
| `approve_story` | `reason`, `storyId` | Approve & Merge into the epic's branch, with the orchestrator's model for the commit message; the stories that start after it can start. | the story is not in review; its agent works; this computer has not its records; its last turn did not end `completed` (the harness did not accept its `finish_task`), whatever the prompt says; its target is not the epic's branch as this host made and kept it, or that branch is the target branch, or the API names another; it ran Direct; the merge of the epic's branch into it conflicts (aborted, never resolved by the merge agent: ask for changes, its agent merges the epic's branch in and passes its checks again) |
| `reject_story` | `reason`, `storyId` | Discards the story; its worktree goes. | the story is merged |
| `end_turn` | `action: "wait" \| "ask" \| "finish"`, `reason`, `question?` and `options?` (ask), `summary?` (finish) | Ends the turn, whoever wrote last: `wait` sleeps until woken (also after answering the person mid-epic while stories work); `ask` hands the turn back to the person with a question (also when nothing works yet: chatting before any story, a plan to show first); `finish` gives the epic's summary for the person's review. | `wait` while no story of the epic works or will start by itself (a queued story waiting for a story in review, paused, held or rejected, held by the epic, waiting for the person (no model, a missing tool, Git without a name, the runtime to install), or whose start has kept failing for 90 s); `ask` without a question; `finish` while a story is neither merged (`done`) nor rejected, or without a summary |

With `askBeforeLaunch`, `create_stories` (unless every story is held),
`update_story` when it queues, and `approve_story` need the person's
approval through the engine's approval request. The three tools always
declare `needs_approval`; the host answers the request at once when the
epic does not ask (`Orchestrator.approval`); any other tool's approval
request is the person's. So the tool list, part of the
provider's cached prompt, never changes with the setting, which applies
from the next call; the transcript records each call's approval as
requested and resolved, an instant apart when it was not asked.

### Waking

The host listens to `stories.onTurnEnded`. For a story of an epic whose
conversation runs here, it keeps the ended turn (in
`<userData>/orchestrator-epics.json`) and looks at the epic. It sends the
epic's session one message when:

- no story of the epic is working any more (its agent runs, or it is being
  started or merged), or
- the story that ended is one another story of the epic (not merged or
  rejected) starts after.

It also writes to the conversation when its last turn was cut by a quit or
a crash (`resumed`: it goes on from the board), and when it waits while
nothing of the epic works or will start by itself and no ended turn is left
to tell (`idle`: a story deleted from the board, the budget spent, a story
waiting for the person, a start that keeps failing). An `idle` wake is told
once: the next needs something about the epic's stories to change (one
started or ended, the person acted, another error), never the same states
and reasons again, so a story whose start alternates between an error and
another wait cannot wake the orchestrator over and over. A start counts as
failing from its first error until it starts, whatever it waits for in
between, and is blocked after 90 s. A message that waited behind a turn
through a quit is sent on (`promote`). A conversation cut again and again
is resumed three times in a row, then left to the person (it shows
`failed`); a pause's cut does not count.

Nothing is sent while the epic is not `active`, while a turn runs or a
message waits behind one, before its first turn, after `ask`, or after the
person stopped its turn (the host's `interrupt`): it is sent when the epic
resumes, the person answers or writes, once that turn ends. When the
person writes while stories work, the orchestrator answers and ends with
`wait`, and the stories' wake still comes; before any story exists it hands
the turn back with `ask` (the prompt and `end_turn` say so).

**The message** is the host's, never the person's: a user message of one
`context` block, no `text` block, whose text is `<orchestrator_wake>`, a
line for the model, a JSON line (`OrchestratorWake`), `</orchestrator_wake>`.
The model reads it as text; the transcript keeps it as a user item whose
blocks are that one context block. `parseOrchestratorWake(blocks)` (in
`engine-protocol`) gives the wake or `undefined`. Only the host writes one:
`send` refuses a window's message whose context reads as a wake ("Only
Blame writes the orchestrator's wake"), so a window can neither show one
nor make a turn count as told. The screen shows it as an event row, never
as something the person wrote. It carries:

- `reason`: `stories`, `resumed` or `idle`;
- `stories`: each story turn that ended since the orchestrator last heard of
  it: `storyId`, `number`, `title`, `session`, `turn`, `outcome` (the turn's
  status), `verified`, `failingChecks?`, `error?`, `status` (the story's,
  once the end was applied), `reply?` (its first six lines);
- `board`: the counts (`working`, `queued`, `held`, `inReview`, `paused`,
  `merged`, `rejected`);
- `blocked?`: the queued stories only the person can start, each with
  `storyId`, `number`, `title`, `reason` in words (a start that keeps
  failing gives its error);
- `budget?`: `spent`, `remainingMicroUsd`, with a budget.

The orchestrator calls `story_report` for more.

**Each ended turn is told exactly once, across a quit.** What a wake
carried is in the conversation's records (rewound wakes included), which
the host reads back: that set is what was reported. An ended turn not in it
is told by the next wake. The candidates are the turns the story service
told, kept here before the wake goes and dropped once the records have
them, and the ended turns of the sessions of the epic's stories this
computer runs (`status`), read again on every look, so a telling lost in a
crash (between the story service's ledger and this file) is found there.
What the orchestrator's own `epic_board` or `story_report` showed it counts
as heard, exactly the turns the answer showed (each story's last ended
turn): no wake repeats them (kept in the same file, the last 500). The
message is in the engine's records by the time `send` answers (the engine
appends it before it accepts the message), so the next look reads it. A
story whose agent still works is left until its end is settled. The host
looks at an epic on each ended story turn, each end of an orchestrator
turn, `epicChanged`, `epicState`, sign-in and every minute, one look at a
time per epic.

## The spend

Computed by the host from the records, never stored by the API:

- a story's cost is what its session's requests cost, rewound ones included
  (`status.spentMicroUsd`, from the transcript's `usage.spent`). It is read
  for the stories this computer runs and at work, and kept per story and
  session in `<userData>/orchestrator-epics.json`, since a merged story's
  session is deleted from this computer;
- the orchestrator's cost is its own session's, read the same way and kept
  there too;
- the epic's total is both; `spent` once it reaches `budgetMicroUsd`. The
  queue's gate reads the kept amounts, never a flag held in memory, so a
  spent epic's stories stay held from the first start after a launch, and
  what a story's ended turn spent is kept before its dependents can start.
  `unpricedRequests` counts requests the catalog had no price for: the
  totals are then a floor.

Not counted: the git flows' agents (commit messages, conflicts), titles and
other tasks, and ultra mode's helpers (sessions of their own).

`epic_board` shows it (as dollars), `epicState` and the `epic` event give it
to the screen (micro-USD, `EpicSpend`). Once the budget is spent the host
refuses `create_stories`, `update_story` that queues and `message_story`,
and the queue holds the epic's queued stories; approving and rejecting go
on, and the orchestrator is woken (`idle`) to wrap up.

## What the screen reads

- `platform.engine.call("epicState", { epicId })` and the `epic` event
  (`onEpic`, `{ type: "epic", epicId, state }`, sent when the state
  changes): an `EpicState` (`engine/orchestrator-protocol.ts`):
  `conversation` (`idle`, `working`, `waiting`, `asking`, `finished`,
  `stopped`, `failed`), `error` (why it failed, or why a wake could not be
  sent), `question` (`text`, `options`) of an `ask`, `summary` of a
  `finish`, `unreported` (ended turns not told yet), `blocked` (the queued
  stories only the person can start, with why) and `spend`. The sidebar's
  dot: working for `working`/`waiting`, needs you for `asking`, `stopped`,
  `failed` or any `blocked`, done for `finished`.
- A queued story's card reads the `epic` wait reason (`storyWaitText`).
- `resolveModelIntent` and `escalateModel` come from `engine-protocol`, so
  the screen shows the same choice the host makes.
- `epicChanged({ epicId })` after writing an epic's settings or status.
- `createSession({ session, purpose: "orchestrator", settings })` creates
  the conversation and the epic's branch; `send` with the same settings for
  each of the person's messages; `interrupt` stops a turn for good (it is
  not resumed).
- In the transcript: a user item that `parseOrchestratorWake` reads is the
  host's wake (an event row); each orchestrator tool call is a decision row
  (`name`, the input's `reason` and `storyId`); `approve_story`,
  `create_stories` and `update_story` may show Allow and Deny (an approval
  the host answered at once leaves its records too).

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

1. **Engine** (done on `feat/orchestrator-engine`): the purpose, the tools,
   the waking, the epic's branch, the budget refusals. Proven with the real
   engine, real git, the local API and a scripted model, no window
   (`orchestrator.e2e.test.ts`). Unproven until the screen exists: the
   person's own messages, answers to an `ask`, Allow and Deny of an
   approval, Pause all and resume, the `epic` event reaching a window, and a
   Local Container (runtime VM) or real Cloud Preview story in an epic.
2. **Screen**: the sidebar entry, the epic page with its board and
   settings, the removal of Plan Mode's interface; then, once the engine
   slice is merged, the conversation and the removal of the `plan` purpose.
3. **Epic review**: checks on the epic's branch after each merge, a preview
   of the epic's branch, and the person's merge of the epic into its target
   (or a pull request).
4. **Later**: agent checks admitted by free memory, an atomic claim so two
   computers never start the same story, previews prepared without a window
   showing the project, a structured question in `finish_task`.
