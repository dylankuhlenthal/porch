import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AdapterContext } from "../src/adapter.js";
import { createClaudeAdapter, isUnder } from "../src/adapters/claude/index.js";
import { claudeHookSettings, handleHookEvent, hookCommand, HOOK_EVENTS, shQuote } from "../src/adapters/claude/hooks.js";
import { parseListing } from "../src/adapters/claude/listing.js";
import { jobActivity } from "../src/adapters/claude/observe.js";
import { socketLine } from "../src/adapters/claude/socket.js";
import { DRIVERS, scrubClaudeSnapshot } from "../src/conformance/drivers/index.js";
import { replayFixture, type Fixture, type Snapshot } from "../src/conformance/recorder.js";
import type { Env } from "../src/home.js";
import type { HarnessIO, RunResult } from "../src/io.js";
import { Porch } from "../src/porch.js";
import { bin, BIN, cli, REPO, scratchEnv, schemaValidators } from "./helpers.js";

const v = schemaValidators();
const SID = "5b0e750e-44ca-46ad-a46a-6408e83922b1";
const SHORT = "5b0e750e";
const OTHER = "06bb8fe1-860d-4965-8fdd-f81d5796767d";

/** A HarnessIO answering `claude agents --json` and job files from canned values. */
function stubIO(rows: unknown[] | RunResult | "missing", jobs: Record<string, unknown> = {}): HarnessIO & { runs: string[][] } {
  const runs: string[][] = [];
  return {
    runs,
    async run(cmd, args) {
      runs.push([cmd, ...args]);
      if (args[0] === "--version") return { code: 0, stdout: "2.1.284 (Claude Code)\n", stderr: "" };
      if (rows === "missing") return { code: null, stdout: "", stderr: "spawn claude ENOENT" };
      if (!Array.isArray(rows)) return rows;
      return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
    },
    async readFile(file) {
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
    const porch = porchWith(stubIO([row({ status: "idle" })]), env);
    await hook(porch.ctx, "SessionStart", { source: "startup", cwd: "/work/a" });
    await hook(porch.ctx, "UserPromptSubmit", { prompt: "hi" });
    // The listing still says idle; the record says a turn started.
    const obs = await porch.observe(SID);
    v.observation!(obs);
    expect(obs).toMatchObject({ harness: "claude", session: SID, status: "busy", since: "2026-09-29T16:00:00.000Z" });
    expect(obs.detail).toMatchObject({ pid: 4242, shortId: SHORT, statusSource: "hooks", hasInsidePart: true, lastTurnStart: "2026-09-29T16:00:00.000Z" });
  });

  it("does not trust the listing's busy over the record's idle (the listing's busy can be stale)", async () => {
    const porch = porchWith(stubIO([row({ status: "busy" })]));
    await hook(porch.ctx, "SessionStart", { source: "startup" });
    await hook(porch.ctx, "Stop", { background_tasks: [{ id: 1 }, { id: 2 }] });
    const obs = await porch.observe(SID);
    expect(obs.status).toBe("idle");
    expect(obs.detail).toMatchObject({ lastTurnEnd: "2026-09-29T16:00:00.000Z", backgroundTasks: 2 });
  });

  it("reports waiting-on-prompt from the listing, with what it waits for", async () => {
    const io = stubIO([row({ status: "waiting", waitingFor: "permission prompt" })], {
      [SHORT]: { sessionId: SID, tempo: "blocked", needs: "approve Bash: touch x" },
    });
    const porch = porchWith(io);
    await hook(porch.ctx, "UserPromptSubmit", {});
    const obs = await porch.observe(SID);
    expect(obs.status).toBe("waiting-on-prompt");
    expect(obs.since).toBeNull();
    expect(obs.detail).toMatchObject({ prompt: "permission prompt", promptNeeds: "approve Bash: touch x", statusSource: null });
  });

  it("shows a session whose process is gone as gone, even with a fresh record, and reads no job file for it", async () => {
    const io = stubIO([row({ pid: undefined, status: undefined })], { [SHORT]: { sessionId: SID, detail: "x" } });
    const porch = porchWith(io);
    await hook(porch.ctx, "UserPromptSubmit", {});
    const obs = await porch.observe(SID);
    expect(obs.status).toBe("gone");
    expect(obs.detail).toMatchObject({ pid: null, activity: null });
    expect(obs.raw).toMatchObject({ job: null });
  });

  it("shows a record whose session is not in the listing at all as gone", async () => {
    const porch = porchWith(stubIO([]));
    await hook(porch.ctx, "SessionStart", { source: "startup" });
    const list = await porch.list();
    expect(list.sessions.map((o) => [o.session, o.status])).toEqual([[SID, "gone"]]);
  });

  it("gives a session without Porch's hooks the listing's own busy or idle, marked as such", async () => {
    const porch = porchWith(stubIO([row({ status: "busy" }), row({ id: "06bb8fe1", sessionId: OTHER, status: "starting?" })]));
    const [a, b] = (await porch.list()).sessions;
    expect(a).toMatchObject({ session: OTHER, status: "unknown" });
    expect(b).toMatchObject({ session: SID, status: "busy", since: null });
    expect(b!.detail).toMatchObject({ hasInsidePart: false, statusSource: "listing" });
  });

  it("finds a session by its short id and reports it under the full id", async () => {
    const porch = porchWith(stubIO([row()]));
    expect((await porch.observe(SHORT)).session).toBe(SID);
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
    expect((await porch.list()).sessions.map((o) => o.session)).toEqual([SID]);
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
    const r = await porch.deliver(SHORT, 'hello "there"\nline two', { from: "sous chef" });
    v.deliver!(r);
    expect(r).toMatchObject({ result: "delivered", session: SID, statusAtSend: "idle", via: "socket", guessed: false, reason: null });
    await waitFor(() => got.length === 1);
    expect(got).toEqual([socketLine('[from sous chef] hello "there"\nline two')]);
    expect(JSON.parse(got[0]!)).toEqual({ type: "user", message: { role: "user", content: '[from sous chef] hello "there"\nline two' } });
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

  it("says failed, with the reason, when nothing listens on the socket", async () => {
    const porch = porchWith(stubIO([row()]), scratchEnv(), { socketDirs: [sockDir()] });
    const r = await porch.deliver(SID, "hi", { from: "x" });
    expect(r).toMatchObject({ result: "failed", via: "socket", guessed: true });
    expect(r.reason).toMatch(/nothing is listening/);
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

  it("keeps the status through a compaction, and SessionEnd removes the record", async () => {
    const env = hookEnv();
    const run = (event: string, input: Record<string, unknown> = {}) =>
      cli(["hooks", "claude", "on", event], env, { stdin: JSON.stringify({ session_id: SID, ...input }) });
    await run("UserPromptSubmit");
    await run("SessionStart", { source: "compact" });
    expect((await readRecord(env))!.inside!.status).toBe("busy");
    await run("SessionEnd", { reason: "other" });
    expect(await readRecord(env)).toBeNull();
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
    const command = settings.hooks.UserPromptSubmit[0]!.hooks[0]!.command;
    const code = await new Promise<number>((resolve) => {
      const child = execFile("/bin/sh", ["-c", command], { env: { PATH: "/usr/bin:/bin", HOME: env.HOME }, cwd: "/" }, (err) =>
        resolve(err ? Number((err as { code?: number }).code ?? 1) : 0),
      );
      child.stdin!.end(JSON.stringify({ session_id: SID }));
    });
    expect(code).toBe(0);
    const rec = JSON.parse(readFileSync(path.join(home, "sessions", `claude-${SID}.json`), "utf8"));
    expect(rec.inside.status).toBe("busy");
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
});
