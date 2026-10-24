import type {
  PreviewManifestContainer,
  PreviewManifestEndpoint,
  PreviewManifestService,
} from "@blame/preview-contract";

// Small reads of a preview manifest shared by its normalization.

export function serviceEndpoint(
  service: PreviewManifestService,
  endpointId: string,
): PreviewManifestEndpoint | undefined {
  return service.endpoints.find(({ id }) => id === endpointId);
}

export function previewEndpoint(service: PreviewManifestService) {
  return service.kind === "preview"
    ? service.endpoints.find(({ protocol }) => protocol !== "tcp")
    : undefined;
}

export function containerImage(container: PreviewManifestContainer) {
  return container.image ?? "";
}

export function mysqlImage(image: string) {
  return /^mysql(?::|$)/.test(image) || /\/mysql(?::|$)/.test(image);
}

export function runsNodePackageManager(commands: string) {
  return /\b(?:(?:corepack\s+)?(?:pnpm|yarn)|npm|bun)\s+(?:install|ci|exec|run)\b/.test(
    commands,
  );
}

export function defaultSetupRunAs(command: string) {
  return workspacePermissionRepairCommand(command) ? "root" : "host";
}

function workspacePermissionRepairCommand(command: string) {
  return (
    command.includes("/workspace") &&
    !unsafeWorkspaceOwnershipCommand(command) &&
    /\b(?:chown|chmod|rm\s+-rf)\b/.test(command) &&
    /\/workspace\/\.(?:nuxt|next|vite)\b|\/workspace\/node_modules\b/.test(
      command,
    )
  );
}

function unsafeWorkspaceOwnershipCommand(command: string) {
  return (
    /\b(?:chown|chmod)\b/.test(command) &&
    /\/workspace(?:\s|$)|\/workspace\/(?:apps|packages)(?:\s|\/|$)/.test(
      command,
    )
  );
}

export function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}
