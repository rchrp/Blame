import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  composeWithNonMutatingNpmInstalls,
  composeWithCurrentDependencyVolumes,
  composeWithoutNumericSuUser,
  composeHostPorts,
  composeWithAllocatedHostPorts,
  dockerComposeForPreview,
  dockerComposeWithCiForPackageInstalls,
  dockerComposeWithCorepackPnpm,
  dockerComposeWithHostFileMounts,
} from "./workspace-compose.ts";
import {
  dockerComposeWithDependencyVolumes,
  dependencyVolumeHashFromInputs,
} from "./workspace-compose-volumes.ts";

test("refreshes existing preview caches after package edits without rotating database volumes", () => {
  const oldKey = "f97e587feee3";
  const key = "154e50fa4907";
  const compose = `services:
  deps:
    labels:
      blame.dependencies.cache.key: ${oldKey}
    volumes:
      - blame_node_modules_${oldKey}:/workspace/node_modules
      - blame_node_modules_${oldKey}_apps_web:/workspace/apps/web/node_modules
  init:
    volumes:
      - blame_node_modules_${oldKey}:/workspace/node_modules
  web:
    volumes:
      - type: volume
        source: blame_node_modules_${oldKey}_apps_web
        target: /workspace/apps/web/node_modules
  db:
    volumes:
      - project_database:/var/lib/postgresql/data
volumes:
  blame_node_modules_${oldKey}:
    name: blame_node_modules_${oldKey}
  blame_node_modules_${oldKey}_apps_web:
    name: blame_node_modules_${oldKey}_apps_web
  project_database:
    name: project_database
`;
  const refreshed = composeWithCurrentDependencyVolumes(compose, key);
  const result = parseYaml(refreshed);
  assert.doesNotMatch(refreshed, new RegExp(oldKey));
  assert.equal(
    result.services.deps.labels["blame.dependencies.cache.key"],
    key,
  );
  assert.equal(
    result.services.web.volumes[0].source,
    `blame_node_modules_${key}_apps_web`,
  );
  assert.deepEqual(result.services.db, parseYaml(compose).services.db);
  assert.deepEqual(result.volumes.project_database, {
    name: "project_database",
  });
  assert.equal(composeWithCurrentDependencyVolumes(refreshed, key), refreshed);
});

test("refreshes list cache labels and leaves unmanaged compose files unchanged", () => {
  const compose =
    "services:\n  deps:\n    labels:\n      - blame.dependencies.cache.key=f97e587feee3\n";
  assert.deepEqual(
    parseYaml(composeWithCurrentDependencyVolumes(compose, "154e50fa4907"))
      .services.deps.labels,
    ["blame.dependencies.cache.key=154e50fa4907"],
  );
  const unmanaged = "services:\n  db:\n    image: postgres:16\n";
  assert.equal(
    composeWithCurrentDependencyVolumes(unmanaged, "154e50fa4907"),
    unmanaged,
  );
  assert.equal(composeWithCurrentDependencyVolumes(compose, ""), compose);
});

test("allocates explicit localhost ports for runtime previews", async () => {
  const compose = [
    "services:",
    "  web:",
    "    ports:",
    '      - "127.0.0.1::3000"',
  ].join("\n");

  const result = await composeWithAllocatedHostPorts(compose);

  assert.match(result, /"127\.0\.0\.1:[0-9]+:3000"/);
  assert.doesNotMatch(result, /127\.0\.0\.1::3000/);
});

test("materializes typed browser binding placeholders", async () => {
  const compose = [
    "services:",
    "  web:",
    "    environment:",
    '      PUBLIC_API_URL: "http://localhost:__BLAME_PREVIEW_PORT_api_3000__/api"',
    '      PUBLIC_PORT: "__BLAME_PREVIEW_PORT_api_3000__"',
    "    ports:",
    '      - "127.0.0.1::3000"',
    "  api:",
    "    ports:",
    '      - "127.0.0.1::3000"',
  ].join("\n");

  const result = await composeWithAllocatedHostPorts(compose);
  const hostPorts = Array.from(result.matchAll(/127\.0\.0\.1:(\d+):3000/g)).map(
    (match) => match[1],
  );

  assert.equal(hostPorts.length, 2);
  assert.notEqual(hostPorts[0], hostPorts[1]);
  assert.match(
    result,
    new RegExp(`PUBLIC_API_URL: "http://localhost:${hostPorts[1]}/api"`),
  );
  assert.match(result, new RegExp(`PUBLIC_PORT: "${hostPorts[1]}"`));
  assert.doesNotMatch(result, /__BLAME_PREVIEW_PORT/);
});

test("refreshes declared browser bindings when host ports are reallocated", async () => {
  const compose = [
    "services:",
    "  frontend:",
    "    environment:",
    '      PUBLIC_API_URL: "http://localhost:41000/api"',
    "    labels:",
    '      blame.binding.0.key: "PUBLIC_API_URL"',
    '      blame.binding.0.source.service: "backend"',
    '      blame.binding.0.source.endpoint: "http"',
    '      blame.binding.0.exposure: "browser"',
    '      blame.binding.0.format: "url"',
    "  backend:",
    "    labels:",
    '      blame.endpoint.0.id: "http"',
    '      blame.endpoint.0.protocol: "http"',
    '      blame.endpoint.0.port: "3333"',
    "    ports:",
    '      - "127.0.0.1::3333"',
  ].join("\n");

  const result = await composeWithAllocatedHostPorts(compose);
  const hostPort = /127\.0\.0\.1:(\d+):3333/.exec(result)?.[1];

  assert.ok(hostPort);
  assert.match(
    result,
    new RegExp(`PUBLIC_API_URL: "http://localhost:${hostPort}/api"`),
  );
  assert.doesNotMatch(result, /localhost:41000/);
});

test("keeps explicit localhost ports unchanged", async () => {
  const compose = [
    "services:",
    "  web:",
    "    ports:",
    '      - "127.0.0.1:4173:3000"',
  ].join("\n");

  const result = await composeWithAllocatedHostPorts(compose);

  assert.equal(result, compose);
});

test("removes invalid numeric su user commands", () => {
  const compose = [
    "services:",
    "  deps:",
    "    command: >-",
    "      bash -lc \"chown -R ${BLAME_HOST_UID}:${BLAME_HOST_GID} /workspace/node_modules && su -s /bin/bash -c 'corepack pnpm install' '#${BLAME_HOST_UID}'\"",
  ].join("\n");

  const result = composeWithoutNumericSuUser(compose);

  assert.match(result, /bash -lc 'corepack pnpm install'/);
  assert.doesNotMatch(result, /'#\$\{BLAME_HOST_UID\}'/);
});

test("uses non-mutating npm installs for runtime previews", () => {
  const compose = [
    "services:",
    "  app:",
    '    command: ["sh", "-c", "npm install --cache /npm-cache && npx nuxt dev"]',
  ].join("\n");

  const result = composeWithNonMutatingNpmInstalls(compose);

  assert.match(
    result,
    /npm install --no-package-lock --cache \/npm-cache && npx nuxt dev/,
  );
  assert.doesNotMatch(result, /npm ci/);
});

test("keeps already non-mutating npm installs unchanged", () => {
  const compose = [
    "services:",
    "  app:",
    '    command: "npm install --no-package-lock && npm run dev"',
  ].join("\n");

  const result = composeWithNonMutatingNpmInstalls(compose);

  assert.equal(result, compose);
});

test("prefixes pnpm commands without rewriting pnpm paths", () => {
  const compose = [
    "services:",
    "  pnpm-cache-init:",
    "    command:",
    "      - bash",
    "      - -lc",
    "      - mkdir -p /pnpm/store /pnpm/home && chown -R ${BLAME_HOST_UID}:${BLAME_HOST_GID} /pnpm /workspace",
    "  frontend:",
    "    command:",
    "      - bash",
    "      - -lc",
    "      - corepack prepare pnpm@10.32.1 --activate && pnpm install --frozen-lockfile",
  ].join("\n");

  const result = dockerComposeWithCorepackPnpm(compose);

  assert.match(result, /chown -R .+ \/pnpm \/workspace/);
  assert.doesNotMatch(result, /\/corepack pnpm/);
  assert.match(result, /&& corepack pnpm install --frozen-lockfile/);
});

test("does not rewrite pnpm commands already run through corepack", () => {
  const compose = [
    "services:",
    "  frontend:",
    "    command:",
    "      - bash",
    "      - -lc",
    "      - corepack prepare pnpm@10.32.1 --activate && corepack pnpm install --frozen-lockfile",
  ].join("\n");

  const result = dockerComposeWithCorepackPnpm(compose);

  assert.match(result, /&& corepack pnpm install --frozen-lockfile/);
  assert.doesNotMatch(result, /corepack corepack pnpm/);
});

test("adds CI to services running package installs", () => {
  const compose = [
    "services:",
    "  frontend:",
    "    environment:",
    "      NODE_ENV: development",
    "    command:",
    "      - bash",
    "      - -lc",
    "      - corepack prepare pnpm@9.12.2 --activate && corepack pnpm install --frozen-lockfile && corepack pnpm dev",
  ].join("\n");

  const result = dockerComposeWithCiForPackageInstalls(compose);

  assert.match(result, /environment:\n      CI: "true"\n      NODE_ENV:/);
});

test("adds CI to list environments", () => {
  const compose = [
    "services:",
    "  frontend:",
    "    environment:",
    "      - NODE_ENV=development",
    "    command:",
    "      - bash",
    "      - -lc",
    "      - npm install && npm run dev",
  ].join("\n");

  const result = dockerComposeWithCiForPackageInstalls(compose);

  assert.match(result, /environment:\n      - CI=true\n      - NODE_ENV=/);
});

test("normalizes preview compose before writing it", () => {
  const compose = [
    "services:",
    "  frontend:",
    "    volumes:",
    "      - .:/workspace",
    "    command:",
    "      - bash",
    "      - -lc",
    "      - corepack prepare pnpm@10.32.1 --activate && corepack pnpm install --frozen-lockfile",
  ].join("\n");

  const result = dockerComposeForPreview(compose, "/tmp/project");

  assert.doesNotMatch(
    result,
    /user: "\$\{BLAME_HOST_UID\}:\$\{BLAME_HOST_GID\}"/,
  );
  assert.match(result, /CI: "true"/);
  assert.doesNotMatch(result, /corepack corepack pnpm/);
});

test("escapes container shell variables in preview commands", () => {
  const compose = [
    "services:",
    "  preview:",
    "    command:",
    "      - bash",
    "      - -lc",
    "      - |",
    "        export HOME=/tmp/blame-home",
    '        mkdir -p "$HOME" "${NPM_CONFIG_CACHE}"',
    '        echo "${BLAME_HOST_UID}:${BLAME_HOST_GID}"',
    "    environment:",
    "      NODE_ENV: development",
  ].join("\n");

  const result = dockerComposeForPreview(compose, "/tmp/project");

  assert.match(result, /mkdir -p "\$\$HOME" "\$\$\{NPM_CONFIG_CACHE\}"/);
  assert.match(result, /echo "\$\{BLAME_HOST_UID\}:\$\{BLAME_HOST_GID\}"/);
  assert.match(result, /NODE_ENV: development/);
});

test("does not force host uid user for rootless runtime mounts", () => {
  const compose = [
    "services:",
    "  app:",
    "    volumes:",
    "      - ${BLAME_PROJECT_ROOT}:/workspace",
    "    command:",
    "      - bash",
    "      - -lc",
    "      - corepack pnpm install && corepack pnpm dev",
  ].join("\n");

  const result = dockerComposeForPreview(compose, "/tmp/project");

  assert.doesNotMatch(
    result,
    /user: "\$\{BLAME_HOST_UID\}:\$\{BLAME_HOST_GID\}"/,
  );
});

test("mounts host env files over worktree symlinks inside services", () => {
  const compose = [
    "services:",
    "  backend:",
    "    volumes:",
    "      - ${BLAME_PROJECT_ROOT}:/workspace",
    "    command: pnpm dev",
    "  db:",
    "    image: postgres:17",
  ].join("\n");

  const result = dockerComposeWithHostFileMounts(compose, "/tmp/worktree", [
    {
      containerPath: "apps/backend/.env",
      hostPath: "/mnt/dev/project/apps/backend/.env",
    },
  ]);

  assert.match(
    result,
    /"\/mnt\/dev\/project\/apps\/backend\/\.env:\/workspace\/apps\/backend\/\.env"/,
  );
  assert.doesNotMatch(result, /postgres:17\n    volumes:/);
});

test("replaces existing host env file mounts for the same container path", () => {
  const compose = [
    "services:",
    "  web:",
    "    volumes:",
    "      - /tmp/worktree:/workspace",
    "      - /tmp/old/.env:/workspace/.env",
    "      - /tmp/old/.env:/workspace/.env",
  ].join("\n");

  const result = dockerComposeWithHostFileMounts(compose, "/tmp/worktree", [
    {
      containerPath: ".env",
      hostPath: "/tmp/new/.env",
    },
  ]);

  assert.doesNotMatch(result, /\/tmp\/old\/\.env/);
  assert.equal([...result.matchAll(/\/workspace\/\.env/g)].length, 1);
  assert.match(result, /"\/tmp\/new\/\.env:\/workspace\/\.env"/);
});

test("normalizes Windows project root placeholders for YAML", () => {
  const compose = [
    "services:",
    "  app:",
    "    volumes:",
    "      - ${BLAME_PROJECT_ROOT}:/workspace",
    "    command:",
    "      - bash",
    "      - -lc",
    "      - npm install && npm run dev",
  ].join("\n");

  const result = dockerComposeForPreview(
    compose,
    String.raw`C:\Users\vanwa\Downloads\projet_test`,
  );

  assert.match(result, /C:\/Users\/vanwa\/Downloads\/projet_test:\/workspace/);
  assert.doesNotMatch(result, /C:\\Users/);
});

test("adds runtime dependency volumes for pnpm worktree installs", () => {
  const compose = [
    "services:",
    "  frontend:",
    "    volumes:",
    "      - .:/workspace",
    "    command:",
    "      - bash",
    "      - -lc",
    "      - corepack prepare pnpm@9.12.2 --activate && corepack pnpm install --frozen-lockfile && corepack pnpm dev",
  ].join("\n");

  const result = dockerComposeWithDependencyVolumes(compose, "/tmp/project");

  assert.match(result, /blame-dependencies-init:/);
  assert.match(result, /"blame_node_modules:\/workspace\/node_modules"/);
  assert.match(result, /"blame_corepack_cache:\/tmp\/corepack-cache"/);
  assert.match(result, /"blame_pnpm_store:\/pnpm\/store"/);
  assert.match(result, /COREPACK_HOME: "\/tmp\/corepack-cache"/);
  assert.match(result, /npm_config_store_dir: "\/pnpm\/store"/);
  assert.match(result, /depends_on:\n      - blame-dependencies-init/);
  assert.match(
    result,
    /blame_corepack_cache:\n    name: blame_corepack_cache\n    external: true/,
  );
  assert.match(
    result,
    /blame_pnpm_store:\n    name: blame_pnpm_store\n    external: true/,
  );
});

test("uses reusable node modules volumes for preview worktrees", () => {
  const compose = [
    "services:",
    "  frontend:",
    "    volumes:",
    "      - .:/workspace",
    "    command:",
    "      - corepack pnpm install && corepack pnpm dev",
  ].join("\n");

  const first = dockerComposeForPreview(compose, "/tmp/project/story-1");
  const second = dockerComposeForPreview(compose, "/tmp/project/story-2");
  const pattern =
    /"(blame_node_modules_[a-f0-9]{12}):\/workspace\/node_modules"/;
  const firstVolume = pattern.exec(first)?.[1];
  const secondVolume = pattern.exec(second)?.[1];

  assert.ok(firstVolume);
  assert.equal(firstVolume, secondVolume);
  assert.match(first, new RegExp(`${firstVolume}:\\n    name: ${firstVolume}`));
  assert.doesNotMatch(
    first,
    new RegExp(
      `${firstVolume}:\\n    name: ${firstVolume}\\n    external: true`,
    ),
  );
  assert.match(first, /blame\.dependencies\.cache: "true"/);
  assert.match(first, /blame\.dependencies\.cache\.key: "[a-f0-9]{12}"/);
});

test("uses explicit dependency volume key for preview worktrees", () => {
  const compose = [
    "services:",
    "  frontend:",
    "    volumes:",
    "      - .:/workspace",
    "    command:",
    "      - corepack pnpm install && corepack pnpm dev",
  ].join("\n");

  const result = dockerComposeForPreview(
    compose,
    "/tmp/project/story-1",
    "abc123abc123",
  );

  assert.match(
    result,
    /"blame_node_modules_abc123abc123:\/workspace\/node_modules"/,
  );
  assert.match(result, /blame\.dependencies\.cache\.key: "abc123abc123"/);
});

test("changes dependency volume keys when a nested manifest changes", () => {
  const compose = "services:\n  web:\n    image: node:22";
  const before = dependencyVolumeHashFromInputs(
    [{ content: '{"dependencies":{}}', file: "apps/web/package.json" }],
    compose,
  );
  const after = dependencyVolumeHashFromInputs(
    [
      {
        content: '{"dependencies":{"three":"^0.180.0"}}',
        file: "apps/web/package.json",
      },
    ],
    compose,
  );

  assert.notEqual(after, before);
});

test("replaces generated node modules volume with dependency keyed volume", () => {
  const compose = [
    "services:",
    "  deps:",
    "    volumes:",
    "      - .:/workspace",
    "      - blame_node_modules:/workspace/node_modules",
    "    command:",
    "      - corepack pnpm install",
    "volumes:",
    "  blame_node_modules:",
  ].join("\n");

  const result = dockerComposeForPreview(
    compose,
    "/tmp/project/story-1",
    "abc123abc123",
  );

  assert.match(
    result,
    /"blame_node_modules_abc123abc123:\/workspace\/node_modules"/,
  );
  assert.doesNotMatch(result, /"blame_node_modules:\/workspace\/node_modules"/);
  assert.match(result, /blame\.dependencies\.cache: "true"/);
});

test("uses dependency keyed node modules volume for runtime services", () => {
  const compose = [
    "services:",
    "  deps:",
    "    volumes:",
    "      - .:/workspace",
    "      - blame_node_modules:/workspace/node_modules",
    "    command:",
    "      - corepack pnpm install",
    "  backend:",
    "    working_dir: /workspace/apps/backend",
    "    volumes:",
    "      - .:/workspace",
    "      - blame_node_modules:/workspace/node_modules",
    "    command:",
    "      - corepack pnpm dev",
    "  web:",
    "    working_dir: /workspace/apps/frontend",
    "    volumes:",
    "      - .:/workspace",
    "      - blame_node_modules:/workspace/node_modules",
    "    command:",
    "      - corepack pnpm dev",
    "volumes:",
    "  blame_node_modules:",
  ].join("\n");

  const result = dockerComposeForPreview(
    compose,
    "/tmp/project/story-1",
    "abc123abc123",
  );

  assert.equal(
    result.match(/"blame_node_modules_abc123abc123:\/workspace\/node_modules"/g)
      ?.length,
    4,
  );
  assert.match(
    result,
    /"blame_node_modules_abc123abc123_apps_backend:\/workspace\/apps\/backend\/node_modules"/,
  );
  assert.match(
    result,
    /"blame_node_modules_abc123abc123_apps_frontend:\/workspace\/apps\/frontend\/node_modules"/,
  );
  assert.doesNotMatch(result, /"blame_node_modules:\/workspace\/node_modules"/);
});

const packageManagerComposeCases = [
  {
    cacheMount: /"blame_pnpm_store:\/pnpm\/store"/,
    command: "corepack pnpm",
    env: /npm_config_store_dir: "\/pnpm\/store"/,
    name: "pnpm",
  },
  {
    cacheMount: /"blame_npm_cache:\/npm\/cache"/,
    command: "npm",
    env: /NPM_CONFIG_CACHE: "\/npm\/cache"/,
    name: "npm",
  },
  {
    cacheMount: /"blame_yarn_cache:\/yarn\/cache"/,
    command: "yarn",
    env: /YARN_CACHE_FOLDER: "\/yarn\/cache"/,
    name: "yarn",
  },
  {
    cacheMount: /"blame_bun_cache:\/bun\/cache"/,
    command: "bun",
    env: /BUN_INSTALL_CACHE_DIR: "\/bun\/cache"/,
    name: "bun",
  },
];

for (const manager of packageManagerComposeCases) {
  test(`adds keyed node_modules and cache volumes for single-package ${manager.name}`, () => {
    const compose = [
      "services:",
      "  app:",
      "    volumes:",
      "      - .:/workspace",
      "    command:",
      `      - ${manager.command} install && ${manager.command} run dev`,
    ].join("\n");

    const result = dockerComposeForPreview(
      compose,
      "/tmp/project/story-1",
      "abc123abc123",
    );

    assert.match(
      result,
      /"blame_node_modules_abc123abc123:\/workspace\/node_modules"/,
    );
    assert.match(result, manager.cacheMount);
    assert.match(result, manager.env);
    assert.match(result, /blame\.dependencies\.cache: "true"/);
  });

  test(`adds package node_modules volumes for ${manager.name} workspaces`, () => {
    const compose = [
      "services:",
      "  deps:",
      "    volumes:",
      "      - .:/workspace",
      "      - blame_node_modules:/workspace/node_modules",
      "    command:",
      `      - ${manager.command} install`,
      "  backend:",
      "    working_dir: /workspace/apps/backend",
      "    volumes:",
      "      - .:/workspace",
      "      - blame_node_modules:/workspace/node_modules",
      "    command:",
      `      - ${manager.command} run dev`,
      "  web:",
      "    working_dir: /workspace/apps/frontend",
      "    volumes:",
      "      - .:/workspace",
      "      - blame_node_modules:/workspace/node_modules",
      "    command:",
      `      - ${manager.command} run dev`,
      "volumes:",
      "  blame_node_modules:",
    ].join("\n");

    const result = dockerComposeForPreview(
      compose,
      "/tmp/project/story-1",
      "abc123abc123",
    );

    assert.match(
      result,
      /"blame_node_modules_abc123abc123:\/workspace\/node_modules"/,
    );
    assert.match(
      result,
      /"blame_node_modules_abc123abc123_apps_backend:\/workspace\/apps\/backend\/node_modules"/,
    );
    assert.match(
      result,
      /"blame_node_modules_abc123abc123_apps_frontend:\/workspace\/apps\/frontend\/node_modules"/,
    );
    assert.match(result, manager.cacheMount);
    assert.doesNotMatch(
      result,
      /"blame_node_modules:\/workspace\/node_modules"/,
    );
  });
}

test("marks initialized dependency volumes before recursive chown", () => {
  const compose = [
    "services:",
    "  frontend:",
    "    volumes:",
    "      - .:/workspace",
    "    command:",
    "      - npm install && npm run dev",
  ].join("\n");

  const result = dockerComposeForPreview(compose, "/tmp/project/story-1");

  assert.match(result, /\.blame-volume-ready/);
  assert.match(
    result,
    /\[ -e \/workspace\/node_modules\/\.blame-volume-ready \] \|\|/,
  );
});

test("preserves list environment while adding npm cache volume", () => {
  const compose = [
    "services:",
    "  frontend:",
    "    environment:",
    "      - NODE_ENV=development",
    "    volumes:",
    "      - .:/app",
    "    command:",
    "      - npm install && npm run dev",
  ].join("\n");

  const result = dockerComposeWithDependencyVolumes(compose, "/tmp/project");

  assert.match(
    result,
    /environment:\n      - NPM_CONFIG_CACHE=\/npm\/cache\n      - NODE_ENV=development/,
  );
  assert.match(result, /"blame_node_modules:\/app\/node_modules"/);
  assert.match(result, /"blame_npm_cache:\/npm\/cache"/);
});

test("adds shared Yarn cache for plain yarn install", () => {
  const compose = [
    "services:",
    "  frontend:",
    "    volumes:",
    "      - .:/app",
    "    command:",
    "      - yarn install && yarn dev",
  ].join("\n");

  const result = dockerComposeWithDependencyVolumes(compose, "/tmp/project");

  assert.match(result, /"blame_node_modules:\/app\/node_modules"/);
  assert.match(result, /"blame_yarn_cache:\/yarn\/cache"/);
  assert.match(result, /YARN_CACHE_FOLDER: "\/yarn\/cache"/);
  assert.match(
    result,
    /blame_yarn_cache:\n    name: blame_yarn_cache\n    external: true/,
  );
});

test("adds shared Bun cache for bun install", () => {
  const compose = [
    "services:",
    "  frontend:",
    "    volumes:",
    "      - .:/app",
    "    command:",
    "      - bun install && bun run dev",
  ].join("\n");

  const result = dockerComposeWithDependencyVolumes(compose, "/tmp/project");

  assert.match(result, /"blame_node_modules:\/app\/node_modules"/);
  assert.match(result, /"blame_bun_cache:\/bun\/cache"/);
  assert.match(result, /BUN_INSTALL_CACHE_DIR: "\/bun\/cache"/);
  assert.match(
    result,
    /blame_bun_cache:\n    name: blame_bun_cache\n    external: true/,
  );
});

test("detects portable Windows project root mounts for dependency volumes", () => {
  const compose = [
    "services:",
    "  frontend:",
    "    volumes:",
    "      - C:/Users/dev/project:/workspace",
    "    command:",
    "      - corepack pnpm install && corepack pnpm dev",
  ].join("\n");

  const result = dockerComposeWithDependencyVolumes(
    compose,
    String.raw`C:\Users\dev\project`,
  );

  assert.match(result, /"blame_node_modules:\/workspace\/node_modules"/);
  assert.match(result, /"blame_pnpm_store:\/pnpm\/store"/);
});

test("promotes existing package cache volumes to global runtime volumes", () => {
  const compose = [
    "services:",
    "  deps:",
    "    volumes:",
    "      - .:/workspace",
    "      - corepack_cache:/tmp/corepack-cache",
    "      - pnpm_store:/pnpm/store",
    "    command:",
    "      - corepack prepare pnpm@9.12.2 --activate && corepack pnpm install",
    "volumes:",
    "  corepack_cache:",
    "  pnpm_store:",
    "  node_modules:",
  ].join("\n");

  const result = dockerComposeWithDependencyVolumes(compose, "/tmp/project");

  assert.match(
    result,
    /corepack_cache:\n    name: blame_corepack_cache\n    external: true/,
  );
  assert.match(
    result,
    /pnpm_store:\n    name: blame_pnpm_store\n    external: true/,
  );
  assert.doesNotMatch(result, /node_modules:\n    name:/);
});

test("does not orphan global volume metadata when cache volume already exists", () => {
  const compose = [
    "services:",
    "  deps:",
    "    volumes:",
    "      - blame_pnpm_store:/pnpm/store",
    "    command: corepack pnpm install",
    "volumes:",
    "  blame_pnpm_store:",
  ].join("\n");

  const result = dockerComposeWithDependencyVolumes(compose, "/tmp/project");

  assert.match(
    result,
    /volumes:\n  blame_pnpm_store:\n    name: blame_pnpm_store\n    external: true/,
  );
  assert.doesNotMatch(result, /volumes:\n    name:/);
});

test("replaces project-scoped package cache volume names", () => {
  const compose = [
    "services:",
    "  deps:",
    "    volumes:",
    "      - .:/workspace",
    "      - pnpm_store:/pnpm/store",
    "      - corepack_cache:/tmp/corepack-cache",
    "    command:",
    "      - corepack prepare pnpm@9.12.2 --activate && corepack pnpm install",
    "volumes:",
    "  node_modules:",
    "    name: ${COMPOSE_PROJECT_NAME:-demo}_node_modules",
    "  pnpm_store:",
    "    name: ${COMPOSE_PROJECT_NAME:-demo}_pnpm_store",
    "  corepack_cache:",
    "    name: ${COMPOSE_PROJECT_NAME:-demo}_corepack_cache",
  ].join("\n");

  const result = dockerComposeWithDependencyVolumes(compose, "/tmp/project");

  assert.match(
    result,
    /node_modules:\n    name: \$\{COMPOSE_PROJECT_NAME:-demo\}_node_modules/,
  );
  assert.match(
    result,
    /pnpm_store:\n    name: blame_pnpm_store\n    external: true/,
  );
  assert.match(
    result,
    /corepack_cache:\n    name: blame_corepack_cache\n    external: true/,
  );
});

test("preserves mapping depends_on when adding dependency init service", () => {
  const compose = [
    "services:",
    "  setup:",
    "    image: node:20",
    "  deps:",
    "    depends_on:",
    "      setup:",
    "        condition: service_completed_successfully",
    "    volumes:",
    "      - .:/workspace",
    "    command:",
    "      - npm install",
  ].join("\n");

  const result = dockerComposeWithDependencyVolumes(compose, "/tmp/project");

  assert.match(
    result,
    /depends_on:\n      blame-dependencies-init:\n        condition: service_completed_successfully\n      setup:\n        condition: service_completed_successfully/,
  );
  assert.doesNotMatch(
    result,
    /depends_on:\n      - blame-dependencies-init\n      setup:/,
  );
});

test("uses existing pnpm store mount instead of adding a second store", () => {
  const compose = [
    "services:",
    "  deps:",
    "    volumes:",
    "      - .:/workspace",
    "      - pnpm_store:/tmp/pnpm-store",
    "    command:",
    "      - corepack pnpm install --store-dir /tmp/pnpm-store",
    "volumes:",
    "  pnpm_store:",
    "    name: ${COMPOSE_PROJECT_NAME:-demo}_pnpm_store",
  ].join("\n");

  const result = dockerComposeWithDependencyVolumes(compose, "/tmp/project");

  assert.doesNotMatch(result, /blame_pnpm_store:\/pnpm\/store/);
  assert.match(
    result,
    /pnpm_store:\n    name: blame_pnpm_store\n    external: true/,
  );
});

test("does not add dependency cache labels to setup tasks that do not run npm install", () => {
  const compose = [
    "services:",
    "  clean_nuxt_cache:",
    "    labels:",
    '      blame.setup: "true"',
    "    volumes:",
    "      - .:/workspace",
    "      - blame_node_modules:/workspace/node_modules",
    "    command:",
    "      - rm -rf .nuxt",
    "  deps:",
    "    labels:",
    '      blame.setup: "true"',
    "    volumes:",
    "      - .:/workspace",
    "      - blame_node_modules:/workspace/node_modules",
    "    command:",
    "      - npm install",
  ].join("\n");

  const result = dockerComposeWithDependencyVolumes(
    compose,
    "/tmp/project",
    "e9343feddfde",
  );

  assert.match(
    result,
    /clean_nuxt_cache:\n    depends_on:\n      - blame-dependencies-init\n    labels:\n      blame\.setup: "true"\n    volumes:/,
  );
  assert.match(result, /deps:[\s\S]*?blame\.dependencies\.cache: "true"/);
});

test("safely prepends corepack enable to commands using pnpm", () => {
  const compose = [
    "services:",
    "  web:",
    "    command: \"sh -lc 'corepack prepare pnpm@10.33.2 --activate && corepack pnpm dev'\"",
    "  deps:",
    "    command:",
    "      - sh",
    "      - -lc",
    "      - corepack prepare pnpm@10.33.2 --activate && corepack pnpm install",
  ].join("\n");

  const result = dockerComposeWithCorepackPnpm(compose);

  assert.match(
    result,
    /command: "sh -lc '\(corepack enable 2>\/dev\/null \|\| true\) && corepack prepare pnpm@10.33.2 --activate && corepack pnpm dev'"/,
  );
  assert.match(
    result,
    /- \(corepack enable 2>\/dev\/null \|\| true\) && corepack prepare pnpm@10.33.2 --activate && corepack pnpm install/,
  );
});

test("reuses the host ports of the previous start while they are free", async () => {
  const compose = [
    "services:",
    "  web:",
    "    ports:",
    '      - "127.0.0.1::3000"',
    "  api:",
    "    ports:",
    '      - "127.0.0.1::3000"',
  ].join("\n");
  const first = composeHostPorts(await composeWithAllocatedHostPorts(compose));
  assert.deepEqual(Object.keys(first).sort(), ["api:3000", "web:3000"]);

  const again = composeHostPorts(
    await composeWithAllocatedHostPorts(compose, first),
  );
  assert.deepEqual(again, first);

  const busy = createServer();
  await new Promise<void>((resolve) =>
    busy.listen(first["web:3000"], "127.0.0.1", resolve),
  );
  try {
    const moved = composeHostPorts(
      await composeWithAllocatedHostPorts(compose, first),
    );
    assert.notEqual(moved["web:3000"], first["web:3000"]);
    assert.equal(moved["api:3000"], first["api:3000"]);
  } finally {
    await new Promise((resolve) => busy.close(resolve));
  }

  const shared = composeHostPorts(
    await composeWithAllocatedHostPorts(compose, {
      "web:3000": first["web:3000"]!,
      "api:3000": first["web:3000"]!,
    }),
  );
  assert.notEqual(shared["web:3000"], shared["api:3000"]);
});
