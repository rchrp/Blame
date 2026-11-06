// What one open_component_preview call asks for, checked the same way by
// the agent tool and by the desktop service that renders it.

export const componentPreviewFilePattern = "*.blame-preview.*";
export const componentPreviewMaximumRenders = 6;
export const componentPreviewDefaultWidth = 1280;
export const componentPreviewWidthRange = { maximum: 4096, minimum: 200 };

export type ComponentPreviewTheme = "dark" | "light";

export type ComponentPreviewRequest = {
  // Path of the preview file, relative to the worktree, with "/" separators.
  file: string;
  states: string[];
  themes: ComponentPreviewTheme[];
  widths: number[];
};

export type ComponentPreviewRender = {
  state: string;
  theme: ComponentPreviewTheme;
  width: number;
};

type Parsed<T> = { ok: true; value: T } | { message: string; ok: false };

const fileName = /^[^/]+\.blame-preview\.(?:tsx|jsx|ts|js|mts|mjs)$/u;
const stateName = /^[A-Za-z_$][\w$-]{0,63}$/u;

// A worktree-relative preview file, normalized to "/" separators, or
// undefined when the path leaves the worktree or is not a preview file.
export function componentPreviewFile(value: string) {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!path || path.startsWith("/") || /^[A-Za-z]:/u.test(path))
    return undefined;
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment === "node_modules",
    )
  )
    return undefined;
  return fileName.test(segments.at(-1) ?? "") ? path : undefined;
}

export function parseComponentPreviewRequest(
  value: unknown,
): Parsed<ComponentPreviewRequest> {
  const record = recordValue(value);
  const rawFile = typeof record.file === "string" ? record.file : "";
  const file = componentPreviewFile(rawFile);
  if (!file)
    return failure(
      `file must be a path relative to the worktree, ending in .blame-preview.tsx (or .jsx, .ts, .js, .mts, .mjs), outside node_modules. Got: ${rawFile.trim() || "(empty)"}`,
    );
  const states = parsedStates(record.states);
  if (!states.ok) return states;
  const themes = parsedThemes(record.themes);
  if (!themes.ok) return themes;
  const widths = parsedWidths(record.widths);
  if (!widths.ok) return widths;
  const count = states.value.length * themes.value.length * widths.value.length;
  if (count > componentPreviewMaximumRenders)
    return failure(
      `${states.value.length} states × ${themes.value.length} themes × ${widths.value.length} widths make ${count} renders; one call renders at most ${componentPreviewMaximumRenders}. Split it into several calls.`,
    );
  return {
    ok: true,
    value: {
      file,
      states: states.value,
      themes: themes.value,
      widths: widths.value,
    },
  };
}

// Every combination, state first, then theme, then width.
export function componentPreviewRenders(
  request: ComponentPreviewRequest,
): ComponentPreviewRender[] {
  return request.states.flatMap((state) =>
    request.themes.flatMap((theme) =>
      request.widths.map((width) => ({ state, theme, width })),
    ),
  );
}

function parsedStates(value: unknown): Parsed<string[]> {
  if (value === undefined) return { ok: true, value: ["default"] };
  const list = uniqueList(value);
  if (!list?.length || list.length > componentPreviewMaximumRenders)
    return failure(
      `states must list 1 to ${componentPreviewMaximumRenders} export names, such as ["default", "empty"].`,
    );
  const invalid = list.find(
    (item) => typeof item !== "string" || !stateName.test(item),
  );
  if (invalid !== undefined)
    return failure(
      `Each state is the name of an export of the preview file, such as "default" or "empty". Got: ${JSON.stringify(invalid)}`,
    );
  return { ok: true, value: list as string[] };
}

function parsedThemes(value: unknown): Parsed<ComponentPreviewTheme[]> {
  if (value === undefined) return { ok: true, value: ["light"] };
  const list = uniqueList(value);
  if (!list?.length || list.some((item) => item !== "light" && item !== "dark"))
    return failure('themes must list "light", "dark" or both.');
  return { ok: true, value: list as ComponentPreviewTheme[] };
}

function parsedWidths(value: unknown): Parsed<number[]> {
  if (value === undefined)
    return { ok: true, value: [componentPreviewDefaultWidth] };
  const list = uniqueList(value);
  const { maximum, minimum } = componentPreviewWidthRange;
  if (
    !list?.length ||
    list.length > componentPreviewMaximumRenders ||
    list.some(
      (item) =>
        typeof item !== "number" ||
        !Number.isInteger(item) ||
        item < minimum ||
        item > maximum,
    )
  )
    return failure(
      `widths must list 1 to ${componentPreviewMaximumRenders} whole numbers of CSS pixels between ${minimum} and ${maximum}, such as [390, 1280].`,
    );
  return { ok: true, value: list as number[] };
}

function uniqueList(value: unknown) {
  return Array.isArray(value) ? [...new Set<unknown>(value)] : undefined;
}

function failure(message: string): { message: string; ok: false } {
  return { message, ok: false };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
