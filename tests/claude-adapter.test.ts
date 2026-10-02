import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AdapterContext } from "../src/adapter.js";
import { createClaudeAdapter, isUnder } from "../src/adapters/claude/index.js";
import { claudeHookSettings, handleHookEvent, hookCommand, HOOK_EVENTS, shQuote } from "../src/adapters/claude/hooks.js";
import { findIdleStop, parseRetireLine } from "../src/adapters/claude/daemon-log.js";
import { parseListing } from "../src/adapters/claude/listing.js";
import { jobActivity } from "../src/adapters/claude/observe.js";
import { socketLine } from "../src/adapters/claude/socket.js";
import { DRIVERS, scrubClaudeSnapshot } from "../src/conformance/drivers/index.js";
import { dashedPath, fromPlaceholders, replayFixture, toPlaceholders, type Fixture, type Snapshot } from "../src/conformance/recorder.js";
import type { Env } from "../src/home.js";
import type { HarnessIO, RunResult } from "../src/io.js";
import type { SessionRecord } from "../src/records.js";
import { Porch } from "../src/porch.js";
import { bin, BIN, cli, REPO, scratchEnv, schemaValidators } from "./helpers.js";

const v = schemaValidators();
const SID = "5b0e750e-44ca-46ad-a46a-6408e83922b1";
const SHORT = "5b0e750e";
const OTHER = "06bb8fe1-860d-4965-8fdd-f81d5796767d";

/**
 * A HarnessIO answering `claude agents --json`, job files and the daemon log
 * (`daemon.log`, `daemon.log.1`; an Error is thrown when read) from canned values.
 */
function stubIO(
  rows: unknown[] | RunResult | "missing",
  jobs: Record<string, unknown> = {},
  logs: Record<string, string | Error> = {},
): HarnessIO & { runs: string[][]; reads: string[] } {
  const runs: string[][] = [];
  const reads: string[] = [];
  return {
    runs,
    reads,
    async run(cmd, args) {
      runs.push([cmd, ...args]);
      if (args[0] === "--version") return { code: 0, stdout: "2.1.284 (Claude Code)\n", stderr: "" };
      if (rows === "missing") return { code: null, stdout: "", stderr: "spawn claude ENOENT" };
      if (!Array.isArray(rows)) return rows;
      return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
    },
    async readFile(file) {
      reads.push(file);
      const log = logs[path.basename(file)];
      if (/\/\.claude\/daemon\.log(\.1)?$/.test(file) && log !== undefined) {
        if (log instanceof Error) throw log;
        return log;
      }
      const m = /jobs\/([0-9a-f]+)\/state\.json$/.exec(file);
      if (m && jobs[m[1]!] !== undefined) {
        const j = jobs[m[1]!];
        return typeof j === "string" ? j : JSON.stringify(j);
      }
      return null;
    },
  };
}

function porchWith(io: HarnessIO, env: Env = scratchEnv(), options: Parameters<typeof createClaudeAdapter>[0] = {}) {
  return new Porch({ env: { ...env, PORCH_CLAUDE_BIN: "claude" }, adapters: [createClaudeAdapter(options)], io, now: () => new Date("2026-09-29T16:00:00Z") });
}

function row(fields: Record<string, unknown> = {}) {
  return { id: SHORT, sessionId: SID, name: "porch-exp", kind: "background", cwd: "/work/a", pid: 4242, status: "idle", state: "done", ...fields };
}

async function hook(ctx: AdapterContext, event: string, input: Record<string, unknown>) {
  await handleHookEvent(ctx, event, { session_id: SID, ...input });
}

describe("reading claude agents --json", () => {
  it("keeps rows with a session id and fields of the expected types", () => {
    const rows = parseListing(JSON.stringify([row(), { id: "abc" }, row({ sessionId: OTHER, pid: "12", status: 3 }), "junk"]));
    expect(rows.map((r) => r.sessionId)).toEqual([SID, OTHER]);
    expect(rows[1]).toMatchObject({ pid: null, status: null });
    expect(rows[0]!.raw).toEqual(row());
  });

  it("refuses output that is not a JSON array", () => {
    expect(() => parseListing("nope")).toThrow(/did not print JSON/);
    expect(() => parseListing("{}")).toThrow(/JSON array/);
    expect(parseListing("")).toEqual([]);
  });

  it("reads activity from the job file, and treats odd fields as unknown", () => {
    expect(jobActivity(null)).toBeNull();
    expect(jobActivity({})).toBeNull();
    expect(
      jobActivity({
        detail: "  writing\n tests  ",
        inFlight: { tasks: 2 },
        fan: [
          { kind: "agent", label: "Build it", startedAt: 1790698204535 },
          { kind: "bash", label: "done one", doneAt: 5 },
          { label: "" },
        ],
      }),
    ).toEqual({ detail: "writing tests", inFlight: 2, running: [{ kind: "agent", label: "Build it", since: "2026-09-29T16:10:04.535Z" }] });
    expect(jobActivity({ detail: "x", inFlight: { tasks: -1 } })).toEqual({ detail: "x", inFlight: null, running: [] });
  });
});

describe("Claude Code adapter: status", () => {
  it("takes busy and idle from the hook record, alive and pid from the listing", async () => {
    const env = scratchEnv();
    const porch = porchWith(stubIO([row({ status: "busy" })]), env);
    await hook(porch.ctx, "SessionStart", { source: "startup", cwd: "/work/a" });
    await hook(porch.ctx, "UserPromptSubmit", { prompt: "hi" });
    const obs = await porch.observe(SID);
    v.observation!(obs);
    expect(obs).toMatchObject({ harness: "claude", session: SID, attached: true, status: "busy", since: "2026-09-29T16:00:00.000Z" });
    expect(obs.detail).toMatchObject({ pid: 4242, shortId: SHORT, statusSource: "hooks", hasInsidePart: true, lastTurnStart: "2026-09-29T16:00:00.000Z" });
    expect((await porch.list()).sessions.map((o) => o.session)).toEqual([SID]);
    expect(obs.detail).not.toHaveProperty("recordStatus");
  });

  it("lets the listing's idle win over the record's busy (Stop does not fire on an interrupted turn)", async () => {
    const porch = porchWith(stubIO([row({ status: "idle" })]));
    await hook(porch.ctx, "SessionStart", { source: "startup" });
    await hook(porch.ctx, "UserPromptSubmit", { prompt: "hi" });
    const obs = await porch.observe(SID);
    v.observation!(obs);
    expect(obs).toMatchObject({ status: "idle", since: null });
    expect(obs.detail).toMatchObject({ statusSource: "listing", recordStatus: "busy", hasInsidePart: true, lastTurnStart: "2026-09-29T16:00:00.000Z" });
    expect(obs.detail).not.toHaveProperty("recordPid");
    // list agrees with observe.
    expect((await porch.list()).sessions[0]).toMatchObject({ status: "idle" });
  });

  it("does not trust the listing's busy over the record's idle (the listing's busy can be stale)", async () => {
    const porch = porchWith(stubIO([row({ status: "busy" })]));
    await hook(porch.ctx, "SessionStart", { source: "startup" });
    await hook(porch.ctx, "Stop", { background_tasks: [{ id: 1 }, { id: 2 }] });
    const obs = await porch.observe(SID);
    expect(obs.status).toBe("idle");
    expect(obs.detail).toMatchObject({ statusSource: "hooks", lastTurnEnd: "2026-09-29T16:00:00.000Z", backgroundTasks: 2 });
    expect(obs.detail).not.toHaveProperty("recordStatus");
  });

  it("keeps the record's busy when the listing gives no busy or idle", async () => {
    const porch = porchWith(stubIO([row({ status: "starting?" })]));
    await hook(porch.ctx, "SessionStart", { source: "startup" });
    await hook(porch.ctx, "UserPromptSubmit", {});
    const obs = await porch.observe(SID);
    expect(obs).toMatchObject({ status: "busy", detail: { statusSource: "hooks" } });
    expect(obs.detail).not.toHaveProperty("recordStatus");
  });

  it("does not use the status of a record written by an earlier process of the session", async () => {
    // A resume without the hooks: the record (pid 111) says busy, the listed process (pid 4242) is idle.
    const env = { ...scratchEnv(), CLAUDE_PID: "111" };
    const porch = porchWith(stubIO([row({ status: "idle", pid: 4242 })]), env);
    await hook(porch.ctx, "SessionStart", { source: "startup" });
    await hook(porch.ctx, "UserPromptSubmit", {});
    await porch.ctx.records.setSelf("claude", SID, { status: "working", text: null, since: "2026-09-29T15:00:00.000Z" });
    const obs = await porch.observe(SID);
    v.observation!(obs);
    // The record is from another process, so the listed one is not attached: only list --all shows it.
    expect(obs).toMatchObject({ attached: false, status: "idle", since: null, self: { status: "working" } });
    expect((await porch.list()).sessions).toEqual([]);
    expect((await porch.list(undefined, { all: true })).sessions.map((o) => o.session)).toEqual([SID]);
    expect(obs.detail).toMatchObject({ pid: 4242, recordPid: 111, statusSource: "listing", hasInsidePart: true, lastTurnStart: "2026-09-29T16:00:00.000Z" });
    expect(obs.detail).not.toHaveProperty("recordStatus");
    // Same pid: the record's status is used, and there is no recordPid.
    const same = porchWith(stubIO([row({ status: "busy", pid: 111 })]), env);
    const obs2 = await same.observe(SID);
    expect(obs2).toMatchObject({ attached: true, status: "busy" });
    expect(obs2.detail).toMatchObject({ statusSource: "hooks" });
    expect(obs2.detail).not.toHaveProperty("recordPid");
  });

  it("reports waiting-on-prompt from the listing, with what it waits for", async () => {
    const io = stubIO([row({ status: "waiting", waitingFor: "permission prompt" })], {
      [SHORT]: { sessionId: SID, tempo: "blocked", needs: "approve Bash: touch x" },
    });
    const porch = porchWith(io);
    await hook(porch.ctx, "SessionStart", { source: "startup" });
    await hook(porch.ctx, "UserPromptSubmit", {});
    const obs = await porch.observe(SID);
    expect(obs.status).toBe("waiting-on-prompt");
    expect(obs.since).toBeNull();
    expect(obs.detail).toMatchObject({ prompt: "permission prompt", promptNeeds: "approve Bash: touch x", statusSource: null });
  });

  it("shows a session whose process is gone as gone, even with a fresh record, and reads no job file for it", async () => {
    const io = stubIO([row({ pid: undefined, status: undefined })], { [SHORT]: { sessionId: SID, detail: "x" } });
    const porch = porchWith(io);
    await hook(porch.ctx, "SessionStart", { source: "startup" });
    await hook(porch.ctx, "UserPromptSubmit", {});
    const obs = await porch.observe(SID);
    expect(obs.status).toBe("gone");
    expect(obs.detail).toMatchObject({ pid: null, activity: null });
    expect(obs.raw).toMatchObject({ job: null });
  });

  it("shows a record whose session is not in the listing at all as gone, only with list --all", async () => {
    const porch = porchWith(stubIO([]));
    await hook(porch.ctx, "SessionStart", { source: "startup" });
    // Still attached (the hooks wrote its record), but not running: hidden by default.
    expect((await porch.list()).sessions).toEqual([]);
    const all = await porch.list(undefined, { all: true });
    expect(all.sessions.map((o) => [o.session, o.attached, o.status, o.endReason])).toEqual([[SID, true, "gone", null]]);
    expect(await porch.observe(SID)).toMatchObject({ status: "gone" });
  });

  it("shows a session whose SessionEnd hook ran as ended, with the hook's reason and when", async () => {
    const porch = porchWith(stubIO([]));
    await hook({ ...porch.ctx, env: { ...porch.ctx.env, CLAUDE_JOB_DIR: `/h/.claude/jobs/${SHORT}` } }, "SessionStart", { source: "startup" });
    await hook(porch.ctx, "SessionEnd", { reason: "prompt_input_exit" });
    const obs = await porch.observe(SID);
    v.observation!(obs);
    expect(obs).toMatchObject({ attached: true, status: "ended", since: "2026-09-29T16:00:00.000Z", endReason: "prompt_input_exit" });
    expect(obs.detail).toMatchObject({ pid: null, statusSource: "hooks", shortId: SHORT });
    // The short id still finds it, from the record.
    expect((await porch.observe(SHORT)).status).toBe("ended");
    expect((await porch.list()).sessions).toEqual([]);
    expect((await porch.list(undefined, { all: true })).sessions.map((o) => o.status)).toEqual(["ended"]);
    expect(await porch.deliver(SID, "hi", { from: "x" })).toMatchObject({ result: "not-running", reason: "the session has ended" });
  });

  it("shows ended while the ended session's process is still listed (SessionEnd runs before it exits)", async () => {
    const porch = porchWith(stubIO([row({ pid: 36322, status: "busy" })]));
    await hook({ ...porch.ctx, env: { ...porch.ctx.env, CLAUDE_PID: "36322" } }, "SessionStart", { source: "startup" });
    await hook(porch.ctx, "SessionEnd", { reason: "other" });
    const obs = await porch.observe(SID);
    expect(obs).toMatchObject({ status: "ended", endReason: "other" });
    expect(obs.detail).toMatchObject({ pid: null, activity: null });
    expect((await porch.deliver(SID, "hi", { from: "x" })).result).toBe("not-running");
  });

  it("lets a running listing row win over an ended record whose pid is not known", async () => {
    const porch = porchWith(stubIO([row({ pid: 5555, status: "busy" })]));
    await hook({ ...porch.ctx, env: { ...porch.ctx.env, CLAUDE_PID: undefined, CLAUDE_CODE_MESSAGING_SOCKET: undefined } }, "SessionStart", { source: "startup" });
    await hook(porch.ctx, "SessionEnd", { reason: "other" });
    expect((await porch.ctx.records.read("claude", SID))!.inside!.pid).toBeNull();
    expect(await porch.observe(SID)).toMatchObject({ attached: false, status: "busy", endReason: null });
    // Not listed any more: the ended record answers.
    const gone = porchWith(stubIO([]), porch.ctx.env);
    expect(await gone.observe(SID)).toMatchObject({ status: "ended", endReason: "other" });
  });

  it("does not use an ended record once a later process of the session is listed (a resume without the hooks)", async () => {
    const porch = porchWith(stubIO([row({ pid: 5555, status: "busy" })]));
    await hook({ ...porch.ctx, env: { ...porch.ctx.env, CLAUDE_PID: "36322" } }, "SessionStart", { source: "startup" });
    await hook(porch.ctx, "SessionEnd", { reason: "other" });
    const obs = await porch.observe(SID);
    expect(obs).toMatchObject({ attached: false, status: "busy", endReason: null });
    expect(obs.detail).toMatchObject({ recordPid: 36322, statusSource: "listing" });
  });

  it("gives a session without Porch's hooks the listing's own busy or idle, marked as such, shown only by list --all", async () => {
    const porch = porchWith(stubIO([row({ status: "busy" }), row({ id: "06bb8fe1", sessionId: OTHER, status: "starting?" })]));
    const [a, b] = (await porch.list(undefined, { all: true })).sessions;
    expect(a).toMatchObject({ session: OTHER, attached: false, status: "unknown" });
    expect(b).toMatchObject({ session: SID, attached: false, status: "busy", since: null });
    expect(b!.detail).toMatchObject({ hasInsidePart: false, statusSource: "listing" });
    expect((await porch.list()).sessions).toEqual([]);
    // Named explicitly, an unattached session is still observed.
    expect(await porch.observe(SID)).toMatchObject({ session: SID, attached: false, status: "busy" });
  });

  it("a record holding only a self part (porch status set) does not make a session attached", async () => {
    const porch = porchWith(stubIO([row({ status: "idle" })]));
    await porch.ctx.records.setSelf("claude", SID, { status: "working", text: null, since: "2026-09-29T15:00:00.000Z" });
    expect(await porch.observe(SID)).toMatchObject({ attached: false, status: "idle", self: { status: "working" } });
    expect((await porch.list()).sessions).toEqual([]);
  });

  it("finds a session by its short id and reports it under the full id", async () => {
    const porch = porchWith(stubIO([row()]));
    expect((await porch.observe(SHORT)).session).toBe(SID);
  });

  it("porch watch --session takes a short id too, and reports the session under its full id", async () => {
    const porch = porchWith(stubIO([row(), row({ id: "06bb8fe1", sessionId: OTHER })]), scratchEnv(), { pollIntervalMs: 20 });
    const seen: string[] = [];
    const controller = new AbortController();
    const done = porch.watch({ session: SHORT, signal: controller.signal, onObservation: (o) => seen.push(o.session), backstopPollMs: 60_000 });
    for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 60));
    controller.abort();
    await done;
    expect(seen).toEqual([SID]);
  });

  it("porch watch --session runs one claude agents --json per look, even while the id is not found", async () => {
    const io = stubIO([row({ id: "06bb8fe1", sessionId: OTHER })]);
    const adapter = createClaudeAdapter({ pollIntervalMs: 20 });
    let looks = 0;
    const counted = { ...adapter, list: (ctx: AdapterContext) => (looks++, adapter.list(ctx)) };
    const porch = new Porch({ env: { ...scratchEnv(), PORCH_CLAUDE_BIN: "claude" }, adapters: [counted], io });
    const controller = new AbortController();
    const done = porch.watch({ session: SHORT, signal: controller.signal, onObservation: () => undefined, backstopPollMs: 60_000 });
    for (let i = 0; i < 100 && looks < 4; i++) await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await done;
    expect(looks).toBeGreaterThanOrEqual(4);
    expect(io.runs.filter((r) => r[1] === "agents").length).toBe(looks);
  });

  it("finds a killed session by its short id through its record once the listing has dropped it", async () => {
    // Observed with 2.1.284: a few seconds after a kill, the row leaves `claude agents --json` (only --all keeps it).
    const porch = porchWith(stubIO([]), { ...scratchEnv(), CLAUDE_JOB_DIR: `/h/.claude/jobs/${SHORT}` });
    await hook(porch.ctx, "SessionStart", { source: "startup" });
    const obs = await porch.observe(SHORT);
    expect(obs).toMatchObject({ session: SID, status: "gone" });
    const r = await porch.deliver(SHORT, "hi", { from: "t" });
    expect(r).toMatchObject({ harness: "claude", session: SID, result: "not-running" });
  });

  it("puts the listing row, job file and record in raw, and activity in detail", async () => {
    const job = { sessionId: SID, detail: "doing it", inFlight: { tasks: 0 } };
    const porch = porchWith(stubIO([row()], { [SHORT]: job }));
    const obs = await porch.observe(SID);
    expect(obs.raw).toEqual({ listing: row(), job, record: null });
    expect(obs.detail).toMatchObject({ activity: { detail: "doing it", inFlight: 0, running: [] }, name: "porch-exp", cwd: "/work/a" });
  });

  it("ignores a job file that names another session, and one that is not JSON", async () => {
    let porch = porchWith(stubIO([row()], { [SHORT]: { sessionId: OTHER, detail: "not mine" } }));
    expect((await porch.observe(SID)).raw).toMatchObject({ job: null });
    porch = porchWith(stubIO([row()], { [SHORT]: "{not json" }));
    expect((await porch.observe(SID)).detail).toMatchObject({ activity: null });
  });

  it("returns null for an unknown or invalid id, without failing", async () => {
    const adapter = createClaudeAdapter();
    const porch = porchWith(stubIO([row()]));
    expect(await adapter.observe(porch.ctx, "nobody")).toBeNull();
    expect(await adapter.observe(porch.ctx, "../../etc")).toBeNull();
  });

  it("sees no sessions when Claude Code is not installed, and says so in adapters", async () => {
    const env = scratchEnv();
    const porch = porchWith(stubIO("missing"), env);
    expect((await porch.list()).sessions).toEqual([]);
    const r = await cli(["adapters"], env);
    v.adapters!(r.json);
    expect(r.json.adapters.find((a: { harness: string }) => a.harness === "claude")).toMatchObject({ available: false, version: null });
  });

  it("reports a failing claude agents in list errors instead of guessing", async () => {
    const porch = porchWith(stubIO({ code: 1, stdout: "", stderr: "boom\n" }));
    const list = await porch.list();
    expect(list.errors).toEqual([{ harness: "claude", message: "`claude agents --json` failed (exit 1): boom" }]);
  });

  it("detects the installed version", async () => {
    const porch = porchWith(stubIO([]));
    expect(await porch.adapters[0]!.detect(porch.ctx)).toEqual({ available: true, version: "2.1.284", reason: null });
  });

  it("can be limited to sessions under one folder (for conformance runs)", async () => {
    const io = stubIO([row({ cwd: "/work/a/b" }), row({ id: "06bb8fe1", sessionId: OTHER, cwd: "/work/ab" })]);
    const porch = porchWith(io, scratchEnv(), { onlyUnder: () => "/work/a" });
    expect((await porch.list(undefined, { all: true })).sessions.map((o) => o.session)).toEqual([SID]);
    expect(isUnder("/work/a", "/work/a")).toBe(true);
    expect(isUnder("/work/ab", "/work/a")).toBe(false);
    expect(isUnder(null, "/work/a")).toBe(false);
  });

  it("uses CLAUDE_CODE_SESSION_ID for current", async () => {
    const adapter = createClaudeAdapter();
    const porch = porchWith(stubIO([]));
    expect(await adapter.current({ ...porch.ctx, env: { CLAUDE_CODE_SESSION_ID: SID } })).toBe(SID);
    expect(await adapter.current({ ...porch.ctx, env: {} })).toBeNull();
  });
});

describe("Claude Code's daemon log: the idle stop line", () => {
  const AFTER = "2026-09-30T13:00:00.000Z";

  it("reads every form of the retire line Claude Code writes", () => {
    // Real lines from daemon.log (2.1.285), then forms read from 2.1.286's code.
    expect(parseRetireLine("[2026-09-30T14:58:56.171Z] [bg] bg retire 3e95c991: settled, idle 61m")).toEqual({
      short: "3e95c991",
      at: "2026-09-30T14:58:56.171Z",
      cause: "settled",
      idleMinutes: 61,
      lowMemory: null,
      line: "[2026-09-30T14:58:56.171Z] [bg] bg retire 3e95c991: settled, idle 61m",
    });
    expect(parseRetireLine("[2026-09-30T15:02:56.175Z] [bg] bg retire d8d23018: idle-prompt, idle 61m")).toMatchObject({ cause: "idle-prompt", idleMinutes: 61 });
    expect(parseRetireLine("[2026-09-12T09:01:00.000Z] [bg] bg retire 0900bcd2: idle-prompt, idle 64m, worker 2.1.278 (daemon 2.1.280)")).toMatchObject({
      cause: "idle-prompt",
      idleMinutes: 64,
      lowMemory: null,
    });
    expect(parseRetireLine("[2026-09-30T15:00:00.000Z] [bg] bg retire abcd1234: settled, idle 1m [low memory]")).toMatchObject({ idleMinutes: 1, lowMemory: "low memory" });
    expect(parseRetireLine("[2026-09-30T15:00:00.000Z] [bg] bg retire abcd1234: settled, idle 3m, worker 2.1.285 (daemon 2.1.286) [low memory, pinned]")).toMatchObject({
      lowMemory: "low memory, pinned",
    });
    expect(parseRetireLine("[2026-09-30T15:00:00.000Z] [bg] bg retire abcd1234: abandoned-stale, idle 2h [low memory, monitoring only]")).toMatchObject({
      cause: "abandoned-stale",
      idleMinutes: 120,
      lowMemory: "low memory, monitoring only",
    });
    expect(parseRetireLine("[2026-09-30T15:00:00.000Z] [bg] bg retire abcd1234: empty-idle, idle 5h")).toMatchObject({ cause: "empty-idle", idleMinutes: 300 });
  });

  it("does not read a kill, a claude stop, another format or garbage as an idle stop", () => {
    for (const line of [
      "[2026-09-30T13:59:11.152Z] [bg] bg settled 2c9aceec (killed)",
      "[2026-09-30T13:59:20.540Z] [bg] bg settled 9269d5b2 (done)",
      "[2026-09-30T13:59:20.540Z] [bg] bg retire 9269d5b2: settled, idle 61 minutes",
      "[2026-09-30T13:59:20.540Z] [supervisor] bg retire 9269d5b2: settled, idle 61m",
      "bg retire 9269d5b2: settled, idle 61m",
      "[not a time] [bg] bg retire 9269d5b2: settled, idle 61m",
      "[2026-09-30T13:59:20.540Z] [bg] bg retire 9269d5b2: settled, idle 61m and more",
      "",
      "\u0000\u0001 garbage",
    ]) {
      expect(parseRetireLine(line), line).toBeNull();
    }
  });

  it("finds the session's own line dated after the bound, in daemon.log.1 or daemon.log", () => {
    const older = [
      "[2026-09-29T10:00:00.000Z] [bg] bg retire 3e95c991: settled, idle 60m",
      "[2026-09-30T14:10:00.000Z] [bg] bg retire 3e95c99: settled, idle 60m",
      "[2026-09-30T14:20:00.000Z] [bg] bg retire 3e95c9910: settled, idle 60m",
    ].join("\n");
    const current = [
      "[2026-09-30T13:59:11.152Z] [bg] bg settled 3e95c991 (killed)",
      "[2026-09-30T14:58:56.171Z] [bg] bg retire 3e95c991: settled, idle 61m\r",
      "[2026-09-30T14:58:56.258Z] [bg] bg settled 3e95c991 (done)",
      "[2026-09-30T15:02:56.175Z] [bg] bg retire d8d23018: idle-prompt, idle 61m",
      "",
    ].join("\n");
    expect(findIdleStop([older, current], "3e95c991", AFTER)).toMatchObject({ at: "2026-09-30T14:58:56.171Z", cause: "settled" });
    // Only lines dated after the bound count: an earlier stop of a session resumed since.
    expect(findIdleStop([older, current], "3e95c991", "2026-09-30T14:58:56.171Z")).toBeNull();
    expect(findIdleStop([older], "3e95c991", AFTER)).toBeNull();
    expect(findIdleStop([older], "3e95c991", "2026-09-29T09:00:00.000Z")).toMatchObject({ at: "2026-09-29T10:00:00.000Z" });
    // Another session's line, a short id that only starts the same, and a bad bound.
    expect(findIdleStop([current], "d8d2301", AFTER)).toBeNull();
    expect(findIdleStop([older, current], "3e95c99", "2026-09-30T14:00:00.000Z")).toMatchObject({ at: "2026-09-30T14:10:00.000Z" });
    expect(findIdleStop([current], "3e95c991", "not a time")).toBeNull();
    expect(findIdleStop([], "3e95c991", AFTER)).toBeNull();
  });
});

describe("Claude Code adapter: a session Claude Code stopped for being idle", () => {
  // The record's startedAt and lastTurnEnd are the porch clock, 2026-09-29T16:00:00Z.
  const RETIRE = `[2026-09-29T17:01:00.000Z] [bg] bg retire ${SHORT}: idle-prompt, idle 61m`;
  const SETTLED = `[2026-09-29T17:01:00.090Z] [bg] bg settled ${SHORT} (done)`;
  const withJobDir = (ctx: AdapterContext) => ({ ...ctx, env: { ...ctx.env, CLAUDE_JOB_DIR: `/h/.claude/jobs/${SHORT}` } });
  const logReads = (io: { reads: string[] }) => io.reads.filter((f) => /daemon\.log/.test(f));

  async function started(porch: Porch) {
    await hook(withJobDir(porch.ctx), "SessionStart", { source: "startup" });
    await hook(porch.ctx, "UserPromptSubmit", {});
    await hook(porch.ctx, "Stop", {});
  }

  it("shows it as ended with reason idle, the stop's time and Claude Code's cause, and marks the record", async () => {
    const env = scratchEnv();
    const io = stubIO([row({ pid: null, status: null })], {}, { "daemon.log": `${RETIRE}\n${SETTLED}\n` });
    const porch = porchWith(io, env);
    await started(porch);
    const obs = await porch.observe(SID);
    v.observation!(obs);
    expect(obs).toMatchObject({ attached: true, status: "ended", since: "2026-09-29T17:01:00.000Z", endReason: "idle" });
    expect(obs.detail).toMatchObject({ pid: null, statusSource: "hooks", idleStop: { cause: "idle-prompt", idleMinutes: 61, lowMemory: null } });
    const rec = await porch.ctx.records.read("claude", SID);
    v.record!(rec);
    expect(rec!.inside).toMatchObject({
      status: "ended",
      since: "2026-09-29T17:01:00.000Z",
      endedAt: "2026-09-29T17:01:00.000Z",
      endReason: "idle",
      data: { shortId: SHORT, idleStop: { cause: "idle-prompt", idleMinutes: 61, lowMemory: null, line: RETIRE } },
    });
    // Not running: deliver says it ended, the default list leaves it out, list --all shows it.
    expect(await porch.deliver(SID, "hi", { from: "x" })).toMatchObject({ result: "not-running", reason: "the session has ended" });
    expect((await porch.list()).sessions).toEqual([]);
    expect((await porch.list(undefined, { all: true })).sessions.map((o) => [o.status, o.endReason])).toEqual([["ended", "idle"]]);
    // Once marked, the answer no longer depends on the log: rotated away, it stays ended, and the log is not read.
    const later = stubIO([], {}, {});
    const again = await porchWith(later, env).observe(SHORT);
    expect(again).toMatchObject({ status: "ended", endReason: "idle", since: "2026-09-29T17:01:00.000Z" });
    expect(again.detail).toMatchObject({ idleStop: { cause: "idle-prompt" } });
    expect(logReads(later)).toEqual([]);
  });

  it("deliver is the first look that finds it: it marks the record and says the session has ended", async () => {
    const env = scratchEnv();
    const porch = porchWith(stubIO([], {}, { "daemon.log.1": `${RETIRE}\n` }), env);
    await started(porch);
    expect(await porch.deliver(SHORT, "hi", { from: "x" })).toMatchObject({ result: "not-running", session: SID, reason: "the session has ended" });
    expect((await porch.ctx.records.read("claude", SID))!.inside).toMatchObject({ status: "ended", endReason: "idle" });
  });

  it("keeps a killed session gone: the log has no retire line for it", async () => {
    const io = stubIO([row({ pid: null, status: null })], {}, { "daemon.log": `${SETTLED}\n[2026-09-29T17:02:00.000Z] [bg] bg retire 0badbeef: settled, idle 61m\n` });
    const porch = porchWith(io);
    await started(porch);
    const before = await porch.ctx.records.read("claude", SID);
    const obs = await porch.observe(SID);
    expect(obs).toMatchObject({ status: "gone", endReason: null });
    expect(obs.detail).not.toHaveProperty("idleStop");
    expect(await porch.ctx.records.read("claude", SID)).toEqual(before);
    expect(logReads(io).map((f) => path.basename(f))).toEqual(["daemon.log.1", "daemon.log"]);
  });

  it("keeps gone a session stopped for idling earlier, resumed since, then killed", async () => {
    const env = scratchEnv();
    const porch = porchWith(stubIO([]), env);
    await started(porch);
    // The retire line is older than the resume's SessionStart (startedAt 18:00).
    const resumed = new Porch({ env: { ...env, PORCH_CLAUDE_BIN: "claude" }, adapters: porch.adapters, io: stubIO([]), now: () => new Date("2026-09-29T18:00:00Z") });
    await hook(withJobDir(resumed.ctx), "SessionStart", { source: "resume" });
    expect(await porchWith(stubIO([], {}, { "daemon.log": `${RETIRE}\n` }), env).observe(SID)).toMatchObject({ status: "gone" });
  });

  it("keeps gone a session whose retire line is older than its last turn's end", async () => {
    const env = scratchEnv();
    const porch = porchWith(stubIO([]), env);
    await hook(withJobDir(porch.ctx), "SessionStart", { source: "startup" });
    const afterTurn = new Porch({ env: { ...env, PORCH_CLAUDE_BIN: "claude" }, adapters: porch.adapters, io: stubIO([]), now: () => new Date("2026-09-29T17:30:00Z") });
    await hook(afterTurn.ctx, "Stop", {});
    expect(await porchWith(stubIO([], {}, { "daemon.log": `${RETIRE}\n` }), env).observe(SID)).toMatchObject({ status: "gone" });
  });

  it("keeps it gone when the log cannot be read, and marks it on a later look that can read it", async () => {
    const env = scratchEnv();
    const porch = porchWith(stubIO([], {}, { "daemon.log": new Error("EACCES: permission denied") }), env);
    await started(porch);
    expect(await porch.observe(SID)).toMatchObject({ status: "gone" });
    expect((await porch.ctx.records.read("claude", SID))!.inside!.status).toBe("idle");
    expect(await porchWith(stubIO([], {}, { "daemon.log": `${RETIRE}\n` }), env).observe(SID)).toMatchObject({ status: "ended", endReason: "idle" });
  });

  it("never reads the log for a running session or an interactive one (no short id)", async () => {
    const running = stubIO([row()], {}, { "daemon.log": `${RETIRE}\n` });
    const porch = porchWith(running);
    await started(porch);
    expect(await porch.observe(SID)).toMatchObject({ status: "idle" });
    expect(logReads(running)).toEqual([]);
    const interactive = stubIO([], {}, { "daemon.log": `${RETIRE}\n` });
    const p2 = porchWith(interactive);
    await hook(p2.ctx, "SessionStart", { source: "startup" });
    expect((await p2.ctx.records.read("claude", SID))!.inside!.data!.shortId).toBeNull();
    expect(await p2.observe(SID)).toMatchObject({ status: "gone" });
    expect((await p2.list(undefined, { all: true })).sessions.map((o) => o.status)).toEqual(["gone"]);
    expect(logReads(interactive)).toEqual([]);
  });

  it("list reads the log once, however many sessions it looks up", async () => {
    const env = scratchEnv();
    const second = "0badbeef-0000-4000-8000-000000000000";
    const io = stubIO([], {}, { "daemon.log": `${RETIRE}\n[2026-09-29T17:05:00.000Z] [bg] bg retire 0badbeef: settled, idle 62m\n` });
    const porch = porchWith(io, env);
    await started(porch);
    await handleHookEvent({ ...porch.ctx, env: { ...porch.ctx.env, CLAUDE_JOB_DIR: "/h/.claude/jobs/0badbeef" } }, "SessionStart", { session_id: second, source: "startup" });
    const all = (await porch.list(undefined, { all: true })).sessions;
    expect(all.map((o) => [o.session, o.status, o.since, o.detail?.idleStop])).toEqual([
      [second, "ended", "2026-09-29T17:05:00.000Z", { cause: "settled", idleMinutes: 62, lowMemory: null }],
      [SID, "ended", "2026-09-29T17:01:00.000Z", { cause: "idle-prompt", idleMinutes: 61, lowMemory: null }],
    ]);
    expect(logReads(io)).toHaveLength(2);
  });

  it("a resume's SessionStart makes it a running session again and drops how it was stopped", async () => {
    const env = scratchEnv();
    const porch = porchWith(stubIO([], {}, { "daemon.log": `${RETIRE}\n` }), env);
    await started(porch);
    expect((await porch.observe(SID)).status).toBe("ended");
    await hook(withJobDir(porch.ctx), "SessionStart", { source: "resume" });
    const rec = await porch.ctx.records.read("claude", SID);
    expect(rec!.inside!.status).toBe("idle");
    expect(rec!.inside).not.toHaveProperty("endReason");
    expect(rec!.inside!.data).not.toHaveProperty("idleStop");
    const obs = await porchWith(stubIO([row()]), env).observe(SID);
    expect(obs).toMatchObject({ status: "idle", endReason: null });
    expect(obs.detail).not.toHaveProperty("idleStop");
  });
});

describe("Claude Code adapter: deliver", () => {
  const servers: net.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  /** A socket that collects what is written to it, like a session's messaging socket. */
  async function listen(file: string): Promise<string[]> {
    const got: string[] = [];
    const server = net.createServer((c) => {
      let buf = "";
      c.on("data", (d) => (buf += d));
      c.on("end", () => got.push(buf));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(file, r));
    return got;
  }

  function sockDir(): string {
    // Unix socket paths are short (about 104 bytes), so not under the scratch HOME.
    return mkdtempSync(path.join(os.tmpdir(), "pcs-"));
  }

  const waitFor = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it("writes one JSON line to the recorded socket and reports the status at sending", async () => {
    const dir = sockDir();
    const got = await listen(path.join(dir, "4242.sock"));
    const env = { ...scratchEnv(), CLAUDE_CODE_MESSAGING_SOCKET: path.join(dir, "4242.sock"), CLAUDE_PID: "4242" };
    const porch = porchWith(stubIO([row()]), env);
    await hook({ ...porch.ctx, env }, "SessionStart", { source: "startup" });
    const r = await porch.deliver(SHORT, 'hello "there"\nline two', { from: "reviewer" });
    v.deliver!(r);
    expect(r).toMatchObject({ result: "delivered", session: SID, statusAtSend: "idle", via: "socket", guessed: false, reason: null });
    await waitFor(() => got.length === 1);
    expect(got).toEqual([socketLine('[from reviewer] hello "there"\nline two')]);
    expect(JSON.parse(got[0]!)).toEqual({ type: "user", message: { role: "user", content: '[from reviewer] hello "there"\nline two' } });
  });

  it("reports idle at sending when the listing says idle and the record still says busy", async () => {
    const dir = sockDir();
    await listen(path.join(dir, "4242.sock"));
    const env = { ...scratchEnv(), CLAUDE_CODE_MESSAGING_SOCKET: path.join(dir, "4242.sock"), CLAUDE_PID: "4242" };
    const porch = porchWith(stubIO([row({ status: "idle" })]), env);
    await hook({ ...porch.ctx, env }, "SessionStart", { source: "startup" });
    await hook({ ...porch.ctx, env }, "UserPromptSubmit", {});
    const r = await porch.deliver(SID, "hi", { from: "x" });
    expect(r).toMatchObject({ result: "delivered", statusAtSend: "idle", guessed: false });
  });

  it("guesses the pid-based socket for a session without the hooks, and says it guessed", async () => {
    const [first, second] = [sockDir(), sockDir()];
    const got = await listen(path.join(second, "4242.sock"));
    const porch = porchWith(stubIO([row({ status: "busy" })]), scratchEnv(), { socketDirs: [first, second] });
    const r = await porch.deliver(SID, "hi", { from: "x" });
    expect(r).toMatchObject({ result: "delivered", statusAtSend: "busy", guessed: true });
    await waitFor(() => got.length === 1);
    expect(got.length).toBe(1);
  });

  it("does not use a recorded socket from an earlier process of the session", async () => {
    const dir = sockDir();
    const got = await listen(path.join(dir, "4242.sock"));
    const env = { ...scratchEnv(), CLAUDE_CODE_MESSAGING_SOCKET: "/nonexistent/111.sock", CLAUDE_PID: "111" };
    const porch = porchWith(stubIO([row()]), env, { socketDirs: [dir] });
    await hook({ ...porch.ctx, env }, "SessionStart", { source: "startup" });
    expect(await porch.deliver(SID, "hi", { from: "x" })).toMatchObject({ result: "delivered", guessed: true });
    await waitFor(() => got.length === 1);
    expect(got.length).toBe(1);
  });

  it("falls back to the pid-based socket, marked guessed, when the recorded socket file has gone", async () => {
    const dir = sockDir();
    const got = await listen(path.join(dir, "4242.sock"));
    const env = { ...scratchEnv(), CLAUDE_CODE_MESSAGING_SOCKET: path.join(sockDir(), "4242.sock"), CLAUDE_PID: "4242" };
    const porch = porchWith(stubIO([row()]), env, { socketDirs: [dir] });
    await hook({ ...porch.ctx, env }, "SessionStart", { source: "startup" });
    const r = await porch.deliver(SID, "hi", { from: "x" });
    expect(r).toMatchObject({ result: "delivered", guessed: true });
    await waitFor(() => got.length === 1);
    expect(got.length).toBe(1);
  });

  it("says failed, with the reason, when nothing listens on the socket", async () => {
    const porch = porchWith(stubIO([row()]), scratchEnv(), { socketDirs: [sockDir()] });
    const r = await porch.deliver(SID, "hi", { from: "x" });
    expect(r).toMatchObject({ result: "failed", via: "socket", guessed: true });
    expect(r.reason).toMatch(/nothing is listening/);
  });

  it("refuses a guessed socket owned by another user, and never reports it delivered", async () => {
    const dir = sockDir();
    const got = await listen(path.join(dir, "4242.sock"));
    // Another user's socket, simulated through the check's inputs: the listening socket is ours, the uid it must match is not.
    const uid = (process.getuid?.() ?? 0) + 1;
    const porch = porchWith(stubIO([row()]), scratchEnv(), { socketDirs: [dir], socketCheck: { uid } });
    const r = await porch.deliver(SID, "hi", { from: "x" });
    expect(r).toMatchObject({ result: "failed", via: "socket", guessed: true });
    expect(r.reason).toMatch(/belongs to another user/);
    await new Promise((res) => setTimeout(res, 50));
    expect(got).toEqual([]);
  });

  it("refuses a guessed path that is a symlink or a regular file, and tries the next one", async () => {
    const [first, second, target] = [sockDir(), sockDir(), sockDir()];
    // A symlink to a real listening socket we own must still be refused: someone else could have placed it.
    const linkedTo = await listen(path.join(target, "real.sock"));
    symlinkSync(path.join(target, "real.sock"), path.join(first, "4242.sock"));
    writeFileSync(path.join(second, "4242.sock"), "not a socket");
    const porch = porchWith(stubIO([row()]), scratchEnv(), { socketDirs: [first, second] });
    const r = await porch.deliver(SID, "hi", { from: "x" });
    expect(r).toMatchObject({ result: "failed", guessed: true });
    expect(r.reason).toMatch(/symlink, not a socket.*; .*is not a socket/);
    await new Promise((res) => setTimeout(res, 50));
    expect(linkedTo).toEqual([]);
  });

  it("checks the owner of the recorded socket too", async () => {
    const dir = sockDir();
    const got = await listen(path.join(dir, "4242.sock"));
    const env = { ...scratchEnv(), CLAUDE_CODE_MESSAGING_SOCKET: path.join(dir, "4242.sock"), CLAUDE_PID: "4242" };
    const lstat = async () => ({ uid: 1, isSocket: () => true, isSymbolicLink: () => false });
    const porch = porchWith(stubIO([row()]), env, { socketDirs: [], socketCheck: { lstat, uid: 2 } });
    await hook({ ...porch.ctx, env }, "SessionStart", { source: "startup" });
    const r = await porch.deliver(SID, "hi", { from: "x" });
    expect(r).toMatchObject({ result: "failed", guessed: false });
    expect(r.reason).toMatch(/belongs to another user \(uid 1\)/);
    await new Promise((res) => setTimeout(res, 50));
    expect(got).toEqual([]);
  });

  it("says not-running for a session whose process is gone, and for one Claude Code does not know", async () => {
    const porch = porchWith(stubIO([row({ pid: undefined })]));
    expect(await porch.deliver(SID, "hi", { from: "x" })).toMatchObject({ result: "not-running", harness: "claude" });
    const adapter = porch.adapters[0]!;
    expect(await adapter.deliver(porch.ctx, "nobody-here", "hi")).toMatchObject({ result: "not-running" });
  });
});

describe("Claude Code hooks (the inside part)", () => {
  function hookEnv(extra: Env = {}): Env {
    return { ...scratchEnv(), CLAUDE_PID: "36322", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/36322.sock", CLAUDE_JOB_DIR: `/h/.claude/jobs/${SHORT}`, ...extra };
  }
  const readRecord = (env: Env) => new Porch({ env }).ctx.records.read("claude", SID);

  it("SessionStart records the socket, pid, cwd and transcript, and idle", async () => {
    const env = hookEnv();
    const r = await cli(["hooks", "claude", "on", "SessionStart"], env, {
      stdin: JSON.stringify({ session_id: SID, source: "startup", cwd: "/work/a", transcript_path: "/h/t.jsonl" }),
    });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, "", ""]);
    const rec = await readRecord(env);
    v.record!(rec);
    expect(rec!.inside).toMatchObject({
      pid: 36322,
      status: "idle",
      delivery: { via: "socket", address: "/tmp/cc-socks/36322.sock" },
      cwd: "/work/a",
      data: { source: "startup", transcriptPath: "/h/t.jsonl", shortId: SHORT },
    });
  });

  it("takes the pid from the socket name when CLAUDE_PID is not set", async () => {
    const env = hookEnv({ CLAUDE_PID: undefined });
    await cli(["hooks", "claude", "on", "SessionStart"], env, { stdin: JSON.stringify({ session_id: SID, source: "startup" }) });
    expect((await readRecord(env))!.inside!.pid).toBe(36322);
  });

  it("records turn start, turn end with background tasks, a failed turn, and a permission request", async () => {
    const env = hookEnv();
    let t = Date.parse("2026-09-29T16:00:00Z");
    const now = () => new Date(t);
    const run = (event: string, input: Record<string, unknown> = {}) => {
      t += 1000; // one second per hook
      return cli(["hooks", "claude", "on", event], env, { stdin: JSON.stringify({ session_id: SID, ...input }), now });
    };
    await run("SessionStart", { source: "startup" });
    await run("UserPromptSubmit", { prompt: "x" });
    let inside = (await readRecord(env))!.inside!;
    expect(inside).toMatchObject({ status: "busy", lastTurnStart: "2026-09-29T16:00:02.000Z", since: "2026-09-29T16:00:02.000Z" });
    await run("UserPromptSubmit", { prompt: "a message delivered mid-turn" });
    inside = (await readRecord(env))!.inside!;
    expect(inside).toMatchObject({ status: "busy", since: "2026-09-29T16:00:02.000Z", lastTurnStart: "2026-09-29T16:00:03.000Z" });
    await run("Stop", { background_tasks: [{}] });
    inside = (await readRecord(env))!.inside!;
    expect(inside).toMatchObject({ status: "idle", lastTurnEnd: "2026-09-29T16:00:04.000Z", backgroundTasks: 1 });
    await run("PermissionRequest", { tool_name: "Bash" });
    expect((await readRecord(env))!.inside!.data).toMatchObject({ lastPermissionRequest: { at: "2026-09-29T16:00:05.000Z", tool: "Bash" } });
    await run("UserPromptSubmit");
    await run("StopFailure", { error: "rate_limit" });
    inside = (await readRecord(env))!.inside!;
    expect(inside).toMatchObject({ status: "idle", lastTurnEnd: "2026-09-29T16:00:07.000Z", data: { lastStopFailure: { error: "rate_limit" } } });
  });

  it("clears the background task count when a Stop hook does not give one", async () => {
    const env = hookEnv();
    const run = (event: string, input: Record<string, unknown> = {}) =>
      cli(["hooks", "claude", "on", event], env, { stdin: JSON.stringify({ session_id: SID, ...input }) });
    await run("SessionStart", { source: "startup" });
    await run("Stop", { background_tasks: [{}, {}] });
    expect((await readRecord(env))!.inside!.backgroundTasks).toBe(2);
    await run("Stop");
    expect((await readRecord(env))!.inside!.backgroundTasks).toBeNull();
  });

  it("keeps startedAt through a compaction", async () => {
    const env = hookEnv();
    let t = Date.parse("2026-09-29T16:00:00Z");
    const now = () => new Date(t);
    await cli(["hooks", "claude", "on", "SessionStart"], env, { stdin: JSON.stringify({ session_id: SID, source: "startup" }), now });
    t += 60000;
    await cli(["hooks", "claude", "on", "SessionStart"], env, { stdin: JSON.stringify({ session_id: SID, source: "compact" }), now });
    expect((await readRecord(env))!.inside!.data).toMatchObject({ source: "compact", startedAt: "2026-09-29T16:00:00.000Z" });
  });

  it("keeps the status through a compaction, and SessionEnd marks the record ended with the hook's reason", async () => {
    const env = hookEnv();
    const now = () => new Date("2026-09-29T17:00:00Z");
    const run = (event: string, input: Record<string, unknown> = {}) =>
      cli(["hooks", "claude", "on", event], env, { stdin: JSON.stringify({ session_id: SID, ...input }), now });
    await run("SessionStart", { source: "startup" });
    await run("UserPromptSubmit");
    await run("SessionStart", { source: "compact" });
    expect((await readRecord(env))!.inside!.status).toBe("busy");
    const r = await run("SessionEnd", { reason: "prompt_input_exit" });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, "", ""]);
    const rec = await readRecord(env);
    v.record!(rec);
    expect(rec!.inside).toMatchObject({ status: "ended", since: "2026-09-29T17:00:00.000Z", endedAt: "2026-09-29T17:00:00.000Z", endReason: "prompt_input_exit", pid: 36322 });
  });

  it("records a null end reason when SessionEnd gives none, never a guess", async () => {
    const env = hookEnv();
    const run = (event: string, input: Record<string, unknown> = {}) =>
      cli(["hooks", "claude", "on", event], env, { stdin: JSON.stringify({ session_id: SID, ...input }) });
    await run("SessionStart", { source: "startup" });
    await run("SessionEnd");
    expect((await readRecord(env))!.inside).toMatchObject({ status: "ended", endReason: null });
  });

  it("does not bring back a record, or revive an ended one, after SessionEnd: only SessionStart does", async () => {
    const env = hookEnv();
    const run = (event: string, input: Record<string, unknown> = {}) =>
      cli(["hooks", "claude", "on", event], env, { stdin: JSON.stringify({ session_id: SID, ...input }) });
    // No record at all (the session started without Porch's hooks): nothing is created.
    for (const event of ["UserPromptSubmit", "Stop", "StopFailure", "PermissionRequest", "SessionEnd"]) {
      const r = await run(event, { tool_name: "Bash" });
      expect([event, r.code, r.stdout, r.stderr]).toEqual([event, 0, "", ""]);
      expect(await readRecord(env)).toBeNull();
    }
    await run("SessionStart", { source: "startup" });
    await run("SessionEnd", { reason: "other" });
    const ended = await readRecord(env);
    for (const event of ["UserPromptSubmit", "Stop", "StopFailure", "PermissionRequest", "SessionEnd"]) {
      const r = await run(event, { tool_name: "Bash", reason: "clear" });
      expect([event, r.code, r.stdout, r.stderr]).toEqual([event, 0, "", ""]);
      expect(await readRecord(env)).toEqual(ended);
    }
    // A resume (the same session id) starts it again, and how it ended last time goes.
    await run("SessionStart", { source: "resume" });
    const inside = (await readRecord(env))!.inside!;
    expect(inside.status).toBe("idle");
    expect(inside).not.toHaveProperty("endedAt");
    expect(inside).not.toHaveProperty("endReason");
  });

  it("a late hook still updates a record that holds only a self part", async () => {
    const env = hookEnv();
    const porch = new Porch({ env });
    await porch.ctx.records.setSelf("claude", SID, { status: "working", text: null, since: "2026-09-29T15:00:00.000Z" });
    await cli(["hooks", "claude", "on", "UserPromptSubmit"], env, { stdin: JSON.stringify({ session_id: SID }) });
    expect((await readRecord(env))!).toMatchObject({ inside: { status: "busy" }, self: { status: "working" } });
  });

  it("SessionStart keeps background tasks in the same process and clears them for another, whatever the source", async () => {
    const env = hookEnv();
    const run = (event: string, input: Record<string, unknown> = {}, extra: Env = {}) =>
      cli(["hooks", "claude", "on", event], { ...env, ...extra }, { stdin: JSON.stringify({ session_id: SID, ...input }) });
    const tasks = async () => (await readRecord(env))!.inside!.backgroundTasks;
    await run("SessionStart", { source: "startup" });
    await run("UserPromptSubmit");
    await run("Stop", { background_tasks: [{}, {}] });
    // Same process (pid 36322): a compaction, /clear or an in-session /resume keeps them.
    for (const source of ["compact", "clear", "resume"]) {
      await run("SessionStart", { source });
      expect([source, await tasks()]).toEqual([source, 2]);
    }
    const before = (await readRecord(env))!.inside!;
    // Another process: cleared, turn history kept.
    await run("SessionStart", { source: "resume" }, { CLAUDE_PID: "999", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/999.sock" });
    const inside = (await readRecord(env))!.inside!;
    expect(inside).toMatchObject({ pid: 999, backgroundTasks: null, lastTurnStart: before.lastTurnStart, lastTurnEnd: before.lastTurnEnd });
    expect(inside.lastTurnEnd).not.toBeNull();
    // Unknown pid: cannot tell, so cleared.
    await run("Stop", { background_tasks: [{}] }, { CLAUDE_PID: "999" });
    expect(await tasks()).toBe(1);
    await run("SessionStart", { source: "compact" }, { CLAUDE_PID: undefined, CLAUDE_CODE_MESSAGING_SOCKET: undefined });
    expect(await tasks()).toBeNull();
  });

  it("always exits 0 with nothing on stdout, whatever goes wrong (exit 2 would block the session)", async () => {
    const env = hookEnv({ CLAUDE_CODE_SESSION_ID: undefined });
    const cases: [string[], string][] = [
      [["hooks", "claude", "on", "SessionStart"], "{not json"],
      [["hooks", "claude", "on", "SessionStart"], "[1,2]"],
      [["hooks", "claude", "on", "Bogus"], JSON.stringify({ session_id: SID })],
      [["hooks", "claude", "on", "Stop"], JSON.stringify({})],
      [["hooks", "claude", "on", "Stop"], JSON.stringify({ session_id: "../../x" })],
      [["hooks", "claude", "on"], ""],
      [["hooks", "claude", "on", "Stop", "extra"], ""],
      [["hooks", "claude", "on", "--bogus-flag"], ""],
    ];
    for (const [argv, stdin] of cases) {
      const r = await cli(argv, env, { stdin });
      expect([argv, r.code, r.stdout]).toEqual([argv, 0, ""]);
      expect(r.stderr).toMatch(/^porch hooks claude: /);
    }
  });

  it("always exits 0 as a real process too, even when the records folder cannot be written", async () => {
    const env = hookEnv({ PORCH_HOME: "/dev/null/porch" });
    const r = await bin(["hooks", "claude", "on", "Stop"], env, JSON.stringify({ session_id: SID }));
    expect([r.code, r.stdout]).toEqual([0, ""]);
    expect(r.stderr).toMatch(/porch hooks claude: /);
  });

  it("uses CLAUDE_CODE_SESSION_ID when the hook input has no session id", async () => {
    const env = hookEnv({ CLAUDE_CODE_SESSION_ID: SID });
    await cli(["hooks", "claude", "on", "SessionStart"], env, { stdin: "" });
    await cli(["hooks", "claude", "on", "UserPromptSubmit"], env, { stdin: "" });
    expect((await readRecord(env))!.inside!.status).toBe("busy");
  });
});

describe("porch hooks claude (the settings to pass with --settings)", () => {
  it("prints hook settings for every event, running this node and this Porch", async () => {
    const r = await bin(["hooks", "claude"], scratchEnv());
    expect(r.code).toBe(0);
    v["claude-hooks"]!(r.json);
    expect(r.json).toMatchObject({ harness: "claude", node: process.execPath, cli: BIN, porchHome: null });
    expect(Object.keys(r.json.settings.hooks)).toEqual([...HOOK_EVENTS]);
    expect(r.json.settings.hooks.Stop[0].hooks[0]).toEqual({
      type: "command",
      command: `'${process.execPath}' '${BIN}' hooks claude on Stop`,
      timeout: 10,
    });
  });

  it("bakes in --porch-home, quoted for sh", async () => {
    const r = await bin(["hooks", "claude", "--porch-home", "/tmp/it's here"], scratchEnv());
    expect(r.json.porchHome).toBe("/tmp/it's here");
    expect(r.json.settings.hooks.SessionStart[0].hooks[0].command).toMatch(/^PORCH_HOME='\/tmp\/it'\\''s here' '/);
  });

  it("rejects stray arguments and an empty --porch-home as usage errors", async () => {
    expect((await cli(["hooks", "claude", "extra"], scratchEnv())).code).toBe(2);
    expect((await cli(["hooks", "claude", "--porch-home", " "], scratchEnv())).code).toBe(2);
    expect((await cli(["hooks", "claude", "--nope"], scratchEnv())).code).toBe(2);
  });

  it("prints commands that work when run by sh, as Claude Code runs them, from any folder", async () => {
    const env = scratchEnv();
    const home = mkdtempSync(path.join(os.tmpdir(), "porch-baked-"));
    const settings = claudeHookSettings({ porchHome: home, cli: BIN });
    const command = settings.hooks.SessionStart[0]!.hooks[0]!.command;
    const code = await new Promise<number>((resolve) => {
      const child = execFile("/bin/sh", ["-c", command], { env: { PATH: "/usr/bin:/bin", HOME: env.HOME }, cwd: "/" }, (err) =>
        resolve(err ? Number((err as { code?: number }).code ?? 1) : 0),
      );
      child.stdin!.end(JSON.stringify({ session_id: SID, source: "startup" }));
    });
    expect(code).toBe(0);
    const rec = JSON.parse(readFileSync(path.join(home, "sessions", `claude-${SID}.json`), "utf8"));
    expect(rec.inside.status).toBe("idle");
  });

  it("quotes for sh", () => {
    expect(shQuote("a b")).toBe("'a b'");
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(hookCommand("Stop", { node: "/n", cli: "/c" })).toBe("'/n' '/c' hooks claude on Stop");
  });
});

describe("conformance recordings of Claude Code", () => {
  it("keep only the case's own sessions from claude agents --json", () => {
    const snap: Snapshot = {
      label: "x",
      at: "2026-09-29T16:00:00.000Z",
      records: {},
      observations: [],
      io: [
        {
          op: "run",
          cmd: "claude",
          args: ["agents", "--json"],
          result: { code: 0, stderr: "", stdout: JSON.stringify([row({ cwd: "$WORK/cwd-1" }), row({ cwd: "$HOME/secret-project" }), row({ cwd: "$WORK" })]) },
        },
        { op: "readFile", path: "$HOME/.claude/jobs/x/state.json", result: null },
      ],
    };
    const out = scrubClaudeSnapshot(snap);
    const call = out.io[0] as Extract<Snapshot["io"][number], { op: "run" }>;
    expect(JSON.parse(call.result.stdout).map((r: { cwd: string }) => r.cwd)).toEqual(["$WORK/cwd-1", "$WORK"]);
    expect(out.io[1]).toEqual(snap.io[1]);
  });

  it("keep only the daemon log lines naming the case's own sessions", () => {
    const log = [
      "[2026-09-30T14:00:00.000Z] [supervisor] auth: scheduling proactive refresh in 9028s",
      `[2026-09-30T14:00:01.000Z] [bg] bg claimed-spare ${SHORT} (shell)`,
      "[2026-09-30T14:00:02.000Z] [bg] bg claimed-spare 0badbeef (shell)",
      "[2026-09-30T15:00:00.000Z] [bg] bg retire cafe1234: settled, idle 61m",
      `[2026-09-30T15:00:01.000Z] [bg] bg retire ${SHORT}0: settled, idle 61m`,
      "[2026-09-30T15:01:00.000Z] [bg] bg retire 0badbeef: settled, idle 61m",
      "",
    ].join("\n");
    const snap: Snapshot = {
      label: "x",
      at: "2026-09-30T16:00:00.000Z",
      // cafe1234 is the case's too: its record knows it, though it has left the listing.
      records: { "claude-a.json": { inside: { data: { shortId: "cafe1234" } } } },
      observations: [],
      io: [
        {
          op: "run",
          cmd: "claude",
          args: ["agents", "--json"],
          result: { code: 0, stderr: "", stdout: JSON.stringify([row({ cwd: "$WORK/cwd-1" }), row({ id: "0badbeef", cwd: "$HOME/elsewhere" })]) },
        },
        { op: "readFile", path: "$HOME/.claude/daemon.log.1", result: null },
        { op: "readFile", path: "$HOME/.claude/daemon.log", result: log },
        { op: "readFile", path: "$HOME/.claude/jobs/x/state.json", result: "0badbeef" },
      ],
    };
    const out = scrubClaudeSnapshot(snap);
    expect(out.io[1]).toEqual(snap.io[1]);
    expect((out.io[2] as { result: string }).result).toBe(
      `[2026-09-30T14:00:01.000Z] [bg] bg claimed-spare ${SHORT} (shell)\n[2026-09-30T15:00:00.000Z] [bg] bg retire cafe1234: settled, idle 61m\n`,
    );
    expect(out.io[3]).toEqual(snap.io[3]);
  });

  it("replay of the recorded prompt case depends on the recorded listing", async () => {
    const fixture = JSON.parse(readFileSync(path.join(REPO, "conformance", "fixtures", "claude", "held-at-prompt.json"), "utf8")) as Fixture;
    const workDir = mkdtempSync(path.join(os.tmpdir(), "porch-replay-"));
    const scratch = { env: scratchEnv({ PORCH_HOME: path.join(workDir, "porch-home"), PORCH_CLAUDE_BIN: undefined }), workDir };
    expect(await replayFixture(fixture, DRIVERS.claude!.adapter(), scratch)).toEqual([]);
    const tampered = structuredClone(fixture);
    const snap = tampered.snapshots.find((x) => x.label === "held")!;
    const call = snap.io.find((c) => c.op === "run") as Extract<Snapshot["io"][number], { op: "run" }>;
    expect(call.result.stdout).toContain('"waiting"');
    call.result.stdout = call.result.stdout.replace('"waiting"', '"idle"');
    const mismatches = await replayFixture(tampered, DRIVERS.claude!.adapter(), scratch);
    expect(mismatches.map((m) => m.snapshot)).toEqual(["held"]);
  });

  it("turn paths written as one folder name into placeholders too, and back", () => {
    const env = { HOME: "/Users/someone", PORCH_HOME: "/w/case/porch-home" };
    const text = `/Users/someone/.claude/projects/${dashedPath("/w/case")}-cwd-1/x.jsonl and ${dashedPath("/Users/someone")}-other`;
    const stored = toPlaceholders(text, env, "/w/case");
    expect(stored).toBe("$HOME/.claude/projects/$WORK_DASHED-cwd-1/x.jsonl and $HOME_DASHED-other");
    expect(fromPlaceholders(stored, { HOME: "/h2", PORCH_HOME: "/w2/porch-home" }, "/w2")).toBe(
      `/h2/.claude/projects/${dashedPath("/w2")}-cwd-1/x.jsonl and ${dashedPath("/h2")}-other`,
    );
  });

  it("committed Claude fixtures hold only the case's own sessions and no home folder", () => {
    const dir = path.join(REPO, "conformance", "fixtures", "claude");
    // The real home folder: tests/setup.ts points HOME (and so os.homedir()) at a scratch folder.
    const home = os.userInfo().homedir;
    for (const name of readdirSync(dir)) {
      const text = readFileSync(path.join(dir, name), "utf8");
      expect(text.includes(home) || text.includes(dashedPath(home)), `${name} mentions the home folder`).toBe(false);
      const fixture = JSON.parse(text) as Fixture;
      const own = new Set<string>();
      for (const snap of fixture.snapshots) {
        for (const rec of Object.values(snap.records) as SessionRecord[]) {
          if (typeof rec.inside?.data?.shortId === "string") own.add(rec.inside.data.shortId);
        }
      }
      for (const snap of fixture.snapshots) {
        for (const call of snap.io) {
          if (call.op === "readFile" && /daemon\.log/.test(call.path)) {
            for (const line of (call.result ?? "").split("\n").filter(Boolean)) {
              expect([...own].some((id) => line.includes(id)), `${name}: a daemon log line about another session (${line})`).toBe(true);
            }
          }
          if (call.op !== "run" || call.args[0] !== "agents") continue;
          for (const r of JSON.parse(call.result.stdout) as { cwd?: string }[]) {
            expect(r.cwd === "$WORK" || r.cwd?.startsWith("$WORK/"), `${name}: a session outside the case (${r.cwd})`).toBe(true);
          }
        }
      }
    }
  });
});
