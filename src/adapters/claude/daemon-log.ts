/**
 * Claude Code's idle stop, read from its daemon log (decision 0014).
 *
 * Claude Code stops a background session it judges idle (after an hour, or sooner
 * when the machine is short of memory) without running the `SessionEnd` hook, so
 * the session's record is left saying it was running, like a session that died.
 * The daemon writes one line when it does this, just before the process exits:
 *
 *   [2026-09-30T15:02:56.175Z] [bg] bg retire d8d23018: idle-prompt, idle 61m
 *
 * optionally followed by `, worker <version> (daemon <version>)` and ` [low memory]`
 * (or `[low memory, monitoring only]`, `[low memory, pinned]`). From 120 minutes the
 * idle time is written in whole hours (`idle 2h`). A killed or crashed session gets
 * no such line. The format is observed, not documented (docs/domains/claude-adapter.md),
 * so a line that does not match exactly is not an idle stop: the session stays `gone`.
 *
 * The log is `daemon.log` in Claude Code's folder, rotated to `daemon.log.1`. Both
 * are read through `ctx.io`, so conformance runs record them, and every problem
 * reading them reads as "no line".
 */
import path from "node:path";

import type { AdapterContext } from "../../adapter.js";
import type { InsidePart, SessionRecord } from "../../records.js";
import { claudeConfigDir, type ListingRow } from "./listing.js";

/** The endReason Porch gives a session Claude Code stopped for being idle. */
export const IDLE_END_REASON = "idle";

/** What a `bg retire` line says. */
export interface IdleStop {
  /** The line's own time (ISO 8601): when Claude Code stopped the session. */
  at: string;
  /** Claude Code's reason: settled, idle-prompt, abandoned-stale or empty-idle (2.1.286). */
  cause: string;
  /** How long the session had been idle, in minutes (whole hours from 120 minutes, as the line gives it). */
  idleMinutes: number;
  /** The low-memory note (`low memory`, `low memory, monitoring only`, `low memory, pinned`), or null. */
  lowMemory: string | null;
  /** The line as written. */
  line: string;
}

const SHORT_ID_RE = /^[0-9a-f]{4,64}$/;
const RETIRE_RE =
  /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\] \[bg\] bg retire ([0-9a-f]+): ([a-z][a-z-]*), idle (\d+)(m|h)(?:, worker \S+ \(daemon \S+\))?(?: \[(low memory[^\]]*)\])?$/;

/** The `bg retire` line in one log line, or null when it is not one. */
export function parseRetireLine(line: string): (IdleStop & { short: string }) | null {
  const m = RETIRE_RE.exec(line);
  if (m === null) return null;
  const at = new Date(m[1]!);
  if (Number.isNaN(at.getTime())) return null;
  const amount = Number(m[4]);
  return {
    short: m[2]!,
    at: at.toISOString(),
    cause: m[3]!,
    idleMinutes: m[5] === "h" ? amount * 60 : amount,
    lowMemory: m[6] ?? null,
    line,
  };
}

/**
 * The last `bg retire <shortId>:` line dated after `after`, in the log texts given
 * oldest first (`daemon.log.1`, then `daemon.log`), or null.
 */
export function findIdleStop(logs: string[], shortId: string, after: string): IdleStop | null {
  const bound = Date.parse(after);
  if (Number.isNaN(bound)) return null;
  const marker = `bg retire ${shortId}:`;
  let found: IdleStop | null = null;
  for (const text of logs) {
    for (const raw of text.split("\n")) {
      if (!raw.includes(marker)) continue;
      const parsed = parseRetireLine(raw.replace(/\r$/, ""));
      if (parsed === null || parsed.short !== shortId || Date.parse(parsed.at) <= bound) continue;
      const { short: _short, ...stop } = parsed;
      found = stop;
    }
  }
  return found;
}

/** `daemon.log.1` then `daemon.log`, those that could be read. */
export async function readDaemonLogs(ctx: AdapterContext): Promise<string[]> {
  const dir = claudeConfigDir(ctx.env);
  if (dir === null) return [];
  const texts: string[] = [];
  for (const name of ["daemon.log.1", "daemon.log"]) {
    try {
      const text = await ctx.io.readFile(path.join(dir, name));
      if (text !== null) texts.push(text);
    } catch {
      // Unreadable reads as "no line".
    }
  }
  return texts;
}

/** The later of two times (ISO 8601), skipping any that do not parse; null when neither does. */
function later(a: unknown, b: unknown): string | null {
  const times = [a, b].filter((t): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t)));
  if (times.length === 0) return null;
  return times.reduce((x, y) => (Date.parse(y) > Date.parse(x) ? y : x));
}

/**
 * What to look for in the log for this session: its short id and the time a
 * retire line must come after (the later of its last turn's end and its process's
 * start), or null when the session does not qualify. It qualifies when its record
 * has an inside part that has not ended and knows its short id (so interactive
 * sessions never do), and no process of it is listed running.
 */
export function idleStopQuery(row: ListingRow | null, inside: InsidePart | null | undefined): { shortId: string; after: string } | null {
  if (row !== null && row.pid !== null) return null;
  if (inside == null || inside.status === "ended") return null;
  const shortId = inside.data?.shortId;
  if (typeof shortId !== "string" || !SHORT_ID_RE.test(shortId)) return null;
  const after = later(inside.lastTurnEnd, inside.data?.startedAt);
  return after === null ? null : { shortId, after };
}

/** The end fields that mark a record's inside part as stopped for being idle. */
export function idleStopEnd(stop: IdleStop): { endedAt: string; endReason: string; data: Record<string, unknown> } {
  return {
    endedAt: stop.at,
    endReason: IDLE_END_REASON,
    data: { idleStop: { cause: stop.cause, idleMinutes: stop.idleMinutes, lowMemory: stop.lowMemory, line: stop.line } },
  };
}

/**
 * If the session's process has gone and the log says Claude Code stopped it for
 * being idle, mark its record ended (the fields `SessionEnd` would have written,
 * with endReason "idle" and the line's time) and return the record as it now is.
 * Otherwise return the record unchanged. `logs` is read at most once per caller.
 */
export async function applyIdleStop(
  ctx: AdapterContext,
  session: string,
  row: ListingRow | null,
  rec: SessionRecord | null,
  logs: () => Promise<string[]>,
  harness: string,
): Promise<SessionRecord | null> {
  const query = idleStopQuery(row, rec?.inside);
  if (rec === null || query === null) return rec;
  const stop = findIdleStop(await logs(), query.shortId, query.after);
  if (stop === null) return rec;
  const end = idleStopEnd(stop);
  // Re-checked under the record's lock: a resume since the record was read starts
  // the session again, and an earlier stop no longer counts.
  const stillApplies = (inside: InsidePart) => {
    const q = idleStopQuery(row, inside);
    return q !== null && q.shortId === query.shortId && Date.parse(stop.at) > Date.parse(q.after);
  };
  try {
    const marked = await ctx.records.markInsideEnded(harness, session, end, stillApplies);
    if (marked !== null) return marked;
    // Not written: the record changed or went away since it was read. Use it as it is now.
    return (await ctx.records.read(harness, session).catch(() => null)) ?? rec;
  } catch {
    // The record could not be written (a lock held too long, a folder that cannot be
    // written): report what the log says this time; the next look tries to save it again.
    return { ...rec, inside: { ...rec.inside!, status: "ended", since: end.endedAt, endedAt: end.endedAt, endReason: end.endReason, data: { ...rec.inside!.data, ...end.data } } };
  }
}
