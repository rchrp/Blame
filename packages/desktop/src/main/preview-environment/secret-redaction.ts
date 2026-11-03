import { secretEnvVariable } from "./dotenv.ts";
import { resolveForView } from "./environment-view.ts";

// Text that leaves for an agent (container logs, setup diagnostics) never
// carries a secret value of the story's preview: each one becomes the name
// of its variable. Values are found from the story's resolved environment,
// read again at most every half minute.

const cacheMs = 30_000;
const cached = new Map<string, { at: number; secrets: Promise<Secrets> }>();

type Secrets = Map<string, string>;

export function worktreeSecrets(worktree: string): Promise<Secrets> {
  const entry = cached.get(worktree);
  if (entry && Date.now() - entry.at < cacheMs) return entry.secrets;
  const secrets = resolveForView({ worktree })
    .then(({ environment }) =>
      secretValues(
        environment.resolved.items.flatMap(({ variables }) => variables),
      ),
    )
    .catch(() => new Map<string, string>());
  cached.set(worktree, { at: Date.now(), secrets });
  return secrets;
}

export function secretValues(
  variables: Array<{ key: string; value: string }>,
): Secrets {
  const secrets: Secrets = new Map();
  for (const { key, value } of variables) {
    if (!value || !secretEnvVariable(key, value)) continue;
    const password = /^[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:([^\s/@]+)@/i.exec(
      value,
    )?.[1];
    if (password && password.length >= 4) secrets.set(password, key);
    if (value.length >= 6) secrets.set(value, key);
  }
  return secrets;
}

export function redactSecrets(text: string, secrets: Secrets) {
  let redacted = text;
  // The longest first, so a URL goes before the password it holds.
  for (const [value, key] of [...secrets].sort(
    ([left], [right]) => right.length - left.length,
  ))
    redacted = redacted.split(value).join(`[${key} hidden]`);
  return redacted;
}

/** The value with every string in it redacted. */
export function redactDeep<T>(value: T, secrets: Secrets): T {
  if (!secrets.size) return value;
  if (typeof value === "string") return redactSecrets(value, secrets) as T;
  if (Array.isArray(value))
    return value.map((entry) => redactDeep(entry, secrets)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      redactDeep(entry, secrets),
    ]),
  ) as T;
}

export async function redactForWorktree<T>(worktree: string, value: T) {
  return redactDeep(value, await worktreeSecrets(worktree));
}
