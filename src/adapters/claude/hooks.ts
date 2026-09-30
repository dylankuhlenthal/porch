/**
 * The Claude Code adapter's inside part: hook commands Claude Code runs inside
 * each session, which keep the session record up to date, and `porch hooks claude`,
 * which prints the hook settings for callers to pass with `--settings`.
 *
 * Hook commands must never change what the session does (decision 24(a) in
 * TRV-1133). Claude Code reads a hook's exit code 2 as "block" (for Stop, the turn
 * keeps going), reads stdout on exit 0 as text to add to the model's context
 * (SessionStart, UserPromptSubmit), and reads JSON on stdout from a
 * PermissionRequest hook as an answer to the prompt. So `porch hooks claude on`
 * always exits 0, prints nothing on stdout, and reports any problem on stderr only.
 */
import path from "node:path";
import { parseArgs } from "node:util";

import type { AdapterCommand, AdapterContext, CommandContext } from "../../adapter.js";
import { jsonLine } from "../../cli/output.js";
import { porchCliPath } from "../../cli/path.js";
import { PorchError } from "../../errors.js";
import { errorMessage } from "../../fsutil.js";
import { SCHEMA_VERSION } from "../../types.js";
import { CLAUDE_HARNESS } from "./observe.js";

/** The Claude Code hook events Porch listens to, and what each does to the record. */
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "PermissionRequest", "SessionEnd"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** How long Claude Code lets a hook run. A record write waits at most 5 s for its lock. */
export const HOOK_TIMEOUT_SECONDS = 10;

export { porchCliPath };

/** Quote for sh, which Claude Code runs hook commands with. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface HookSettingsOptions {
  /** Bake this PORCH_HOME into each command. Without it, the hook uses the session's own PORCH_HOME, or ~/.porch. */
  porchHome?: string | null;
  /** The node executable. Default: the one running this Porch. */
  node?: string;
  /** The Porch CLI script. Default: porchCliPath(). */
  cli?: string;
}

export interface ClaudeHookSettings {
  hooks: Record<HookEvent, { hooks: { type: "command"; command: string; timeout: number }[] }[]>;
}

/** The command line for one event, for example `'/usr/bin/node' '/x/dist/cli/main.js' hooks claude on Stop`. */
export function hookCommand(event: HookEvent, options: HookSettingsOptions = {}): string {
  const node = options.node ?? process.execPath;
  const cli = options.cli ?? porchCliPath();
  const prefix = options.porchHome ? `PORCH_HOME=${shQuote(path.resolve(options.porchHome))} ` : "";
  return `${prefix}${shQuote(node)} ${shQuote(cli)} hooks claude on ${event}`;
}

/** Claude Code settings with Porch's hooks, in the shape `--settings` takes. */
export function claudeHookSettings(options: HookSettingsOptions = {}): ClaudeHookSettings {
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: "command", command: hookCommand(event, options), timeout: HOOK_TIMEOUT_SECONDS }] }]]),
  ) as ClaudeHookSettings["hooks"];
  return { hooks };
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/** The session's process id: CLAUDE_PID, or the number in the socket file name. */
function sessionPid(env: AdapterContext["env"]): number | null {
  const fromEnv = positiveInt(env.CLAUDE_PID);
  if (fromEnv !== null) return fromEnv;
  const m = /(\d+)\.sock$/.exec(env.CLAUDE_CODE_MESSAGING_SOCKET ?? "");
  return m ? positiveInt(m[1]) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Apply one hook event to the session record. Throws on any problem; the command turns that into stderr. */
export async function handleHookEvent(ctx: AdapterContext, event: string, input: Record<string, unknown>): Promise<void> {
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) throw new Error(`unknown Claude Code hook event '${event}'`);
  const session = str(input.session_id) ?? str(ctx.env.CLAUDE_CODE_SESSION_ID);
  if (session === null) throw new Error("the hook input has no session_id");
  const records = ctx.records;
  const now = ctx.now().toISOString();
  switch (event as HookEvent) {
    case "SessionStart": {
      const source = str(input.source);
      const socket = str(ctx.env.CLAUDE_CODE_MESSAGING_SOCKET);
      const jobDir = str(ctx.env.CLAUDE_JOB_DIR);
      const pid = sessionPid(ctx.env);
      await records.updateInside(CLAUDE_HARNESS, session, (current) => ({
        ...(current ?? {}),
        pid,
        delivery: socket ? { via: "socket", address: socket } : null,
        cwd: str(input.cwd) ?? current?.cwd ?? null,
        // After a compaction the session may be mid-turn, so its status stays as it was.
        ...(source === "compact" ? {} : { status: "idle" as const, since: now }),
        // Background tasks belong to a process. They are kept only when this hook runs in
        // the process that wrote the record (both pids known and equal): a compaction,
        // `/clear` or an in-session `/resume` can all be the same process, so the source
        // name does not say. A different or unknown pid clears them to null (cannot tell).
        // lastTurnStart and lastTurnEnd are kept as history either way.
        ...(pid !== null && current?.pid === pid ? {} : { backgroundTasks: null }),
        data: {
          ...(current?.data ?? {}),
          source,
          transcriptPath: str(input.transcript_path),
          shortId: jobDir ? path.basename(jobDir) : (current?.data?.shortId ?? null),
          // When this process of the session started (a compaction is not a start).
          startedAt: source === "compact" ? (current?.data?.startedAt ?? now) : now,
        },
      }));
      return;
    }
    // Every event but SessionStart only changes an existing record: a hook that runs
    // after SessionEnd removed the record must not bring back a partial one that
    // nothing would remove.
    case "UserPromptSubmit":
      // Fires for each prompt, including a message delivered mid-turn (observed with 2.1.284).
      await records.updateInsideIfExists(CLAUDE_HARNESS, session, { status: "busy", lastTurnStart: now });
      return;
    case "Stop": {
      const tasks = input.background_tasks;
      // Null when the hook does not say, so an earlier turn's count never lingers.
      const backgroundTasks = Array.isArray(tasks) ? tasks.length : typeof tasks === "number" && Number.isInteger(tasks) ? tasks : null;
      await records.updateInsideIfExists(CLAUDE_HARNESS, session, { status: "idle", lastTurnEnd: now, backgroundTasks });
      return;
    }
    case "StopFailure":
      await records.updateInsideIfExists(CLAUDE_HARNESS, session, {
        status: "idle",
        lastTurnEnd: now,
        data: { lastStopFailure: { at: now, error: str(input.error) ?? str(input.error_type) ?? null } },
      });
      return;
    case "PermissionRequest":
      // Status comes from `claude agents --json` (decision 11); this write makes `porch watch` look at once.
      await records.updateInsideIfExists(CLAUDE_HARNESS, session, { data: { lastPermissionRequest: { at: now, tool: str(input.tool_name) } } });
      return;
    case "SessionEnd":
      await records.remove(CLAUDE_HARNESS, session);
      return;
  }
}

function hookCommandRun(): AdapterCommand {
  return {
    path: ["hooks", "claude", "on"],
    summary: "run by Claude Code's hooks inside a session: update its record (always exits 0)",
    usage: "porch hooks claude on <hook event>",
    // Never throws and never exits non-zero: see the top of this file.
    async run(args: string[], ctx: CommandContext): Promise<number> {
      try {
        if (args.length !== 1) throw new Error(`usage: porch hooks claude on <${HOOK_EVENTS.join("|")}>`);
        const text = await ctx.readStdin();
        let input: unknown = {};
        if (text.trim() !== "") input = JSON.parse(text);
        if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("the hook input is not a JSON object");
        await handleHookEvent(ctx.adapter, args[0]!, input as Record<string, unknown>);
      } catch (err) {
        try {
          ctx.stderr(`porch hooks claude: ${errorMessage(err)}\n`);
        } catch {
          // nowhere left to report it
        }
      }
      return 0;
    },
  };
}

function hookSettingsCommand(): AdapterCommand {
  const usage = "porch hooks claude [--porch-home <dir>]";
  return {
    path: ["hooks", "claude"],
    summary: "print Claude Code hook settings to pass with --settings",
    usage,
    async run(args: string[], ctx: CommandContext): Promise<number> {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "porch-home": { type: "string" } } });
      if (positionals.length > 0) throw new PorchError("usage", `usage: ${usage}`);
      const porchHome = values["porch-home"];
      if (porchHome !== undefined && porchHome.trim() === "") throw new PorchError("usage", "--porch-home must not be empty");
      const cli = porchCliPath();
      ctx.stdout(
        jsonLine({
          schema: SCHEMA_VERSION,
          harness: CLAUDE_HARNESS,
          node: process.execPath,
          cli,
          porchHome: porchHome === undefined ? null : path.resolve(porchHome),
          settings: claudeHookSettings({ porchHome: porchHome ?? null }),
        }),
      );
      return 0;
    },
  };
}

export const claudeCommands: AdapterCommand[] = [hookSettingsCommand(), hookCommandRun()];
