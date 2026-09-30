/**
 * The Pi adapter. Pi has no outside way into a running session and no listing of
 * its sessions, so everything comes from the inside part: a Pi extension
 * (extension.ts) that writes each session's record and listens on a socket for
 * delivered messages (protocol.ts). The outside part reads the records, checks with
 * `ps` that each session's process is still running (process.ts, observe.ts), and
 * delivers through the recorded socket. `porch launch pi` loads the extension for
 * one session (launch.ts); `porch extension pi` prints the arguments that do so
 * (commands.ts). docs/domains/pi-adapter.md describes it, including what
 * it relies on from Pi.
 */
import { deliverResult, type Adapter, type AdapterContext, type Capabilities } from "../../adapter.js";
import { validateSessionId, type SessionRecord } from "../../records.js";
import type { DeliverResult, Observation } from "../../types.js";
import { checkSocketOwner, type SocketCheckOptions } from "../../unix-socket.js";
import { piCommands } from "./commands.js";
import { piBin, piLaunchPlan } from "./launch.js";
import { PI_HARNESS, piObservation } from "./observe.js";
import { readProcesses } from "./process.js";
import { sendToPiSocket } from "./protocol.js";

/** The environment variable Pi sets for commands its bash tool runs. */
export const PI_SESSION_ENV = "PI_SESSION_ID";

export interface PiAdapterOptions {
  pollIntervalMs?: number;
  /** How a socket path is checked before connecting (tests replace the lstat and uid). */
  socketCheck?: SocketCheckOptions;
}

function isValidId(id: string): boolean {
  try {
    validateSessionId(id);
    return true;
  } catch {
    return false;
  }
}

export function createPiAdapter(options: PiAdapterOptions = {}): Adapter {
  const capabilities: Capabilities = {
    // `sendUserMessage` with `deliverAs: "followUp"` waits for the current run.
    queuesWhileBusy: true,
    // Extension dialogs (ui_prompt_start); Pi itself asks for no permissions.
    seesPrompts: true,
    outsideListing: false,
    insidePart: true,
    // A process that dies without its shutdown handler (a crash, kill -9) shows only in `ps`.
    pollIntervalMs: options.pollIntervalMs ?? 3000,
    launch: true,
  };

  const observeAll = async (ctx: AdapterContext, recs: SessionRecord[]): Promise<Observation[]> => {
    const pids = recs.map((r) => r.inside?.pid).filter((p): p is number => typeof p === "number");
    const table = await readProcesses(ctx, pids);
    return recs.map((r) => piObservation(r.session, r, table));
  };

  const adapter: Adapter = {
    harness: PI_HARNESS,
    capabilities,
    inside: {
      kind: "extension",
      description: "A Pi extension, loaded per session with `pi -e`, that writes the session record and takes delivered messages on a socket.",
      setup: "porch extension pi",
    },
    commands: piCommands,

    async detect(ctx) {
      const r = await ctx.io.run(piBin(ctx.env), ["--version"], { env: ctx.env, timeoutMs: 15000 });
      if (r.code !== 0) {
        return { available: false, version: null, reason: `\`${piBin(ctx.env)} --version\` failed: ${r.stderr.trim() || `exit ${r.code}`}` };
      }
      const m = /(\d+\.\d+\.\d+\S*)/.exec(r.stdout);
      return { available: true, version: m ? m[1]! : r.stdout.trim() || null, reason: null };
    },

    async list(ctx) {
      const { records } = await ctx.records.list(PI_HARNESS);
      return observeAll(ctx, [...records].sort((a, b) => a.session.localeCompare(b.session)));
    },

    async observe(ctx, session) {
      if (!isValidId(session)) return null;
      const rec = await ctx.records.read(PI_HARNESS, session).catch(() => null);
      if (rec === null) return null;
      return (await observeAll(ctx, [rec]))[0]!;
    },

    async current(ctx) {
      const id = ctx.env[PI_SESSION_ENV];
      return id && id.trim() !== "" ? id : null;
    },

    async deliver(ctx, session, text): Promise<DeliverResult> {
      const obs = await adapter.observe(ctx, session);
      if (obs === null || obs.status === "gone") {
        return deliverResult({
          harness: PI_HARNESS,
          session,
          result: "not-running",
          reason: obs === null ? "Porch has no record of this Pi session" : "the session's Pi process is not running",
        });
      }
      const rec = (obs.raw as { record: SessionRecord }).record;
      const delivery = rec.inside?.delivery ?? null;
      if (delivery === null || delivery.via !== "socket") {
        const why = typeof rec.inside?.data?.lastError === "string" ? `: ${rec.inside.data.lastError}` : "";
        return deliverResult({ harness: PI_HARNESS, session, result: "failed", reason: `the session recorded no delivery socket${why}` });
      }
      try {
        await checkSocketOwner(delivery.address, options.socketCheck);
        const reply = await sendToPiSocket(delivery.address, text);
        if (!reply.ok) return deliverResult({ harness: PI_HARNESS, session, result: "failed", via: "socket", reason: reply.error });
        return deliverResult({ harness: PI_HARNESS, session, result: "delivered", statusAtSend: reply.status, via: "socket" });
      } catch (err) {
        return deliverResult({ harness: PI_HARNESS, session, result: "failed", via: "socket", reason: (err as Error).message });
      }
    },

    launch: (ctx, args) => piLaunchPlan(ctx, args),
  };
  return adapter;
}

export { PI_HARNESS, piObservation };
