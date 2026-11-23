// The credentials the person keeps on this computer only, as the engine host
// reaches them: through the desktop's services, which hold them encrypted by
// the system keychain. Nothing here touches the API.

import type { DesktopServices } from "./desktop-services.js";
import type { DeviceCredentials } from "./providers.js";

/** Undefined where the desktop offers no keychain store (tests, benchmarks). */
export function deviceCredentials(
  desktop: DesktopServices | undefined,
): DeviceCredentials | undefined {
  if (
    !desktop?.deviceCredentialStatus ||
    !desktop.deviceCredentialList ||
    !desktop.deviceCredentialResolve ||
    !desktop.deviceCredentialSave ||
    !desktop.deviceCredentialRemove
  )
    return undefined;
  const { deviceCredentialStatus, deviceCredentialList } = desktop;
  const { deviceCredentialResolve, deviceCredentialSave } = desktop;
  const { deviceCredentialRemove } = desktop;
  return {
    available: async () => (await deviceCredentialStatus({})).available,
    list: () => deviceCredentialList({}),
    resolve: (input) => deviceCredentialResolve(input),
    save: (input) => deviceCredentialSave(input),
    remove: async (id) => {
      await deviceCredentialRemove({ id });
    },
  };
}
