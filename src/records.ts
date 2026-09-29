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
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { errorMessage, isNotFound, withLock, writeAtomic } from "./fsutil.js";
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
}

export interface RecordProblem {
  file: string;
  message: string;
}

const HARNESS_RE = /^[a-z][a-z0-9]{0,31}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class RecordError extends Error {}

export function validateHarness(harness: string): void {
  if (!HARNESS_RE.test(harness)) {
    throw new RecordError(`invalid harness name '${harness}' (lowercase letters and digits, starting with a letter)`);
  }
}

export function validateSessionId(session: string): void {
  if (!SESSION_RE.test(session) || session.includes("..")) {
    throw new RecordError(`invalid session id '${session}'`);
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
    return this.mutate(harness, session, (rec) => {
      const current = rec.inside;
      let next: InsidePart;
      if (typeof change === "function") {
        next = change(current === null ? null : structuredClone(current));
      } else {
        next = { ...(current ?? {}), ...change };
        if (change.data !== undefined) next.data = { ...(current?.data ?? {}), ...change.data };
      }
      const statusChanged = next.status != null && next.status !== current?.status;
      const sinceGiven = typeof change === "function" ? next.since !== current?.since : change.since !== undefined;
      if (statusChanged && !sinceGiven) next.since = this.now().toISOString();
      rec.inside = next;
    });
  }

  /** Write the self-reported part. Only `porch status set` calls this. */
  async setSelf(harness: string, session: string, self: SelfReport): Promise<SessionRecord> {
    return this.mutate(harness, session, (rec) => {
      rec.self = { ...self };
    });
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

  private async mutate(harness: string, session: string, fn: (rec: SessionRecord) => void): Promise<SessionRecord> {
    const file = this.recordPath(harness, session);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    return this.withLock(file, async () => {
      const nowIso = this.now().toISOString();
      const existing = await readRecordFile(file);
      const rec: SessionRecord = existing ?? {
        schema: SCHEMA_VERSION,
        harness,
        session,
        createdAt: nowIso,
        updatedAt: nowIso,
        inside: null,
        self: null,
      };
      fn(rec);
      rec.updatedAt = nowIso;
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
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new RecordError(`${path.basename(file)} is not a schema ${SCHEMA_VERSION} session record`);
  return parsed;
}

function isRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.schema === SCHEMA_VERSION &&
    typeof v.harness === "string" &&
    typeof v.session === "string" &&
    (v.inside === null || typeof v.inside === "object") &&
    (v.self === null || typeof v.self === "object")
  );
}

