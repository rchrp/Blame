import type { FoldAttention } from "./light-fold-view.js";

/** What the session pointed at in a file: search hits and failing-check lines since its last change, edited symbols. */
export type LightAttentionState = {
  pointed: Array<{ path: string; lines: number[] }>;
  edited: Array<{ path: string; symbols: string[] }>;
};

const maximumPaths = 200;
const maximumLines = 64;
const maximumSymbols = 64;

/**
 * Bodies the session already pointed at are needed far more often than
 * others (33% against 7.8% after a search hit), so folded views keep them.
 */
export class LightAttention {
  private readonly pointed = new Map<string, number[]>();
  private readonly edited = new Map<string, string[]>();

  point(path: string, lines: number[]) {
    const merged = [...new Set([...(this.pointed.get(path) ?? []), ...lines.filter((line) => Number.isSafeInteger(line) && line > 0)])];
    this.pointed.delete(path);
    this.pointed.set(path, merged.slice(-maximumLines));
    trim(this.pointed);
  }

  /** The file changed: its lines no longer point where they did. */
  changed(path: string) {
    this.pointed.delete(path);
  }

  edit(path: string, symbols: string[]) {
    if (!symbols.length) return;
    const merged = [...new Set([...(this.edited.get(path) ?? []), ...symbols])];
    this.edited.delete(path);
    this.edited.set(path, merged.slice(-maximumSymbols));
    trim(this.edited);
  }

  forFile(path: string): FoldAttention {
    return {
      lines: new Set(this.pointed.get(path) ?? []),
      symbols: new Set(this.edited.get(path) ?? []),
    };
  }

  snapshot(): LightAttentionState {
    return {
      pointed: [...this.pointed].map(([path, lines]) => ({ path, lines: [...lines] })),
      edited: [...this.edited].map(([path, symbols]) => ({ path, symbols: [...symbols] })),
    };
  }

  hydrate(state: LightAttentionState | undefined) {
    this.pointed.clear();
    this.edited.clear();
    for (const entry of state?.pointed ?? []) this.pointed.set(entry.path, [...entry.lines]);
    for (const entry of state?.edited ?? []) this.edited.set(entry.path, [...entry.symbols]);
  }
}

function trim(map: Map<string, unknown>) {
  while (map.size > maximumPaths) map.delete(map.keys().next().value!);
}
