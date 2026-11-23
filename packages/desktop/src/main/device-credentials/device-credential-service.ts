import { app, safeStorage } from "electron";
import { join } from "node:path";
import { DeviceCredentialStore } from "./device-credential-store.ts";
import { rememberDeviceSecret } from "./device-secret-redaction.ts";

let store: DeviceCredentialStore | undefined;

/** The credentials kept on this computer: `<userData>/device-credentials`. */
export function deviceCredentialStore() {
  store ??= new DeviceCredentialStore(
    join(app.getPath("userData"), "device-credentials"),
    safeStorage,
  );
  return store;
}

/** What the engine host asks for (`deviceCredential*` desktop services). */
export const deviceCredentialServices = {
  deviceCredentialStatus: async () => ({
    available: await deviceCredentialStore().available(),
  }),
  deviceCredentialList: () => deviceCredentialStore().list(),
  deviceCredentialResolve: async (input: {
    providerId: string;
    label?: string;
  }) => {
    const credential = await deviceCredentialStore().resolve(input);
    if (credential) {
      rememberDeviceSecret(credential.apiKey);
      rememberDeviceSecret(credential.oauthCredentials?.refresh);
    }
    return credential;
  },
  deviceCredentialSave: async (
    input: Parameters<DeviceCredentialStore["save"]>[0],
  ) => {
    rememberDeviceSecret(input.apiKey);
    rememberDeviceSecret(input.oauthCredentials?.refresh);
    return deviceCredentialStore().save(input);
  },
  deviceCredentialRemove: async (input: { id: string }) => {
    await deviceCredentialStore().remove(input.id);
    return null;
  },
};
