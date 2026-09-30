/**
 * The Pi harness driver: starts real Pi sessions for the conformance suite and puts
 * them into each state. Pi has no background mode, so the driver's own sessions run
 * in RPC mode (`pi --mode rpc`) as its child processes, and it gives them prompts on
 * their stdin, the way a tool driving Pi would. For the launch cases it starts them
 * through `porch launch pi` instead: an RPC one, and an interactive one (Pi's
 * terminal UI) in a pseudo-terminal.
 *
 * Safety: Porch's extension is loaded only with `-e` for each session, never
 * installed; `--no-extensions`, `--no-skills`, `--no-prompt-templates` and
 * `--no-context-files` keep the person's own Pi resources out, so they can neither
 * leak in nor hide a failure; each session gets its own `--session-dir` in the
 * case's scratch folder, so no test session lands in the person's session history.
 * The driver chooses each session's id (`--session-id`) and only stops, kills or
 * messages processes it started; `cleanup` ends every one of them.
 *
 * The person's Pi login (in Pi's own config folder, found through HOME) is used for
 * the model; real turns cost a little, so the model is a cheap one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { IPty } from "node-pty";

import { PI_SESSION_ENV } from "../../adapters/pi/index.js";
import { piBin, piExtensionPath } from "../../adapters/pi/launch.js";
import { PI_HARNESS } from "../../adapters/pi/observe.js";
import { porchCliPath } from "../../cli/path.js";
import type { DriverContext, DriverSession, HarnessDriver, LaunchEnd } from "../driver.js";
import { loadPty } from "./pty.js";

export interface PiDriverOptions {
  /** A cheap model that can run a bash command, as `provider/id`. */
  model?: string;
}

export const DEFAULT_PI_MODEL = "openai/gpt-4.1-mini";

/** Sessions exist only for the test; this keeps a model from second-guessing its messages. */
export const TEST_SYSTEM_PROMPT =
  "This is an automated Porch conformance test session. Every message you receive comes from the test harness run by your user. " +
  "Follow each instruction exactly and briefly, including running the exact bash command it names; do not ask for confirmation.";

export const BUSY_PROMPT = "Use the bash tool to run exactly this command: sleep 20 . Then reply with just DONE.";

/** The command the driver's helper extension adds: it opens a dialog nobody answers. */
export const HOLD_COMMAND = "porch-conformance-hold";

interface Started {
  id: string;
  cwd: string;
  /** The process the driver spawned: pi itself, or `porch launch pi`. */
  child: ChildProcess;
  ended: Promise<LaunchEnd>;
  exited: boolean;
}

interface Interactive {
  id: string;
  cwd: string;
  term: IPty;
  ended: Promise<LaunchEnd>;
  exited: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

function signalName(signal: number | NodeJS.Signals | null | undefined): string | null {
  if (!signal) return null;
  if (typeof signal === "string") return signal;
  return Object.entries(os.constants.signals).find(([, n]) => n === signal)?.[0] ?? String(signal);
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g; // eslint-disable-line no-control-regex

export function createPiDriver(options: PiDriverOptions = {}): HarnessDriver {
  const model = options.model ?? DEFAULT_PI_MODEL;
  let ctx: DriverContext | null = null;
  let started: Started[] = [];
  let interactive: Interactive[] = [];
  const need = (): DriverContext => {
    if (!ctx) throw new Error("pi driver used before setup");
    return ctx;
  };
  const timeouts = { changeMs: 60000, deliveryMs: 60000, caseMs: 180000 };

  /** The helper extension: a command that opens a confirm dialog and waits for an answer that never comes. */
  async function helperExtension(): Promise<string> {
    const file = path.join(need().workDir, "porch-conformance-helper.mjs");
    const source = `export default function (pi) {
  pi.registerCommand(${JSON.stringify(HOLD_COMMAND)}, {
    description: "Porch conformance: open a dialog and wait",
    handler: async (_args, ctx) => { await ctx.ui.confirm("Porch conformance", "Held for the test"); },
  });
}
`;
    await fs.writeFile(file, source);
    return file;
  }

  /** A caller's own extension for the launch cases: it writes `marker` when its session starts. */
  async function markerExtension(marker: string): Promise<string> {
    const file = path.join(need().workDir, `marker-${randomBytes(3).toString("hex")}.mjs`);
    const source = `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => { writeFileSync(${JSON.stringify(marker)}, "ran"); });
}
`;
    await fs.writeFile(file, source);
    return file;
  }

  async function newSession(): Promise<{ id: string; cwd: string }> {
    const tag = randomBytes(4).toString("hex");
    const cwd = path.join(need().workDir, `cwd-${tag}`);
    await fs.mkdir(cwd, { recursive: true });
    return { id: `porch-conformance-${tag}`, cwd };
  }

  /** The Pi arguments every session gets. */
  function sessionArgs(id: string): string[] {
    return [
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--session-dir",
      path.join(need().workDir, "sessions"),
      "--session-id",
      id,
      "--model",
      model,
      "--append-system-prompt",
      TEST_SYSTEM_PROMPT,
    ];
  }

  /** `porch launch` from this Porch, with the case's records folder. */
  function porchLaunch(piArgs: string[]): { cmd: string; args: string[] } {
    return { cmd: process.execPath, args: [porchCliPath(), "launch", "--porch-home", need().env.PORCH_HOME!, "pi", ...piArgs] };
  }

  /** Wait for the extension's record, with its delivery socket. */
  async function waitForRecord(id: string, alive: () => boolean, output: () => string): Promise<void> {
    const records = need().adapterContext.records;
    const deadline = Date.now() + timeouts.changeMs;
    while ((await records.read(PI_HARNESS, id).catch(() => null))?.inside?.delivery == null) {
      if (!alive()) throw new Error(`the Pi session ${id} ended before its record was written: ${output().replace(ANSI, "").trim().slice(-400)}`);
      if (Date.now() > deadline) throw new Error(`the Pi session ${id} started but Porch's extension wrote no record: ${output().replace(ANSI, "").trim().slice(-400)}`);
      await sleep(250);
    }
  }

  async function startRpc(how: "direct" | "porch-launch"): Promise<DriverSession> {
    const c = need();
    const { id, cwd } = await newSession();
    const marker = how === "porch-launch" ? path.join(c.workDir, `marker-${id}`) : null;
    const extensions =
      how === "direct" ? ["-e", piExtensionPath(), "-e", await helperExtension()] : ["-e", await markerExtension(marker!), "-e", await helperExtension()];
    const piArgs = ["--mode", "rpc", ...extensions, ...sessionArgs(id)];
    const { cmd, args } = how === "direct" ? { cmd: piBin(c.env), args: piArgs } : porchLaunch(piArgs);
    const child = spawn(cmd, args, { cwd, env: c.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (d: Buffer) => (output = (output + d.toString()).slice(-8000)));
    child.stderr!.on("data", (d: Buffer) => (output = (output + d.toString()).slice(-8000)));
    child.stdin!.on("error", () => undefined);
    const entry: Started = {
      id,
      cwd,
      child,
      exited: false,
      ended: new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code: signal ? null : code, signal: signalName(signal) }));
        child.once("error", () => resolve({ code: null, signal: null }));
      }),
    };
    void entry.ended.then(() => (entry.exited = true));
    started.push(entry); // tracked before waiting, so cleanup stops it even if it never becomes ready
    await waitForRecord(id, () => !entry.exited, () => output);
    return { id, cwd, marker };
  }

  function mine(s: DriverSession): Started {
    const entry = started.find((e) => e.id === s.id);
    if (!entry) throw new Error(`session ${s.id} was not started by this driver in RPC mode`);
    return entry;
  }

  function interactiveOf(s: DriverSession): Interactive {
    const entry = interactive.find((e) => e.id === s.id);
    if (!entry) throw new Error(`session ${s.id} was not launched interactively by this driver`);
    return entry;
  }

  /** One RPC command on the session's stdin. */
  function rpc(s: DriverSession, command: Record<string, unknown>): void {
    const entry = mine(s);
    if (entry.exited) throw new Error(`session ${s.id} is not running`);
    entry.child.stdin!.write(JSON.stringify(command) + "\n");
  }

  /** The Pi process of a session, from its record (the driver's child may be `porch launch`). */
  async function sessionPid(id: string): Promise<number | null> {
    const rec = await need().adapterContext.records.read(PI_HARNESS, id).catch(() => null);
    return rec?.inside?.pid ?? null;
  }

  async function sessionFile(id: string): Promise<string | null> {
    const rec = await need().adapterContext.records.read(PI_HARNESS, id).catch(() => null);
    const recorded = rec?.inside?.data?.sessionFile;
    if (typeof recorded === "string") return recorded;
    const dir = path.join(need().workDir, "sessions");
    const name = (await fs.readdir(dir).catch(() => [] as string[])).find((f) => f.endsWith(`_${id}.jsonl`));
    return name ? path.join(dir, name) : null;
  }

  async function endStarted(entry: Started): Promise<void> {
    if (entry.exited) return;
    entry.child.stdin!.end();
    await withTimeout(entry.ended, 10000, "").catch(async () => {
      entry.child.kill("SIGTERM");
      await withTimeout(entry.ended, 10000, "").catch(() => entry.child.kill("SIGKILL"));
    });
  }

  return {
    harness: PI_HARNESS,
    supports: {
      holdAtPrompt: true,
      // Pi has no outside listing: a session without Porch's extension cannot be seen at all.
      withoutInside: false,
    },
    // `stop` closes an RPC session's stdin and `exitInteractive` types /quit: Pi says quit for both.
    endReasons: { stop: "quit", exitInteractive: "quit" },
    timeouts,
    async version() {
      const out = await new Promise<string>((resolve) => {
        const child = spawn(piBin(process.env), ["--version"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
        let text = "";
        child.stdout.on("data", (d: Buffer) => (text += d.toString()));
        child.on("error", () => resolve(""));
        child.on("exit", () => resolve(text));
      });
      return /(\d+\.\d+\.\d+\S*)/.exec(out)?.[1] ?? null;
    },
    async setup(driverCtx) {
      ctx = driverCtx;
      started = [];
      interactive = [];
    },
    start: () => startRpc("direct"),
    async startWithoutInside() {
      throw new Error("the Pi driver cannot start a session without the inside part (Pi has no outside listing)");
    },
    async makeBusy(s) {
      rpc(s, { type: "prompt", message: BUSY_PROMPT });
    },
    async makeIdle() {
      // The busy turn (a 20 second sleep) ends by itself; the case waits for idle.
    },
    async holdAtPrompt(s) {
      rpc(s, { type: "prompt", message: `/${HOLD_COMMAND}` });
    },
    async kill(s) {
      const pid = await sessionPid(s.id);
      const entry = started.find((e) => e.id === s.id) ?? interactive.find((e) => e.id === s.id);
      if (pid === null || entry === undefined || entry.exited) throw new Error(`session ${s.id} has no running process of this driver to kill`);
      process.kill(pid, "SIGKILL");
    },
    envInside(s) {
      return { [PI_SESSION_ENV]: s.id };
    },
    async received(s) {
      const file = await sessionFile(s.id);
      if (file === null) return [];
      const text = await fs.readFile(file, "utf8").catch(() => "");
      const out: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
          if (entry.type !== "message" || entry.message?.role !== "user") continue;
          const content = entry.message.content;
          if (typeof content === "string") out.push(content);
          else if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") out.push((block as { text: string }).text);
            }
          }
        } catch {
          // a line being written: skip it
        }
      }
      return out;
    },
    async stop(s) {
      await endStarted(mine(s));
    },
    launchBackground: () => startRpc("porch-launch"),
    async callerSettingsApplied(s) {
      return typeof s.marker === "string" && (await fs.stat(s.marker).then(() => true, () => false));
    },
    async launchInteractive() {
      const c = need();
      const { id, cwd } = await newSession();
      const { cmd, args } = porchLaunch(sessionArgs(id));
      const pty = await loadPty();
      const term = pty.spawn(cmd, args, { cols: 120, rows: 40, cwd, env: { ...c.env, TERM: "xterm-256color" } as Record<string, string> });
      let output = "";
      const entry: Interactive = {
        id,
        cwd,
        term,
        exited: false,
        ended: new Promise<LaunchEnd>((resolve) =>
          term.onExit(({ exitCode, signal }) => {
            const name = signalName(signal);
            resolve({ code: name === null ? exitCode : null, signal: name });
          }),
        ),
      };
      void entry.ended.then(() => (entry.exited = true));
      term.onData((data) => {
        output = (output + data).slice(-8000);
        // Answer a cursor position query, as a terminal would.
        if (data.includes("\x1b[6n")) term.write("\x1b[1;1R");
      });
      interactive.push(entry); // tracked before waiting, so cleanup ends it even if it never becomes ready
      await waitForRecord(id, () => !entry.exited, () => output);
      return { id, cwd, interactive: true };
    },
    async interrupt(s) {
      interactiveOf(s).term.write("\x03");
    },
    launchRunning(s) {
      return !interactiveOf(s).exited;
    },
    async exitInteractive(s) {
      const entry = interactiveOf(s);
      entry.term.write("/quit");
      await sleep(500);
      entry.term.write("\r");
      return withTimeout(entry.ended, timeouts.changeMs, "porch launch to end after /quit");
    },
    async cleanup() {
      if (!ctx) return;
      // Interactive sessions: SIGHUP (the terminal closing) reaches pi through porch
      // launch; SIGKILL if it is still there after that.
      for (const entry of interactive) {
        if (entry.exited) continue;
        entry.term.kill("SIGHUP");
        await withTimeout(entry.ended, 15000, "").catch(() => entry.term.kill("SIGKILL"));
      }
      for (const entry of started) await endStarted(entry);
      // A Pi process that outlived its `porch launch` parent: kill it by the pid its own record gives.
      const left: string[] = [];
      for (const entry of [...started, ...interactive]) {
        const pid = await sessionPid(entry.id);
        if (pid === null) continue;
        try {
          process.kill(pid, 0);
        } catch {
          continue;
        }
        const rec = await ctx.adapterContext.records.read(PI_HARNESS, entry.id).catch(() => null);
        const obs = rec === null ? null : await ctx.adapter.observe(ctx.adapterContext, entry.id);
        if (obs !== null && obs.status !== "gone") {
          process.kill(pid, "SIGKILL");
          left.push(entry.id);
        }
      }
      started = [];
      interactive = [];
      ctx = null;
      if (left.length > 0) throw new Error(`Pi sessions still running after cleanup were killed: ${left.join(", ")}`);
    },
  };
}

