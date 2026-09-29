/**
 * Reading Claude Code from outside: `claude agents --json` (the outside listing)
 * and Claude Code's job file for a session. Both go through `ctx.io`, so a
 * conformance run records them and the per-PR tests replay them.
 *
 * What is relied on, and whether Claude Code documents it, is listed in
 * docs/domains/claude-adapter.md.
 */
import path from "node:path";

import type { AdapterContext } from "../../adapter.js";
import type { Env } from "../../home.js";

/** One row of `claude agents --json`, keeping only fields of the expected types. */
export interface ListingRow {
  /** The short id background sessions have (the first 8 hex digits of the session id). */
  id: string | null;
  sessionId: string;
  name: string | null;
  kind: string | null;
  cwd: string | null;
  /** Only while the session's process is running. */
  pid: number | null;
  /** busy, waiting or idle; only while running. */
  status: string | null;
  /** What a waiting session waits for, for example "permission prompt". */
  waitingFor: string | null;
  /** The row exactly as Claude Code printed it, for `raw`. */
  raw: Record<string, unknown>;
}

/** The listing, or null when Claude Code is not installed (then no Claude session can be running). */
export type Listing = ListingRow[] | null;

/** The `claude` command: $PORCH_CLAUDE_BIN, or `claude` on PATH. */
export function claudeBin(env: Env): string {
  const bin = env.PORCH_CLAUDE_BIN;
  return bin && bin.trim() !== "" ? bin : "claude";
}

export class ListingError extends Error {}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Parse `claude agents --json` output. Rows without a session id are left out (see the adapter doc). */
export function parseListing(stdout: string): ListingRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
  } catch {
    throw new ListingError("`claude agents --json` did not print JSON");
  }
  if (!Array.isArray(parsed)) throw new ListingError("`claude agents --json` did not print a JSON array");
  const rows: ListingRow[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const sessionId = str(r.sessionId);
    if (sessionId === null) continue;
    const pid = typeof r.pid === "number" && Number.isInteger(r.pid) && r.pid > 0 ? r.pid : null;
    rows.push({
      id: str(r.id),
      sessionId,
      name: str(r.name),
      kind: str(r.kind),
      cwd: str(r.cwd),
      pid,
      status: str(r.status),
      waitingFor: str(r.waitingFor),
      raw: r,
    });
  }
  return rows;
}

/**
 * Run `claude agents --json`. Returns null when the `claude` command does not
 * exist; throws ListingError when it fails or prints something unexpected.
 */
export async function readListing(ctx: AdapterContext): Promise<Listing> {
  const bin = claudeBin(ctx.env);
  const result = await ctx.io.run(bin, ["agents", "--json"], { env: ctx.env, timeoutMs: 15000 });
  if (result.code === null && /ENOENT/.test(result.stderr)) return null;
  if (result.code !== 0) {
    const why = result.stderr.trim().split("\n").slice(-1)[0] ?? "";
    throw new ListingError(`\`claude agents --json\` failed (exit ${result.code ?? "none"})${why ? `: ${why}` : ""}`);
  }
  return parseListing(result.stdout);
}

/** Claude Code's own folder: $CLAUDE_CONFIG_DIR, or ~/.claude. */
export function claudeConfigDir(env: Env): string | null {
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv);
  if (!env.HOME || env.HOME.trim() === "") return null;
  return path.join(env.HOME, ".claude");
}

const SHORT_ID_RE = /^[0-9a-f]{4,64}$/;

/**
 * The job file of a running background session (`<config dir>/jobs/<short id>/state.json`),
 * parsed, or null when there is none or it is unusable. Claude Code does not
 * document this file, so every problem reads as "no job file". A file naming
 * another session than the row is ignored, so a reused short id never lends one
 * session another's state.
 */
export async function readJob(ctx: AdapterContext, row: ListingRow): Promise<Record<string, unknown> | null> {
  const dir = claudeConfigDir(ctx.env);
  if (dir === null || row.id === null || !SHORT_ID_RE.test(row.id)) return null;
  let text: string | null;
  try {
    text = await ctx.io.readFile(path.join(dir, "jobs", row.id, "state.json"));
  } catch {
    return null;
  }
  if (text === null) return null;
  let job: unknown;
  try {
    job = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof job !== "object" || job === null || Array.isArray(job)) return null;
  const j = job as Record<string, unknown>;
  if (typeof j.sessionId === "string" && j.sessionId !== row.sessionId) return null;
  return j;
}
