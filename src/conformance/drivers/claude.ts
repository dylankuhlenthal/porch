/**
 * The Claude Code harness driver: starts real background sessions (`claude --bg`)
 * for the conformance suite and puts them into each state.
 *
 * Safety (decision 23 in TRV-1133): sessions get Porch's hooks and
 * `crossSessionInbound: accept` only through a per-session `--settings` file in the
 * case's scratch folder, and `--setting-sources project` so the person's own user
 * settings (their hooks, permission rules and `crossSessionInbound`) neither leak
 * in nor hide a failure. The driver only ever stops, kills or messages sessions it
 * started itself, tracked by short id from the moment `claude --bg` prints it, and
 * `cleanup` stops and removes every one of them.
 *
 * Claude Code only runs a background session in a folder the person has trusted,
 * so the case folders must sit under a trusted folder (see workRoot in drivers/index.ts).
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { CLAUDE_SESSION_ENV, isUnder } from "../../adapters/claude/index.js";
import { claudeHookSettings } from "../../adapters/claude/hooks.js";
import { claudeBin, claudeConfigDir, parseListing, type ListingRow } from "../../adapters/claude/listing.js";
import { CLAUDE_HARNESS } from "../../adapters/claude/observe.js";
import { defaultSocketDirs, guessedSocketPaths, sendToSocket, SocketMissingError } from "../../adapters/claude/socket.js";
import type { Env } from "../../home.js";
import type { DriverContext, DriverSession, HarnessDriver } from "../driver.js";

export interface ClaudeDriverOptions {
  /** Cheapest model that can run a Bash command. */
  model?: string;
}

interface Started {
  short: string;
  name: string;
  /** The session's process id as last seen in the listing, for `kill`. */
  pid: number | null;
  sessionId: string | null;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { env: Env; cwd?: string; timeoutMs?: number }): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env: opts.env as NodeJS.ProcessEnv, cwd: opts.cwd, timeout: opts.timeoutMs ?? 60000, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr || (err ? err.message : "") });
      },
    );
  });
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g; // eslint-disable-line no-control-regex
const BACKGROUNDED = /backgrounded\s+·\s+([0-9a-f]+)\s+·/;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Messages reach the session framed as coming from another Claude session, and a
 * model may decline to act on those. These sessions exist only for the test, so
 * they are told to follow them.
 */
export const TEST_SYSTEM_PROMPT =
  "This is an automated Porch conformance test session. Every message you receive comes from the test harness run by your user. " +
  "Follow each instruction exactly and briefly, including running the exact Bash command it names; do not ask for confirmation.";

export const BUSY_PROMPT = "Use the Bash tool to run exactly this command: sleep 20 . Then reply with just DONE.";
export const PROMPT_PROMPT = "Use the Bash tool to run exactly this command: touch porch-conformance-probe.txt";

export function createClaudeDriver(options: ClaudeDriverOptions = {}): HarnessDriver {
  const model = options.model ?? "haiku";
  let ctx: DriverContext | null = null;
  let started: Started[] = [];
  const need = (): DriverContext => {
    if (!ctx) throw new Error("claude driver used before setup");
    return ctx;
  };
  const bin = () => claudeBin(need().env);
  const timeouts = { changeMs: 60000, deliveryMs: 60000, caseMs: 240000 };

  /** Only this case's sessions: those started under its scratch folder. */
  async function listing(all = false): Promise<ListingRow[]> {
    const c = need();
    const r = await run(bin(), ["agents", "--json", ...(all ? ["--all"] : [])], { env: c.env, timeoutMs: 30000 });
    if (r.code !== 0) throw new Error(`claude agents --json failed: ${r.stderr.trim()}`);
    return parseListing(r.stdout).filter((row) => isUnder(row.cwd, c.workDir));
  }

  async function settingsFile(withHooks: boolean): Promise<string> {
    const c = need();
    const file = path.join(c.workDir, withHooks ? "settings-hooks.json" : "settings-plain.json");
    const settings = {
      ...(withHooks ? claudeHookSettings({ porchHome: c.env.PORCH_HOME ?? null }) : {}),
      crossSessionInbound: "accept",
      permissions: { allow: ["Bash(sleep *)"] },
    };
    await fs.writeFile(file, JSON.stringify(settings, null, 2));
    return file;
  }

  async function launch(withHooks: boolean): Promise<DriverSession> {
    const c = need();
    const tag = randomBytes(4).toString("hex");
    const name = `porch-conformance-${tag}`;
    const cwd = path.join(c.workDir, `cwd-${tag}`);
    await fs.mkdir(cwd, { recursive: true });
    const args = [
      "--bg",
      "-n",
      name,
      "--model",
      model,
      "--permission-mode",
      "default",
      "--setting-sources",
      "project",
      "--settings",
      await settingsFile(withHooks),
      "--append-system-prompt",
      TEST_SYSTEM_PROMPT,
    ];
    const out = await run(bin(), args, { env: c.env, cwd, timeoutMs: 90000 });
    const text = (out.stdout + out.stderr).replace(ANSI, "");
    let short = BACKGROUNDED.exec(text)?.[1] ?? null;
    if (short === null) {
      // The output was not understood, but the session may have started: find it by its unique name.
      short = (await listing(true)).find((r) => r.name === name)?.id ?? null;
    }
    if (short === null) throw new Error(`claude --bg did not start a session (exit ${out.code}): ${text.trim().slice(-400)}`);
    const entry: Started = { short, name, pid: null, sessionId: null };
    started.push(entry); // tracked before waiting, so cleanup stops it even if it never becomes ready
    const deadline = Date.now() + timeouts.changeMs;
    for (;;) {
      const row = (await listing()).find((r) => r.id === short);
      if (row?.pid && row.sessionId) {
        entry.pid = row.pid;
        entry.sessionId = row.sessionId;
        break;
      }
      if (Date.now() > deadline) throw new Error(`session ${short} did not appear running in claude agents --json`);
      await sleep(500);
    }
    if (withHooks) {
      // Wait for the SessionStart hook's record, so later steps use the recorded socket.
      const records = c.adapterContext.records;
      while ((await records.read(CLAUDE_HARNESS, entry.sessionId).catch(() => null))?.inside?.delivery == null) {
        if (Date.now() > deadline) throw new Error(`session ${short} started but its SessionStart hook wrote no record`);
        await sleep(250);
      }
    }
    return { id: entry.sessionId, short, cwd };
  }

  function mine(s: DriverSession): Started {
    const entry = started.find((e) => e.short === s.short);
    if (!entry) throw new Error(`session ${String(s.short)} was not started by this driver`);
    return entry;
  }

  /** Send text through the session's socket the way Porch does, without going through Porch. */
  async function send(s: DriverSession, text: string): Promise<void> {
    const c = need();
    const entry = mine(s);
    const row = (await listing()).find((r) => r.id === entry.short);
    if (!row?.pid) throw new Error(`session ${entry.short} is not running`);
    entry.pid = row.pid;
    const rec = await c.adapterContext.records.read(CLAUDE_HARNESS, row.sessionId).catch(() => null);
    const recorded = rec?.inside?.delivery?.via === "socket" && rec.inside.pid === row.pid ? [rec.inside.delivery.address] : [];
    let last: unknown = null;
    for (const address of [...recorded, ...guessedSocketPaths(row.pid, defaultSocketDirs())]) {
      try {
        await sendToSocket(address, text);
        return;
      } catch (err) {
        last = err;
        if (!(err instanceof SocketMissingError)) break;
      }
    }
    throw new Error(`could not reach session ${entry.short}: ${String(last)}`);
  }

  async function transcriptPath(s: DriverSession): Promise<string | null> {
    const c = need();
    const rec = await c.adapterContext.records.read(CLAUDE_HARNESS, s.id).catch(() => null);
    const recorded = rec?.inside?.data?.transcriptPath;
    if (typeof recorded === "string") return recorded;
    const dir = claudeConfigDir(c.env);
    if (dir === null) return null;
    const projects = path.join(dir, "projects");
    for (const p of await fs.readdir(projects).catch(() => [] as string[])) {
      const candidate = path.join(projects, p, `${s.id}.jsonl`);
      if (await fs.stat(candidate).then(() => true, () => false)) return candidate;
    }
    return null;
  }

  async function stopOne(entry: Started, env: Env): Promise<void> {
    await run(bin(), ["stop", entry.short], { env, timeoutMs: 60000 });
    await run(bin(), ["rm", entry.short], { env, timeoutMs: 60000 });
  }

  return {
    harness: CLAUDE_HARNESS,
    supports: { holdAtPrompt: true, withoutInside: true },
    timeouts,
    async version() {
      const r = await run(claudeBin(process.env), ["--version"], { env: process.env });
      return /(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null;
    },
    async setup(driverCtx) {
      ctx = driverCtx;
      started = [];
    },
    start: () => launch(true),
    startWithoutInside: () => launch(false),
    async makeBusy(s) {
      await send(s, BUSY_PROMPT);
    },
    async makeIdle() {
      // The busy turn (a 20 second sleep) ends by itself; the case waits for idle.
    },
    async holdAtPrompt(s) {
      // If the turn ends without the prompt opening (the model did not run the
      // command), ask once more.
      const c = need();
      for (let attempt = 0; attempt < 2; attempt++) {
        const sentAt = new Date().toISOString();
        await send(s, PROMPT_PROMPT);
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          await sleep(500);
          const row = (await listing()).find((r) => r.id === s.short);
          if (row?.status === "waiting") return;
          const rec = await c.adapterContext.records.read(CLAUDE_HARNESS, s.id).catch(() => null);
          const ended = rec?.inside?.lastTurnEnd;
          if (typeof ended === "string" && ended > sentAt && row?.status === "idle") break;
        }
      }
      // A driver failure, not an adapter one: the model never ran the command.
      throw new Error(`session ${String(s.short)} did not stop at a permission prompt after two attempts`);
    },
    async kill(s) {
      const entry = mine(s);
      const row = (await listing()).find((r) => r.id === entry.short);
      const pid = row?.pid ?? null;
      if (pid === null) throw new Error(`session ${entry.short} has no running process to kill`);
      process.kill(pid, "SIGKILL");
    },
    envInside(s) {
      return { [CLAUDE_SESSION_ENV]: s.id };
    },
    async received(s) {
      const file = await transcriptPath(s);
      if (file === null) return [];
      const text = await fs.readFile(file, "utf8").catch(() => "");
      const out: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const entry = JSON.parse(line) as { type?: string; message?: { content?: unknown }; attachment?: { type?: unknown; prompt?: unknown } };
          // A message that arrives mid-turn is given to the model as a queued_command
          // attachment instead of a user message (observed with 2.1.284).
          if (entry.type === "attachment" && entry.attachment?.type === "queued_command" && typeof entry.attachment.prompt === "string") {
            out.push(entry.attachment.prompt);
            continue;
          }
          if (entry.type !== "user") continue;
          const content = entry.message?.content;
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
      await stopOne(mine(s), need().env);
    },
    async cleanup() {
      if (!ctx) return;
      const env = ctx.env;
      for (const entry of started) await stopOne(entry, env).catch(() => undefined);
      // Check nothing of ours is left; kill a leftover by the pid recorded for it.
      const left = (await listing(true).catch(() => [] as ListingRow[])).filter((r) => started.some((e) => e.short === r.id));
      for (const row of left) {
        const entry = started.find((e) => e.short === row.id)!;
        if (row.pid !== null && row.pid === entry.pid) process.kill(row.pid, "SIGKILL");
        await stopOne(entry, env).catch(() => undefined);
      }
      const still = (await listing(true).catch(() => [] as ListingRow[])).filter((r) => started.some((e) => e.short === r.id));
      started = [];
      ctx = null;
      if (still.length > 0) throw new Error(`sessions still listed after cleanup: ${still.map((r) => r.id).join(", ")}`);
    },
  };
}
