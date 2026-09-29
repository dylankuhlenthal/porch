/**
 * The fake harness: a JSON file standing in for a harness's own view of its
 * sessions (its "outside listing"). Tests, here and in other repos, edit it
 * directly or through `porch fake ...` commands.
 *
 * File: $PORCH_FAKE_STATE, or <porch home>/fake-harness.json.
 *
 *   {
 *     "sessions": {
 *       "<id>": { "alive": true, "pid": 4242, "prompt": null, "promptSince": null,
 *                 "goneSince": null, "failDeliver": null }
 *     },
 *     "deliveries": [ { "session": "<id>", "text": "...", "at": "<iso>", "statusAtSend": "idle" } ]
 *   }
 *
 * - "alive": false models a session that is not running. If its record is still in
 *   the records folder, that is a crash that left the record behind.
 * - "prompt": a string models a session held at a permission prompt or dialog; only
 *   the outside listing can see it, as with Claude Code.
 * - "failDeliver": a string makes deliver fail with that reason.
 * - "deliveries": every message deliver sent, in order.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Env } from "../../home.js";
import { porchHome } from "../../home.js";
import { withLock, writeAtomic } from "../../fsutil.js";
import type { SessionStatus } from "../../types.js";

export interface FakeSession {
  alive: boolean;
  pid?: number | null;
  prompt?: string | null;
  promptSince?: string | null;
  goneSince?: string | null;
  failDeliver?: string | null;
}

export interface FakeDelivery {
  session: string;
  text: string;
  at: string;
  statusAtSend: SessionStatus | null;
}

export interface FakeState {
  sessions: Record<string, FakeSession>;
  deliveries: FakeDelivery[];
}

export function fakeStatePath(env: Env): string {
  const fromEnv = env.PORCH_FAKE_STATE;
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv);
  return path.join(porchHome(env), "fake-harness.json");
}

export function emptyState(): FakeState {
  return { sessions: {}, deliveries: [] };
}

/** Parse the state file's text; null text (no file) is an empty harness. */
export function parseState(text: string | null): FakeState {
  if (text === null) return emptyState();
  const parsed = JSON.parse(text) as Partial<FakeState>;
  return {
    sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [],
  };
}

/** Change the state file under a lock. Used by deliver and the `porch fake` commands. */
export async function updateState<T>(file: string, fn: (state: FakeState) => T): Promise<T> {
  return withLock(file, async () => {
    let text: string | null = null;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
    const state = parseState(text);
    const result = fn(state);
    await writeAtomic(file, JSON.stringify(state, null, 2) + "\n");
    return result;
  });
}
