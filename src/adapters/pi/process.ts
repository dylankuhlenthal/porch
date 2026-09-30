/**
 * Whether the Pi processes named in session records are still running. Pi has no
 * outside listing of its sessions, so this is the Pi adapter's only outside read:
 * one `ps -o pid=,etime= -p <pids>` for every record, run through `ctx.io` so a
 * conformance run records it and the per-PR tests replay it.
 *
 * A pid alone is not enough: after a crash the pid can be reused by an unrelated
 * process. The extension records when its process started (`data.processStartedAt`),
 * and a pid counts as the session's process only when the running process started
 * within START_TOLERANCE_MS of that (`ps` gives the elapsed time to the second).
 */
import type { AdapterContext } from "../../adapter.js";

/** How far the start time from `ps` may be from the recorded one. */
export const START_TOLERANCE_MS = 10_000;

/** The `ps` command. PORCH_PS_BIN replaces it (tests). */
export function psBin(env: AdapterContext["env"]): string {
  const v = env.PORCH_PS_BIN;
  return v && v.trim() !== "" ? v : "ps";
}

/**
 * What `ps` said: each running pid with when it started, or null when `ps` could not
 * be run or gave output Porch cannot read (then nothing can be said about any pid).
 */
export interface ProcessTable {
  /** pid -> start time (ms since epoch), for the pids asked about that are running. */
  started: Map<number, number>;
  /** The `ps` output as it came, for `raw`. */
  output: string;
}

/** `[[dd-]hh:]mm:ss` from `ps -o etime` as milliseconds, or null. */
export function parseElapsed(text: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/**
 * Parse `ps -o pid=,etime=` output. Returns null when any line cannot be read, so a
 * `ps` that prints something else is never taken to mean "not running".
 */
export function parsePs(output: string, now: Date): Map<number, number> | null {
  const started = new Map<number, number>();
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    const elapsed = m ? parseElapsed(m[2]!) : null;
    if (!m || elapsed === null) return null;
    started.set(Number(m[1]), now.getTime() - elapsed);
  }
  return started;
}

/**
 * Look up the given pids. `ps` exits 1 when some or all of them are not running
 * (with no output when none is; macOS's `ps` exits 0 when at least one is, Linux's
 * procps may exit 1 while still printing the running ones), so exit 1 is read like
 * exit 0: a pid missing from the output is not running. The runner puts its own
 * error text in stderr on a non-zero exit, so stderr is not looked at. Any other
 * failure (no `ps`, another exit code, output Porch cannot read) gives null.
 */
export async function readProcesses(ctx: AdapterContext, pids: number[]): Promise<ProcessTable | null> {
  const unique = [...new Set(pids)].sort((a, b) => a - b);
  if (unique.length === 0) return { started: new Map(), output: "" };
  const r = await ctx.io.run(psBin(ctx.env), ["-o", "pid=,etime=", "-p", unique.join(",")], { env: ctx.env, timeoutMs: 5000 });
  if (r.code !== 0 && r.code !== 1) return null;
  const started = parsePs(r.stdout, ctx.now());
  return started === null ? null : { started, output: r.stdout };
}

/**
 * Is `pid` the session's process? true, false, or null when Porch cannot tell (no
 * process table). Without a recorded start time, a running pid counts as the session's.
 */
export function isSessionProcess(table: ProcessTable | null, pid: number, recordedStart: string | null): boolean | null {
  if (table === null) return null;
  const started = table.started.get(pid);
  if (started === undefined) return false;
  if (recordedStart === null) return true;
  const recorded = Date.parse(recordedStart);
  return Number.isNaN(recorded) || Math.abs(started - recorded) <= START_TOLERANCE_MS;
}
