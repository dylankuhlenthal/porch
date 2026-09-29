/** Small file helpers shared by the record store and the fake adapter's state file. */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export class LockTimeoutError extends Error {}

export interface LockOptions {
  /** How long to wait for another writer's lock before giving up. */
  timeoutMs?: number;
  /** A lock older than this is treated as left behind by a crashed writer and broken. */
  staleMs?: number;
}

/**
 * Run `fn` while holding `<file>.lock`, created with O_EXCL so only one process
 * holds it at a time. Creates the file's folder if needed.
 */
export async function withLock<T>(file: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const lock = `${file}.lock`;
  const timeoutMs = options.timeoutMs ?? 3000;
  const staleMs = options.staleMs ?? 10000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await fs.open(lock, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (err) {
      if (isNotFound(err)) {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        continue;
      }
      if (!isExists(err)) throw err;
      await breakStaleLock(lock, staleMs);
      if (Date.now() > deadline) throw new LockTimeoutError(`timed out waiting for the lock on ${path.basename(file)}`);
      await sleep(5 + Math.floor(Math.random() * 10));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(lock).catch(() => undefined);
  }
}

async function breakStaleLock(lock: string, staleMs: number): Promise<void> {
  try {
    const st = await fs.stat(lock);
    if (Date.now() - st.mtimeMs > staleMs) await fs.unlink(lock);
  } catch {
    // already gone, or unreadable: the next attempt finds out
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
