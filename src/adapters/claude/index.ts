/**
 * The Claude Code adapter. Its inside part is hook commands (hooks.ts) that write
 * the session record; its outside part combines those records with
 * `claude agents --json` and Claude Code's job files (listing.ts, observe.ts), and
 * delivers through the session's messaging socket (socket.ts).
 * docs/domains/claude-adapter.md describes it, including what it relies on.
 */
import { deliverResult, type Adapter, type AdapterContext, type Capabilities } from "../../adapter.js";
import type { SessionRecord } from "../../records.js";
import { validateSessionId } from "../../records.js";
import type { DeliverResult, Observation } from "../../types.js";
import { claudeCommands } from "./hooks.js";
import { claudeBin, readJob, readListing, type Listing, type ListingRow } from "./listing.js";
import { CLAUDE_HARNESS, claudeObservation } from "./observe.js";
import { defaultSocketDirs, guessedSocketPaths, sendToSocket, SocketMissingError } from "./socket.js";

/** The environment variable Claude Code sets for commands run inside a session. */
export const CLAUDE_SESSION_ENV = "CLAUDE_CODE_SESSION_ID";

export interface ClaudeAdapterOptions {
  pollIntervalMs?: number;
  /**
   * See only sessions whose working folder is this folder or inside it. Conformance
   * runs use it so a case sees only its own sessions, never others on the machine.
   */
  onlyUnder?: (ctx: AdapterContext) => string | null;
  /** Folders to look in for a socket that was not recorded. Default /tmp/cc-socks and /tmp/cc-socks-<uid>. */
  socketDirs?: string[];
}

/** Is `cwd` the folder `dir` or inside it? */
export function isUnder(cwd: string | null, dir: string): boolean {
  return cwd !== null && (cwd === dir || cwd.startsWith(dir.endsWith("/") ? dir : `${dir}/`));
}

function isValidId(id: string): boolean {
  try {
    validateSessionId(id);
    return true;
  } catch {
    return false;
  }
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): Adapter {
  const capabilities: Capabilities = {
    queuesWhileBusy: true,
    seesPrompts: true,
    outsideListing: true,
    insidePart: true,
    // Prompts opening and sessions dying without SessionEnd show only in the listing.
    pollIntervalMs: options.pollIntervalMs ?? 3000,
  };
  const socketDirs = options.socketDirs ?? defaultSocketDirs();

  const listing = async (ctx: AdapterContext): Promise<Listing> => {
    const rows = await readListing(ctx);
    const dir = options.onlyUnder?.(ctx) ?? null;
    return rows === null || dir === null ? rows : rows.filter((r) => isUnder(r.cwd, dir));
  };

  /** Job files are read only for running sessions: a gone session has no activity. */
  const observeOne = async (ctx: AdapterContext, id: string, row: ListingRow | null, rec: SessionRecord | null): Promise<Observation> => {
    const job = row !== null && row.pid !== null ? await readJob(ctx, row) : null;
    return claudeObservation(id, row, rec, job);
  };

  /** One session by full session id or short id: its row, record and canonical id, or null. */
  const find = async (ctx: AdapterContext, session: string) => {
    if (!isValidId(session)) return null;
    const rows = (await listing(ctx)) ?? [];
    const row = rows.find((r) => r.sessionId === session) ?? rows.find((r) => r.id === session) ?? null;
    const id = row?.sessionId ?? session;
    const rec = isValidId(id) ? await ctx.records.read(CLAUDE_HARNESS, id).catch(() => null) : null;
    if (row === null && rec === null) return null;
    return { id, row, rec };
  };

  const adapter: Adapter = {
    harness: CLAUDE_HARNESS,
    capabilities,
    inside: {
      kind: "hooks",
      description:
        "Claude Code hook commands (SessionStart, UserPromptSubmit, Stop, StopFailure, PermissionRequest, SessionEnd) that write the session record.",
      setup: "porch hooks claude",
    },
    commands: claudeCommands,

    async detect(ctx) {
      const r = await ctx.io.run(claudeBin(ctx.env), ["--version"], { env: ctx.env, timeoutMs: 15000 });
      if (r.code !== 0) {
        return { available: false, version: null, reason: `\`${claudeBin(ctx.env)} --version\` failed: ${r.stderr.trim() || `exit ${r.code}`}` };
      }
      const m = /(\d+\.\d+\.\d+\S*)/.exec(r.stdout);
      return { available: true, version: m ? m[1]! : r.stdout.trim() || null, reason: null };
    },

    async list(ctx) {
      const rows = (await listing(ctx)) ?? [];
      const { records } = await ctx.records.list(CLAUDE_HARNESS);
      const recs = new Map(records.map((r) => [r.session, r]));
      const byId = new Map(rows.map((r) => [r.sessionId, r]));
      const ids = [...new Set([...byId.keys(), ...recs.keys()])].sort();
      return Promise.all(ids.map((id) => observeOne(ctx, id, byId.get(id) ?? null, recs.get(id) ?? null)));
    },

    async observe(ctx, session) {
      const found = await find(ctx, session);
      return found === null ? null : observeOne(ctx, found.id, found.row, found.rec);
    },

    async current(ctx) {
      const id = ctx.env[CLAUDE_SESSION_ENV];
      return id && id.trim() !== "" ? id : null;
    },

    async deliver(ctx, session, text): Promise<DeliverResult> {
      const found = await find(ctx, session);
      if (found === null) {
        return deliverResult({ harness: CLAUDE_HARNESS, session, result: "not-running", reason: "Claude Code has no such session" });
      }
      const { id, row, rec } = found;
      const obs = await observeOne(ctx, id, row, rec);
      if (obs.status === "gone" || row === null || row.pid === null) {
        return deliverResult({
          harness: CLAUDE_HARNESS,
          session: id,
          result: "not-running",
          reason: "the session is not running (no pid in `claude agents --json`)",
        });
      }
      // The recorded socket belongs to the process that ran SessionStart; after a
      // resume without the hooks the pid differs and the pid-based path is used.
      const recorded = rec?.inside?.delivery;
      const recordedPid = rec?.inside?.pid ?? null;
      const useRecorded = recorded?.via === "socket" && (recordedPid === null || recordedPid === row.pid);
      const candidates = useRecorded ? [recorded.address] : guessedSocketPaths(row.pid, socketDirs);
      const problems: string[] = [];
      for (const address of candidates) {
        try {
          await sendToSocket(address, text);
          return deliverResult({
            harness: CLAUDE_HARNESS,
            session: id,
            result: "delivered",
            statusAtSend: obs.status,
            via: "socket",
            guessed: !useRecorded,
          });
        } catch (err) {
          problems.push((err as Error).message);
          if (!(err instanceof SocketMissingError)) break;
        }
      }
      return deliverResult({
        harness: CLAUDE_HARNESS,
        session: id,
        result: "failed",
        via: "socket",
        guessed: !useRecorded,
        reason: problems.join("; "),
      });
    },
  };
  return adapter;
}

export { CLAUDE_HARNESS, claudeObservation };
