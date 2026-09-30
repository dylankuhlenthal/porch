/**
 * How the Pi adapter turns a session record and the process table into an
 * Observation. Pi has no outside listing, so the record written by Porch's extension
 * is the only source, and `ps` only says whether its process is still running.
 *
 * In order:
 * 1. the record has no inside part, or no pid          -> unknown (nothing says whether it runs)
 * 2. `ps` could not be read                            -> unknown
 * 3. the recorded process is not running (or its pid
 *    now belongs to a process that started later)      -> gone
 * 4. an extension dialog is open (data.prompt)         -> waiting-on-prompt
 * 5. the inside part has a status                      -> that status
 * 6. otherwise                                         -> unknown
 */
import { observation } from "../../adapter.js";
import type { SessionRecord } from "../../records.js";
import type { Observation } from "../../types.js";
import { isSessionProcess, type ProcessTable } from "./process.js";

export const PI_HARNESS = "pi";

/** An extension dialog that is open, as the extension records it in `data.prompt`. */
export interface PiPrompt {
  kind: string | null;
  title: string | null;
  since: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function recordedPrompt(rec: SessionRecord | null): PiPrompt | null {
  const p = rec?.inside?.data?.prompt;
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  return { kind: str(o.kind), title: str(o.title), since: str(o.since) };
}

export function piObservation(session: string, rec: SessionRecord, table: ProcessTable | null): Observation {
  const inside = rec.inside;
  const data = inside?.data ?? {};
  const pid = inside?.pid ?? null;
  const prompt = recordedPrompt(rec);
  const running = pid === null ? null : isSessionProcess(table, pid, str(data.processStartedAt));
  const detail = {
    pid,
    cwd: inside?.cwd ?? null,
    mode: str(data.mode),
    sessionFile: str(data.sessionFile),
    prompt: prompt === null ? null : { kind: prompt.kind, title: prompt.title },
    hasInsidePart: inside !== null,
    lastTurnStart: inside?.lastTurnStart ?? null,
    lastTurnEnd: inside?.lastTurnEnd ?? null,
  };
  const raw = { record: rec, ps: pid === null || table === null ? null : (table.output.split("\n").find((l) => new RegExp(`^\\s*${pid}\\s`).test(l)) ?? null) };
  const base = { harness: PI_HARNESS, session, detail, raw, self: rec.self };
  if (running === null) return observation({ ...base, status: "unknown" });
  if (!running) return observation({ ...base, status: "gone" });
  if (prompt !== null) return observation({ ...base, status: "waiting-on-prompt", since: prompt.since });
  if (inside?.status) return observation({ ...base, status: inside.status, since: inside.since ?? null });
  return observation({ ...base, status: "unknown" });
}
