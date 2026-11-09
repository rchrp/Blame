import { sha256 } from "./harness/light-identity.js";
import {
  SessionJournal,
  type JournalFileTransition,
} from "./harness/session-journal.js";
import { WorkspaceFiles } from "./harness/workspace-files.js";
import { assertGitRepository, git } from "./runtime-git.js";
import { isRuntimeArtifactPath } from "./story-worktree-git.js";
import type {
  DirectStoryFile,
  DirectStoryFilesInput,
  DirectStoryFilesResult,
} from "./types.js";

// The files of a Direct story, in a folder it shares with the person, other
// Direct stories, chats and Plan Mode.
//
// The agent's journal records the file's hash before and after each of the
// story's writes, so the story needs no snapshot of the files that were
// already modified when it started: the first recorded hash says whether the
// file differed from HEAD before the story touched it.
export async function findDirectStoryFiles(
  input: DirectStoryFilesInput,
): Promise<DirectStoryFilesResult> {
  await assertGitRepository(input.root);
  const transitions = await sessionTransitions(input);
  const files = new WorkspaceFiles(input.root);
  const notIgnored = await notIgnoredPaths(input.root);
  const found: DirectStoryFile[] = [];
  for (const written of writtenFiles(transitions)) {
    if (
      isRuntimeArtifactPath(written.path) ||
      written.initial === written.final
    )
      continue;
    const [current, head] = await Promise.all([
      currentHash(files, written.path),
      headHashes(files, written.path),
    ]);
    // Already committed, or put back as it was: nothing left to commit.
    if (head.includes(current)) continue;
    // Not in HEAD and not known to Git: the file is ignored.
    if (head.includes("absent") && !notIgnored.has(written.path)) continue;
    found.push({
      path: written.path,
      shared: !(
        !written.interleaved &&
        written.initial !== undefined &&
        head.includes(written.initial) &&
        written.final === current
      ),
    });
  }
  return { files: found.sort((a, b) => a.path.localeCompare(b.path)) };
}

export type WrittenFile = {
  // Hash after the story's last write.
  final: string;
  // Hash before the story's first write, when it was recorded.
  initial?: string;
  // Someone else changed the file between two writes of the story.
  interleaved: boolean;
  path: string;
};

// Folds the story's writes, across its sessions, into one entry per file.
export function writtenFiles(transitions: JournalFileTransition[]) {
  const byPath = new Map<string, WrittenFile>();
  const ordered = [...transitions].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
  for (const { after, before, path } of ordered) {
    const known = byPath.get(path);
    if (!known) {
      byPath.set(path, {
        final: after,
        ...(before ? { initial: before } : {}),
        interleaved: false,
        path,
      });
      continue;
    }
    if (before && before !== known.final) known.interleaved = true;
    known.final = after;
  }
  return [...byPath.values()];
}

async function sessionTransitions(input: DirectStoryFilesInput) {
  const transitions = await Promise.all(
    [...new Set(input.sessionIds)].map((sessionId) =>
      new SessionJournal(input.root, sessionId).fileTransitions(),
    ),
  );
  return transitions.flat();
}

// Tracked or untracked files Git does not ignore, relative to the folder.
async function notIgnoredPaths(root: string) {
  const listing = await git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  return new Set(listing.split("\0").filter(Boolean));
}

async function currentHash(files: WorkspaceFiles, path: string) {
  try {
    return await files.blobHash(path);
  } catch {
    return "absent";
  }
}

// The hashes HEAD's version of a file has in the working tree: with
// core.autocrlf, Git checks the file out with CRLF line endings.
async function headHashes(files: WorkspaceFiles, path: string) {
  const baseline = await files.baseline(path);
  if (!baseline) return ["absent"];
  const crlf = Buffer.from(
    baseline.content.toString("latin1").replace(/\r?\n/g, "\r\n"),
    "latin1",
  );
  return [sha256(baseline.content), sha256(crlf)];
}
