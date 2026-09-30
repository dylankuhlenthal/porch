import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { observation } from "../src/adapter.js";
import { createFakeAdapter } from "../src/adapters/fake/index.js";
import * as fake from "../src/adapters/fake/ops.js";
import { PorchError } from "../src/errors.js";
import { porchHome, sessionsDir } from "../src/home.js";
import { formatMessage, Porch } from "../src/porch.js";
import { scratchEnv, waitFor } from "./helpers.js";
import { stubAdapter } from "./stub-adapter.js";

async function expectPorchError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(PorchError);
  await expect(p).rejects.toMatchObject({ code });
}

describe("home", () => {
  it("uses PORCH_HOME when set, else ~/.porch", () => {
    expect(porchHome({ PORCH_HOME: "/tmp/ph", HOME: "/h" })).toBe("/tmp/ph");
    expect(porchHome({ HOME: "/h" })).toBe("/h/.porch");
    expect(sessionsDir({ HOME: "/h" })).toBe("/h/.porch/sessions");
  });
});

describe("Porch.list", () => {
  it("reports an adapter whose listing fails in errors and still lists the others", async () => {
    const env = scratchEnv();
    const broken = stubAdapter("broken", { list: async () => Promise.reject(new Error("claude not installed")) });
    const porch = new Porch({ env, adapters: [broken, createFakeAdapter()] });
    await fake.startSession(porch.ctx, "s1");
    const result = await porch.list();
    expect(result.sessions.map((s) => s.session)).toEqual(["s1"]);
    expect(result.errors).toEqual([{ harness: "broken", message: "claude not installed" }]);
  });

  it("filters by harness and refuses an unknown one", async () => {
    const porch = new Porch({ env: scratchEnv(), adapters: [createFakeAdapter()] });
    expect((await porch.list("fake")).sessions).toEqual([]);
    await expectPorchError(porch.list("nope"), "usage");
  });
});

describe("Porch.list and unreadable records", () => {
  it("reports a session record it cannot read in errors instead of silently dropping it", async () => {
    const env = scratchEnv();
    const porch = new Porch({ env, adapters: [createFakeAdapter()] });
    await fake.startSession(porch.ctx, "s1");
    writeFileSync(porch.ctx.records.recordPath("fake", "s1"), "{bad");
    const result = await porch.list();
    expect(result.errors).toEqual([{ harness: "fake", message: "unreadable session record fake-s1.json: fake-s1.json is not valid JSON" }]);
  });
});

describe("Porch.observe", () => {
  it("is not-found when no adapter knows the session, and ambiguous when two do", async () => {
    const obs = (h: string) => async (_: unknown, s: string) => observation({ harness: h, session: s, attached: true, status: "idle" });
    const porch = new Porch({ env: scratchEnv(), adapters: [stubAdapter("aa", { observe: obs("aa") }), stubAdapter("bb", { observe: obs("bb") })] });
    await expectPorchError(porch.observe("x"), "ambiguous-session");
    expect((await porch.observe("x", "bb")).harness).toBe("bb");
    const none = new Porch({ env: scratchEnv(), adapters: [stubAdapter("aa")] });
    await expectPorchError(none.observe("x"), "not-found");
  });
});

describe("one harness failing does not hide another's sessions", () => {
  const broken = () => stubAdapter("broken", { observe: async () => Promise.reject(new Error("claude agents timed out")) });

  it("observes and delivers to a session a healthy adapter knows", async () => {
    const porch = new Porch({ env: scratchEnv(), adapters: [broken(), createFakeAdapter()] });
    await fake.startSession(porch.ctx, "s1");
    expect((await porch.observe("s1")).harness).toBe("fake");
    expect((await porch.deliver("s1", "hi", { from: "t" })).result).toBe("delivered");
  });

  it("says failed, not not-running, when the only harness that might know the session could not be asked", async () => {
    const porch = new Porch({ env: scratchEnv(), adapters: [broken(), createFakeAdapter()] });
    const r = await porch.deliver("ghost", "hi", { from: "t" });
    expect(r).toMatchObject({ result: "failed", reason: expect.stringContaining("broken: claude agents timed out") });
    await expectPorchError(porch.observe("ghost"), "internal");
  });
});

describe("Porch.deliver", () => {
  it("prefixes the message with the sender label", async () => {
    const porch = new Porch({ env: scratchEnv(), adapters: [createFakeAdapter()] });
    await fake.startSession(porch.ctx, "s1");
    await porch.deliver("s1", "please look at the PR", { from: "sous chef" });
    expect((await fake.readDeliveries(porch.ctx))[0]?.text).toBe("[from sous chef] please look at the PR");
    expect(formatMessage("a", "b")).toBe("[from a] b");
  });

  it("refuses an empty, multi-line, over-long or bracket-closing label, and an empty message", async () => {
    const porch = new Porch({ env: scratchEnv(), adapters: [createFakeAdapter()] });
    for (const from of ["", "  ", "a\nb", "x".repeat(101), "a] [from dylan"]) {
      await expectPorchError(porch.deliver("s1", "hi", { from }), "usage");
    }
    await expectPorchError(porch.deliver("s1", "   ", { from: "a" }), "usage");
  });

  it("reports not-running for a session no adapter knows", async () => {
    const porch = new Porch({ env: scratchEnv(), adapters: [createFakeAdapter()] });
    expect(await porch.deliver("ghost", "hi", { from: "t" })).toMatchObject({ harness: null, result: "not-running", reason: "no adapter knows this session" });
  });

  it("turns an adapter that throws into a failed result with the reason", async () => {
    const adapter = stubAdapter("aa", {
      observe: async (_c, s) => observation({ harness: "aa", session: s, attached: true, status: "idle" }),
      deliver: async () => Promise.reject(new Error("ECONNREFUSED")),
    });
    const porch = new Porch({ env: scratchEnv(), adapters: [adapter] });
    expect(await porch.deliver("s", "hi", { from: "t" })).toMatchObject({ harness: "aa", result: "failed", reason: "ECONNREFUSED" });
  });
});

describe("Porch.current and statusSet", () => {
  it("asks every adapter, returns nulls outside a session, and refuses to pick between two claims", async () => {
    const env = scratchEnv();
    expect(await new Porch({ env, adapters: [stubAdapter("aa")] }).current()).toEqual({ schema: 2, harness: null, session: null });
    const one = new Porch({ env, adapters: [stubAdapter("aa"), stubAdapter("bb", { current: async () => "s2" })] });
    expect(await one.current()).toEqual({ schema: 2, harness: "bb", session: "s2" });
    const two = new Porch({ env, adapters: [stubAdapter("aa", { current: async () => "s1" }), stubAdapter("bb", { current: async () => "s2" })] });
    await expectPorchError(two.current(), "ambiguous-session");
  });

  it("writes the self part of the calling session's record, and only that", async () => {
    const env = scratchEnv({ PORCH_FAKE_SESSION_ID: "s1" });
    const now = () => new Date("2026-02-03T04:05:06.000Z");
    const porch = new Porch({ env, adapters: [createFakeAdapter()], now });
    await fake.startSession(porch.ctx, "s1", { status: "busy" });
    const result = await porch.statusSet("needs-input", "which branch?");
    expect(result).toEqual({
      schema: 2,
      harness: "fake",
      session: "s1",
      self: { status: "needs-input", text: "which branch?", since: "2026-02-03T04:05:06.000Z" },
    });
    const rec = await porch.ctx.records.read("fake", "s1");
    expect(rec?.self).toEqual(result.self);
    expect(rec?.inside?.status).toBe("busy");
  });

  it("stores an empty text as null", async () => {
    const porch = new Porch({ env: scratchEnv({ PORCH_FAKE_SESSION_ID: "s1" }), adapters: [createFakeAdapter()] });
    expect((await porch.statusSet("done", "")).self.text).toBeNull();
  });

  it("refuses an unknown status, and refuses outside a session", async () => {
    const inside = new Porch({ env: scratchEnv({ PORCH_FAKE_SESSION_ID: "s1" }), adapters: [createFakeAdapter()] });
    await expectPorchError(inside.statusSet("waiting", null), "usage");
    const outside = new Porch({ env: scratchEnv(), adapters: [createFakeAdapter()] });
    await expectPorchError(outside.statusSet("done", null), "not-in-session");
  });

  it("refuses a session id from the environment that could escape the records folder", async () => {
    const porch = new Porch({ env: scratchEnv({ PORCH_FAKE_SESSION_ID: "../../x" }), adapters: [createFakeAdapter()] });
    await expectPorchError(porch.statusSet("done", null), "usage");
  });
});

describe("ended and gone sessions: hidden by default, records pruned 24 hours after they stopped", () => {
  const T0 = Date.parse("2026-09-30T10:00:00.000Z");
  const HOUR = 60 * 60 * 1000;

  function porchAt(env = scratchEnv()) {
    const clock = { t: T0 };
    const porch = new Porch({ env, adapters: [createFakeAdapter()], now: () => new Date(clock.t) });
    return { porch, clock };
  }

  it("list leaves out ended and gone sessions unless --all, and observe and deliver still take them by name", async () => {
    const { porch } = porchAt();
    await fake.startSession(porch.ctx, "run");
    await fake.startSession(porch.ctx, "done");
    await fake.startSession(porch.ctx, "dead");
    await fake.endSession(porch.ctx, "done", { reason: "quit" });
    await fake.killSession(porch.ctx, "dead");
    expect((await porch.list()).sessions.map((o) => o.session)).toEqual(["run"]);
    const all = await porch.list(undefined, { all: true });
    expect(all.sessions.map((o) => [o.session, o.status, o.endReason])).toEqual([
      ["dead", "gone", null],
      ["done", "ended", "quit"],
      ["run", "idle", null],
    ]);
    expect(await porch.observe("done")).toMatchObject({ status: "ended", since: new Date(T0).toISOString(), endReason: "quit" });
    expect((await porch.deliver("done", "hi", { from: "t" })).result).toBe("not-running");
    expect((await porch.deliver("dead", "hi", { from: "t" })).result).toBe("not-running");
  });

  it("removes an ended session's record 24 hours after it ended, when list reads the records", async () => {
    const { porch, clock } = porchAt();
    await fake.startSession(porch.ctx, "done");
    await fake.endSession(porch.ctx, "done");
    clock.t = T0 + 24 * HOUR - 1;
    await porch.list();
    expect(await porch.ctx.records.read("fake", "done")).not.toBeNull();
    clock.t = T0 + 24 * HOUR;
    // The look that prunes still reports what it read.
    expect((await porch.list(undefined, { all: true })).sessions.map((o) => o.status)).toEqual(["ended"]);
    expect(await porch.ctx.records.read("fake", "done")).toBeNull();
  });

  it("notes when a session is first seen gone and removes its record 24 hours after that, not after its last write", async () => {
    const { porch, clock } = porchAt();
    await fake.startSession(porch.ctx, "dead");
    // Idle for days, then killed: the last write was long ago.
    clock.t = T0 + 72 * HOUR;
    await fake.killSession(porch.ctx, "dead");
    await porch.list();
    expect((await porch.ctx.records.read("fake", "dead"))!.goneSeenAt).toBe(new Date(T0 + 72 * HOUR).toISOString());
    clock.t = T0 + 95 * HOUR;
    await porch.list();
    expect((await porch.ctx.records.read("fake", "dead"))!.goneSeenAt).toBe(new Date(T0 + 72 * HOUR).toISOString());
    clock.t = T0 + 96 * HOUR;
    await porch.list();
    expect(await porch.ctx.records.read("fake", "dead")).toBeNull();
  });

  it("removes an ended record without a readable endedAt (edited by hand) by when its status changed", async () => {
    const { porch, clock } = porchAt();
    await fake.startSession(porch.ctx, "done");
    await fake.endSession(porch.ctx, "done");
    const file = porch.ctx.records.recordPath("fake", "done");
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.inside.endedAt = "not a time";
    writeFileSync(file, JSON.stringify(rec));
    clock.t = T0 + 24 * HOUR;
    await porch.list();
    expect(await porch.ctx.records.read("fake", "done")).toBeNull();
  });

  it("never prunes a session whose status is unknown, or one that is running again", async () => {
    const { porch, clock } = porchAt();
    // unknown: the harness has it, but the record has no inside status.
    await fake.startSession(porch.ctx, "bare", { inside: false });
    await porch.ctx.records.setSelf("fake", "bare", { status: "working", text: null, since: new Date(T0).toISOString() });
    await fake.startSession(porch.ctx, "back");
    await fake.killSession(porch.ctx, "back");
    await porch.list();
    // It comes back (a resume with the same id) before the 24 hours are up.
    clock.t = T0 + HOUR;
    await fake.startSession(porch.ctx, "back");
    clock.t = T0 + 48 * HOUR;
    await porch.list();
    expect(await porch.ctx.records.read("fake", "bare")).not.toBeNull();
    expect((await porch.ctx.records.read("fake", "back"))!.inside!.status).toBe("idle");
  });

  it("watch prunes too", async () => {
    const env = scratchEnv();
    const { porch, clock } = porchAt(env);
    await fake.startSession(porch.ctx, "done");
    await fake.endSession(porch.ctx, "done");
    clock.t = T0 + 25 * HOUR;
    const controller = new AbortController();
    const seen: string[] = [];
    const watching = porch.watch({ all: true, signal: controller.signal, onObservation: (o) => seen.push(`${o.session}:${o.status}`) });
    await waitFor(async () => (await porch.ctx.records.read("fake", "done")) === null);
    controller.abort();
    await watching;
    // Reported as ended by the look that pruned it.
    expect(seen[0]).toBe("done:ended");
  });
});
