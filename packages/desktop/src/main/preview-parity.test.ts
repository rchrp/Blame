import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  generatePreviewArtifacts,
  parsePreviewManifest,
} from "@blame/agent-runtime";
import { compilePreviewManifest, probeEndpoint } from "@blame/preview-runtime";
import { parse as parseYaml } from "yaml";

// Local previews run the docker-compose.yml generated from the manifest;
// cloud previews run the compiled execution plan. For every manifest of the
// corpus, both must agree on what runs and how it is wired. The compose file
// is also kept as a golden file so a generator change shows up in review
// (UPDATE_PREVIEW_GOLDEN=1 rewrites them).

const corpus = join(import.meta.dirname, "preview-parity-corpus");
const localOnlyServices = new Set(["blame-volumes-init"]);

type ComposeService = {
  depends_on?: Record<string, unknown>;
  environment?: Record<string, string>;
  labels?: Record<string, string>;
};

for (const file of readdirSync(corpus).filter((name) =>
  name.endsWith(".json"),
)) {
  const name = file.replace(/\.json$/, "");
  const manifest = parsePreviewManifest(
    JSON.parse(readFileSync(join(corpus, file), "utf8")),
  );
  const dockerCompose = generatePreviewArtifacts(manifest).dockerCompose;
  const compose = parseYaml(dockerCompose).services as Record<
    string,
    ComposeService
  >;
  const plan = compilePreviewManifest(manifest);

  test(`${name}: local and cloud run the same services and setup`, () => {
    const setupIds = Object.keys(compose).filter(
      (id) => compose[id]?.labels?.["blame.setup"] === "true",
    );
    const serviceIds = Object.keys(compose).filter(
      (id) => !localOnlyServices.has(id) && !setupIds.includes(id),
    );
    assert.deepEqual(
      [...serviceIds].sort(),
      plan.services.map(({ id }) => id).sort(),
    );
    assert.deepEqual(
      [...setupIds].sort(),
      plan.setup.map(({ id }) => id).sort(),
    );
    // The plan's setup order satisfies every local setup dependency.
    const order = plan.setup.map(({ id }) => id);
    for (const id of setupIds) {
      for (const dependency of dependencies(compose[id])) {
        if (!setupIds.includes(dependency)) continue;
        assert.ok(
          order.indexOf(dependency) < order.indexOf(id),
          `${dependency} runs before ${id}`,
        );
      }
    }
  });

  test(`${name}: local and cloud wire dependencies and environment alike`, () => {
    for (const item of [...plan.setup, ...plan.services]) {
      const local = compose[item.id];
      assert.deepEqual(
        dependencies(local).sort(),
        [...item.dependsOn].sort(),
        `${item.id} dependencies`,
      );
      assert.deepEqual(
        local?.environment ?? {},
        item.environment,
        `${item.id} environment`,
      );
    }
  });

  test(`${name}: local and cloud expose the same endpoints and probes`, () => {
    for (const service of plan.services) {
      const labels = compose[service.id]?.labels ?? {};
      const endpoints = service.endpoints.map((_, index) => ({
        id: labels[`blame.endpoint.${index}.id`],
        protocol: labels[`blame.endpoint.${index}.protocol`],
        port: Number(labels[`blame.endpoint.${index}.port`]),
      }));
      assert.deepEqual(
        endpoints,
        service.endpoints.map(({ id, protocol, port }) => ({
          id,
          protocol,
          port,
        })),
        `${service.id} endpoints`,
      );
    }
    assert.equal(plan.probes.length, manifest.probes.length);
    for (const probe of plan.probes) {
      assert.ok(probeEndpoint(plan, probe), `${probe.id} target exists`);
    }
  });

  test(`${name}: local compose matches its golden file`, () => {
    const golden = join(corpus, `${name}.compose.yml`);
    if (process.env.UPDATE_PREVIEW_GOLDEN === "1") {
      writeFileSync(golden, dockerCompose);
    }
    assert.equal(dockerCompose, readFileSync(golden, "utf8"));
  });
}

function dependencies(service: ComposeService | undefined) {
  return Object.keys(service?.depends_on ?? {}).filter(
    (id) => !localOnlyServices.has(id),
  );
}
