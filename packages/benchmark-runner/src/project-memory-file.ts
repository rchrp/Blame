import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ProjectMemoryCandidate,
  ProjectMemoryPersistence,
  ProjectMemoryRecord,
} from "@blame/agent-runtime/engine";

export class ProjectMemoryFile implements ProjectMemoryPersistence {
  constructor(private readonly path: string) {}

  async list(_connection: unknown, projectId: string) {
    return (await this.records()).filter(
      (record) => record.projectId === projectId,
    );
  }

  async save(
    _connection: unknown,
    projectId: string,
    candidate: ProjectMemoryCandidate,
  ) {
    const records = await this.records();
    const existing = records.find(
      (record) =>
        record.projectId === projectId &&
        record.fingerprint === candidate.fingerprint,
    );
    if (existing) return existing;
    const record = {
      ...candidate,
      createdAt: new Date().toISOString(),
      id: randomUUID(),
      projectId,
    } satisfies ProjectMemoryRecord;
    const projectRecords = [
      record,
      ...records.filter((item) => item.projectId === projectId),
    ].slice(0, 64);
    const otherRecords = records.filter((item) => item.projectId !== projectId);
    await this.write([...projectRecords, ...otherRecords]);
    return record;
  }

  private async records(): Promise<ProjectMemoryRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(parsed))
        throw new Error("Project memory file must contain an array.");
      return parsed as ProjectMemoryRecord[];
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  private async write(records: ProjectMemoryRecord[]) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function isMissingFile(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
