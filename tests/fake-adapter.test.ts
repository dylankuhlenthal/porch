import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createFakeAdapter, FAKE_SESSION_ENV } from "../src/adapters/fake/index.js";
import * as fake from "../src/adapters/fake/ops.js";
import { fakeStatePath } from "../src/adapters/fake/state.js";
import { Porch } from "../src/porch.js";
import { scratchEnv } from "./helpers.js";

function setup(extra = {}) {
  const env = scratchEnv(extra);
  const porch = new Porch({ env, adapters: [createFakeAdapter()] });
  const adapter = porch.adapters[0]!;
  return { env, porch, ctx: porch.ctx, adapter };
}

describe("fake adapter: status", () => {
  it("reports the inside part's status and since, with turn times in detail", async () => {
    const { ctx, adapter } = setup();
    await fake.startSession(ctx, "s1", { pid: 7 });
    let obs = await adapter.observe(ctx, "s1");
    expect(obs).toMatchObject({ status: "idle", detail: { pid: 7, hasInsidePart: true } });
    await fake.setInsideStatus(ctx, "s1", "busy");
    await fake.setInsideStatus(ctx, "s1", "idle");
    obs = await adapter.observe(ctx, "s1");
    expect(obs?.status).toBe("idle");
    expect(obs?.detail?.lastTurnStart).toEqual(expect.any(String));
    expect(obs?.detail?.lastTurnEnd).toEqual(expect.any(String));
    expect(obs?.since).toBe(obs?.detail?.lastTurnEnd);
  });

  it("reports waiting-on-prompt from the listing even though the record still says busy", async () => {
    const { ctx, adapter } = setup();
    await fake.startSession(ctx, "s1", { status: "busy" });
    await fake.setPrompt(ctx, "s1", "Allow Bash?");
    expect(await adapter.observe(ctx, "s1")).toMatchObject({ status: "waiting-on-prompt", detail: { prompt: "Allow Bash?" } });
    await fake.setPrompt(ctx, "s1", null);
    expect((await adapter.observe(ctx, "s1"))?.status).toBe("busy");
  });

  it("reports a crashed session whose record was left behind as gone", async () => {
    const { ctx, adapter } = setup();
    await fake.startSession(ctx, "s1");
    await fake.killSession(ctx, "s1");
    expect(await ctx.records.read("fake", "s1")).not.toBeNull();
    expect((await adapter.observe(ctx, "s1"))?.status).toBe("gone");
  });

  it("reports a session that ended cleanly as ended, with the reason given, and a late status change leaves it ended", async () => {
    const { ctx, adapter } = setup();
    await fake.startSession(ctx, "s1");
    await fake.endSession(ctx, "s1", { reason: "quit" });
    expect(await adapter.observe(ctx, "s1")).toMatchObject({ status: "ended", endReason: "quit", attached: true });
    await fake.setInsideStatus(ctx, "s1", "idle");
    expect((await adapter.observe(ctx, "s1"))?.status).toBe("ended");
    expect((await adapter.deliver(ctx, "s1", "hi")).result).toBe("not-running");
  });

  it("reports a record with no listing row at all as gone", async () => {
    const { ctx, adapter } = setup();
    await ctx.records.updateInside("fake", "orphan", { status: "busy" });
    expect((await adapter.observe(ctx, "orphan"))?.status).toBe("gone");
    expect((await adapter.list(ctx)).map((o) => [o.session, o.status])).toEqual([["orphan", "gone"]]);
  });

  it("reports unknown, never a guess, for a session without the inside part", async () => {
    const { ctx, adapter } = setup();
    await fake.startSession(ctx, "bare", { inside: false });
    expect(await adapter.observe(ctx, "bare")).toMatchObject({ status: "unknown", since: null, detail: { hasInsidePart: false } });
  });

  it("returns null for a session it does not know, including invalid ids", async () => {
    const { ctx, adapter } = setup();
    expect(await adapter.observe(ctx, "nope")).toBeNull();
    expect(await adapter.observe(ctx, "../../etc/passwd")).toBeNull();
  });

  it("shows self-reported state side by side with status, not combined", async () => {
    const { ctx, adapter } = setup();
    await fake.startSession(ctx, "s1", { status: "busy" });
    await ctx.records.setSelf("fake", "s1", { status: "done", text: "shipped", since: "2026-01-01T00:00:00.000Z" });
    expect(await adapter.observe(ctx, "s1")).toMatchObject({ status: "busy", self: { status: "done", text: "shipped" } });
  });

  it("reads the state file from PORCH_FAKE_STATE when set", async () => {
    const env = scratchEnv();
    const file = path.join(env.PORCH_HOME!, "elsewhere", "state.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ sessions: { x: { alive: true } } }));
    const porch = new Porch({ env: { ...env, PORCH_FAKE_STATE: file }, adapters: [createFakeAdapter()] });
    expect(fakeStatePath(porch.ctx.env)).toBe(file);
    expect((await porch.list(undefined, { all: true })).sessions.map((s) => s.session)).toEqual(["x"]);
  });

  it("detects the fake harness only when its state file exists", async () => {
    const { ctx, adapter } = setup();
    expect((await adapter.detect(ctx)).available).toBe(false);
    await fake.startSession(ctx, "s1");
    expect(await adapter.detect(ctx)).toEqual({ available: true, version: "fake-1", reason: null });
  });

  it("refuses to change a session that was never started", async () => {
    const { ctx } = setup();
    await expect(fake.killSession(ctx, "ghost")).rejects.toBeInstanceOf(fake.FakeSessionError);
    await expect(fake.setInsideStatus(ctx, "ghost", "busy")).rejects.toBeInstanceOf(fake.FakeSessionError);
    expect(await ctx.records.read("fake", "ghost")).toBeNull();
  });
});

describe("fake adapter: deliver", () => {
  it("delivers with the status at the moment of sending and the recorded address", async () => {
    const { ctx, adapter } = setup();
    await fake.startSession(ctx, "s1", { status: "busy" });
    const r = await adapter.deliver(ctx, "s1", "[from t] hi");
    expect(r).toEqual({
      schema: 2,
      harness: "fake",
      session: "s1",
      result: "delivered",
      statusAtSend: "busy",
      via: "fake",
      guessed: false,
      reason: null,
    });
    expect((await fake.readDeliveries(ctx, "s1")).map((d) => [d.text, d.statusAtSend])).toEqual([["[from t] hi", "busy"]]);
  });

  it("marks the address as guessed for a session without the inside part", async () => {
    const { ctx, adapter } = setup();
    await fake.startSession(ctx, "bare", { inside: false });
    expect(await adapter.deliver(ctx, "bare", "x")).toMatchObject({ result: "delivered", guessed: true, via: "fake-listing", statusAtSend: "unknown" });
  });

  it("reports not-running for a gone session and records nothing", async () => {
    const { ctx, adapter } = setup();
    await fake.startSession(ctx, "s1");
    await fake.killSession(ctx, "s1");
    expect(await adapter.deliver(ctx, "s1", "x")).toMatchObject({ result: "not-running", statusAtSend: null, via: null });
    expect(await fake.readDeliveries(ctx)).toEqual([]);
  });

  it("reports failed with the reason when told to fail", async () => {
    const { ctx, adapter } = setup();
    await fake.startSession(ctx, "s1");
    await fake.setFailDeliver(ctx, "s1", "socket refused");
    expect(await adapter.deliver(ctx, "s1", "x")).toMatchObject({ result: "failed", reason: "socket refused" });
    expect(await fake.readDeliveries(ctx)).toEqual([]);
  });
});

describe("fake adapter: current", () => {
  it(`works out the session from ${FAKE_SESSION_ENV}, and null without it`, async () => {
    const { adapter, ctx } = setup();
    expect(await adapter.current(ctx)).toBeNull();
    const withEnv = setup({ [FAKE_SESSION_ENV]: "s9" });
    expect(await withEnv.adapter.current(withEnv.ctx)).toBe("s9");
  });
});
