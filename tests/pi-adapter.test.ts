import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import porchPiExtension, { type PiExtensionAPI } from "../src/adapters/pi/extension.js";
import { createPiAdapter, PI_SESSION_ENV } from "../src/adapters/pi/index.js";
import { piExtensionPath, PI_SUBCOMMANDS } from "../src/adapters/pi/launch.js";
import { PI_HARNESS } from "../src/adapters/pi/observe.js";
import { parseElapsed, parsePs, START_TOLERANCE_MS } from "../src/adapters/pi/process.js";
import { ensurePrivateDir, MAX_REQUEST_BYTES, piSocketDir, sendToPiSocket } from "../src/adapters/pi/protocol.js";
import { EXIT } from "../src/cli/exit-codes.js";
import type { Env } from "../src/home.js";
import type { HarnessIO, RunResult } from "../src/io.js";
import { Porch } from "../src/porch.js";
import { SocketMissingError } from "../src/unix-socket.js";
import { cli, NO_PI, scratchEnv, schemaValidators } from "./helpers.js";

const v = schemaValidators();
const T0 = new Date("2026-09-30T10:00:00.000Z");
const NOW = new Date(T0.getTime() + 65_000);

/** A HarnessIO whose `ps` knows the given pids (each started at the given time), and records every call. */
function psIO(procs: Record<number, Date>, override?: RunResult) {
  const calls: string[][] = [];
  const io: HarnessIO = {
    async run(cmd, args) {
      calls.push([cmd, ...args]);
      if (override) return override;
      const asked = args[args.indexOf("-p") + 1]!.split(",").map(Number);
      const lines = asked
        .filter((p) => procs[p] !== undefined)
        .map((p) => {
          const s = Math.round((NOW.getTime() - procs[p]!.getTime()) / 1000);
          return `${String(p).padStart(5)} ${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
        });
      return lines.length === 0 ? { code: 1, stdout: "", stderr: "Command failed: ps" } : { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
    },
    async readFile() {
      return null;
    },
  };
  return { io, calls };
}

/** A fresh private folder named like the extension's own (`porch-<uid>`), so deliver accepts paths in it. */
function socketFolder(): string {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "pp-")), path.basename(piSocketDir()));
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

function porchWith(env: Env, io: HarnessIO) {
  return new Porch({ env, adapters: [createPiAdapter()], io, now: () => NOW });
}

async function writeRecord(porch: Porch, session: string, inside: Record<string, unknown>) {
  await porch.ctx.records.updateInside(PI_HARNESS, session, inside);
}

/** Write raw bytes to a socket and read the one reply line. */
function rawRequest(address: string, text: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let out = "";
    const c = net.createConnection(address, () => c.write(text));
    c.setEncoding("utf8");
    c.on("data", (d: string) => (out += d));
    c.on("error", () => undefined);
    c.on("close", () => {
      try {
        resolve(JSON.parse(out.split("\n")[0]!));
      } catch (err) {
        reject(new Error(`no reply line: ${JSON.stringify(out)} (${String(err)})`));
      }
    });
  });
}

describe("pi adapter: ps output", () => {
  it("reads ps elapsed times", () => {
    expect(parseElapsed("00:05")).toBe(5000);
    expect(parseElapsed("12:34")).toBe((12 * 60 + 34) * 1000);
    expect(parseElapsed("01:02:03")).toBe((3600 + 120 + 3) * 1000);
    expect(parseElapsed("2-01:02:03")).toBe(((2 * 24 + 1) * 3600 + 123) * 1000);
    expect(parseElapsed("soon")).toBeNull();
  });

  it("refuses output it cannot read, rather than reading it as nothing running", () => {
    expect(parsePs("  123 00:05\n 4567 1-00:00:00\n", NOW)!.get(123)).toBe(NOW.getTime() - 5000);
    expect(parsePs("", NOW)!.size).toBe(0);
    expect(parsePs("PID ELAPSED\n123 00:05\n", NOW)).toBeNull();
  });
});

describe("pi adapter: status", () => {
  const started = T0.toISOString();

  it("runs one ps for every record, and shows each session's own status and since", async () => {
    const env = scratchEnv();
    const { io, calls } = psIO({ 200: T0, 100: T0 });
    const porch = porchWith(env, io);
    await writeRecord(porch, "s-b", { pid: 200, status: "busy", since: "2026-09-30T10:00:30.000Z", data: { processStartedAt: started } });
    await writeRecord(porch, "s-a", { pid: 100, status: "idle", since: "2026-09-30T10:00:10.000Z", data: { processStartedAt: started, mode: "tui" } });
    const { sessions, errors } = await porch.list();
    expect(errors).toEqual([]);
    expect(calls).toEqual([["ps", "-o", "pid=,etime=", "-p", "100,200"]]);
    expect(sessions.map((o) => [o.session, o.status, o.since])).toEqual([
      ["s-a", "idle", "2026-09-30T10:00:10.000Z"],
      ["s-b", "busy", "2026-09-30T10:00:30.000Z"],
    ]);
    expect(sessions[0]!.detail).toMatchObject({ pid: 100, mode: "tui", hasInsidePart: true, prompt: null });
    expect(sessions.every((o) => o.attached)).toBe(true);
    for (const o of sessions) v.observation!(o);
  });

  it("does not count a record holding only a self part (no extension) as attached", async () => {
    const porch = porchWith(scratchEnv(), psIO({}).io);
    await porch.ctx.records.setSelf("pi", "s-self", { status: "working", text: null, since: started });
    expect((await porch.list()).sessions).toEqual([]);
    expect((await porch.list(undefined, { all: true })).sessions).toMatchObject([{ session: "s-self", attached: false, status: "unknown" }]);
    expect(await porch.observe("s-self")).toMatchObject({ attached: false });
  });

  it("shows gone when the process is not running, or its pid now belongs to a process that started later", async () => {
    const env = scratchEnv();
    const later = new Date(T0.getTime() + START_TOLERANCE_MS + 5000);
    const porch = porchWith(env, psIO({ 300: later }).io);
    await writeRecord(porch, "dead", { pid: 301, status: "idle", data: { processStartedAt: started } });
    await writeRecord(porch, "reused", { pid: 300, status: "idle", data: { processStartedAt: started } });
    const byId = Object.fromEntries((await porch.list(undefined, { all: true })).sessions.map((o) => [o.session, o]));
    expect(byId.dead!.status).toBe("gone");
    expect(byId.dead!.since).toBeNull();
    expect(byId.reused!.status).toBe("gone");
    // Not running, so hidden without --all.
    expect((await porch.list()).sessions).toEqual([]);
  });

  it("shows an ended session as ended with its reason, whether or not its process still runs, and asks ps nothing for it", async () => {
    const env = scratchEnv();
    const { io, calls } = psIO({ 400: T0 });
    const porch = porchWith(env, io);
    const endedAt = new Date(NOW.getTime() - 1000).toISOString();
    // The process runs on after /new ended this session: still ended.
    await writeRecord(porch, "renewed", { pid: 400, status: "ended", endedAt, endReason: "new", data: { processStartedAt: started } });
    await writeRecord(porch, "quit", { pid: 401, status: "ended", endedAt, endReason: "quit", data: { processStartedAt: started } });
    const all = await porch.list(undefined, { all: true });
    for (const o of all.sessions) v.observation!(o);
    expect(all.sessions.map((o) => [o.session, o.status, o.since, o.endReason])).toEqual([
      ["quit", "ended", endedAt, "quit"],
      ["renewed", "ended", endedAt, "new"],
    ]);
    expect(calls).toEqual([]);
    expect((await porch.list()).sessions).toEqual([]);
    expect(await porch.deliver("quit", "hi", { from: "t" })).toMatchObject({ result: "not-running", reason: "the session has ended" });
  });

  it("reads ps output even when ps exits 1 because some pids are not running (as Linux's procps may)", async () => {
    const env = scratchEnv();
    const porch = porchWith(env, psIO({}, { code: 1, stdout: "  100 00:05\n", stderr: "Command failed: ps" }).io);
    const started2 = new Date(NOW.getTime() - 5000).toISOString();
    await writeRecord(porch, "alive", { pid: 100, status: "idle", data: { processStartedAt: started2 } });
    await writeRecord(porch, "dead", { pid: 101, status: "idle", data: { processStartedAt: started2 } });
    const byId = Object.fromEntries((await porch.list(undefined, { all: true })).sessions.map((o) => [o.session, o.status]));
    expect(byId).toEqual({ alive: "idle", dead: "gone" });
  });

  it("says unknown when ps cannot be run, and when the record has no pid", async () => {
    const env = scratchEnv();
    const porch = porchWith(env, psIO({}, { code: null, stdout: "", stderr: "spawn ps ENOENT" }).io);
    await writeRecord(porch, "no-ps", { pid: 5, status: "idle", data: { processStartedAt: started } });
    expect((await porch.observe("no-ps")).status).toBe("unknown");
    const env2 = scratchEnv();
    const porch2 = porchWith(env2, psIO({}).io);
    await porch2.ctx.records.setSelf(PI_HARNESS, "only-self", { status: "working", text: null, since: started });
    expect((await porch2.observe("only-self")).status).toBe("unknown");
  });

  it("an open extension dialog is waiting-on-prompt, whatever the turn status", async () => {
    const env = scratchEnv();
    const porch = porchWith(env, psIO({ 7: T0 }).io);
    const prompt = { kind: "confirm", title: "Deploy?", since: "2026-09-30T10:00:40.000Z" };
    await writeRecord(porch, "held", { pid: 7, status: "busy", data: { processStartedAt: started, prompt } });
    const o = await porch.observe("held");
    expect(o.status).toBe("waiting-on-prompt");
    expect(o.since).toBe(prompt.since);
    expect(o.detail).toMatchObject({ prompt: { kind: "confirm", title: "Deploy?" } });
  });

  it("does not know ids it has no record of, including ids the record store refuses", async () => {
    const env = scratchEnv();
    const adapter = createPiAdapter();
    const porch = new Porch({ env, adapters: [adapter], io: psIO({}).io });
    expect(await adapter.observe(porch.ctx, "nobody")).toBeNull();
    expect(await adapter.observe(porch.ctx, "../escape")).toBeNull();
    expect((await adapter.deliver(porch.ctx, "nobody", "hi")).result).toBe("not-running");
  });

  it("current() is PI_SESSION_ID", async () => {
    const adapter = createPiAdapter();
    const at = (env: Env) => adapter.current(new Porch({ env, adapters: [adapter] }).ctx);
    expect(await at(scratchEnv({ [PI_SESSION_ENV]: "abc" }))).toBe("abc");
    expect(await at(scratchEnv({ [PI_SESSION_ENV]: " " }))).toBeNull();
    expect(await at(scratchEnv())).toBeNull();
  });
});

describe("pi adapter: deliver", () => {
  it("says not-running for a session whose process is gone, and failed without a recorded socket", async () => {
    const env = scratchEnv();
    const porch = porchWith(env, psIO({ 9: T0 }).io);
    await writeRecord(porch, "gone", { pid: 8, status: "idle", data: { processStartedAt: T0.toISOString() } });
    await writeRecord(porch, "nosock", { pid: 9, status: "idle", data: { processStartedAt: T0.toISOString(), lastError: "could not open the delivery socket: EACCES" } });
    const gone = await porch.deliver("gone", "hi", { from: "t" });
    expect(gone.result).toBe("not-running");
    const nosock = await porch.deliver("nosock", "hi", { from: "t" });
    expect(nosock).toMatchObject({ result: "failed", statusAtSend: null });
    expect(nosock.reason).toContain("EACCES");
    v.deliver!(nosock);
  });

  it("refuses a recorded path that is not a socket, and says failed when nothing listens", async () => {
    const env = scratchEnv();
    const porch = porchWith(env, psIO({ 9: T0, 10: T0 }).io);
    const dir = socketFolder();
    writeFileSync(path.join(dir, "pi-9.sock"), "x");
    await writeRecord(porch, "file", { pid: 9, status: "idle", delivery: { via: "socket", address: path.join(dir, "pi-9.sock") }, data: { processStartedAt: T0.toISOString() } });
    await writeRecord(porch, "none", { pid: 10, status: "idle", delivery: { via: "socket", address: path.join(dir, "pi-10.sock") }, data: { processStartedAt: T0.toISOString() } });
    const file = await porch.deliver("file", "hi", { from: "t" });
    expect(file.result).toBe("failed");
    expect(file.reason).toContain("not a socket");
    expect((await porch.deliver("none", "hi", { from: "t" })).result).toBe("failed");
  });

  it("refuses a recorded socket that is not the one the extension makes for that process", async () => {
    const env = scratchEnv();
    const porch = porchWith(env, psIO({ 9: T0 }).io);
    const other = path.join(mkdtempSync(path.join(os.tmpdir(), "pp-")), "agent.sock");
    const server = net.createServer((c) => c.end('{"ok":true,"status":"idle"}\n'));
    await new Promise<void>((r) => server.listen(other, r));
    try {
      const wrongPid = path.join(socketFolder(), "pi-8.sock");
      for (const address of [other, wrongPid]) {
        await writeRecord(porch, "odd", { pid: 9, status: "idle", delivery: { via: "socket", address }, data: { processStartedAt: T0.toISOString() } });
        const r = await porch.deliver("odd", "hi", { from: "t" });
        expect(r.result).toBe("failed");
        expect(r.reason).toContain("refused");
      }
    } finally {
      server.close();
    }
  });

  it("sendToPiSocket: nothing listening is SocketMissingError; a reply it cannot read is an error", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "porch-pi-"));
    await expect(sendToPiSocket(path.join(dir, "none.sock"), "hi")).rejects.toBeInstanceOf(SocketMissingError);
    const address = path.join(dir, "odd.sock");
    const server = net.createServer((c) => c.end("not json\n"));
    await new Promise<void>((r) => server.listen(address, r));
    try {
      await expect(sendToPiSocket(address, "hi")).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});

/** A stand-in for Pi's ExtensionAPI: collects handlers and lets the test fire events. */
function fakePi(session: string, sessionFile: string | undefined) {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const sent: { text: string; deliverAs?: string }[] = [];
  const state = { idle: true };
  const ctx = {
    mode: "rpc",
    cwd: "/work/here",
    isIdle: () => state.idle,
    sessionManager: { getSessionId: () => session, getSessionFile: () => sessionFile },
  };
  const api: PiExtensionAPI = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler as never]);
    },
    sendUserMessage(text, options) {
      sent.push({ text, deliverAs: options?.deliverAs });
    },
  };
  const emit = async (type: string, fields: Record<string, unknown> = {}) => {
    for (const h of handlers.get(type) ?? []) await h({ type, ...fields }, ctx);
  };
  return { api, emit, sent, state };
}

describe("pi extension (the inside part)", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setUp() {
    const env = scratchEnv();
    const socketDir = path.join(mkdtempSync(path.join(os.tmpdir(), "pp-")), path.basename(piSocketDir()));
    const pi = fakePi("sess-1", "/work/here/sessions/x_sess-1.jsonl");
    // Stands in for the process: the extension's exit fallback listens to it.
    const exitEvents = new EventEmitter();
    porchPiExtension(pi.api, { env: env as NodeJS.ProcessEnv, pid: 4242, processStartedAt: T0.toISOString(), socketDir, now: () => NOW, connectionTimeoutMs: 300, exitEvents });
    const porch = porchWith(env, psIO({ 4242: T0 }).io);
    cleanups.push(() => pi.emit("session_shutdown", { reason: "quit" }));
    return { env, socketDir, pi, porch, exitEvents };
  }

  it("writes the record at session start and opens a private socket", async () => {
    const { socketDir, pi, porch } = await setUp();
    await pi.emit("session_start", { reason: "startup" });
    const rec = await porch.ctx.records.read(PI_HARNESS, "sess-1");
    v.record!(rec);
    const address = path.join(socketDir, "pi-4242.sock");
    expect(rec!.inside).toMatchObject({
      pid: 4242,
      status: "idle",
      delivery: { via: "socket", address },
      cwd: "/work/here",
      data: { processStartedAt: T0.toISOString(), sessionFile: "/work/here/sessions/x_sess-1.jsonl", mode: "rpc", source: "startup", prompt: null, lastError: null },
    });
    expect(statSync(socketDir).mode & 0o777).toBe(0o700);
    expect(statSync(address).isSocket()).toBe(true);
    expect((await porch.observe("sess-1")).status).toBe("idle");
  });

  it("delivers through the socket as a follow-up, with the session's own status at that moment", async () => {
    const { pi, porch } = await setUp();
    await pi.emit("session_start", { reason: "startup" });
    const idle = await porch.deliver("sess-1", "wake up", { from: "tester" });
    expect(idle).toMatchObject({ result: "delivered", statusAtSend: "idle", via: "socket", guessed: false });
    v.deliver!(idle);
    pi.state.idle = false;
    const busy = await porch.deliver("sess-1", "and then", { from: "tester" });
    expect(busy.statusAtSend).toBe("busy");
    expect(pi.sent).toEqual([
      { text: "[from tester] wake up", deliverAs: "followUp" },
      { text: "[from tester] and then", deliverAs: "followUp" },
    ]);
  });

  it("follows turns and dialogs: busy on agent_start, idle on agent_settled, waiting while a dialog is open", async () => {
    const { pi, porch } = await setUp();
    await pi.emit("session_start", { reason: "startup" });
    await pi.emit("agent_start");
    let rec = await porch.ctx.records.read(PI_HARNESS, "sess-1");
    expect(rec!.inside).toMatchObject({ status: "busy", lastTurnStart: NOW.toISOString() });
    await pi.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm", title: "Sure?" });
    expect((await porch.observe("sess-1")).status).toBe("waiting-on-prompt");
    expect((await porch.deliver("sess-1", "x", { from: "t" })).statusAtSend).toBe("waiting-on-prompt");
    await pi.emit("ui_prompt_end", { reason: "ui_prompt", kind: "confirm", title: "Sure?" });
    expect((await porch.observe("sess-1")).status).toBe("busy");
    await pi.emit("agent_settled");
    rec = await porch.ctx.records.read(PI_HARNESS, "sess-1");
    expect(rec!.inside).toMatchObject({ status: "idle", lastTurnEnd: NOW.toISOString(), data: { prompt: null } });
  });

  it("keeps the record through a reload, and marks it ended with Pi's reason, and removes the socket, when the session ends", async () => {
    const { socketDir, pi, porch } = await setUp();
    const address = path.join(socketDir, "pi-4242.sock");
    await pi.emit("session_start", { reason: "startup" });
    await pi.emit("session_shutdown", { reason: "reload" });
    expect((await porch.ctx.records.read(PI_HARNESS, "sess-1"))!.inside!.status).toBe("idle");
    expect(existsSync(address)).toBe(false);
    await pi.emit("session_start", { reason: "reload" });
    expect((await porch.ctx.records.read(PI_HARNESS, "sess-1"))!.inside!.data!.source).toBe("reload");
    await pi.emit("session_shutdown", { reason: "quit" });
    const rec = await porch.ctx.records.read(PI_HARNESS, "sess-1");
    v.record!(rec);
    expect(rec!.inside).toMatchObject({ status: "ended", endedAt: NOW.toISOString(), endReason: "quit" });
    expect(existsSync(address)).toBe(false);
    expect(await porch.observe("sess-1")).toMatchObject({ status: "ended", endReason: "quit", since: NOW.toISOString() });
    // A late event does not turn it back into a running session.
    await pi.emit("agent_settled");
    expect((await porch.ctx.records.read(PI_HARNESS, "sess-1"))!.inside!.status).toBe("ended");
  });

  it("ends the old session with reason new when /new replaces it in the same process", async () => {
    const { pi, porch } = await setUp();
    await pi.emit("session_start", { reason: "startup" });
    await pi.emit("session_shutdown", { reason: "new" });
    expect(await porch.observe("sess-1")).toMatchObject({ status: "ended", endReason: "new" });
  });

  it("on a normal exit without session_shutdown (the terminal closed mid-turn: code 129), marks the session ended with no reason", async () => {
    const { pi, porch, exitEvents } = await setUp();
    await pi.emit("session_start", { reason: "startup" });
    await pi.emit("agent_start");
    exitEvents.emit("exit", 129);
    const rec = await porch.ctx.records.read(PI_HARNESS, "sess-1");
    v.record!(rec);
    expect(rec!.inside).toMatchObject({ status: "ended", endedAt: NOW.toISOString(), endReason: null, data: { exitCode: 129 } });
  });

  it("leaves the record as it is when Pi exits with a crash's code, so the session shows as gone", async () => {
    const { pi, porch, exitEvents } = await setUp();
    await pi.emit("session_start", { reason: "startup" });
    exitEvents.emit("exit", 1);
    expect((await porch.ctx.records.read(PI_HARNESS, "sess-1"))!.inside!.status).toBe("idle");
  });

  it("finishes an ended mark session_shutdown started when the process exits before it is written, even under its own lock", async () => {
    const { env, pi, porch, exitEvents } = await setUp();
    await pi.emit("session_start", { reason: "startup" });
    // An unfinished write of this same process holds the lock, as when Pi exits mid-write.
    const lock = `${porch.ctx.records.recordPath(PI_HARNESS, "sess-1")}.lock`;
    writeFileSync(lock, `${process.pid}:unfinished`);
    const shutdown = pi.emit("session_shutdown", { reason: "quit" });
    exitEvents.emit("exit", 0);
    const rec = await new Porch({ env }).ctx.records.read(PI_HARNESS, "sess-1");
    expect(rec!.inside).toMatchObject({ status: "ended", endReason: "quit" });
    await shutdown;
    expect(existsSync(lock)).toBe(false);
  });

  it("refuses requests it cannot take: not a deliver request, and one over the size limit (counted in bytes)", async () => {
    const { socketDir, pi } = await setUp();
    await pi.emit("session_start", { reason: "startup" });
    const address = path.join(socketDir, "pi-4242.sock");
    expect(await rawRequest(address, '{"type":"other"}\n')).toEqual({ ok: false, error: "not a deliver request" });
    expect(await rawRequest(address, "not json\n")).toEqual({ ok: false, error: "not a deliver request" });
    // Two-byte characters: under the limit in characters, over it in bytes.
    const big = JSON.stringify({ type: "deliver", text: "é".repeat(MAX_REQUEST_BYTES / 2 + 10) }) + "\n";
    expect(await rawRequest(address, big)).toEqual({ ok: false, error: "request too long" });
    expect(pi.sent).toEqual([]);
  });

  it("closes a connection that never finishes its request, and a stalled client does not hold up the session's end", async () => {
    const { socketDir, pi, porch } = await setUp();
    await pi.emit("session_start", { reason: "startup" });
    const address = path.join(socketDir, "pi-4242.sock");
    const idle = net.createConnection(address);
    idle.on("error", () => undefined);
    const closed = new Promise<void>((r) => idle.on("close", () => r()));
    idle.write('{"type":"deliver","te');
    await closed; // the 300 ms connection timeout set up in setUp
    const stalled = net.createConnection(address);
    stalled.on("error", () => undefined);
    await new Promise<void>((r) => stalled.on("connect", () => r()));
    stalled.write("{");
    const started = Date.now();
    await pi.emit("session_shutdown", { reason: "quit" });
    expect(Date.now() - started).toBeLessThan(250);
    expect((await porch.ctx.records.read(PI_HARNESS, "sess-1"))!.inside!.status).toBe("ended");
    stalled.destroy();
  });

  it("still writes the record, without a socket, when the socket folder is not private", async () => {
    const env = scratchEnv();
    const socketDir = mkdtempSync(path.join(os.tmpdir(), "pp-"));
    chmodSync(socketDir, 0o777);
    await expect(ensurePrivateDir(socketDir)).rejects.toThrow(/written by other users/);
    const pi = fakePi("sess-2", undefined);
    porchPiExtension(pi.api, { env: env as NodeJS.ProcessEnv, pid: 4243, processStartedAt: T0.toISOString(), socketDir, now: () => NOW });
    await pi.emit("session_start", { reason: "startup" });
    const porch = porchWith(env, psIO({ 4243: T0 }).io);
    const rec = await porch.ctx.records.read(PI_HARNESS, "sess-2");
    expect(rec!.inside!.delivery).toBeNull();
    expect(rec!.inside!.data!.lastError).toMatch(/written by other users/);
    expect((await porch.deliver("sess-2", "hi", { from: "t" })).result).toBe("failed");
    await pi.emit("session_shutdown", { reason: "quit" });
  });
});

describe("porch launch pi and porch extension pi", () => {
  it("adds -e <extension> first and passes everything else through unchanged", async () => {
    const r = await cli(["launch", "--dry-run", "pi", "--mode", "rpc", "--", "-p looks like a flag"], scratchEnv());
    expect(r.code).toBe(EXIT.ok);
    v["launch-plan"]!(r.json);
    expect(r.json).toMatchObject({ harness: "pi", command: NO_PI, args: ["-e", piExtensionPath(), "--mode", "rpc", "--", "-p looks like a flag"] });
    expect(r.stderr).toBe("");
  });

  it("passes Pi's subcommands through untouched: they start no session", async () => {
    for (const sub of PI_SUBCOMMANDS) {
      const r = await cli(["launch", "--dry-run", "pi", sub, "x"], scratchEnv());
      expect(r.json.args).toEqual([sub, "x"]);
    }
  });

  it("porch extension pi prints the same arguments launch adds, and the environment for --porch-home", async () => {
    const env = scratchEnv();
    const plain = await cli(["extension", "pi"], env);
    expect(plain.code).toBe(EXIT.ok);
    v["pi-extension"]!(plain.json);
    expect(plain.json).toEqual({ schema: 2, harness: "pi", extension: piExtensionPath(), porchHome: null, args: ["-e", piExtensionPath()], env: {} });
    const withHome = await cli(["extension", "pi", "--porch-home", "rel/dir"], env);
    expect(withHome.json).toMatchObject({ porchHome: path.resolve("rel/dir"), env: { PORCH_HOME: path.resolve("rel/dir") } });
    expect((await cli(["extension", "pi", "extra"], env)).code).toBe(EXIT.usage);
    expect((await cli(["extension", "pi", "--porch-home", " "], env)).code).toBe(EXIT.usage);
  });

  it("the extension file launch names is built", () => {
    expect(existsSync(piExtensionPath())).toBe(true);
  });
});
