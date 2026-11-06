import type { ParsedSymbol } from "./code-intelligence.js";
import { capabilityForPath } from "./light-capabilities.js";
import type { LightReadCodeInput } from "./light-contracts.js";
import type { ByteInterval } from "./read-coverage.js";

export type EditTarget = { alias: string; qualifiedName: string };

export function symbolicPath(path: string) {
  const capability = capabilityForPath(path);
  return Boolean(capability?.loaded && capability.level !== "raw");
}

export function enclosingSymbol(
  symbols: ParsedSymbol[],
  range: ByteInterval,
): ParsedSymbol | undefined {
  return symbols
    .filter(
      (symbol) =>
        symbol.range_utf8_bytes[0] <= range[0] &&
        symbol.range_utf8_bytes[1] >= range[1],
    )
    .sort((left, right) => symbolSize(left) - symbolSize(right))[0];
}

export function outlineCandidates(symbols: ParsedSymbol[]) {
  const structural = symbols.filter(
    ({ kind }) => kind !== "css_custom_property",
  );
  return structural.length ? structural : symbols;
}

export function editTargetSymbols(
  symbols: ParsedSymbol[],
  intervals?: ByteInterval[],
) {
  const candidates = outlineCandidates(symbols);
  if (intervals?.length) return intervalEditTargets(candidates, intervals);
  const roots = candidates.filter(
    ({ name, qualified_name }) => qualified_name === name,
  );
  return uniqueSymbols([...roots.slice(0, 2), appendSymbol(roots)]).slice(0, 3);
}

function intervalEditTargets(
  symbols: ParsedSymbol[],
  intervals: ByteInterval[],
) {
  const overlapping = symbols
    .filter((symbol) =>
      intervals.some((range) => overlaps(symbol.range_utf8_bytes, range)),
    )
    .sort((left, right) => symbolSize(left) - symbolSize(right));
  const fullyRead = overlapping
    .filter((symbol) =>
      intervals.some(
        ([start, end]) =>
          start <= symbol.range_utf8_bytes[0] &&
          end >= symbol.range_utf8_bytes[1],
      ),
    )
    .sort((left, right) => symbolSize(right) - symbolSize(left));
  const ranked = uniqueSymbols([...fullyRead, ...overlapping]);
  return nonOverlappingSymbols(ranked).slice(0, 3);
}

function nonOverlappingSymbols(symbols: ParsedSymbol[]) {
  const selected: ParsedSymbol[] = [];
  for (const symbol of symbols)
    if (
      !selected.some((candidate) =>
        overlaps(candidate.range_utf8_bytes, symbol.range_utf8_bytes),
      )
    )
      selected.push(symbol);
  return selected;
}

function appendSymbol(symbols: ParsedSymbol[]) {
  return [...symbols].sort(
    (left, right) => right.range_utf8_bytes[1] - left.range_utf8_bytes[1],
  )[0];
}

function uniqueSymbols(symbols: Array<ParsedSymbol | undefined>) {
  const seen = new Set<string>();
  return symbols.filter((symbol): symbol is ParsedSymbol => {
    if (!symbol) return false;
    const key = symbol.range_utf8_bytes.join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function overlaps(left: ByteInterval, right: ByteInterval) {
  return left[0] < right[1] && right[0] < left[1];
}

function symbolSize(symbol: ParsedSymbol) {
  return symbol.range_utf8_bytes[1] - symbol.range_utf8_bytes[0];
}

export function symbolMatches(symbol: ParsedSymbol, query: string) {
  return (
    symbol.name.toLocaleLowerCase().includes(query) ||
    symbol.qualified_name.toLocaleLowerCase().includes(query)
  );
}

export function qualifiedTarget(value: string) {
  return value.includes("#") && !value.startsWith("#");
}

/** "auto" folds a file when its folds repay their cost (light-fold-economics.ts), whatever its size. */
export function routedView(input: LightReadCodeInput) {
  if (requestedLineRange(input)) return "range" as const;
  return input.view ?? ("auto" as const);
}

export function requestedLineRange(input: LightReadCodeInput) {
  return input.view === "range" || Boolean(
    input.range && (!input.view || ["auto", "raw"].includes(input.view)),
  );
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
