import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Projects that turned on Advanced browser diagnostics: performance traces,
// Lighthouse audits, heap snapshots and third-party developer tools.

type SettingsFile = { advancedDiagnostics?: string[] };

export class PreviewDevtoolsSettings {
  private readonly file: string;
  private cache?: Promise<Set<string>>;

  constructor(file: string) {
    this.file = file;
  }

  async advancedDiagnostics(projectId: string | undefined) {
    if (!validProjectId(projectId)) return false;
    return (await this.projects()).has(projectId);
  }

  async setAdvancedDiagnostics(projectId: string, enabled: boolean) {
    if (!validProjectId(projectId)) throw new Error("Invalid project id.");
    const projects = new Set(await this.projects());
    if (enabled) projects.add(projectId);
    else projects.delete(projectId);
    const content: SettingsFile = { advancedDiagnostics: [...projects].sort() };
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(content, null, 2));
    await rename(temporary, this.file);
    this.cache = Promise.resolve(projects);
    return enabled;
  }

  private projects() {
    this.cache ??= readFile(this.file, "utf8")
      .then((value) => {
        const parsed = JSON.parse(value) as SettingsFile;
        return new Set(
          (Array.isArray(parsed.advancedDiagnostics)
            ? parsed.advancedDiagnostics
            : []
          ).filter(validProjectId),
        );
      })
      .catch(() => new Set<string>());
    return this.cache;
  }
}

function validProjectId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value);
}
