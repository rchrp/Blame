import assert from "node:assert/strict";
import test from "node:test";

import { PreviewLiveness } from "./preview-liveness.ts";

function checks(state: {
  answers: boolean;
  running: boolean;
  probes?: boolean;
}) {
  return {
    answers: async () => state.answers,
    servicesRunning: async () => state.running,
    probesPass: async () => state.probes ?? true,
  };
}

test("keeps a preview that answers, even with an error page", async () => {
  const liveness = new PreviewLiveness(90_000);
  assert.equal(
    await liveness.serving("story", checks({ answers: true, running: true })),
    true,
  );
});

test("restarts a preview whose functional checks fail", async () => {
  const liveness = new PreviewLiveness(90_000);
  assert.equal(
    await liveness.serving(
      "story",
      checks({ answers: true, running: true, probes: false }),
    ),
    false,
  );
});

test("restarts at once when a service stopped", async () => {
  const liveness = new PreviewLiveness(90_000);
  assert.equal(
    await liveness.serving("story", checks({ answers: false, running: false })),
    false,
  );
});

test("waits while running services rebuild, then restarts a silent server", async () => {
  const liveness = new PreviewLiveness(90_000);
  const silent = checks({ answers: false, running: true });
  assert.equal(await liveness.serving("story", silent, 0), true);
  assert.equal(await liveness.serving("story", silent, 60_000), true);
  assert.equal(await liveness.serving("story", silent, 90_000), false);
});

test("an answer resets the wait", async () => {
  const liveness = new PreviewLiveness(90_000);
  const silent = checks({ answers: false, running: true });
  await liveness.serving("story", silent, 0);
  await liveness.serving("story", checks({ answers: true, running: true }), 80_000);
  assert.equal(await liveness.serving("story", silent, 100_000), true);
  assert.equal(await liveness.serving("story", silent, 189_999), true);
  assert.equal(await liveness.serving("story", silent, 190_000), false);
});

test("each story waits on its own", async () => {
  const liveness = new PreviewLiveness(90_000);
  const silent = checks({ answers: false, running: true });
  await liveness.serving("first", silent, 0);
  assert.equal(await liveness.serving("second", silent, 95_000), true);
  assert.equal(await liveness.serving("first", silent, 95_000), false);
});
