// Module hooks for the Rust harness conformance runs: imports of
// ./light-workspace.js from the tests, their fixture and the modules that
// build workspaces for them (light-tools, light-executor) load
// rust-harness-adapter.js instead. The adapter itself, in compare mode,
// still gets the TypeScript workspace. Registered by rust-harness-register.js.

type ResolveContext = { parentURL?: string };
type NextResolve = (specifier: string, context: ResolveContext) => Promise<{ url: string }>;

const redirected = /\/harness\/(?:[^/]+\.test|light-agent-guidance-fixture|light-tools|light-executor)\.js$/u;

export async function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve) {
  const parent = context.parentURL ?? "";
  if (specifier === "./light-workspace.js" && redirected.test(parent))
    return nextResolve("./rust-harness-adapter.js", context);
  return nextResolve(specifier, context);
}
