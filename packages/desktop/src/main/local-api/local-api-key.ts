import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The parts of Electron's safeStorage the key needs. */
export type SecretStorage = {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string }>;
};

const keyFile = "app-key.bin";

/**
 * The key the local API encrypts provider credentials with. Generated on
 * first launch and kept only in encrypted form, protected by the system
 * keychain through safeStorage.
 */
export async function localApiKey(directory: string, storage: SecretStorage) {
  if (!(await storage.isAsyncEncryptionAvailable())) {
    throw new Error(
      "The system keychain is unavailable: Blame cannot protect local credentials.",
    );
  }
  const path = join(directory, keyFile);
  const stored = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stored) return (await storage.decryptStringAsync(stored)).result;
  const key = randomBytes(32).toString("base64url");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, await storage.encryptStringAsync(key), {
    flag: "wx",
    mode: 0o600,
  });
  return key;
}
