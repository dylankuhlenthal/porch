/**
 * The conformance cases. Each one is written against the adapter contract (through
 * a Porch instance holding only the adapter under test) and the harness driver,
 * never against a particular harness. Case names are stable: they name the
 * fixture files.
 */
import { randomBytes } from "node:crypto";

import type { Adapter } from "../adapter.js";
import type { Porch } from "../porch.js";
import type { Observation, SessionStatus } from "../types.js";
import type { DriverSession, HarnessDriver } from "./driver.js";

export class ConformanceFailure extends Error {}
export class ConformanceSkip extends Error {}

export interface CaseContext {
  adapter: Adapter;
  driver: HarnessDriver;
  /** A Porch holding only the adapter under test, on the case's scratch folder. */
  porch: Porch;
  /** A Porch that runs "inside" the session: its environment includes the driver's envInside. */
  porchInside(session: DriverSession): Porch;
  /** Record the current state for the fixture. */
  snapshot(label: string): Promise<void>;
  /** Sender label used for every delivery. */
  from: string;
}

export interface ConformanceCase {
  name: string;
  /** What decision 15's list calls it, in plain words. */
  title: string;
  run(c: CaseContext): Promise<void>;
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceFailure(message);
}

function uniqueText(label: string): string {
  return `porch conformance ${label} ${randomBytes(4).toString("hex")}`;
}

async function waitFor<T>(what: string, timeoutMs: number, fn: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      throw new ConformanceFailure(`timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function observeRaw(c: CaseContext, id: string): Promise<Observation | null> {
  return c.adapter.observe(c.porch.ctx, id);
}

async function waitForStatus(c: CaseContext, id: string, statuses: SessionStatus[]): Promise<Observation> {
  return waitFor(`session ${id} to be ${statuses.join(" or ")}`, c.driver.timeouts.changeMs, async () => {
    const obs = await observeRaw(c, id);
    return obs && statuses.includes(obs.status) ? obs : null;
  });
}

async function waitForReceived(c: CaseContext, s: DriverSession, text: string): Promise<void> {
  await waitFor(`the session to receive "${text}"`, c.driver.timeouts.deliveryMs, async () =>
    (await c.driver.received(s)).some((m) => m.includes(text)),
  );
}

function requireSupport(ok: boolean, why: string): void {
  if (!ok) throw new ConformanceSkip(why);
}

export const CASES: ConformanceCase[] = [
  {
    name: "which-session-am-i",
    title: "which session am I",
    async run(c) {
      const s = await c.driver.start();
      await waitForStatus(c, s.id, ["idle", "busy", "starting", "unknown"]);
      const inside = await c.porchInside(s).current();
      check(inside.session === s.id && inside.harness === c.adapter.harness, `current() inside the session returned ${JSON.stringify(inside)}, expected ${s.id}`);
      const outside = await c.adapter.current(c.porch.ctx);
      check(outside === null, `current() outside any session returned ${JSON.stringify(outside)}, expected null`);
      await c.snapshot("started");
    },
  },
  {
    name: "deliver-while-idle",
    title: "deliver while idle",
    async run(c) {
      const s = await c.driver.start();
      await waitForStatus(c, s.id, ["idle"]);
      await c.snapshot("idle");
      const text = uniqueText("idle");
      const r = await c.porch.deliver(s.id, text, { from: c.from });
      check(r.result === "delivered", `deliver returned ${r.result}: ${r.reason}`);
      check(r.statusAtSend === "idle", `statusAtSend was ${r.statusAtSend}, expected idle`);
      check(r.harness === c.adapter.harness, `deliver reported harness ${r.harness}`);
      await waitForReceived(c, s, text);
      await c.snapshot("after delivery");
    },
  },
  {
    name: "deliver-while-busy",
    title: "deliver while busy",
    async run(c) {
      const s = await c.driver.start();
      await waitForStatus(c, s.id, ["idle"]);
      await c.driver.makeBusy(s);
      await waitForStatus(c, s.id, ["busy"]);
      await c.snapshot("busy");
      const text = uniqueText("busy");
      const r = await c.porch.deliver(s.id, text, { from: c.from });
      check(r.result === "delivered", `deliver returned ${r.result}: ${r.reason}`);
      check(r.statusAtSend === "busy", `statusAtSend was ${r.statusAtSend}, expected busy`);
      if (c.adapter.capabilities.queuesWhileBusy) await waitForReceived(c, s, text);
      await c.driver.makeIdle(s);
      await waitForStatus(c, s.id, ["idle"]);
      await c.snapshot("idle again");
    },
  },
  {
    name: "held-at-prompt",
    title: "held at a prompt or dialog",
    async run(c) {
      requireSupport(c.adapter.capabilities.seesPrompts, "the adapter cannot see prompts (capabilities.seesPrompts is false)");
      requireSupport(c.driver.supports.holdAtPrompt, "the driver cannot hold a session at a prompt");
      const s = await c.driver.start();
      await waitForStatus(c, s.id, ["idle"]);
      await c.driver.holdAtPrompt(s);
      await waitForStatus(c, s.id, ["waiting-on-prompt"]);
      await c.snapshot("held");
      const r = await c.porch.deliver(s.id, uniqueText("held"), { from: c.from });
      check(r.result === "delivered", `deliver returned ${r.result}: ${r.reason}`);
      check(r.statusAtSend === "waiting-on-prompt", `statusAtSend was ${r.statusAtSend}, expected waiting-on-prompt`);
      const after = await observeRaw(c, s.id);
      check(after?.status === "waiting-on-prompt", `after delivery the session showed ${after?.status}, expected still waiting-on-prompt`);
      await c.snapshot("after delivery");
    },
  },
  {
    name: "killed-session",
    title: "a killed session",
    async run(c) {
      const s = await c.driver.start();
      await waitForStatus(c, s.id, ["idle", "busy"]);
      await c.driver.kill(s);
      await waitForStatus(c, s.id, ["gone"]);
      await c.snapshot("killed");
      const r = await c.porch.deliver(s.id, uniqueText("killed"), { from: c.from });
      check(r.result === "not-running", `deliver to a killed session returned ${r.result}, expected not-running`);
      const listed = (await c.porch.list()).sessions.find((o) => o.session === s.id);
      check(listed === undefined || listed.status === "gone", `list showed the killed session as ${listed?.status}`);
    },
  },
  {
    name: "without-inside-part",
    title: "a session without the inside part",
    async run(c) {
      requireSupport(c.driver.supports.withoutInside, "the driver cannot start a session without the inside part");
      const s = await c.driver.startWithoutInside();
      const obs = await waitFor(`session ${s.id} to be listed`, c.driver.timeouts.changeMs, async () =>
        (await c.porch.list()).sessions.find((o) => o.session === s.id),
      );
      check(obs.status !== "gone", `a running session without the inside part showed as gone`);
      await c.snapshot("listed");
      const text = uniqueText("no-inside");
      const r = await c.porch.deliver(s.id, text, { from: c.from });
      check(r.result === "delivered", `deliver returned ${r.result}: ${r.reason}`);
      await waitForReceived(c, s, text);
    },
  },
  {
    name: "watch-delivers-each-change",
    title: "watch delivers each change",
    async run(c) {
      const seen: Observation[] = [];
      const controller = new AbortController();
      const watching = c.porch.watch({ signal: controller.signal, onObservation: (o) => seen.push(o) });
      try {
        await new Promise((r) => setTimeout(r, 200));
        const s = await c.driver.start();
        const statuses = () => collapse(seen.filter((o) => o.session === s.id).map((o) => o.status));
        await waitFor("watch to report idle", c.driver.timeouts.changeMs, async () => statuses().includes("idle"));
        await c.driver.makeBusy(s);
        await waitFor("watch to report busy", c.driver.timeouts.changeMs, async () => statuses().includes("busy"));
        await c.driver.makeIdle(s);
        await waitFor("watch to report idle after busy", c.driver.timeouts.changeMs, async () => isSubsequence(["idle", "busy", "idle"], statuses()));
        await c.snapshot("idle after busy");
        await c.driver.kill(s);
        await waitFor("watch to report gone", c.driver.timeouts.changeMs, async () => isSubsequence(["idle", "busy", "idle", "gone"], statuses()));
        await c.snapshot("gone");
      } finally {
        controller.abort();
        await watching;
      }
    },
  },
  {
    name: "self-reported-state",
    title: "self-reported state",
    async run(c) {
      const s = await c.driver.start();
      await waitForStatus(c, s.id, ["idle", "busy", "starting", "unknown"]);
      const set = await c.porchInside(s).statusSet("needs-input", "which branch?");
      check(set.session === s.id, `status set wrote to ${set.session}, expected ${s.id}`);
      const obs = await observeRaw(c, s.id);
      check(obs?.self?.status === "needs-input" && obs.self.text === "which branch?", `observe showed self ${JSON.stringify(obs?.self)}`);
      await c.snapshot("self reported");
    },
  },
  {
    name: "unknown-session",
    title: "a session that does not exist",
    async run(c) {
      const id = `porch-conformance-missing-${randomBytes(4).toString("hex")}`;
      check((await c.adapter.observe(c.porch.ctx, id)) === null, `observe of a made-up session did not return null`);
      const r = await c.porch.deliver(id, "nobody home", { from: c.from });
      check(r.result === "not-running", `deliver to a made-up session returned ${r.result}`);
      // The adapter itself must also refuse, not only the core in front of it.
      const direct = await c.adapter.deliver(c.porch.ctx, id, `[from ${c.from}] nobody home`);
      check(direct.result === "not-running", `the adapter's own deliver to a made-up session returned ${direct.result}`);
    },
  },
];

/** Drop consecutive repeats: [idle, idle, busy] -> [idle, busy]. */
function collapse(statuses: SessionStatus[]): SessionStatus[] {
  return statuses.filter((s, i) => i === 0 || statuses[i - 1] !== s);
}

function isSubsequence(want: SessionStatus[], got: SessionStatus[]): boolean {
  let i = 0;
  for (const s of got) if (s === want[i]) i++;
  return i === want.length;
}
