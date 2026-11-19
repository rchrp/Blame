import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

// The full output of the run logs the app's windows show (a run's
// terminal, a service's logs), one file each: a window keeps the last lines
// and reads the others back from here. Lines arrive whole, each ending with
// a newline; every indexStride-th line's offset is kept to read any range
// from close by.
const indexStride = 256;

type RunLogFile = {
  file: Promise<FileHandle>;
  path: string;
  // Where each indexStride-th line starts, in bytes.
  starts: number[];
  lines: number;
  bytes: number;
  // Writes, reads and the close, in the order they came.
  queue: Promise<unknown>;
};

export class RunLogStore {
  private readonly directory: string;
  private readonly logs = new Map<string, RunLogFile>();
  // A previous run of the app may have left its files.
  private ready?: Promise<unknown>;
  private created = 0;

  constructor(directory: string) {
    this.directory = directory;
  }

  append(key: string, text: string) {
    const log = this.logs.get(key) ?? this.create(key);
    const buffer = Buffer.from(text, "utf8");
    for (
      let at = buffer.indexOf(10);
      at !== -1;
      at = buffer.indexOf(10, at + 1)
    ) {
      log.lines += 1;
      if (log.lines % indexStride === 0) log.starts.push(log.bytes + at + 1);
    }
    const position = log.bytes;
    log.bytes += buffer.length;
    void this.after(log, async (file) => {
      await file.write(buffer, 0, buffer.length, position);
    }).catch(() => undefined);
  }

  // Lines from..to (excluded).
  async read(key: string, from: number, to: number) {
    const log = this.logs.get(key);
    if (!log) return [];
    const first = Math.max(0, Math.min(from, log.lines));
    const last = Math.max(first, Math.min(to, log.lines));
    if (first === last) return [];
    const block = Math.floor(first / indexStride);
    const start = log.starts[block]!;
    const end = log.starts[Math.ceil(last / indexStride)] ?? log.bytes;
    return this.after(log, async (file) => {
      const buffer = Buffer.alloc(end - start);
      await file.read(buffer, 0, buffer.length, start);
      return buffer
        .toString("utf8")
        .split("\n")
        .slice(first - block * indexStride, last - block * indexStride);
    });
  }

  async text(key: string) {
    const log = this.logs.get(key);
    if (!log) return "";
    const bytes = log.bytes;
    return this.after(log, async (file) => {
      const buffer = Buffer.alloc(bytes);
      await file.read(buffer, 0, bytes, 0);
      return buffer.toString("utf8");
    });
  }

  close(key: string) {
    const log = this.logs.get(key);
    if (!log) return;
    this.logs.delete(key);
    void this.after(log, (file) => file.close())
      .catch(() => undefined)
      .then(() => rm(log.path, { force: true }));
  }

  // Those of keys starting with prefix: a window's, once it goes away.
  closeAll(prefix: string) {
    for (const key of [...this.logs.keys()])
      if (key.startsWith(prefix)) this.close(key);
  }

  private create(key: string) {
    this.ready ??= rm(this.directory, { force: true, recursive: true }).then(
      () => mkdir(this.directory, { recursive: true }),
    );
    this.created += 1;
    const path = join(this.directory, `${this.created}.log`);
    const log: RunLogFile = {
      bytes: 0,
      file: this.ready.then(() => open(path, "w+")),
      lines: 0,
      path,
      queue: Promise.resolve(),
      starts: [0],
    };
    this.logs.set(key, log);
    return log;
  }

  private after<T>(log: RunLogFile, task: (file: FileHandle) => Promise<T>) {
    const result = log.queue.then(async () => task(await log.file));
    log.queue = result.catch(() => undefined);
    return result;
  }
}
