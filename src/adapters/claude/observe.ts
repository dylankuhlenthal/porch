/**
 * How the Claude Code adapter turns a listing row, the session record and the job
 * file into an Observation (decision 11 in TRV-1133, amended by decision 28: busy
 * and idle from the hook record, except that the listing's idle wins over the
 * record's busy; alive, pid and waiting-on-prompt from `claude agents --json`; the
 * job file only in `detail` and `raw`).
 *
 * Status, in order:
 * 1. the record's inside part says ended (the  -> ended (statusSource "hooks", with endReason)
 *    SessionEnd hook ran), unless a later
 *    process of the session is listed, or a
 *    process is listed and the record has no pid
 * 2. no listing row with a pid                 -> gone (a record left behind does not revive it)
 * 3. the listing says "waiting"                -> waiting-on-prompt
 * 4. the record's inside part says busy, was   -> idle (statusSource "listing", detail.recordStatus "busy")
 *    written by the listed process, and the
 *    listing says "idle"
 * 5. the record's inside part has a status,   -> that status (statusSource "hooks")
 *    and was written by the listed process
 * 6. the listing says "busy" or "idle"         -> that status (statusSource "listing": a session without Porch's
 *                                                 hooks, a record without an inside status, or a record from an
 *                                                 earlier process of the session, noted as detail.recordPid)
 * 7. otherwise                                 -> unknown
 *
 * Rule 1 comes first because SessionEnd runs while the process is still listed, and
 * after `/clear` the same process goes on under a new session id.
 *
 * Rule 4 is there because Claude Code does not run the Stop hook when a turn is
 * interrupted, so the record says busy until the next prompt. The listing's idle is
 * trusted over the record's busy, but not its busy over the record's idle: the
 * listing's busy has been seen stale long after a turn ended. No grace period after
 * the turn starts is needed: measured with 2.1.285, the listing already says busy
 * when the UserPromptSubmit hook writes busy (docs/domains/claude-adapter.md).
 *
 * A record is from an earlier process when both pids are known and differ (a
 * resume without the hooks); deliver already ignores its socket for the same reason.
 */
import { observation } from "../../adapter.js";
import type { SessionRecord } from "../../records.js";
import type { Observation, SessionStatus } from "../../types.js";
import type { ListingRow } from "./listing.js";

export const CLAUDE_HARNESS = "claude";

export interface RunningEntry {
  kind: string;
  label: string;
  /** ISO 8601, or null when the job file does not say. */
  since: string | null;
}

export interface Activity {
  /** The session's own one-line summary of what it is doing. */
  detail: string | null;
  /** Subagents and background commands it started that are still running (null: cannot tell). */
  inFlight: number | null;
  running: RunningEntry[];
}

function oneLine(value: unknown, limit: number): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.split(/\s+/).filter(Boolean).join(" ");
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** What the job file says the session is doing, or null when it says nothing usable. */
export function jobActivity(job: Record<string, unknown> | null): Activity | null {
  if (job === null) return null;
  const inFlightObj = job.inFlight;
  const inFlight =
    typeof inFlightObj === "object" && inFlightObj !== null ? wholeNumber((inFlightObj as Record<string, unknown>).tasks) : null;
  const running: RunningEntry[] = [];
  for (const entry of Array.isArray(job.fan) ? job.fan : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (e.doneAt !== undefined && e.doneAt !== null) continue;
    const label = oneLine(e.label, 120);
    if (label === null) continue;
    const started = typeof e.startedAt === "number" && Number.isFinite(e.startedAt) ? new Date(e.startedAt) : null;
    running.push({
      kind: typeof e.kind === "string" && e.kind !== "" ? e.kind : "task",
      label,
      since: started !== null && !Number.isNaN(started.getTime()) ? started.toISOString() : null,
    });
  }
  const detail = oneLine(job.detail, 200);
  if (detail === null && inFlight === null && running.length === 0) return null;
  return { detail, inFlight, running };
}

/** The exact ask of an open prompt, from the job file, when it has one. */
function jobNeeds(job: Record<string, unknown> | null): string | null {
  return job !== null && job.tempo === "blocked" ? oneLine(job.needs, 300) : null;
}

export function claudeObservation(
  session: string,
  row: ListingRow | null,
  rec: SessionRecord | null,
  job: Record<string, unknown> | null,
): Observation {
  const inside = rec?.inside ?? null;
  const alive = row !== null && row.pid !== null;
  const waiting = alive && row.status === "waiting";
  const recordPid = inside?.pid ?? null;
  const otherProcess = alive && recordPid !== null && recordPid !== row.pid;
  // An ended record whose pid is not known cannot say whether the listed process is
  // the one that ended or a later one (a resume without the hooks): the running
  // listing row wins, and the record is treated like one from another process.
  const endedUnknownPid = alive && inside?.status === "ended" && recordPid === null;
  const recordOutdated = otherProcess || endedUnknownPid;
  let status: SessionStatus;
  let since: string | null = null;
  let statusSource: "hooks" | "listing" | null = null;
  // The record's status, when it was written by the listed process but the listing's was used instead.
  let recordStatus: SessionStatus | null = null;
  let endReason: string | null = null;
  if (inside?.status === "ended" && !recordOutdated) {
    status = "ended";
    since = inside.endedAt ?? inside.since ?? null;
    endReason = inside.endReason ?? null;
    statusSource = "hooks";
  } else if (!alive) {
    status = "gone";
  } else if (waiting) {
    status = "waiting-on-prompt";
  } else if (inside?.status === "busy" && !recordOutdated && row.status === "idle") {
    status = "idle";
    statusSource = "listing";
    recordStatus = inside.status;
  } else if (inside?.status && !recordOutdated) {
    status = inside.status;
    since = inside.since ?? null;
    statusSource = "hooks";
  } else if (row.status === "busy" || row.status === "idle") {
    status = row.status;
    statusSource = "listing";
  } else {
    status = "unknown";
  }
  const data = inside?.data ?? {};
  const detail = {
    // An ended session's process may still be listed for a moment while it exits.
    pid: alive && status !== "ended" ? row.pid : null,
    shortId: row?.id ?? (typeof data.shortId === "string" ? data.shortId : null),
    name: row?.name ?? null,
    cwd: row?.cwd ?? inside?.cwd ?? null,
    prompt: waiting ? (row.waitingFor ?? null) : null,
    promptNeeds: waiting ? jobNeeds(job) : null,
    hasInsidePart: inside !== null,
    statusSource,
    // Only when the record was written by another process of the session than the
    // listed one, so its status was not used. Left out otherwise, so the committed
    // conformance recordings still replay unchanged.
    ...(otherProcess ? { recordPid } : {}),
    // Only when the listing's idle was used over the record's busy (rule 4). Left out
    // otherwise, for the same reason as recordPid.
    ...(recordStatus !== null ? { recordStatus } : {}),
    lastTurnStart: inside?.lastTurnStart ?? null,
    lastTurnEnd: inside?.lastTurnEnd ?? null,
    backgroundTasks: inside?.backgroundTasks ?? null,
    activity: alive && status !== "ended" ? jobActivity(job) : null,
  };
  const raw = { listing: row?.raw ?? null, job, record: rec };
  // Attached: Porch's hooks wrote the record, from the listed process when it runs.
  // A record from an earlier process (a resume without the hooks) does not count.
  const attached = inside !== null && !recordOutdated;
  return observation({ harness: CLAUDE_HARNESS, session, attached, status, since, endReason, detail, raw, self: rec?.self ?? null });
}
