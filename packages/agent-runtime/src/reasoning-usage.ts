/**
 * Cline reports thinking tokens apart from `outputTokens`, and only as a
 * per-event `reasoningTokenCount`. Providers bill them as output, so Blame
 * counts them as output too: per event, and in the running totals.
 */
type Ledger = { output: number; reasoning: number };

const maximumSessions = 500;
const ledgers = new Map<string, Ledger>();

/** A per-turn usage event: adds its reasoning delta to the turn and to the totals. */
export function usageWithReasoning(sessionId: string, usage: Record<string, unknown>) {
  const reasoning = finite(usage.reasoningTokenCount) ?? 0;
  const ledger = currentLedger(sessionId, finite(usage.totalOutputTokens));
  ledger.reasoning += reasoning;
  const output = finite(usage.outputTokens);
  return {
    ...usage,
    ...(output !== undefined ? { outputTokens: output + reasoning } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
    ...withReasoningTotals(usage, ledger),
  };
}

/** A totals-only usage summary: adds the reasoning already counted for this session. */
export function totalsWithReasoning(sessionId: string, usage: unknown) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return usage;
  const ledger = ledgers.get(sessionId);
  if (!ledger?.reasoning) return usage;
  return { ...usage, ...withReasoningTotals(usage as Record<string, unknown>, ledger) };
}

function withReasoningTotals(usage: Record<string, unknown>, ledger: Ledger) {
  const total = finite(usage.totalOutputTokens);
  if (total === undefined || !ledger.reasoning) return {};
  return { totalOutputTokens: total + ledger.reasoning, totalReasoningTokens: ledger.reasoning };
}

/** Totals that go down belong to a new accounting run: its reasoning starts over. */
function currentLedger(sessionId: string, totalOutput?: number) {
  let ledger = ledgers.get(sessionId);
  if (!ledger || (totalOutput !== undefined && totalOutput < ledger.output)) {
    ledger = { output: 0, reasoning: 0 };
    ledgers.delete(sessionId);
    ledgers.set(sessionId, ledger);
    while (ledgers.size > maximumSessions) ledgers.delete(ledgers.keys().next().value!);
  }
  if (totalOutput !== undefined) ledger.output = totalOutput;
  return ledger;
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
