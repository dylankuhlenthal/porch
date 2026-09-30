/**
 * Removing the records of sessions that are not running (decision 0013). A session
 * that ended cleanly keeps its record, marked `ended`, and a session that died keeps
 * the record it left behind, shown as `gone`, so a tool can tell how it stopped. Both
 * are removed 24 hours later:
 *
 * - `ended`: 24 hours after `endedAt`, which its inside part wrote.
 * - `gone`: 24 hours after `porch list` or `porch watch` first saw it gone. The first
 *   look that sees it gone writes `goneSeenAt` into the record; a record is only ever
 *   seen gone once its adapter has confirmed the process is not running (for Pi, the
 *   pid and start-time rule; for Claude Code, no pid in `claude agents --json`), never
 *   when the adapter could not tell (`unknown`) or could not list at all.
 *
 * `porch list` and `porch watch` call `pruneStopped` with every observation their
 * adapters returned. Each record is read first without a lock, so a look that has
 * nothing to do takes none; any removal re-checks the record under its lock, so a
 * session that started again in between (a resumed Claude Code session keeps its id)
 * is left alone. Pruning is best effort: a failure is left for the next look.
 */
import type { RecordStore, SessionRecord } from "./records.js";
import type { Observation } from "./types.js";

/** How long an ended or gone session's record is kept. Not configurable for now. */
export const STOPPED_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

function olderThan(iso: string | null | undefined, ms: number, now: Date): boolean {
  if (typeof iso !== "string") return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && now.getTime() - t >= ms;
}

/**
 * The ended record is due for removal. Its end time is `endedAt`, or, for a record
 * without a readable one (edited by hand), when its status last changed, or its last write.
 */
export function endedRecordExpired(rec: SessionRecord, now: Date, ttlMs = STOPPED_RECORD_TTL_MS): boolean {
  if (rec.inside?.status !== "ended") return false;
  const at = [rec.inside.endedAt, rec.inside.since, rec.updatedAt].find((t) => typeof t === "string" && !Number.isNaN(Date.parse(t)));
  return olderThan(at, ttlMs, now);
}

/** The record of a session seen gone is due for removal. */
export function goneRecordExpired(rec: SessionRecord, now: Date, ttlMs = STOPPED_RECORD_TTL_MS): boolean {
  return rec.inside?.status !== "ended" && olderThan(rec.goneSeenAt, ttlMs, now);
}

/**
 * Note gone sessions and remove the records of sessions that stopped 24 hours ago,
 * given the observations one look produced. Never throws.
 */
export async function pruneStopped(records: RecordStore, observations: Observation[], now: Date, ttlMs = STOPPED_RECORD_TTL_MS): Promise<void> {
  for (const obs of observations) {
    if (obs.status !== "ended" && obs.status !== "gone") continue;
    try {
      const rec = await records.read(obs.harness, obs.session);
      if (rec === null) continue;
      if (obs.status === "ended") {
        if (endedRecordExpired(rec, now, ttlMs)) await records.removeIf(obs.harness, obs.session, (r) => endedRecordExpired(r, now, ttlMs));
        continue;
      }
      if (rec.goneSeenAt == null) await records.markGoneSeen(obs.harness, obs.session);
      else if (goneRecordExpired(rec, now, ttlMs)) await records.removeIf(obs.harness, obs.session, (r) => goneRecordExpired(r, now, ttlMs));
    } catch {
      // Best effort: the next look tries again.
    }
  }
}
