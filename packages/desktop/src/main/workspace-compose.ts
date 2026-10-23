import { createServer } from "node:net";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  dependencyVolumeHash,
  dockerComposeWithDependencyVolumes,
  mapServiceBlocks,
  mountedWorkspacePath,
  readServiceBlock,
  serviceBlockWithMounts,
  serviceName,
  serviceSectionLine,
  startsNextTopLevelSection,
} from "./workspace-compose-volumes.ts";

// Existing compose artifacts outlive package edits made during an agent run.
// Rotate only Blame's dependency caches; preserve database and user volumes.
export function composeWithCurrentDependencyVolumes(
  compose: string,
  key: string,
) {
  if (!key) return compose;
  const document = parseYaml(compose) as {
    services?: Record<string, { labels?: Record<string, string> | string[] }>;
  };
  const oldKeys = new Set<string>();
  for (const service of Object.values(document.services ?? {})) {
    const labels = service.labels;
    if (!labels) continue;
    const label = "blame.dependencies.cache.key";
    const oldKey = Array.isArray(labels)
      ? labels
          .find((value) => value.startsWith(`${label}=`))
          ?.slice(label.length + 1)
      : labels[label];
    if (!oldKey || !/^[a-f0-9]{12}$/.test(oldKey) || oldKey === key) continue;
    oldKeys.add(oldKey);
    if (Array.isArray(labels)) {
      service.labels = labels.map((value) =>
        value.startsWith(`${label}=`) ? `${label}=${key}` : value,
      );
    } else labels[label] = key;
  }
  if (oldKeys.size === 0) return compose;
  let updated = stringifyYaml(document, { lineWidth: 0 });
  for (const oldKey of oldKeys) {
    updated = updated.replace(
      new RegExp(`\\bblame_node_modules_${oldKey}(?=_|\\b)`, "g"),
      `blame_node_modules_${key}`,
    );
  }
  return updated;
}

export function dockerComposeForPreview(
  compose: string,
  worktree: string,
  dependencyVolumeKey = dependencyVolumeHash(compose),
) {
  const previewCompose = dockerComposeWithEscapedCommandVariables(
    projectRootCompose(compose, worktree),
  );
  return dockerComposeWithDependencyVolumes(
    dockerComposeWithCiForPackageInstalls(
      dockerComposeWithCorepackPnpm(
        dockerComposeWithHostUser(previewCompose, worktree),
      ),
    ),
    worktree,
    dependencyVolumeKey,
  );
}

export type HostFileMount = {
  containerPath: string;
  hostPath: string;
};

export function dockerComposeWithHostFileMounts(
  compose: string,
  worktree: string,
  mounts: HostFileMount[],
) {
  if (mounts.length === 0) return compose;
  const lines = compose.split("\n");
  const servicesLine = serviceSectionLine(lines);
  if (servicesLine === -1) return compose;
  return mapServiceBlocks(lines, servicesLine, (block) => {
    const root = mountedWorkspacePath(block.lines, worktree);
    if (!root) return block.lines;
    return serviceBlockWithMounts(
      block.lines,
      mounts.map(
        (mount) =>
          `${mount.hostPath}:${root.replace(/\/$/, "")}/${mount.containerPath}`,
      ),
    );
  }).join("\n");
}

export function composeWithoutNumericSuUser(compose: string) {
  return compose.replace(
    /\bsu\s+-s\s+\/bin\/bash\s+-c\s+((['"])(?:(?!\2).)+\2)\s+(['"])#\$\{BLAME_HOST_UID\}\3/g,
    "bash -lc $1",
  );
}

export function composeWithNonMutatingNpmInstalls(compose: string) {
  return compose.replace(
    /(^|[\s;&|"'`(])npm\s+install\b([^\n;&|"'`]*)/g,
    (match, prefix: string, args: string) => {
      const options = args.trim();
      if (
        npmInstallTokens(options).some((token) => token === "--no-package-lock")
      )
        return match;
      if (hasNpmInstallPackageArguments(options)) return match;
      const suffix = options ? ` ${options}` : "";
      const separator = /\s$/.test(args) ? " " : "";
      return `${prefix}npm install --no-package-lock${suffix}${separator}`;
    },
  );
}

function hasNpmInstallPackageArguments(options: string) {
  return npmInstallTokens(options).some((token, index, tokens) => {
    if (token.startsWith("-")) return false;
    return !npmOptionTakesValue(tokens[index - 1] ?? "");
  });
}

function npmInstallTokens(options: string) {
  const matches = options.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/g);
  return matches ?? [];
}

function npmOptionTakesValue(option: string) {
  const name = option.split("=")[0];
  return [
    "--cache",
    "--prefix",
    "--registry",
    "--userconfig",
    "--workspace",
    "--workspace-root",
    "-w",
    "-C",
  ].includes(name);
}

// `preferredPorts` maps "<service>:<container port>" to the host port a
// previous start used. Reusing it while it is free keeps the preview origin
// stable across restarts, so its URL, cookies and sessions survive.
export async function composeWithAllocatedHostPorts(
  compose: string,
  preferredPorts: Record<string, number> = {},
) {
  const result: string[] = [];
  const portMappings: ComposePortMapping[] = [];
  const taken = new Set<number>();
  let serviceId: string | undefined;
  for (const line of compose.split("\n")) {
    serviceId = composeServiceId(line, serviceId);
    const allocated = allocatedPortLine(line);
    if (allocated) {
      const preferred =
        preferredPorts[composePortKey(serviceId, allocated.targetPort)];
      const port =
        preferred && !taken.has(preferred) && (await localPortFree(preferred))
          ? preferred
          : await freeLocalPort();
      taken.add(port);
      portMappings.push({
        hostPort: port,
        serviceId,
        targetPort: allocated.targetPort,
      });
      result.push(
        `${allocated.prefix}${allocated.quote}${allocated.host}:${port}:${allocated.targetPort}${allocated.protocol}${allocated.quote}${allocated.suffix}`,
      );
      continue;
    }
    const explicit = explicitPortLine(line);
    if (explicit) portMappings.push({ ...explicit, serviceId });
    result.push(line);
  }
  const materialized = composeWithBindingPlaceholders(
    result.join("\n"),
    portMappings,
  );
  return composeWithDeclaredBrowserBindings(materialized, portMappings);
}

/** The host ports a compose file publishes, keyed like `preferredPorts`. */
export function composeHostPorts(compose: string) {
  const ports: Record<string, number> = {};
  let serviceId: string | undefined;
  for (const line of compose.split("\n")) {
    serviceId = composeServiceId(line, serviceId);
    const explicit = explicitPortLine(line);
    if (explicit)
      ports[composePortKey(serviceId, explicit.targetPort)] = explicit.hostPort;
  }
  return ports;
}

function composePortKey(serviceId: string | undefined, targetPort: number) {
  return `${serviceId ?? ""}:${targetPort}`;
}

type ComposePortMapping = {
  hostPort: number;
  serviceId?: string;
  targetPort: number;
};

function composeServiceId(line: string, current: string | undefined) {
  if (/^services:\s*(?:#.*)?$/.test(line)) return undefined;
  if (/^\S/.test(line)) return undefined;
  const match = /^  ([A-Za-z0-9][A-Za-z0-9_.-]*):\s*(?:#.*)?$/.exec(line);
  return match?.[1] ?? current;
}

export function composeWithRuntimePortPlaceholders(
  compose: string,
  enabled = true,
) {
  if (!enabled) return compose;
  return compose.replace(
    /(\s*-\s*["']?)(127\.0\.0\.1|localhost):\d+:(\d+)(\/[a-z]+)?(["']?\s*(?:#.*)?)$/gm,
    (
      _match,
      prefix: string,
      host: string,
      targetPort: string,
      protocol = "",
      suffix: string,
    ) => `${prefix}${host}::${targetPort}${protocol}${suffix}`,
  );
}

function allocatedPortLine(line: string) {
  const match =
    /^(\s*-\s*)(["']?)(127\.0\.0\.1|localhost)::(\d+)(\/[a-z]+)?\2(\s*(?:#.*)?)$/.exec(
      line,
    );
  if (!match) return undefined;
  return {
    prefix: match[1],
    quote: match[2],
    host: match[3],
    targetPort: Number.parseInt(match[4], 10),
    protocol: match[5] ?? "",
    suffix: match[6],
  };
}

function explicitPortLine(line: string) {
  const match =
    /^\s*-\s*["']?(?:127\.0\.0\.1|localhost):(\d+):(\d+)(?:\/[a-z]+)?["']?\s*(?:#.*)?$/.exec(
      line,
    );
  if (!match) return undefined;
  return {
    hostPort: Number.parseInt(match[1], 10),
    targetPort: Number.parseInt(match[2], 10),
  };
}

function composeWithBindingPlaceholders(
  compose: string,
  portMappings: ComposePortMapping[],
) {
  return compose
    .replace(
      /__BLAME_PREVIEW_ORIGIN_([A-Za-z0-9][A-Za-z0-9_.-]*)_(\d+)__/g,
      (match, serviceId: string, port: string) =>
        previewOriginPlaceholder(match, serviceId, port, portMappings),
    )
    .replace(
      /__BLAME_PREVIEW_PORT_([A-Za-z0-9][A-Za-z0-9_.-]*)_(\d+)__/g,
      (match, serviceId: string, port: string) =>
        previewPortPlaceholder(match, serviceId, port, portMappings),
    );
}

type BindingComposeService = {
  environment?: Record<string, unknown> | string[];
  labels?: Record<string, unknown> | string[];
};

function composeWithDeclaredBrowserBindings(
  compose: string,
  portMappings: ComposePortMapping[],
) {
  const document = parseYaml(compose) as {
    services?: Record<string, BindingComposeService>;
  };
  const services = document.services ?? {};
  const replacements = new Map<string, Record<string, string>>();
  for (const [serviceId, service] of Object.entries(services)) {
    const labels = normalizedComposeEntries(service.labels);
    const environment = normalizedComposeEntries(service.environment);
    const values: Record<string, string> = {};
    for (const binding of declaredBrowserBindings(labels)) {
      const endpoint = declaredServiceEndpoint(
        services[binding.sourceService],
        binding.sourceEndpoint,
      );
      if (!endpoint) continue;
      const hostPort = servicePort(
        portMappings,
        binding.sourceService,
        endpoint.port,
      );
      const current = environment[binding.key];
      if (!hostPort || !current) continue;
      values[binding.key] = materializedBrowserBindingValue(
        binding.format,
        endpoint.protocol,
        hostPort,
        current,
      );
    }
    if (Object.keys(values).length) replacements.set(serviceId, values);
  }
  if (!replacements.size) return compose;
  const lines = compose.split("\n");
  const servicesLine = serviceSectionLine(lines);
  if (servicesLine === -1) return compose;
  return mapServiceBlocks(lines, servicesLine, (block) =>
    serviceBlockWithEnvironmentReplacements(
      block.lines,
      replacements.get(serviceName(block.lines[0])) ?? {},
    ),
  ).join("\n");
}

function declaredBrowserBindings(labels: Record<string, string>) {
  return Object.keys(labels).flatMap((key) => {
    const match = /^blame\.binding\.(\d+)\.key$/.exec(key);
    if (!match) return [];
    const index = match[1];
    if (labels[`blame.binding.${index}.exposure`] !== "browser") return [];
    return [
      {
        key: labels[key],
        sourceService: labels[`blame.binding.${index}.source.service`] ?? "",
        sourceEndpoint: labels[`blame.binding.${index}.source.endpoint`] ?? "",
        format: labels[`blame.binding.${index}.format`] ?? "url",
      },
    ];
  });
}

function declaredServiceEndpoint(
  service: BindingComposeService | undefined,
  endpointId: string,
) {
  const labels = normalizedComposeEntries(service?.labels);
  for (const key of Object.keys(labels)) {
    const match = /^blame\.endpoint\.(\d+)\.id$/.exec(key);
    if (!match || labels[key] !== endpointId) continue;
    const port = Number(labels[`blame.endpoint.${match[1]}.port`]);
    if (!Number.isInteger(port) || port <= 0) return undefined;
    return {
      port,
      protocol: labels[`blame.endpoint.${match[1]}.protocol`] || "http",
    };
  }
  return undefined;
}

function materializedBrowserBindingValue(
  format: string,
  protocol: string,
  hostPort: number,
  current: string,
) {
  if (format === "host") return "localhost";
  if (format === "port") return String(hostPort);
  if (format === "host-port") return `localhost:${hostPort}`;
  const suffix = /^[a-z]+:\/\/[^/]+(.*)$/i.exec(current)?.[1] ?? "";
  return `${protocol}://localhost:${hostPort}${suffix}`;
}

function normalizedComposeEntries(
  value: Record<string, unknown> | string[] | undefined,
) {
  if (!value) return {};
  if (!Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, String(entry)]),
    );
  }
  return Object.fromEntries(
    value.map((entry) => {
      const [key, ...parts] = entry.split("=");
      return [key, parts.join("=")];
    }),
  );
}

function serviceBlockWithEnvironmentReplacements(
  lines: string[],
  replacements: Record<string, string>,
) {
  if (!Object.keys(replacements).length) return lines;
  return lines.map((line) => {
    for (const [key, value] of Object.entries(replacements)) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`^\\s{6}${escapedKey}:`).test(line)) {
        return `      ${key}: ${JSON.stringify(value)}`;
      }
      if (new RegExp(`^\\s{6}-\\s*${escapedKey}=`).test(line)) {
        return `      - ${key}=${value}`;
      }
    }
    return line;
  });
}

function previewOriginPlaceholder(
  fallback: string,
  serviceId: string,
  port: string,
  portMappings: ComposePortMapping[],
) {
  const hostPort = servicePort(
    portMappings,
    serviceId,
    Number.parseInt(port, 10),
  );
  return hostPort ? `http://localhost:${hostPort}` : fallback;
}

function previewPortPlaceholder(
  fallback: string,
  serviceId: string,
  port: string,
  portMappings: ComposePortMapping[],
) {
  return String(
    servicePort(portMappings, serviceId, Number.parseInt(port, 10)) ?? fallback,
  );
}

function servicePort(
  mappings: ComposePortMapping[],
  serviceId: string | undefined,
  targetPort: number,
) {
  return mappings.find(
    (mapping) =>
      mapping.serviceId === serviceId && mapping.targetPort === targetPort,
  )?.hostPort;
}

export function dockerComposeWithEscapedCommandVariables(compose: string) {
  const lines = compose.split("\n");
  let commandIndent: number | undefined;
  return lines
    .map((line) => {
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      if (
        commandIndent !== undefined &&
        line.trim() &&
        indent <= commandIndent
      ) {
        commandIndent = undefined;
      }
      if (/^\s*command:\s*/.test(line)) commandIndent = indent;
      return commandIndent === undefined ? line : escapeCommandVariables(line);
    })
    .join("\n");
}

export function dockerComposeWithHostUser(compose: string, worktree: string) {
  const lines = compose.split("\n");
  const servicesLine = serviceSectionLine(lines);
  if (servicesLine === -1) return compose;
  return addHostUserToServices(lines, servicesLine, worktree).join("\n");
}

function escapeCommandVariables(line: string) {
  return line.replace(
    /(?<!\$)\$(?:\{([a-zA-Z_][a-zA-Z0-9_]*)\}|([a-zA-Z_][a-zA-Z0-9_]*))/g,
    (value, bracedName, plainName) => {
      const name = bracedName ?? plainName;
      return name.startsWith("BLAME_") ? value : `$${value}`;
    },
  );
}

export function dockerComposeWithCorepackPnpm(compose: string) {
  const lines = compose.split("\n");
  let inCommandBlock = false;
  let commandIndent = 0;

  const resultLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    const lineIndent = line.search(/\S/);
    if (inCommandBlock && lineIndent <= commandIndent) {
      inCommandBlock = false;
    }

    if (/^\s*command:\s*/.test(line)) {
      inCommandBlock = true;
      commandIndent = lineIndent;
    }

    if (inCommandBlock || /^\s*command:\s*/.test(line)) {
      let command = line;
      // Replace corepack enable && with the safe version
      command = command.replace(
        /\bcorepack\s+enable\s*&&\s*/g,
        "(corepack enable 2>/dev/null || true) && ",
      );
      // Replace bare pnpm with corepack pnpm
      command = command.replace(
        /(?<!corepack)(^|[\s;&|])pnpm(?=\s)/g,
        "$1corepack pnpm",
      );
      // Prepend corepack enable if pnpm is used but corepack enable is not in the command
      if (
        /\b(?:corepack\s+prepare\s+pnpm@|corepack\s+pnpm|pnpm)\b/.test(
          command,
        ) &&
        !/\bcorepack\s+enable\b/.test(command)
      ) {
        // Check if the command has a sh -lc wrapper (with optional backslash for nested quotes)
        const shMatch = /^(.*?\bsh\s+-lc\s+(?:\\?['"]))(.*)$/.exec(command);
        if (shMatch) {
          command = `${shMatch[1]}(corepack enable 2>/dev/null || true) && ${shMatch[2]}`;
        } else {
          // Find if the command is a list item or an inline string
          const listMatch = /^(\s*-\s*)(.*)$/.exec(command);
          if (listMatch) {
            const content = listMatch[2];
            // Check if it starts with quote
            const quoteMatch = /^(\\?['"])(.*)$/.exec(content);
            if (quoteMatch) {
              command = `${listMatch[1]}${quoteMatch[1]}(corepack enable 2>/dev/null || true) && ${quoteMatch[2]}`;
            } else {
              command = `${listMatch[1]}(corepack enable 2>/dev/null || true) && ${content}`;
            }
          } else {
            const inlineQuoteMatch = /^(\s*command:\s*\\?['"])(.*)$/.exec(
              command,
            );
            if (inlineQuoteMatch) {
              command = `${inlineQuoteMatch[1]}(corepack enable 2>/dev/null || true) && ${inlineQuoteMatch[2]}`;
            } else {
              const inlinePlainMatch = /^(\s*command:\s*)(.*)$/.exec(command);
              if (inlinePlainMatch) {
                command = `${inlinePlainMatch[1]}(corepack enable 2>/dev/null || true) && ${inlinePlainMatch[2]}`;
              }
            }
          }
        }
      }
      return command;
    }
    return line;
  });
  return resultLines.join("\n");
}

export function dockerComposeWithCiForPackageInstalls(compose: string) {
  const lines = compose.split("\n");
  const servicesLine = serviceSectionLine(lines);
  if (servicesLine === -1) return compose;
  return addCiToPackageInstallServices(lines, servicesLine).join("\n");
}

export function dockerComposeWithPortableWindowsPaths(compose: string) {
  return compose.replace(
    /([a-zA-Z]):\\([^\r\n"']*)/g,
    (_match, drive, path) => {
      return `${drive}:/${path.replace(/\\/g, "/")}`;
    },
  );
}

function addHostUserToServices(
  lines: string[],
  servicesLine: number,
  worktree: string,
) {
  const result: string[] = [];
  const serviceIndent = /^\s*/.exec(lines[servicesLine])?.[0].length ?? 0;
  const childIndent = serviceIndent + 2;

  for (let index = 0; index < lines.length; index += 1) {
    if (
      index > servicesLine &&
      startsNextTopLevelSection(lines[index], serviceIndent)
    ) {
      result.push(...lines.slice(index));
      break;
    }
    const serviceBlock = readServiceBlock(lines, index, childIndent);
    if (!serviceBlock || index <= servicesLine) {
      result.push(lines[index]);
      continue;
    }
    result.push(...hostUserServiceBlock(serviceBlock, worktree));
    index = serviceBlock.end;
  }

  return result;
}

function addCiToPackageInstallServices(lines: string[], servicesLine: number) {
  const result: string[] = [];
  const serviceIndent = /^\s*/.exec(lines[servicesLine])?.[0].length ?? 0;
  const childIndent = serviceIndent + 2;

  for (let index = 0; index < lines.length; index += 1) {
    if (
      index > servicesLine &&
      startsNextTopLevelSection(lines[index], serviceIndent)
    ) {
      result.push(...lines.slice(index));
      break;
    }
    const serviceBlock = readServiceBlock(lines, index, childIndent);
    if (!serviceBlock || index <= servicesLine) {
      result.push(lines[index]);
      continue;
    }
    result.push(...ciServiceBlock(serviceBlock));
    index = serviceBlock.end;
  }

  return result;
}

function hostUserServiceBlock(
  block: { lines: string[]; end: number },
  worktree: string,
) {
  void worktree;
  return block.lines;
}

function ciServiceBlock(block: { lines: string[]; end: number }) {
  if (!runsPackageInstall(block.lines)) return block.lines;
  if (hasCiEnvironment(block.lines)) return block.lines;
  const environmentIndex = block.lines.findIndex((line) =>
    /^\s{4}environment:\s*(?:#.*)?$/.test(line),
  );
  if (environmentIndex === -1) {
    const [serviceLine, ...serviceBody] = block.lines;
    return [
      serviceLine,
      "    environment:",
      '      CI: "true"',
      ...serviceBody,
    ];
  }
  return [
    ...block.lines.slice(0, environmentIndex + 1),
    ciEnvironmentLine(block.lines, environmentIndex),
    ...block.lines.slice(environmentIndex + 1),
  ];
}

function runsPackageInstall(lines: string[]) {
  return /\b(?:pnpm|npm|yarn|bun)\s+(?:install|ci)\b/.test(lines.join("\n"));
}

function hasCiEnvironment(lines: string[]) {
  return lines.some((line) => /^\s{6}(?:CI:|-\s*CI=)/.test(line));
}

function ciEnvironmentLine(lines: string[], environmentIndex: number) {
  const nextEnvironmentValue = lines
    .slice(environmentIndex + 1)
    .find((line) => line.trim() && !line.trim().startsWith("#"));
  if (nextEnvironmentValue && /^\s{6}-/.test(nextEnvironmentValue))
    return "      - CI=true";
  return '      CI: "true"';
}

function projectRootCompose(compose: string, worktree: string) {
  return dockerComposeWithPortableWindowsPaths(
    compose.replace(/\$\{BLAME_PROJECT_ROOT\}/g, worktree),
  );
}

function localPortFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function freeLocalPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate local port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
