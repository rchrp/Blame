import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// What the app may send on its own, without the user picking the destination:
// usage telemetry to api.blame.so and the update check at launch. Both are on
// by default; the Windows installer and Settings → Desktop turn them off.
export type PrivacyPreferences = {
  telemetry: boolean;
  updateChecks: boolean;
};

export const defaultPrivacyPreferences: PrivacyPreferences = {
  telemetry: true,
  updateChecks: true,
};

const preferencesFile = "privacy-preferences.json";
// Written by the Windows installer's Privacy page (resources/installer/privacy.nsh).
const installerChoicesFile = "installer-privacy-choices.json";

// Reads the preferences synchronously: telemetry starts before the app is ready.
// The installer's choices are applied once, and only to turn something off, so
// reinstalling with the default boxes never re-enables what Settings turned off.
export function loadPrivacyPreferences(directory: string): PrivacyPreferences {
  const saved = readPreferences(join(directory, preferencesFile));
  const installerFile = join(directory, installerChoicesFile);
  const choices = readPreferences(installerFile);
  if (!choices) return { ...defaultPrivacyPreferences, ...saved };

  const merged = {
    telemetry: (saved?.telemetry ?? true) && choices.telemetry !== false,
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
    typeof (value as PrivacyPreferences).telemetry !== "boolean" ||
    typeof (value as PrivacyPreferences).updateChecks !== "boolean"
  ) {
    throw new Error("Invalid privacy preferences");
  }
  const { telemetry, updateChecks } = value as PrivacyPreferences;
  return { telemetry, updateChecks };
}

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
  const result: Partial<PrivacyPreferences> = {};
  for (const key of ["telemetry", "updateChecks"] as const) {
    const flag = (value as Record<string, unknown>)[key];
    if (typeof flag === "boolean") result[key] = flag;
  }
  return result;
}
