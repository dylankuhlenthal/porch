/**
 * What can happen to a fake session. Each function changes the fake harness's
 * listing (state.ts), the session record's inside part, or both, the way the
 * matching event would for a real harness. Used by the `porch fake` commands and
 * by the fake conformance driver.
 */
import type { AdapterContext } from "../../adapter.js";
import { fakeStatePath, parseState, updateState, type FakeDelivery } from "./state.js";

const HARNESS = "fake";

export type FakeInsideStatus = "starting" | "busy" | "idle";

export interface StartOptions {
  /** Write a session record, as a harness with Porch's inside part installed would. Default true. */
  inside?: boolean;
  pid?: number | null;
  status?: FakeInsideStatus;
}

/** A session starts. With `inside`, its inside part records it (like a session-start hook). */
export async function startSession(ctx: AdapterContext, session: string, options: StartOptions = {}): Promise<void> {
  const inside = options.inside ?? true;
  const pid = options.pid ?? null;
  // Validate the id before touching the listing, so a bad id changes nothing.
  ctx.records.recordPath(HARNESS, session);
  await updateState(fakeStatePath(ctx.env), (state) => {
    state.sessions[session] = { alive: true, pid, prompt: null, promptSince: null, goneSince: null, failDeliver: null };
  });
  if (inside) {
    await ctx.records.updateInside(HARNESS, session, {
      pid,
      status: options.status ?? "idle",
      delivery: { via: "fake", address: `fake:${session}` },
    });
  }
}

export interface TurnFields {
  /** Set the turn times directly (ISO 8601), for example to model a turn that ended long ago. */
  lastTurnStart?: string | null;
  lastTurnEnd?: string | null;
  /** Background tasks still running at the end of the turn, as a Stop hook reports. */
  backgroundTasks?: number | null;
}

/**
 * The inside part reports a status change (like turn-start and turn-end hooks):
 * going busy sets `lastTurnStart`, going from busy to idle sets `lastTurnEnd`.
 * `fields` set the turn times and background task count directly and win over
 * those automatic ones, so a test can model, say, a record that still says busy
 * although its last turn ended ten minutes ago.
 */
export async function setInsideStatus(
  ctx: AdapterContext,
  session: string,
  status: FakeInsideStatus,
  fields: TurnFields = {},
): Promise<void> {
  const now = ctx.now().toISOString();
  // Like the other events, only for a session the fake harness has started.
  requireRow(parseState(await ctx.io.readFile(fakeStatePath(ctx.env))).sessions[session], session);
  await ctx.records.updateInside(HARNESS, session, (current) => {
    const next = { ...(current ?? {}) };
    if (status === "busy" && current?.status !== "busy") next.lastTurnStart = now;
    if (status === "idle" && current?.status === "busy") next.lastTurnEnd = now;
    if (next.status !== status) {
      next.status = status;
      next.since = now;
    }
    if (fields.lastTurnStart !== undefined) next.lastTurnStart = fields.lastTurnStart;
    if (fields.lastTurnEnd !== undefined) next.lastTurnEnd = fields.lastTurnEnd;
    if (fields.backgroundTasks !== undefined) next.backgroundTasks = fields.backgroundTasks;
    return next;
  });
}

/** A permission prompt or dialog opens (text) or closes (null). Only the listing shows it. */
export async function setPrompt(ctx: AdapterContext, session: string, prompt: string | null): Promise<void> {
  const now = ctx.now().toISOString();
  await updateState(fakeStatePath(ctx.env), (state) => {
    const row = requireRow(state.sessions[session], session);
    row.prompt = prompt;
    row.promptSince = prompt === null ? null : now;
  });
}

/** The session dies without its end hook running: the record is left behind. */
export async function killSession(ctx: AdapterContext, session: string): Promise<void> {
  const now = ctx.now().toISOString();
  await updateState(fakeStatePath(ctx.env), (state) => {
    const row = requireRow(state.sessions[session], session);
    row.alive = false;
    row.prompt = null;
    row.promptSince = null;
    row.goneSince = now;
  });
}

/** The session ends cleanly: its end hook removes the record. */
export async function endSession(ctx: AdapterContext, session: string): Promise<void> {
  await killSession(ctx, session);
  await ctx.records.remove(HARNESS, session);
}

/** Make deliver to this session fail with `reason`, or succeed again with null. */
export async function setFailDeliver(ctx: AdapterContext, session: string, reason: string | null): Promise<void> {
  await updateState(fakeStatePath(ctx.env), (state) => {
    requireRow(state.sessions[session], session).failDeliver = reason;
  });
}

/** Every message delivered, oldest first, optionally for one session. */
export async function readDeliveries(ctx: AdapterContext, session?: string): Promise<FakeDelivery[]> {
  const state = parseState(await ctx.io.readFile(fakeStatePath(ctx.env)));
  return session === undefined ? state.deliveries : state.deliveries.filter((d) => d.session === session);
}

export class FakeSessionError extends Error {}

function requireRow<T>(row: T | undefined, session: string): T {
  if (row === undefined) throw new FakeSessionError(`fake session ${session} was never started`);
  return row;
}
