/**
 * How the Claude Code adapter turns a listing row, the session record and the job
 * file into an Observation (decision 11 in TRV-1133: busy and idle from the hook
 * record; alive, pid and waiting-on-prompt from `claude agents --json`; the job
 * file only in `detail` and `raw`).
 *
 * Status, in order:
 * 1. no listing row with a pid                 -> gone (a record left behind does not revive it)
 * 2. the listing says "waiting"                -> waiting-on-prompt
 * 3. the record's inside part has a status     -> that status (statusSource "hooks")
 * 4. the listing says "busy" or "idle"         -> that status (statusSource "listing": a session without Porch's hooks)
 * 5. otherwise                                 -> unknown
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
  let status: SessionStatus;
  let since: string | null = null;
  let statusSource: "hooks" | "listing" | null = null;
  if (!alive) {
    status = "gone";
  } else if (waiting) {
    status = "waiting-on-prompt";
  } else if (inside?.status) {
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
    pid: alive ? row.pid : null,
    shortId: row?.id ?? (typeof data.shortId === "string" ? data.shortId : null),
    name: row?.name ?? null,
    cwd: row?.cwd ?? inside?.cwd ?? null,
    prompt: waiting ? (row.waitingFor ?? null) : null,
    promptNeeds: waiting ? jobNeeds(job) : null,
    hasInsidePart: inside !== null,
    statusSource,
    lastTurnStart: inside?.lastTurnStart ?? null,
    lastTurnEnd: inside?.lastTurnEnd ?? null,
    backgroundTasks: inside?.backgroundTasks ?? null,
    activity: alive ? jobActivity(job) : null,
  };
  const raw = { listing: row?.raw ?? null, job, record: rec };
  return observation({ harness: CLAUDE_HARNESS, session, status, since, detail, raw, self: rec?.self ?? null });
}
