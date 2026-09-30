/** How the fake adapter turns its listing row and session record into an Observation. */
import { observation } from "../../adapter.js";
import type { SessionRecord } from "../../records.js";
import type { Observation } from "../../types.js";
import type { FakeSession } from "./state.js";

export const FAKE_HARNESS = "fake";

export function fakeObservation(session: string, row: FakeSession | undefined, rec: SessionRecord | null): Observation {
  const inside = rec?.inside ?? null;
  const detail = {
    pid: row?.pid ?? inside?.pid ?? null,
    prompt: row?.prompt ?? null,
    hasInsidePart: inside !== null,
    lastTurnStart: inside?.lastTurnStart ?? null,
    lastTurnEnd: inside?.lastTurnEnd ?? null,
    backgroundTasks: inside?.backgroundTasks ?? null,
  };
  const raw = { listing: row ?? null, record: rec };
  const self = rec?.self ?? null;
  const base = { harness: FAKE_HARNESS, session, attached: inside !== null, detail, raw, self };
  // The record says the session ended cleanly: that wins, even over a listing that
  // still shows it (a harness may keep running a process whose session ended).
  if (inside?.status === "ended") return observation({ ...base, status: "ended", since: inside.endedAt ?? inside.since ?? null, endReason: inside.endReason ?? null });
  if (!row || !row.alive) return observation({ ...base, status: "gone", since: row?.goneSince ?? null });
  if (row.prompt) return observation({ ...base, status: "waiting-on-prompt", since: row.promptSince ?? null });
  if (inside?.status) return observation({ ...base, status: inside.status, since: inside.since ?? null });
  return observation({ ...base, status: "unknown" });
}

