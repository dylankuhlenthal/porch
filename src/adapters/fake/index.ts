/**
 * The fake adapter: a harness that runs nothing, for tests of Porch and of the
 * tools built on it. Its outside listing is the JSON file described in state.ts;
 * its inside part is the `porch fake` commands (ops.ts), which write session records
 * through the same record store a real adapter's inside part uses.
 *
 * How it works out status, in order:
 * 1. not in the listing, or "alive": false  -> gone (a left-behind record does not revive it)
 * 2. "prompt" set in the listing            -> waiting-on-prompt
 * 3. the record's inside part has a status  -> that status
 * 4. otherwise (no inside part)             -> unknown
 */
import {
  deliverResult,
  type Adapter,
  type AdapterContext,
  type Capabilities,
} from "../../adapter.js";
import type { DeliverResult } from "../../types.js";
import { fakeCommands } from "./commands.js";
import { FAKE_HARNESS, fakeObservation } from "./observe.js";
import { fakeStatePath, parseState, updateState, type FakeState } from "./state.js";

/** The env var a fake session's commands see, like CLAUDE_CODE_SESSION_ID for Claude Code. */
export const FAKE_SESSION_ENV = "PORCH_FAKE_SESSION_ID";

async function readState(ctx: AdapterContext): Promise<FakeState> {
  return parseState(await ctx.io.readFile(fakeStatePath(ctx.env)));
}

export function createFakeAdapter(options: { pollIntervalMs?: number } = {}): Adapter {
  const capabilities: Capabilities = {
    queuesWhileBusy: true,
    seesPrompts: true,
    outsideListing: true,
    insidePart: true,
    // The state file is also file-watched (watchPaths), so polling is only a backstop.
    pollIntervalMs: options.pollIntervalMs ?? 2000,
  };

  const adapter: Adapter = {
    harness: FAKE_HARNESS,
    capabilities,
    inside: {
      kind: "commands",
      description: "The `porch fake` commands stand in for a harness's hooks and write the session record.",
      setup: "porch fake start <session>",
    },
    commands: fakeCommands,

    async detect(ctx) {
      const text = await ctx.io.readFile(fakeStatePath(ctx.env));
      return text === null
        ? { available: false, version: null, reason: `no fake harness state at ${fakeStatePath(ctx.env)}` }
        : { available: true, version: "fake-1", reason: null };
    },

    async list(ctx) {
      const state = await readState(ctx);
      const { records } = await ctx.records.list(FAKE_HARNESS);
      const byId = new Map(records.map((r) => [r.session, r]));
      const ids = new Set([...Object.keys(state.sessions), ...byId.keys()]);
      return [...ids].sort().map((id) => fakeObservation(id, state.sessions[id], byId.get(id) ?? null));
    },

    async observe(ctx, session) {
      const state = await readState(ctx);
      const rec = await ctx.records.read(FAKE_HARNESS, session).catch(() => null);
      const row = state.sessions[session];
      if (!row && !rec) return null;
      return fakeObservation(session, row, rec);
    },

    async current(ctx) {
      const id = ctx.env[FAKE_SESSION_ENV];
      return id && id.trim() !== "" ? id : null;
    },

    async deliver(ctx, session, text): Promise<DeliverResult> {
      const rec = await ctx.records.read(FAKE_HARNESS, session).catch(() => null);
      const recorded = rec?.inside?.delivery ?? null;
      const file = fakeStatePath(ctx.env);
      return updateState(file, (state) => {
        const row = state.sessions[session];
        const obs = row || rec ? fakeObservation(session, row, rec) : null;
        if (!obs || obs.status === "gone") {
          return deliverResult({
            harness: FAKE_HARNESS,
            session,
            result: "not-running",
            reason: `fake session ${session} is not running`,
          });
        }
        const via = recorded?.via ?? "fake-listing";
        const guessed = recorded === null;
        if (row?.failDeliver) {
          return deliverResult({ harness: FAKE_HARNESS, session, result: "failed", via, guessed, reason: row.failDeliver });
        }
        state.deliveries.push({ session, text, at: ctx.now().toISOString(), statusAtSend: obs.status });
        return deliverResult({ harness: FAKE_HARNESS, session, result: "delivered", statusAtSend: obs.status, via, guessed });
      });
    },

    watchPaths(ctx) {
      return [fakeStatePath(ctx.env)];
    },
  };
  return adapter;
}

export { FAKE_HARNESS, fakeObservation };
