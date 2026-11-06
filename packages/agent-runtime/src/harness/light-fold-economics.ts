/**
 * When read_code folds a body, and when it folds a file at all.
 *
 * Nothing here is a chosen size. Each threshold is the break-even point of
 * one cost model, measured on 25 read_code sessions (November 2026):
 *
 * - A character kept in context is written to the prompt cache once, then
 *   read from it on every later turn: about 0.45 tokens × (1.25 + 0.1 R),
 *   with R the turns left in the session.
 * - An extra tool call re-reads the whole context once (0.1 × its tokens)
 *   when it takes a turn of its own, plus its own output and overhead.
 *
 * All values are in stored characters: the call cost divided by the cost of
 * one stored character.
 */

// Long sessions hold 95% of whole-read cost; these are their medians at a read.
const remainingTurns = 90;
const contextTokens = 86_000;
// Share of follow-up reads that take a turn of their own (measured 0.14 to 0.69).
const ownTurnShare = 0.5;
const tokensPerCharacter = 0.45;
const cacheWrite = 1.25;
const cacheRead = 0.1;
const callOutputTokens = 250;
const callOverheadCharacters = 250;

const characterCost = tokensPerCharacter * (cacheWrite + cacheRead * remainingTurns);
const callCost = ownTurnShare * cacheRead * contextTokens + callOutputTokens + callOverheadCharacters * characterCost;

/** One extra read_code call, in stored characters (about 1,240). */
export const foldCallCharacters = Math.round(callCost / characterCost);

/**
 * A body is folded only when hiding it pays for the call that may unfold it:
 * b > p × call / (1 − p), with p = 0.075 the share of 100–600-character bodies
 * used after a whole-file read. About 100 characters.
 */
const smallBodyNeed = 0.075;
export const foldBodyMinimumCharacters = Math.round((smallBodyNeed * foldCallCharacters) / (1 - smallBodyNeed));

/**
 * A file is folded only when the folded bodies remove at least this many
 * characters. The fold must repay, per read:
 * - q × one call: q = 0.75 of folded reads were followed by some read of the file;
 * - the header line (about 150 characters).
 * What it removes, G, comes back only in part:
 * - a whole re-read (β = 0.46, the rate after outlines imposed in long
 *   sessions) returns only the folded bodies, so it costs G, not the file;
 * - the other follow-ups fetch 1.24 × the needed share (0.17) of G.
 * Break-even: G × (1 − β − (q − β) × 0.21) = q × call + header. About 2,250.
 */
const followUpShare = 0.75;
const wholeRereadShare = 0.46;
const fetchedShare = 1.24 * 0.17;
const headerCharacters = 150;
export const foldFileMinimumCharacters = Math.round(
  (followUpShare * foldCallCharacters + headerCharacters) /
    (1 - wholeRereadShare - (followUpShare - wholeRereadShare) * fetchedShare),
);

/**
 * An explicit outline was asked for, so the re-read risk is the agent's
 * choice: it pays as soon as it removes more than one call.
 */
export const outlineMinimumCharacters = foldCallCharacters;

/**
 * A type declaration up to this size stays visible: types are read to write
 * calls and edits, and the replay was better with them shown (0.954 → 0.938).
 */
export const visibleTypeCharacters = 2_000;

/**
 * The most a folded view shows. Above it, the largest containers list one
 * line per member instead of their folded members.
 */
export const foldViewCharacters = 32_000;
