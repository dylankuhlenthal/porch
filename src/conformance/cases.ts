/**
 * The conformance cases. Each one is written against the adapter contract (through
 * a Porch instance holding only the adapter under test) and the harness driver,
 * never against a particular harness. Case names are stable: they name the
 * fixture files.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Adapter } from "../adapter.js";
import type { Porch } from "../porch.js";
import { RecordStore } from "../records.js";
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
  /** What the case checks, in plain words. */
  title: string;
  /**
   * The case waits on the harness for a long time (an hour or more). It runs only
   * when asked for (`--slow`, or named with `--case`), and its time limit is the
   * driver's caseMs plus its idleStopMs.
   */
  slow?: boolean;
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

/** How long to wait after one Ctrl+C before checking nothing ended. */
const INTERRUPT_SETTLE_MS = 1500;

/** How often, at most, the idle-stopped case looks while it waits (up to an hour for Claude Code). */
const IDLE_STOP_POLL_MS = 10_000;

/**
 * Observe the session against a copy of the case's records, so the look writes
 * nothing to them. An adapter may write a record when it observes (the Claude
 * adapter marks a session stopped for being idle), and the idle-stopped case
 * snapshots the moment before that first write, so the fixture replays the
 * adapter reading the harness's evidence rather than a record already marked.
 */
async function observeOnCopy(c: CaseContext, id: string): Promise<Observation | null> {
  const copy = await fs.mkdtemp(path.join(os.tmpdir(), "porch-observe-copy-"));
  try {
    const dir = c.porch.ctx.records.dir;
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (name.endsWith(".json")) await fs.copyFile(path.join(dir, name), path.join(copy, name)).catch(() => undefined);
    }
    return await c.adapter.observe({ ...c.porch.ctx, records: new RecordStore(copy) }, id);
  } finally {
    await fs.rm(copy, { recursive: true, force: true });
  }
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
      // A session with the inside part is attached, so the default list shows it.
      const listed = await waitFor(`session ${s.id} in the default list`, c.driver.timeouts.changeMs, async () =>
        (await c.porch.list()).sessions.find((o) => o.session === s.id),
      );
      check(listed.attached === true, `the default list showed the session with the inside part as not attached`);
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
      const gone = await waitForStatus(c, s.id, ["gone"]);
      await c.snapshot("killed");
      // Reading what the harness left (the Claude adapter reads Claude Code's daemon
      // log for an idle stop) must not turn a killed session into an ended one.
      check(gone.endReason === null, `the killed session has endReason ${JSON.stringify(gone.endReason)}`);
      const again = await observeRaw(c, s.id);
      check(again?.status === "gone", `looked at again, the killed session showed ${again?.status ?? "not found"}, expected gone`);
      const rec = await c.porch.ctx.records.read(c.adapter.harness, s.id);
      check(rec?.inside?.status !== "ended", "the killed session's record was marked ended");
      const r = await c.porch.deliver(s.id, uniqueText("killed"), { from: c.from });
      check(r.result === "not-running", `deliver to a killed session returned ${r.result}, expected not-running`);
      // Not running: left out of the default list, shown as gone by list --all.
      const listed = (await c.porch.list()).sessions.find((o) => o.session === s.id);
      check(listed === undefined, `the default list showed the killed session (${listed?.status})`);
      const all = (await c.porch.list(undefined, { all: true })).sessions.find((o) => o.session === s.id);
      check(all?.status === "gone", `list --all showed the killed session as ${all?.status ?? "missing"}, expected gone`);
    },
  },
  {
    name: "ended-cleanly",
    title: "a session that ended cleanly",
    async run(c) {
      const s = await c.driver.start();
      await waitForStatus(c, s.id, ["idle", "busy"]);
      await c.driver.stop(s);
      const obs = await waitForStatus(c, s.id, ["ended"]);
      await c.snapshot("ended");
      const want = c.driver.endReasons.stop;
      check(obs.endReason === want, `the ended session's endReason was ${JSON.stringify(obs.endReason)}, expected ${JSON.stringify(want)}`);
      check(obs.since !== null, "the ended session has no since (when it ended)");
      check(obs.attached, "the ended session is no longer attached");
      const r = await c.porch.deliver(s.id, uniqueText("ended"), { from: c.from });
      check(r.result === "not-running", `deliver to an ended session returned ${r.result}, expected not-running`);
      // Not running: left out of the default list, shown as ended by list --all.
      const listed = (await c.porch.list()).sessions.find((o) => o.session === s.id);
      check(listed === undefined, `the default list showed the ended session (${listed?.status})`);
      const all = (await c.porch.list(undefined, { all: true })).sessions.find((o) => o.session === s.id);
      check(all?.status === "ended", `list --all showed the ended session as ${all?.status ?? "missing"}, expected ended`);
    },
  },
  {
    name: "idle-stopped",
    title: "a session the harness stopped for being idle",
    slow: true,
    async run(c) {
      requireSupport(c.driver.supports.idleStop, "the harness does not stop idle sessions by itself (supports.idleStop is false)");
      const waitMs = c.driver.timeouts.idleStopMs;
      requireSupport(waitMs !== undefined && waitMs > 0, "the driver gives no timeouts.idleStopMs");
      const s = await c.driver.start();
      await waitForStatus(c, s.id, ["idle"]);
      // A session the harness stops for idling has had a turn.
      await c.driver.makeBusy(s);
      await waitForStatus(c, s.id, ["busy"]);
      await c.driver.makeIdle(s);
      await waitForStatus(c, s.id, ["idle"]);
      await c.snapshot("idle");
      const stopped = await waitFor(`session ${s.id} to be stopped for being idle`, waitMs!, async () => {
        const obs = await observeOnCopy(c, s.id);
        if (obs && obs.status !== "ended" && obs.status !== "gone") {
          await new Promise((r) => setTimeout(r, Math.min(IDLE_STOP_POLL_MS, Math.max(100, waitMs! / 20))));
          return null;
        }
        return obs;
      });
      check(stopped.status === "ended", `the idle session showed ${stopped.status} once it stopped, expected ended`);
      // The first look that sees it stopped, from the evidence the harness left.
      await c.snapshot("idle-stopped");
      const obs = await observeRaw(c, s.id);
      const want = c.driver.endReasons.idleStop;
      check(obs?.status === "ended", `the idle-stopped session showed ${obs?.status ?? "not found"}, expected ended`);
      check(obs.endReason === want, `the idle-stopped session's endReason was ${JSON.stringify(obs.endReason)}, expected ${JSON.stringify(want)}`);
      check(obs.since !== null, "the idle-stopped session has no since (when it stopped)");
      check(obs.attached, "the idle-stopped session is no longer attached");
      const rec = await c.porch.ctx.records.read(c.adapter.harness, s.id);
      check(rec?.inside?.status === "ended" && rec.inside.endReason === want, `the record says ${rec?.inside?.status} (${rec?.inside?.endReason}), expected ended (${want})`);
      const r = await c.porch.deliver(s.id, uniqueText("idle-stopped"), { from: c.from });
      check(r.result === "not-running", `deliver to an idle-stopped session returned ${r.result}, expected not-running`);
      const listed = (await c.porch.list()).sessions.find((o) => o.session === s.id);
      check(listed === undefined, `the default list showed the idle-stopped session (${listed?.status})`);
      const all = (await c.porch.list(undefined, { all: true })).sessions.find((o) => o.session === s.id);
      check(all?.status === "ended" && all.endReason === want, `list --all showed the idle-stopped session as ${all?.status ?? "missing"} (${all?.endReason})`);
      await c.snapshot("marked");
    },
  },
  {
    name: "without-inside-part",
    title: "a session without the inside part",
    async run(c) {
      requireSupport(c.driver.supports.withoutInside, "the driver cannot start a session without the inside part");
      const s = await c.driver.startWithoutInside();
      // Only `list --all` shows it: the default list is the sessions Porch is attached to.
      const obs = await waitFor(`session ${s.id} to be listed by list --all`, c.driver.timeouts.changeMs, async () =>
        (await c.porch.list(undefined, { all: true })).sessions.find((o) => o.session === s.id),
      );
      check(obs.attached === false, `list --all showed the session without the inside part as attached`);
      check(obs.status !== "gone", `a running session without the inside part showed as gone`);
      const plain = (await c.porch.list()).sessions.find((o) => o.session === s.id);
      check(plain === undefined, `the default list showed a session without the inside part (${JSON.stringify(plain?.status)})`);
      // Named explicitly, it is still observed and delivered to.
      const observed = await c.porch.observe(s.id);
      check(observed.attached === false && observed.status !== "gone", `observe showed ${observed.status}, attached ${observed.attached}`);
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
        const want: SessionStatus[] = ["idle", "busy", "idle"];
        // A prompt opening must arrive through watch too. For some harnesses (Claude
        // Code) only the outside listing shows it, so watch has to poll for it.
        if (c.adapter.capabilities.seesPrompts && c.driver.supports.holdAtPrompt) {
          await c.driver.holdAtPrompt(s);
          want.push("waiting-on-prompt");
          await waitFor("watch to report waiting-on-prompt", c.driver.timeouts.changeMs, async () => isSubsequence(want, statuses()));
          await c.snapshot("waiting on a prompt");
        }
        await c.driver.kill(s);
        want.push("gone");
        await waitFor(`watch to report gone (after ${want.slice(0, -1).join(", ")})`, c.driver.timeouts.changeMs, async () =>
          isSubsequence(want, statuses()),
        );
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
    name: "launch-background",
    title: "a background session started through porch launch",
    async run(c) {
      requireSupport(c.adapter.capabilities.launch, "the adapter cannot launch (capabilities.launch is false)");
      const s = await c.driver.launchBackground();
      const obs = await waitForStatus(c, s.id, ["idle"]);
      check(obs.harness === c.adapter.harness, `the launched session was reported by ${obs.harness}`);
      const rec = await c.porch.ctx.records.read(c.adapter.harness, s.id);
      check(rec?.inside != null, "the launched session has no record from the inside part");
      const applied = await c.driver.callerSettingsApplied(s);
      check(applied !== false, "the caller's own settings passed to porch launch did not take effect alongside Porch's inside part");
      await c.snapshot("launched");
      const text = uniqueText("launched");
      const r = await c.porch.deliver(s.id, text, { from: c.from });
      check(r.result === "delivered", `deliver returned ${r.result}: ${r.reason}`);
      await waitForReceived(c, s, text);
      await c.snapshot("after delivery");
    },
  },
  {
    name: "launch-interactive",
    title: "an interactive session started through porch launch",
    async run(c) {
      requireSupport(c.adapter.capabilities.launch, "the adapter cannot launch (capabilities.launch is false)");
      const seen: Observation[] = [];
      const controller = new AbortController();
      const watching = c.porch.watch({ signal: controller.signal, onObservation: (o) => seen.push(o) });
      try {
        const s = await c.driver.launchInteractive();
        await waitForStatus(c, s.id, ["idle"]);
        const rec = await c.porch.ctx.records.read(c.adapter.harness, s.id);
        check(rec?.inside != null, "the launched session has no record from the inside part");
        await c.snapshot("started");
        // A delivered message starts a turn: idle, busy, idle.
        const text = uniqueText("interactive");
        const r = await c.porch.deliver(s.id, `${text}. Reply with just OK.`, { from: c.from });
        check(r.result === "delivered" && r.statusAtSend === "idle", `deliver returned ${r.result} (${r.statusAtSend}): ${r.reason}`);
        const statuses = () => collapse(seen.filter((o) => o.session === s.id).map((o) => o.status));
        await waitFor("watch to report idle, busy, idle after the delivery", c.driver.timeouts.changeMs, async () =>
          isSubsequence(["idle", "busy", "idle"], statuses()),
        );
        await waitForReceived(c, s, text);
        await c.snapshot("after a turn");
        // One Ctrl+C leaves both the harness and porch launch running.
        await c.driver.interrupt(s);
        await new Promise((r) => setTimeout(r, INTERRUPT_SETTLE_MS));
        check(c.driver.launchRunning(s), "porch launch ended after one Ctrl+C");
        const after = await observeRaw(c, s.id);
        check(after !== null && after.status !== "gone", `after one Ctrl+C the session showed ${after?.status ?? "not found"}`);
        // Exiting the harness passes its exit code back through porch launch, and the
        // inside part marks the session ended, which watch reports.
        const end = await c.driver.exitInteractive(s);
        check(end.code === 0 && end.signal === null, `porch launch ended with ${JSON.stringify(end)} after the harness exited cleanly, expected code 0`);
        const ended = await waitForStatus(c, s.id, ["ended"]);
        const want = c.driver.endReasons.exitInteractive;
        check(ended.endReason === want, `the session's endReason was ${JSON.stringify(ended.endReason)}, expected ${JSON.stringify(want)}`);
        await waitFor("watch to report the session ended", c.driver.timeouts.changeMs, async () =>
          isSubsequence(["idle", "busy", "idle", "ended"], statuses()),
        );
        await c.snapshot("ended");
      } finally {
        controller.abort();
        await watching;
      }
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
