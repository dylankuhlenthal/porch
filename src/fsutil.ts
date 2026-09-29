/** Small file helpers shared by the record store and the fake adapter's state file. */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export class LockTimeoutError extends Error {}

export interface LockOptions {
  /** How long to wait for another writer's lock before giving up. */
  timeoutMs?: number;
  /**
   * A lock older than this whose holder process is no longer running was left
   * behind by a crashed writer, and is broken.
   */
  staleMs?: number;
  /** A lock older than this is broken even if a process with its pid is running (the pid may have been reused). */
  hardStaleMs?: number;
}

/**
 * Run `fn` while holding `<file>.lock`, created with O_EXCL so only one process
 * holds it at a time. Creates the file's folder if needed.
 *
 * The lock file holds a token unique to this acquisition (`<pid>:<random>`).
 * Writers hold the lock for a few milliseconds. A lock older than `staleMs` (2 s)
 * whose pid is not running, or any lock older than `hardStaleMs` (30 s), was left by
 * a crashed writer and is broken; 2 s is shorter than `timeoutMs` (5 s), so a waiting
 * writer gets through instead of failing. Breaking renames the lock aside and
 * checks it is still the stale one before deleting it, and a holder deletes the
 * lock only if it still holds its own token, so a writer never deletes a lock
 * another writer has just taken.
 */
export async function withLock<T>(file: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const lock = `${file}.lock`;
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 2000;
  const hardStaleMs = options.hardStaleMs ?? 30000;
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await fs.open(lock, "wx", 0o600);
      await handle.writeFile(token);
      await handle.close();
      break;
    } catch (err) {
      if (isNotFound(err)) {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        continue;
      }
      if (!isExists(err)) throw err;
      await breakStaleLock(lock, staleMs, hardStaleMs);
      if (Date.now() > deadline) throw new LockTimeoutError(`timed out waiting for the lock on ${path.basename(file)}`);
      await sleep(5 + Math.floor(Math.random() * 10));
    }
  }
  try {
    return await fn();
  } finally {
    const held = await fs.readFile(lock, "utf8").catch(() => null);
    if (held === token) await fs.unlink(lock).catch(() => undefined);
  }
}

function processRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function breakStaleLock(lock: string, staleMs: number, hardStaleMs: number): Promise<void> {
  try {
    const st = await fs.stat(lock);
    const age = Date.now() - st.mtimeMs;
    if (age <= staleMs) return;
    const seen = await fs.readFile(lock, "utf8");
    const pid = Number(seen.split(":")[0]);
    if (age <= hardStaleMs && processRunning(pid)) return;
    // Move it aside, then check it is still the lock we judged stale. If another
    // writer broke it and took a new lock in between, we moved theirs: put it back.
    const aside = `${lock}.breaking.${randomBytes(4).toString("hex")}`;
    await fs.rename(lock, aside);
    const moved = await fs.readFile(aside, "utf8").catch(() => null);
    if (moved !== seen) await fs.link(aside, lock).catch(() => undefined);
    await fs.unlink(aside).catch(() => undefined);
  } catch {
    // already gone, or replaced: the next attempt finds out
  }
}

/** Replace `file` in one step: write a temp file next to it, then rename it over the original. */
export async function writeAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, contents, { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function isExists(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "EEXIST";
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
