// Module hooks for the Rust harness conformance runs: imports of
// ./light-workspace.js from the tests, their fixture and the modules that
// build workspaces for them (light-tools, light-executor) load
// rust-harness-adapter.js instead, and in rust mode their imports of
// ./light-finish-service.js load rust-harness-finish.js. The adapter itself, in compare mode,
// still gets the TypeScript workspace. Registered by rust-harness-register.js.

type ResolveContext = { parentURL?: string };
type NextResolve = (specifier: string, context: ResolveContext) => Promise<{ url: string }>;

const redirected = /\/harness\/(?:[^/]+\.test|light-agent-guidance-fixture|light-tools|light-executor)\.js$/u;
// finish_task: the finish service of the tests, the fixture, the executor
// and the finish tool, in rust mode only (compare mode compares workspaces).
const finishing = /\/harness\/(?:[^/]+\.test|light-agent-guidance-fixture|light-executor|finish-task)\.js$/u;

export async function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve) {
  const parent = context.parentURL ?? "";
  if (specifier === "./light-workspace.js" && redirected.test(parent))
    return nextResolve("./rust-harness-adapter.js", context);
  if (specifier === "./light-finish-service.js" && process.env.BLAME_HARNESS_RUST && finishing.test(parent))
    return nextResolve("./rust-harness-finish.js", context);
  return nextResolve(specifier, context);
}
