/**
 * Session records: one JSON file per session in <porch home>/sessions, named
 * <harness>-<session id>.json.
 *
 * A record has two parts, each with exactly one writer:
 * - `inside`: written only by the adapter's inside part (Claude Code hooks, the Pi
 *   extension, the fake adapter's `porch fake` commands).
 * - `self`: written only by `porch status set`, run inside the session.
 *
 * Every write takes a short lock on the record, reads it, changes only its own part
 * and replaces the file atomically (write a temp file, then rename), so two writers
 * updating different parts at the same moment never lose each other's change, and
 * a reader never sees a half-written file.
 *
 * When a session ends cleanly its inside part marks the record `ended` rather than
 * deleting it. `porch list` and `porch watch` remove ended and gone records 24 hours
 * later (src/prune.ts), and note when they first saw a session gone in `goneSeenAt`.
 */
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";

import { errorMessage, isNotFound, withLock, withLockSync, writeAtomic, writeAtomicSync } from "./fsutil.js";
import { SCHEMA_VERSION, type SchemaVersion, type SelfReport, type SessionStatus } from "./types.js";

/** Where a message for this session should go. `via` names the mechanism, `address` its target. */
export interface DeliveryAddress {
  via: string;
  address: string;
}

/** The part of a record the adapter's inside part owns. Every field is optional. */
export interface InsidePart {
  pid?: number | null;
  status?: SessionStatus | null;
  /** When `status` last changed. Filled in automatically when a patch changes `status` without giving it. */
  since?: string | null;
  delivery?: DeliveryAddress | null;
  cwd?: string | null;
  /** When the last turn started and ended (ISO 8601). */
  lastTurnStart?: string | null;
  lastTurnEnd?: string | null;
  /** Background tasks still running at the end of the last turn, where the harness reports it. */
  backgroundTasks?: number | null;
  /**
   * When the session ended cleanly (ISO 8601) and why, as the harness said (null when
   * it gave no reason). Kept only while `status` is `ended`: a write that changes the
   * status to anything else drops both (a resumed session starts again).
   */
  endedAt?: string | null;
  endReason?: string | null;
  /** Anything else harness-specific. Merged key by key by `updateInside`. */
  data?: Record<string, unknown>;
}

export interface SessionRecord {
  schema: SchemaVersion;
  harness: string;
  session: string;
  createdAt: string;
  updatedAt: string;
  inside: InsidePart | null;
  self: SelfReport | null;
  /**
   * When `porch list` or `porch watch` first saw this session gone (ISO 8601), for
   * removing the record 24 hours later. Written only by them (`markGoneSeen`); any
   * other write drops it, so a session that runs again starts afresh.
   */
  goneSeenAt?: string | null;
}

/** An inside part whose session has ended: only a new start may change it. */
export function hasEnded(rec: SessionRecord | null): boolean {
  return rec?.inside?.status === "ended";
}

export interface RecordProblem {
  file: string;
  message: string;
}

const HARNESS_RE = /^[a-z][a-z0-9]{0,31}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class RecordError extends Error {}
/** A harness name or session id that is not allowed (it could point outside the records folder). */
export class InvalidIdError extends RecordError {}
/** A record file that cannot be read as a schema 1 or 2 record. Writers refuse to overwrite it. */
export class CorruptRecordError extends RecordError {}

export function validateHarness(harness: string): void {
  if (!HARNESS_RE.test(harness)) {
    throw new InvalidIdError(`invalid harness name '${harness}' (lowercase letters and digits, starting with a letter)`);
  }
}

export function validateSessionId(session: string): void {
  if (!SESSION_RE.test(session) || session.includes("..")) {
    throw new InvalidIdError(`invalid session id '${session}'`);
  }
}

export interface RecordStoreOptions {
  /** Clock, replaceable in tests. */
  now?: () => Date;
  /** How long to wait for another writer's lock before giving up. */
  lockTimeoutMs?: number;
  /** A lock older than this is treated as left behind by a crashed writer and broken. */
  staleLockMs?: number;
}

export class RecordStore {
  readonly dir: string;
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(dir: string, options: RecordStoreOptions = {}) {
    this.dir = dir;
    this.now = options.now ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.staleLockMs = options.staleLockMs ?? 2000;
  }

  recordPath(harness: string, session: string): string {
    validateHarness(harness);
    validateSessionId(session);
    return path.join(this.dir, `${harness}-${session}.json`);
  }

  async read(harness: string, session: string): Promise<SessionRecord | null> {
    const file = this.recordPath(harness, session);
    return readRecordFile(file);
  }

  /** Every record, or only one harness's. Unreadable files are reported, not thrown. */
  async list(harness?: string): Promise<{ records: SessionRecord[]; problems: RecordProblem[] }> {
    if (harness !== undefined) validateHarness(harness);
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if (isNotFound(err)) return { records: [], problems: [] };
      throw err;
    }
    const records: SessionRecord[] = [];
    const problems: RecordProblem[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      if (harness !== undefined && !name.startsWith(`${harness}-`)) continue;
      const file = path.join(this.dir, name);
      try {
        const rec = await readRecordFile(file);
        if (rec === null) continue; // removed between readdir and read
        if (`${rec.harness}-${rec.session}.json` !== name) {
          problems.push({ file, message: "file name does not match the harness and session inside it" });
          continue;
        }
        records.push(rec);
      } catch (err) {
        problems.push({ file, message: errorMessage(err) });
      }
    }
    return { records, problems };
  }

  /**
   * Create or change the inside part. A patch object is merged onto the current
   * inside part (and `data` key by key); a function receives the current inside
   * part and returns the whole new one. Changing `status` without giving `since`
   * sets `since` to now.
   */
  async updateInside(
    harness: string,
    session: string,
    change: InsidePart | ((current: InsidePart | null) => InsidePart),
  ): Promise<SessionRecord> {
    return (await this.changeInside(harness, session, change, true))!;
  }

  /**
   * Like `updateInside`, but only when the record already exists and its session has
   * not ended; returns null and writes nothing otherwise. For every event but the
   * session's start, so a late event (a hook that runs after the session ended) can
   * neither bring back a removed record nor turn an ended session back into a running one.
   */
  async updateInsideIfExists(
    harness: string,
    session: string,
    change: InsidePart | ((current: InsidePart | null) => InsidePart),
  ): Promise<SessionRecord | null> {
    return this.changeInside(harness, session, change, false);
  }

  /**
   * `updateInsideIfExists` for a process that is exiting, when nothing asynchronous
   * will run again (Node's `exit` event): the same rules, done synchronously. A lock
   * held by this same process belongs to a write that will now never finish, so it is
   * taken over; a lock held by another process is waited for at most `timeoutMs`.
   * Returns whether it wrote. Throws on failure, like the asynchronous writes.
   */
  updateInsideIfExistsSync(harness: string, session: string, patch: InsidePart, options: { timeoutMs?: number } = {}): boolean {
    const file = this.recordPath(harness, session);
    if (!existsSync(file)) return false; // nothing to change, and maybe no folder to lock in
    return withLockSync(
      file,
      () => {
        const existing = readRecordFileSync(file);
        if (existing === null || hasEnded(existing)) return false;
        this.applyInside(existing, patch, false);
        existing.updatedAt = this.now().toISOString();
        delete existing.goneSeenAt;
        writeAtomicSync(file, JSON.stringify(existing, null, 2) + "\n");
        return true;
      },
      { timeoutMs: options.timeoutMs ?? 500, staleMs: this.staleLockMs },
    );
  }

  private changeInside(
    harness: string,
    session: string,
    change: InsidePart | ((current: InsidePart | null) => InsidePart),
    create: boolean,
  ): Promise<SessionRecord | null> {
    return this.mutate(harness, session, create, (rec) => this.applyInside(rec, change, !create));
  }

  /** Change `rec.inside` in place; false (no change) when `skipEnded` and the session has ended. */
  private applyInside(rec: SessionRecord, change: InsidePart | ((current: InsidePart | null) => InsidePart), skipEnded: boolean): boolean {
    if (skipEnded && hasEnded(rec)) return false;
    const current = rec.inside;
    let next: InsidePart;
    if (typeof change === "function") {
      next = change(current === null ? null : structuredClone(current));
    } else {
      // A key given as undefined means "not part of this patch", never "erase it".
      const patch = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) as InsidePart;
      next = { ...(current ?? {}), ...patch };
      if (change.data !== undefined) next.data = { ...(current?.data ?? {}), ...change.data };
    }
    const statusChanged = next.status != null && next.status !== current?.status;
    const sinceGiven = typeof change === "function" ? next.since !== current?.since : change.since !== undefined;
    if (statusChanged && !sinceGiven) next.since = this.now().toISOString();
    // How the session ended belongs to an ended session only: a start after it (a resume) drops it.
    if (next.status !== "ended") {
      delete next.endedAt;
      delete next.endReason;
    }
    rec.inside = next;
    return true;
  }

  /**
   * Note that `porch list` or `porch watch` saw this session gone, unless an earlier
   * look already did: sets `goneSeenAt` to now when it is not set. Never creates a
   * record. Returns the record written, or null when nothing was (no record, or
   * `goneSeenAt` already set).
   */
  async markGoneSeen(harness: string, session: string): Promise<SessionRecord | null> {
    return this.mutate(
      harness,
      session,
      false,
      (rec) => {
        if (rec.goneSeenAt != null) return false;
        rec.goneSeenAt = this.now().toISOString();
      },
      { keepGoneSeen: true },
    );
  }

  /**
   * Delete the record if `shouldRemove` still says so once its lock is held (the
   * session may have started again since it was last read). Returns whether it did.
   */
  async removeIf(harness: string, session: string, shouldRemove: (rec: SessionRecord) => boolean): Promise<boolean> {
    const file = this.recordPath(harness, session);
    return this.withLock(file, async () => {
      const rec = await readRecordFile(file);
      if (rec === null || !shouldRemove(rec)) return false;
      try {
        await fs.unlink(file);
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    });
  }

  /** Write the self-reported part. Only `porch status set` calls this. */
  async setSelf(harness: string, session: string, self: SelfReport): Promise<SessionRecord> {
    return (await this.mutate(harness, session, true, (rec) => {
      rec.self = { ...self };
    }))!;
  }

  /** Delete the record. Returns false when there was none. */
  async remove(harness: string, session: string): Promise<boolean> {
    const file = this.recordPath(harness, session);
    return this.withLock(file, async () => {
      try {
        await fs.unlink(file);
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    });
  }

  /**
   * Change the record under its lock. With `create` false, a missing record is left
   * missing and null returned. When `fn` returns false nothing is written. Every write
   * but `markGoneSeen`'s drops `goneSeenAt`: a record written to is not gone.
   */
  private async mutate(
    harness: string,
    session: string,
    create: boolean,
    fn: (rec: SessionRecord) => boolean | void,
    options: { keepGoneSeen?: boolean } = {},
  ): Promise<SessionRecord | null> {
    const file = this.recordPath(harness, session);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    return this.withLock(file, async () => {
      const nowIso = this.now().toISOString();
      const existing = await readRecordFile(file);
      if (existing === null && !create) return null;
      const rec: SessionRecord = existing ?? {
        schema: SCHEMA_VERSION,
        harness,
        session,
        createdAt: nowIso,
        updatedAt: nowIso,
        inside: null,
        self: null,
      };
      if (fn(rec) === false) return null;
      rec.updatedAt = nowIso;
      if (!options.keepGoneSeen) delete rec.goneSeenAt;
      await writeAtomic(file, JSON.stringify(rec, null, 2) + "\n");
      return rec;
    });
  }

  private withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    return withLock(file, fn, { timeoutMs: this.lockTimeoutMs, staleMs: this.staleLockMs });
  }
}

async function readRecordFile(file: string): Promise<SessionRecord | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  return parseRecord(file, text);
}

function readRecordFileSync(file: string): SessionRecord | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  return parseRecord(file, text);
}

function parseRecord(file: string, text: string): SessionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CorruptRecordError(`${path.basename(file)} is not valid JSON`);
  }
  if (!isRecord(parsed)) throw new CorruptRecordError(`${path.basename(file)} is not a schema ${READABLE_SCHEMAS.join(" or ")} session record`);
  // Read as the current schema: a schema 1 record has the same shape (schema 2 only
  // added the ended status and its fields), and its next write stores it as schema 2.
  return { ...parsed, schema: SCHEMA_VERSION };
}

/**
 * Record schemas Porch reads. Schema 1 records, written before sessions could end as
 * `ended` (decision 0013), are read as they are, so records already in a records
 * folder keep working.
 */
const READABLE_SCHEMAS: readonly number[] = [1, SCHEMA_VERSION];

function isRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    READABLE_SCHEMAS.includes(v.schema as number) &&
    typeof v.harness === "string" &&
    typeof v.session === "string" &&
    (v.inside === null || typeof v.inside === "object") &&
    (v.self === null || typeof v.self === "object")
  );
}

