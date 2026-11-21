// What the screen shows of an epic (`EpicState`), from one look: the
// conversation's state, the one error to show first, and how far the
// epic's pause is.

import type { Epic, EpicState } from "../protocol.js";
import { conversationState, type ConversationView } from "./conversation.js";
import type { PauseProgress } from "./pause.js";
import type { EpicEntry } from "./state.js";

export function epicStateOf(input: {
  epic: Epic;
  entry: EpicEntry | undefined;
  conversation: ConversationView | undefined;
  spend: EpicState["spend"];
  unreported: number;
  blocked: NonNullable<EpicState["blocked"]>;
  /** Why the kept file, the last look or the last wake failed. */
  errors: { file?: string; look?: string; wake?: string };
  pause: PauseProgress | undefined;
}): EpicState {
  const { epic, entry, conversation, errors, pause, blocked } = input;
  const looked = conversationState(conversation, entry?.stopped === true);
  const { state } = looked;
  const error =
    errors.file ??
    looked.error ??
    errors.wake ??
    (entry?.branchGone
      ? `The epic's branch ${entry.branch} is gone, and stories were already merged into it: nothing starts until it is back.`
      : undefined);
  const endTurn = conversation?.last?.endTurn;
  const session = entry?.session ?? epic.engineSessionId;
  const pauseError = errors.look ?? pause?.error;
  return {
    epicId: epic.id,
    ...(session ? { session } : {}),
    conversation: state,
    ...(error ? { error } : {}),
    ...(state === "asking" && endTurn?.question
      ? {
          question: {
            text: endTurn.question,
            options: endTurn.options ?? [],
          },
        }
      : {}),
    ...(state === "finished" && endTurn?.summary
      ? { summary: endTurn.summary }
      : {}),
    unreported: input.unreported,
    ...(blocked.length ? { blocked } : {}),
    ...(epic.status === "paused"
      ? {
          pause: {
            phase: pause?.done && !errors.look ? "paused" : "pausing",
            ...(pauseError ? { error: pauseError } : {}),
          },
        }
      : {}),
    spend: input.spend,
  };
}
