import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parsePreviewManifest } from "@blame/agent-runtime";
import { compilePreviewManifest, probeEndpoint } from "@blame/preview-runtime";
import {
  publishedEndpointKeys,
  renderCompose,
} from "@blame/preview-runtime/compose";
import { parse as parseYaml } from "yaml";

// Local and cloud previews render one Compose project from the same plan,
// with a different target. For every manifest of the corpus, both targets
// must run the same services and setup, wired and checked the same way;
// only the workspace source, published ports, cache names and sandbox
// hardening differ. The local render is kept as a golden file so a renderer
// change shows up in review (UPDATE_PREVIEW_GOLDEN=1 rewrites them).

const corpus = join(import.meta.dirname, "preview-parity-corpus");
const sandboxOnlyKeys = new Set([
  "cap_drop",
  "pids_limit",
  "read_only",
  "security_opt",
]);

type ComposeService = Record<string, unknown> & {
  environment?: Record<string, string>;
  volumes?: string[];
};

for (const file of readdirSync(corpus).filter((name) =>
  name.endsWith(".json"),
)) {
  const name = file.replace(/\.json$/, "");
  const manifest = parsePreviewManifest(
    JSON.parse(readFileSync(join(corpus, file), "utf8")),
  );
  const plan = compilePreviewManifest(manifest);
  const keys = publishedEndpointKeys(plan);
  const local = renderCompose(plan, {
    kind: "local",
    projectName: `blame_${name.replace(/-/g, "_")}`,
    workspacePath: "/home/blame/.local/share/blame/runtime/worktrees/story",
    projectUser: "1001:1001",
    hostPorts: Object.fromEntries(
      keys.map((key, index) => [key, 50_000 + index]),
    ),
    dependencyKey: "0123456789ab",
  });
  const sandbox = renderCompose(plan, {
    kind: "sandbox",
    projectUser: "1000:1000",
    proxyCertificatePath: "/etc/pki/proxy-ca.pem",
    browserBindingUrls: Object.fromEntries(
      keys.map((key) => [key, `https://${key.replace(":", "-")}.preview.test`]),
    ),
  });
  const localServices = services(local.yaml);
  const sandboxServices = services(sandbox.yaml);

  test(`${name}: both targets run the plan's services and setup`, () => {
    const expected = [
      ...plan.setup.map(({ id }) => `setup-${id}`),
      ...plan.services.map(({ id }) => id),
    ];
    assert.deepEqual(Object.keys(localServices), expected);
    assert.deepEqual(Object.keys(sandboxServices), expected);
  });

  test(`${name}: both targets wire and check services alike`, () => {
    for (const [id, service] of Object.entries(sandboxServices)) {
      const other = localServices[id]!;
      for (const key of new Set([
        ...Object.keys(service),
        ...Object.keys(other),
      ])) {
        if (
          [
            "environment",
            "ports",
            "volumes",
            "build",
            "user",
            "restart",
          ].includes(key)
        )
          continue;
        if (sandboxOnlyKeys.has(key)) continue;
        assert.deepEqual(other[key], service[key], `${id} ${key}`);
      }
      assert.deepEqual(
        withoutTargetValues(other.environment, plan, id, true),
        withoutTargetValues(service.environment, plan, id, false),
        `${id} environment`,
      );
    }
  });

  test(`${name}: probes target published endpoints`, () => {
    assert.equal(plan.probes.length, manifest.probes.length);
    for (const probe of plan.probes) {
      const endpoint = probeEndpoint(plan, probe);
      assert.ok(endpoint, `${probe.id} target exists`);
      assert.ok(local.targets[`${probe.target.serviceId}:${endpoint.id}`]);
    }
  });

  test(`${name}: local compose matches its golden file`, () => {
    const golden = join(corpus, `${name}.compose.yml`);
    if (process.env.UPDATE_PREVIEW_GOLDEN === "1") {
      writeFileSync(golden, local.yaml);
    }
    assert.equal(local.yaml, readFileSync(golden, "utf8"));
  });
}

function services(yaml: string) {
  return (parseYaml(yaml) as { services: Record<string, ComposeService> })
    .services;
}

// Browser bindings resolve to the target's own origin, and the sandbox
// trusts its proxy certificate; every other value is the plan's.
function withoutTargetValues(
  environment: Record<string, string> | undefined,
  plan: ReturnType<typeof compilePreviewManifest>,
  id: string,
  local: boolean,
) {
  const browserKeys = new Set(
    plan.services
      .find((service) => service.id === id)
      ?.bindings.filter(({ exposure }) => exposure === "browser")
      .map(({ targetKey }) => targetKey) ?? [],
  );
  return Object.fromEntries(
    Object.entries(environment ?? {}).filter(
      ([key]) =>
        !browserKeys.has(key) && (local || key !== "NODE_EXTRA_CA_CERTS"),
    ),
  );
}
