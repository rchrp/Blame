import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, normalize } from "node:path";

// Projects whose stories in review keep their development server instead
// of serving a production build. Review builds are on by default; a project
// is keyed by its checkout's folder, which its story worktrees record.

type SettingsFile = { developmentOnly?: string[] };

export class PreviewServingSettings {
  private readonly file: string;
  private cache?: Promise<Set<string>>;

  constructor(file: string) {
    this.file = file;
  }

  async reviewBuilds(projectPath: string | undefined) {
    if (!validPath(projectPath)) return true;
    return !(await this.projects()).has(projectKey(projectPath));
  }

  async setReviewBuilds(projectPath: string, enabled: boolean) {
    if (!validPath(projectPath)) throw new Error("Invalid project folder.");
    const projects = new Set(await this.projects());
    if (enabled) projects.delete(projectKey(projectPath));
    else projects.add(projectKey(projectPath));
    const content: SettingsFile = { developmentOnly: [...projects].sort() };
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
          (Array.isArray(parsed.developmentOnly) ? parsed.developmentOnly : [])
            .filter(validPath)
            .map((path) => projectKey(path)),
        );
      })
      .catch(() => new Set<string>());
    return this.cache;
  }
}

function projectKey(path: string, platform = process.platform) {
  const key = normalize(path).replace(/[\\/]+$/, "");
  return platform === "win32" ? key.toLowerCase() : key;
}

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length < 4_096 &&
    !/[\0\r\n]/.test(value)
  );
}
