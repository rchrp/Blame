import assert from "node:assert/strict";
import test from "node:test";

import {
  InitializationBlockedError,
  InitializationSession,
} from "./initialization-session.js";
import {
  PreviewSetupError,
  type PreviewSetupIssue,
} from "./project-preview-validation.js";

const migrations: PreviewSetupIssue = {
  severity: "blocking",
  rule: "must run detected database migrations before starting backend services",
  warning: "Migrations do not run.",
};
const install: PreviewSetupIssue = {
  severity: "warning",
  rule: "must install detected Node dependencies before starting services",
  warning: "No setup task seems to install the Node dependencies.",
};

/** A check that rejects inputs listed in `issues` by their `id`. */
function checker(issues: Record<string, PreviewSetupIssue[]>) {
  return (input: unknown, options: { acceptWarnings?: boolean }) => {
    const id = (input as { id: string }).id;
    const found = (issues[id] ?? []).filter(
      (issue) => !options.acceptWarnings || issue.severity === "blocking",
    );
    if (found.length) throw new PreviewSetupError(found);
    return { id, acceptedWarnings: Boolean(options.acceptWarnings) };
  };
}

test("accepts a valid submission and ends the session", () => {
  const session = new InitializationSession(checker({}));
  assert.deepEqual(session.submit({ id: "ok" }), { accepted: true });
  const outcome = session.outcome();
  assert.equal(outcome.type, "accepted");
});

test("sends every problem back to the agent, then accepts the fix", () => {
  const rejected: number[] = [];
  const session = new InitializationSession(
    checker({ bad: [migrations, install] }),
    { onRejected: (submission) => rejected.push(submission) },
  );
  assert.throws(
    () => session.submit({ id: "bad" }),
    (error: Error) => {
      assert.match(error.message, /Submission 1 of 10 was rejected/);
      assert.match(error.message, /Problems \(2\)/);
      assert.match(error.message, /1\. \[must fix\] .*migrations/);
      assert.match(error.message, /2\. \[warning\] .*Node dependencies/);
      return true;
    },
  );
  assert.deepEqual(rejected, [1]);
  assert.deepEqual(session.submit({ id: "good" }), { accepted: true });
  assert.equal(session.outcome().type, "accepted");
});

test("saves a setup whose warnings the agent confirms by resubmitting it", () => {
  const session = new InitializationSession(checker({ same: [install] }));
  assert.throws(() => session.submit({ id: "same" }));
  assert.deepEqual(session.submit({ id: "same" }), {
    accepted: true,
    savedWithWarnings: true,
  });
  const outcome = session.outcome();
  assert.ok(outcome.type === "accepted");
  assert.deepEqual(outcome.result, { id: "same", acceptedWarnings: true });
});

test("stops after the same blocking problem three times in a row", () => {
  const session = new InitializationSession(
    checker({ a: [migrations], b: [migrations], c: [migrations] }),
  );
  assert.throws(() => session.submit({ id: "a" }));
  assert.throws(() => session.submit({ id: "b" }));
  const answer = session.submit({ id: "c" });
  assert.equal(answer.accepted, false);
  const outcome = session.outcome();
  assert.ok(outcome.type === "stopped");
  assert.match(outcome.error.message, /3 times in a row/);
});

test("accepts warnings on the last submission", () => {
  const session = new InitializationSession(
    checker({ a: [migrations], b: [install] }),
    {},
    2,
  );
  assert.throws(() => session.submit({ id: "a" }));
  assert.deepEqual(session.submit({ id: "b" }), { accepted: true });
  const outcome = session.outcome();
  assert.ok(outcome.type === "accepted");
  assert.deepEqual(outcome.result, { id: "b", acceptedWarnings: true });
});

test("asks to fix a fixable rejection before recording a block", () => {
  const session = new InitializationSession(checker({ a: [migrations] }));
  assert.throws(() => session.submit({ id: "a" }));
  const block = {
    category: "missing_secret",
    summary: "The app needs a Stripe key to start.",
    userAction: "Add STRIPE_SECRET_KEY to .env.example.",
  };
  assert.throws(
    () => session.reportBlocked(block),
    /rejected for a problem in the setup itself/,
  );
  assert.deepEqual(session.reportBlocked(block), { recorded: true });
  const outcome = session.outcome();
  assert.ok(outcome.type === "blocked");
  const error = new InitializationBlockedError(outcome.blocked);
  assert.equal(
    error.message,
    "Initialization blocked [missing_secret]: The app needs a Stripe key to start.\nWhat you can do: Add STRIPE_SECRET_KEY to .env.example.",
  );
});

test("records a block once the same problem came back twice", () => {
  const session = new InitializationSession(
    checker({ a: [migrations], b: [migrations] }),
  );
  assert.throws(() => session.submit({ id: "a" }));
  assert.throws(() => session.submit({ id: "b" }));
  assert.deepEqual(
    session.reportBlocked({
      category: "blame_problem",
      summary: "A Blame rule rejects every PostgreSQL image.",
      userAction: "Report it to Blame.",
    }),
    { recorded: true },
  );
});

test("names the setup, not internal fields, when it stops", () => {
  const session = new InitializationSession(
    checker({ a: [migrations], b: [migrations], c: [migrations] }),
  );
  assert.throws(() => session.submit({ id: "a" }));
  assert.throws(() => session.submit({ id: "b" }));
  session.submit({ id: "c" });
  const outcome = session.outcome();
  assert.ok(outcome.type === "stopped");
  assert.equal(
    outcome.error.message,
    "The setup was rejected 3 times in a row for the same problem: The setup must run detected database migrations before starting backend services.",
  );
});

test("records a block straight away when nothing was rejected", () => {
  const session = new InitializationSession(checker({}));
  assert.throws(
    () =>
      session.reportBlocked({
        category: "other",
        summary: "x",
        userAction: "y",
      }),
    /category must be one of/,
  );
  assert.deepEqual(
    session.reportBlocked({
      category: "unsupported_stack",
      summary: "This is an iOS app with no server.",
      userAction: "Run stories in Direct mode.",
    }),
    { recorded: true },
  );
});
