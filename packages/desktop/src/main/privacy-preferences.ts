import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// What the app may send on its own, without the user picking the destination:
// the update check at launch. It is on by default; the Windows installer and
// Settings → Desktop turn it off.
export type PrivacyPreferences = {
  updateChecks: boolean;
};

export const defaultPrivacyPreferences: PrivacyPreferences = {
  updateChecks: true,
};

const preferencesFile = "privacy-preferences.json";
// Written by the Windows installer's Privacy page (resources/installer/privacy.nsh).
const installerChoicesFile = "installer-privacy-choices.json";

// The installer's choices are applied once, and only to turn something off, so
// reinstalling with the default boxes never re-enables what Settings turned off.
export function loadPrivacyPreferences(directory: string): PrivacyPreferences {
  const saved = readPreferences(join(directory, preferencesFile));
  const installerFile = join(directory, installerChoicesFile);
  const choices = readPreferences(installerFile);
  if (!choices) return { ...defaultPrivacyPreferences, ...saved };

  const merged = {
    updateChecks:
      (saved?.updateChecks ?? true) && choices.updateChecks !== false,
  };
  try {
    savePrivacyPreferences(directory, merged);
    rmSync(installerFile, { force: true });
  } catch (error) {
    console.warn("Could not apply the installer's privacy choices", error);
  }
  return merged;
}

export function savePrivacyPreferences(
  directory: string,
  preferences: PrivacyPreferences,
) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, preferencesFile),
    `${JSON.stringify(preferences, null, 2)}\n`,
    "utf8",
  );
}

export function parsePrivacyPreferences(value: unknown): PrivacyPreferences {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as PrivacyPreferences).updateChecks !== "boolean"
  ) {
    throw new Error("Invalid privacy preferences");
  }
  return { updateChecks: (value as PrivacyPreferences).updateChecks };
}

// Keys the app no longer knows are ignored, so older files still load.
function readPreferences(
  file: string,
): Partial<PrivacyPreferences> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const updateChecks = (value as Record<string, unknown>).updateChecks;
  return typeof updateChecks === "boolean" ? { updateChecks } : {};
}
