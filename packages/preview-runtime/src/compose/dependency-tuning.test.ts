import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import type {
  PreviewExecutionPlan,
  ServiceLaunchPlan,
} from "../domain/execution-plan.js";
import { renderCompose } from "./compose-renderer.js";
import type { LocalComposeTarget } from "./compose-target.js";
import { dependencyTuning } from "./dependency-tuning.js";

function dependency(
  id: string,
  image: string,
  extra: Partial<ServiceLaunchPlan> = {},
): ServiceLaunchPlan {
  return {
    id,
    kind: "dependency",
    container: { image },
    workingDir: "/workspace",
    environment: {},
    dependsOn: [],
    endpoints: [{ id: "tcp", protocol: "tcp", port: 3306 }],
    bindings: [],
    ...extra,
  };
}

test("tunes official MySQL, Elasticsearch and OpenSearch images", () => {
  assert.deepEqual(dependencyTuning(dependency("db", "mysql:8.4"))?.command, [
    "mysqld",
    "--performance-schema=OFF",
    "--innodb-buffer-pool-size=64M",
  ]);
  assert.ok(
    dependencyTuning(dependency("db", "docker.io/library/mysql@sha256:ab")),
  );
  assert.deepEqual(
    dependencyTuning(
      dependency(
        "search",
        "docker.elastic.co/elasticsearch/elasticsearch:8.17.0",
      ),
    )?.environment,
    { ES_JAVA_OPTS: "-Xms512m -Xmx512m" },
  );
  assert.deepEqual(
    dependencyTuning(dependency("search", "opensearchproject/opensearch:2"))
      ?.environment,
    { OPENSEARCH_JAVA_OPTS: "-Xms512m -Xmx512m" },
  );
});

test("leaves other images and declared settings as they are", () => {
  for (const image of [
    "bitnami/mysql:8.4",
    "mariadb:11",
    "postgres:17-alpine",
    "mongo:8",
    "redis:7",
    "registry.example.com/mysql:8",
  ])
    assert.equal(dependencyTuning(dependency("db", image)), undefined, image);
  assert.equal(
    dependencyTuning(
      dependency("db", "mysql:8.4", { command: "mysqld --log-bin=OFF" }),
    ),
    undefined,
  );
  assert.equal(
    dependencyTuning(
      dependency("db", "mysql:8.4", { entrypoint: ["/custom.sh"] }),
    ),
    undefined,
  );
  assert.equal(
    dependencyTuning(
      dependency("search", "elasticsearch:8.17.0", {
        environment: { ES_JAVA_OPTS: "-Xmx2g" },
      }),
    ),
    undefined,
  );
  assert.equal(
    dependencyTuning({ ...dependency("db", "mysql:8.4"), kind: "preview" }),
    undefined,
  );
});

test("renders the settings only for the dependencies the target names", () => {
  const plan = {
    version: 2,
    workspaceRoot: "/workspace",
    setup: [],
    services: [
      dependency("db", "mysql:8.4"),
      dependency("search", "elasticsearch:8.17.0", {
        environment: { "discovery.type": "single-node" },
      }),
    ],
    caches: [],
    probes: [],
    environmentPlan: { entries: [] },
    networking: {
      gatewayListeners: [],
      loopbackGroups: [],
      publishedPortCount: 0,
      browserBindingCount: 0,
      requiresSharedLoopback: false,
      requiresWebSockets: false,
      integratedPreviewRequired: false,
      incompatibilityReasons: [],
    },
    detectedCompatibility: [],
  } as unknown as PreviewExecutionPlan;
  const target: LocalComposeTarget = {
    kind: "local",
    projectName: "blame_tuning",
    workspacePath: "/home/blame/worktrees/story",
    projectUser: "1001:1001",
    hostPorts: { "db:tcp": 51000, "search:tcp": 51001 },
    dependencyKey: "abc",
  };
  const services = (yaml: string) =>
    (parse(yaml) as { services: Record<string, Record<string, unknown>> })
      .services;
  const untouched = services(renderCompose(plan, target).yaml);
  assert.equal(untouched.db!.command, undefined);
  assert.equal(
    (untouched.search!.environment as Record<string, string>).ES_JAVA_OPTS,
    undefined,
  );
  assert.deepEqual(untouched.db!.labels, { "blame.preview": "true" });

  const tuned = services(
    renderCompose(plan, { ...target, tunedDependencies: ["db", "search"] })
      .yaml,
  );
  assert.deepEqual(tuned.db!.command, [
    "mysqld",
    "--performance-schema=OFF",
    "--innodb-buffer-pool-size=64M",
  ]);
  assert.equal(
    (tuned.search!.environment as Record<string, string>).ES_JAVA_OPTS,
    "-Xms512m -Xmx512m",
  );
  assert.equal(
    (tuned.search!.environment as Record<string, string>)["discovery.type"],
    "single-node",
  );
  assert.deepEqual(tuned.db!.labels, {
    "blame.dependency-tuning": "1",
    "blame.preview": "true",
  });
});
