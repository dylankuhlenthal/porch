import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { builtinAdapters } from "../src/adapters/index.js";
import { EXIT } from "../src/cli/exit-codes.js";
import { parseLaunchArgs } from "../src/cli/run.js";
import { signalExitCode } from "../src/launch.js";
import { BIN, bin, cli, scratchEnv, schemaValidators, waitFor } from "./helpers.js";
import { stubAdapter } from "./stub-adapter.js";

const v = schemaValidators();

interface Launched {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout(): string;
}

/** `porch launch ...` as its own process in its own process group, like a job a shell started. */
function launch(argv: string[], env: Record<string, string | undefined>): Launched {
  const child = spawn(process.execPath, [BIN, "launch", ...argv], { env: env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", () => undefined);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, exited, stdout: () => stdout };
}

async function listed(env: Record<string, string | undefined>, session: string) {
  return waitFor(async () => {
    const r = await bin(["observe", session], env);
    return r.code === 0 && r.json.status !== "gone" ? r.json : null;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("porch launch: options", () => {
  it("takes Porch's own options only before the harness name and passes everything after it through", () => {
    expect(parseLaunchArgs(["claude", "-c", "--dry-run", "--porch-home", "x"])).toEqual({
      porchHome: null,
      dryRun: false,
      harness: "claude",
      rest: ["-c", "--dry-run", "--porch-home", "x"],
    });
    expect(parseLaunchArgs(["--porch-home", "/p", "--dry-run", "fake", "s1"])).toMatchObject({ porchHome: "/p", dryRun: true, harness: "fake", rest: ["s1"] });
    expect(parseLaunchArgs(["--porch-home=/q", "fake"])).toMatchObject({ porchHome: "/q", rest: [] });
  });

  it("refuses a missing harness, an unknown option before it, and an empty --porch-home", async () => {
    const env = scratchEnv();
    for (const argv of [["launch"], ["launch", "--bogus", "fake"], ["launch", "--porch-home"], ["launch", "--porch-home=", "fake"], ["launch", "--dry-run"]]) {
      const r = await cli(argv, env);
      expect(r.code, argv.join(" ")).toBe(EXIT.usage);
      v.error!(r.json);
    }
  });

  it("refuses an unknown harness and a harness whose adapter cannot launch, with a usage error", async () => {
    const env = scratchEnv();
    const unknown = await cli(["launch", "nope"], env);
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.json.error.message).toContain("unknown harness 'nope'");
    const cannot = await cli(["launch", "aa"], env, { adapters: [stubAdapter("aa")] });
    expect(cannot.code).toBe(EXIT.usage);
    expect(cannot.json.error).toEqual({ code: "usage", message: "the aa adapter cannot launch sessions" });
  });

  it("gives Porch's JSON error when the harness program cannot be started at all", async () => {
    const adapter = stubAdapter("aa", {
      capabilities: { ...stubAdapter("aa").capabilities, launch: true },
      launch: async () => ({ command: "/nonexistent/porch-test-harness", args: [] }),
    });
    const r = await cli(["launch", "aa"], scratchEnv(), { adapters: [adapter] });
    expect(r.code).toBe(EXIT.internal);
    expect(r.json.error.message).toMatch(/could not start \/nonexistent\/porch-test-harness: ENOENT/);
  });

  it("--dry-run prints the plan as JSON and starts nothing", async () => {
    const env = scratchEnv();
    const r = await bin(["launch", "--dry-run", "fake", "s1", "--no-inside"], env);
    expect(r.code).toBe(EXIT.ok);
    v["launch-plan"]!(r.json);
    expect(r.json).toEqual({ schema: 1, harness: "fake", command: process.execPath, args: [BIN, "fake", "run", "s1", "--no-inside"] });
    expect((await bin(["observe", "s1"], env)).code).toBe(EXIT.notFound);
  });

  it("every built-in adapter's launch capability says whether it has a launch method", () => {
    for (const adapter of builtinAdapters()) {
      expect(adapter.capabilities.launch, adapter.harness).toBe(typeof adapter.launch === "function");
    }
  });

  it("shows which adapters can launch in porch adapters", async () => {
    const r = await cli(["adapters"], scratchEnv());
    v.adapters!(r.json);
    const can = Object.fromEntries(r.json.adapters.map((a: { harness: string; capabilities: { launch: boolean } }) => [a.harness, a.capabilities.launch]));
    expect(can.fake).toBe(true);
  });
});

describe("porch launch: running the harness (fake)", () => {
  it("lists the session while it runs, prints nothing of its own, and exits with the harness's exit code", async () => {
    const env = scratchEnv();
    const run = launch(["fake", "s1"], env);
    const obs = await listed(env, "s1");
    expect(obs).toMatchObject({ harness: "fake", status: "idle", detail: { hasInsidePart: true } });
    expect(obs.detail.pid).not.toBe(run.child.pid); // the harness is a child, not Porch itself
    await bin(["fake", "end", "s1", "--exit-code", "7"], env);
    expect(await run.exited).toEqual({ code: 7, signal: null });
    expect(run.stdout()).toBe("");
  });

  it("a delivered message makes a launched fake session take a turn (busy, then idle)", async () => {
    const env = scratchEnv();
    const run = launch(["fake", "s1"], env);
    await listed(env, "s1");
    expect((await bin(["deliver", "s1", "--from", "t", "hi"], env)).json.result).toBe("delivered");
    await waitFor(async () => (await bin(["observe", "s1"], env)).json.detail.lastTurnEnd);
    expect((await bin(["observe", "s1"], env)).json.status).toBe("idle");
    await bin(["fake", "end", "s1"], env);
    expect(await run.exited).toEqual({ code: 0, signal: null });
  });

  it("dies of the signal that killed the harness", async () => {
    const env = scratchEnv();
    const run = launch(["fake", "s1"], env);
    await listed(env, "s1");
    await bin(["fake", "kill", "s1"], env);
    expect(await run.exited).toEqual({ code: null, signal: "SIGKILL" });
  });

  it("passes SIGTERM sent to Porch alone on to the harness, then dies of it", async () => {
    const env = scratchEnv();
    const run = launch(["fake", "s1"], env);
    await listed(env, "s1");
    run.child.kill("SIGTERM");
    expect(await run.exited).toEqual({ code: null, signal: "SIGTERM" });
    // The fake ended cleanly on SIGTERM, so its record is gone: it got the signal.
    expect((await bin(["observe", "s1"], env)).json.status).toBe("gone");
  });

  it("passes SIGHUP on too", async () => {
    const env = scratchEnv();
    const run = launch(["fake", "s1"], env);
    await listed(env, "s1");
    run.child.kill("SIGHUP");
    expect(await run.exited).toEqual({ code: null, signal: "SIGHUP" });
  });

  it("ignores Ctrl+C and Ctrl+\\ whether sent to Porch alone or to the whole terminal group", async () => {
    const env = scratchEnv();
    const run = launch(["fake", "s1"], env);
    await listed(env, "s1");
    run.child.kill("SIGINT");
    process.kill(-run.child.pid!, "SIGINT"); // the terminal sends Ctrl+C to the whole foreground group
    process.kill(-run.child.pid!, "SIGQUIT");
    await sleep(300);
    expect(run.child.exitCode).toBeNull();
    expect(run.child.signalCode).toBeNull();
    expect((await bin(["observe", "s1"], env)).json.status).toBe("idle");
    await bin(["fake", "end", "s1"], env);
    expect(await run.exited).toEqual({ code: 0, signal: null });
  });

  it("--porch-home puts the records there and gives the harness the same PORCH_HOME", async () => {
    const env = scratchEnv();
    const other = path.join(path.dirname(env.PORCH_HOME!), "other-home");
    const run = launch(["--porch-home", other, "fake", "s1"], env);
    const otherEnv = { ...env, PORCH_HOME: other };
    await listed(otherEnv, "s1");
    expect(existsSync(path.join(other, "sessions", "fake-s1.json"))).toBe(true);
    expect((await bin(["observe", "s1"], env)).code).toBe(EXIT.notFound);
    await bin(["fake", "end", "s1"], otherEnv);
    expect(await run.exited).toEqual({ code: 0, signal: null });
  });

  it("in process (the library path), returns 128 plus the signal's number for a harness killed by a signal", async () => {
    expect(signalExitCode("SIGKILL")).toBe(137);
    expect(signalExitCode("SIGTERM")).toBe(143);
  });
});
