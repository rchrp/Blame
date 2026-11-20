import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeDevelopmentAttachment(
  name: string,
  content: Buffer,
  directory: string,
) {
  await mkdir(directory, { recursive: true });
  const filename = name.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
  const path = join(directory, `${randomUUID()}-${filename}`);
  await writeFile(path, content);
  return path;
}

export async function storeWorkspaceAttachment(
  workspaceRoot: string,
  input: unknown,
) {
  const attachment = input as {
    name?: unknown;
    contentBase64?: unknown;
  } | null;
  if (
    typeof attachment?.name !== "string" ||
    typeof attachment.contentBase64 !== "string"
  )
    throw new Error("Invalid workspace attachment");
  return writeDevelopmentAttachment(
    attachment.name,
    Buffer.from(attachment.contentBase64, "base64"),
    join(workspaceRoot, ".blame", "attachments", randomUUID()),
  );
}
