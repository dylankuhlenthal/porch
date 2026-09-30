/**
 * `porch fake run <session>`: a fake session as a real process, which is what
 * `porch launch fake` starts. It lets the per-PR tests check how `porch launch`
 * handles a harness process (exit codes, signals, the terminal's Ctrl+C) without
 * running a real harness. Run it as its own process: it installs signal handlers
 * and may kill itself.
 *
 * - On start it registers the session with the fake harness, with its record unless
 *   `--no-inside`, and its own pid.
 * - It follows the fake harness file: each message delivered to it is a turn (busy
 *   for TURN_MS, then idle); `porch fake end` makes it exit with the code given
 *   there (default 0); `porch fake kill` makes it die of SIGKILL, like a crash.
 * - Like an interactive harness, it ignores SIGINT and SIGQUIT (one Ctrl+C does not
 *   end it). On SIGTERM or SIGHUP it ends cleanly (its record is removed) and dies
 *   of that signal.
 */
import type { AdapterContext } from "../../adapter.js";
import { endSession, setInsideStatus, startSession } from "./ops.js";
import { fakeStatePath, parseState } from "./state.js";

/** How long a turn started by a delivered message stays busy. */
export const TURN_MS = 500;
/** How often the harness file is read. */
const POLL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Runs until the session ends; resolves with the exit code, or never (it kills itself). */
export async function runFakeSession(ctx: AdapterContext, session: string, options: { inside: boolean }): Promise<number> {
  await startSession(ctx, session, { inside: options.inside, pid: process.pid });
  let ending: NodeJS.Signals | null = null;
  const ignore = () => undefined;
  process.on("SIGINT", ignore);
  process.on("SIGQUIT", ignore);
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      ending = signal;
    });
  }
  const readState = async () => parseState(await ctx.io.readFile(fakeStatePath(ctx.env)));
  const deliveredTo = (state: Awaited<ReturnType<typeof readState>>) => state.deliveries.filter((d) => d.session === session).length;
  let seen = deliveredTo(await readState());
  for (;;) {
    if (ending !== null) {
      await endSession(ctx, session).catch(() => undefined);
      process.removeAllListeners(ending);
      process.kill(process.pid, ending);
      return 128;
    }
    const state = await readState();
    const row = state.sessions[session];
    if (row === undefined || !row.alive) {
      if (typeof row?.exitCode === "number") return row.exitCode;
      process.kill(process.pid, "SIGKILL");
      return 137;
    }
    const delivered = deliveredTo(state);
    if (delivered > seen) {
      seen = delivered;
      if (options.inside) {
        await setInsideStatus(ctx, session, "busy");
        await sleep(TURN_MS);
        // Not after the session ended meanwhile: that would bring its removed record back.
        if ((await readState()).sessions[session]?.alive) await setInsideStatus(ctx, session, "idle");
      }
    }
    await sleep(POLL_MS);
  }
}
