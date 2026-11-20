// The security audit's agent steps through the engine host, against the
// real `blame-engine`, the real harness runner and a mock Anthropic server:
// a result before any code was read is refused, the harness reads the
// project, the task's records carry what the progress shows, and the
// validator cannot name a candidate it was not given. Skipped when the
// binary is not built.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { FollowEvent, SessionRecord } from "@blame/engine-client";
import { EngineHost } from "./host.js";
import type { MapSecurityAuditResult } from "../types.js";
import type { EngineHostEvent } from "./protocol.js";
import { FakeApi, MockModel, testModel, tools } from "./testing.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const binary =
  process.env.BLAME_ENGINE_BIN ?? join(root, "target/debug/blame-engine");
const runner = fileURLToPath(
  new URL("../harness/semantic-harness-runner.js", import.meta.url),
);
const model = { providerId: "anthropic", modelId: testModel };
const repository: MapSecurityAuditResult = {
  revision: { snapshotDigest: "digest", dirty: false },
  deterministic: {
    candidates: [],
    inspectedPaths: [],
    limitations: [],
    scanners: [],
  },
  surfaceMap: {
    rootName: "app",
    fileCount: 1,
    relevantFileCount: 1,
    ignoredDirectoryCount: 0,
    truncated: false,
    languages: ["TypeScript"],
    frameworks: [],
    projectRoots: [],
    services: [],
    entrypoints: [],
    sensitivePaths: ["src/projects.ts"],
    dependencyPaths: [],
    infrastructurePaths: [],
    ciPaths: [],
    evidencePaths: [],
  },
};
const threatModel = {
  assets: ["Projects"],
  actors: ["Authenticated user"],
  trustBoundaries: [],
  attackerInputs: ["project id"],
  securityInvariants: [],
};
const candidate = {
  id: "c1",
  title: "Unscoped project deletion",
  summary: "Deletes a project by id without checking its tenant.",
  vulnerabilityFamily: "broken access control",
  rootControl: "tenant ownership",
  component: "projects",
  attacker: "Authenticated user",
  locations: [{ path: "src/projects.ts", startLine: 1 }],
  evidence: [{ summary: "No tenant filter." }],
  taxonomy: { cwe: ["CWE-862"] },
};
const discovered = {
  threatModel,
  candidates: [candidate],
  inspectedPaths: ["src/projects.ts"],
  limitations: [],
};

describe(
  "security audit tasks",
  { skip: !existsSync(binary) && "no engine binary" },
  () => {
    let mock: MockModel;
    let api: FakeApi;
    let host: EngineHost;
    let workspace: string;
    let dataDir: string;
    const events: EngineHostEvent[] = [];

    before(async () => {
      mock = await MockModel.start([]);
      api = await FakeApi.start();
      api.modelBase = mock.base;
      workspace = mkdtempSync(join(tmpdir(), "blame-security-tasks-"));
      mkdirSync(join(workspace, "src"));
      writeFileSync(
        join(workspace, "src", "projects.ts"),
        "export const remove = (id: string) => db.projects.delete(id);\n",
      );
      dataDir = mkdtempSync(join(tmpdir(), "blame-security-tasks-data-"));
      host = new EngineHost({
        binary,
        dataDir,
        harnessCommand: [process.execPath, runner, "--serve"],
        clientVersion: "test",
        env: { ...process.env, BLAME_ENGINE_LOG: "warn" },
        emit: (event) => events.push(event),
      });
      await host.call("connect", { api: api.connection() });
    });

    after(async () => {
      await host.shutdown();
      await mock.close();
      await api.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    });

    function records(subscription: string): SessionRecord[] {
      return events.flatMap((event) =>
        event.type === "follow" &&
        event.subscription === subscription &&
        event.event.type === "records"
          ? (event.event as Extract<FollowEvent, { type: "records" }>).records
          : [],
      );
    }

    it("an investigator reads the code before its candidates are accepted", async () => {
      mock.script(
        tools({ name: "submit_security_discovery", input: discovered }),
        tools({ name: "read_code", input: { target: "src/projects.ts" } }),
        tools({ name: "submit_security_discovery", input: discovered }),
      );
      const asked = mock.requests.length;
      const task = "security-audit-1-discovery-baseline";
      const result = await host.call("discoverSecurityAudit", {
        task,
        model,
        workspace: { root: workspace },
        mode: "standard",
        perspective: "baseline",
        repository,
      });
      assert.equal(result.session, task);
      assert.deepEqual(
        result.candidates.map(({ id, sources }) => ({ id, sources })),
        [{ id: "c1", sources: ["ai:baseline"] }],
      );
      const requests = mock.requests.slice(asked);
      assert.equal(requests.length, 3);
      const offered = (
        requests[0]!.body as { tools: Array<{ name: string }> }
      ).tools
        .map((tool) => tool.name)
        .sort();
      assert.deepEqual(offered, [
        "read_code",
        "search_code",
        "submit_security_discovery",
      ]);
      assert.match(
        JSON.stringify(requests[1]!.body.messages),
        /Not accepted.*read_code/,
        "the first result came before any code was read",
      );
      assert.match(
        JSON.stringify(requests[2]!.body.messages),
        /db\.projects\.delete/,
        "the harness read the project's file",
      );

      // What the progress shows comes from the task's records.
      await host.call("follow", { session: task, subscription: "audit-1" });
      const deadline = Date.now() + 10_000;
      while (!records("audit-1").some((r) => r.type === "turn_ended")) {
        if (Date.now() > deadline) throw new Error("no records");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const started = records("audit-1").flatMap((record) =>
        record.type === "tool_call_started" ? [record.name] : [],
      );
      assert.ok(started.includes("read_code"), String(started));
      await host.call("unfollow", { subscription: "audit-1" });
    });

    it("the validator names only the candidates it was given", async () => {
      const finding = {
        candidateIds: ["candidate-1"],
        title: "Unscoped project deletion",
        severity: "high",
        confidence: "high",
        priority: "p1",
        taxonomy: { cwe: ["CWE-862"] },
        attacker: "Authenticated user",
        rootCause: { summary: "No tenant check before the delete." },
        attackPath: [{ label: "DELETE /projects/:id" }],
        impact: "Another tenant's project is deleted.",
        evidence: [{ summary: "remove() deletes by id only." }],
        affectedLocations: [{ path: "src/projects.ts", startLine: 1 }],
        remediation: { summary: "Scope the delete.", guidance: [] },
        rationale: "Reachable, and nothing checks the tenant.",
        counterEvidence: [],
      };
      const result_ = {
        rejected: [],
        inspectedPaths: ["src/projects.ts"],
        limitations: [],
      };
      mock.script(
        tools({ name: "read_code", input: { target: "src/projects.ts" } }),
        tools({
          name: "submit_security_validation",
          input: {
            ...result_,
            findings: [{ ...finding, candidateIds: ["made-up"] }],
          },
        }),
        tools({
          name: "submit_security_validation",
          input: { ...result_, findings: [finding] },
        }),
      );
      const asked = mock.requests.length;
      const result = await host.call("validateSecurityAudit", {
        task: "security-audit-1-validation",
        model,
        workspace: { root: workspace },
        mode: "standard",
        repository,
        discoveries: [
          {
            ...discovered,
            candidates: [
              {
                ...candidate,
                sourceCandidateIds: ["c1"],
                sources: ["ai:baseline"],
              },
            ],
          },
        ],
      });
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0]?.severity, "high");
      assert.equal(result.candidateCount, 1);
      assert.equal(result.coverage.reviewedFiles, 1);
      assert.match(
        JSON.stringify(mock.requests.slice(asked)[2]!.body.messages),
        /Not accepted.*candidateIds\/0: must be one of/,
      );
    });
  },
);
