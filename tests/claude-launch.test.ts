import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { claudeHookSettings, HOOK_EVENTS } from "../src/adapters/claude/hooks.js";
import { EXIT } from "../src/cli/exit-codes.js";
import type { Env } from "../src/home.js";
import { BIN, cli, NO_CLAUDE, scratchEnv, schemaValidators } from "./helpers.js";

const v = schemaValidators();

/** `porch launch --dry-run claude ...`: the plan, its settings parsed, and what went to stderr. */
async function plan(args: string[], env: Env = scratchEnv()) {
  const r = await cli(["launch", "--dry-run", "claude", ...args], env);
  expect(r.code, r.stdout).toBe(EXIT.ok);
  v["launch-plan"]!(r.json);
  const out = r.json as { command: string; args: string[] };
  expect(out.args[0]).toBe("--settings");
  return { command: out.command, settings: JSON.parse(out.args[1]!), rest: out.args.slice(2), stderr: r.stderr };
}

function porchHooks(porchHome: string | null = null) {
  return claudeHookSettings({ porchHome }).hooks;
}

const MARKER = { hooks: [{ type: "command", command: "touch marker" }] };

describe("porch launch claude (dry run)", () => {
  it("with no caller settings: one --settings first, holding Porch's hooks and crossSessionInbound accept", async () => {
    const env = scratchEnv();
    const p = await plan(["-p", "hi"], env);
    expect(p.command).toBe(NO_CLAUDE); // PORCH_CLAUDE_BIN, as the rest of the adapter uses
    expect(p.rest).toEqual(["-p", "hi"]);
    expect(p.settings).toEqual({ hooks: porchHooks(env.PORCH_HOME!), crossSessionInbound: "accept" });
    expect(p.stderr).toBe("");
  });

  it("bakes the records folder into the hooks: --porch-home, else PORCH_HOME, else none", async () => {
    const env = scratchEnv();
    const other = path.join(path.dirname(env.PORCH_HOME!), "elsewhere");
    const r = await cli(["launch", "--dry-run", "--porch-home", other, "claude"], env);
    expect(JSON.parse(r.json.args[1]).hooks).toEqual(porchHooks(other));
    const noHome = { ...env, PORCH_HOME: undefined };
    expect((await plan([], noHome)).settings.hooks).toEqual(porchHooks(null));
  });

  it("merges a settings file: the caller's hooks first per event, every other key kept", async () => {
    const env = scratchEnv();
    const file = path.join(path.dirname(env.PORCH_HOME!), "mine.json");
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [MARKER], PreToolUse: [MARKER] }, permissions: { allow: ["Bash(ls)"] }, model: "haiku" }));
    const p = await plan(["--bg", "--settings", file, "do it"], env);
    expect(p.rest).toEqual(["--bg", "do it"]);
    const porch = porchHooks(env.PORCH_HOME!);
    expect(p.settings.hooks.Stop).toEqual([MARKER, ...porch.Stop]);
    expect(p.settings.hooks.PreToolUse).toEqual([MARKER]);
    for (const event of HOOK_EVENTS.filter((e) => e !== "Stop")) expect(p.settings.hooks[event]).toEqual(porch[event]);
    expect(p.settings).toMatchObject({ permissions: { allow: ["Bash(ls)"] }, model: "haiku", crossSessionInbound: "accept" });
  });

  it("reads a relative settings file from the current folder", () => {
    const env = scratchEnv();
    const dir = path.join(path.dirname(env.PORCH_HOME!), "cwd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "rel.json"), JSON.stringify({ model: "relative" }));
    const r = spawnSync(process.execPath, [BIN, "launch", "--dry-run", "claude", "--settings", "rel.json"], {
      cwd: dir,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(JSON.parse(r.stdout).args[1]).model).toBe("relative");
  });

  it("takes a JSON string, and --settings=<value>", async () => {
    const inline = await plan(["--settings", JSON.stringify({ hooks: { SessionStart: [MARKER] } })]);
    expect(inline.settings.hooks.SessionStart[0]).toEqual(MARKER);
    expect(inline.settings.hooks.SessionStart).toHaveLength(2);
    const equals = await plan([`--settings=${JSON.stringify({ model: "m" })}`, "-c"]);
    expect(equals.settings.model).toBe("m");
    expect(equals.rest).toEqual(["-c"]);
  });

  it("uses the last --settings when given more than once, as Claude Code does, and removes them all", async () => {
    const p = await plan(["--settings", '{"model":"first"}', "-p", "x", "--settings", '{"effort":"low"}']);
    expect(p.settings.model).toBeUndefined();
    expect(p.settings.effort).toBe("low");
    expect(p.rest).toEqual(["-p", "x"]);
  });

  it("leaves everything after a bare -- alone", async () => {
    const p = await plan(["-p", "--", "--settings", '{"model":"not-mine"}', "--bare"]);
    expect(p.settings.model).toBeUndefined();
    expect(p.rest).toEqual(["-p", "--", "--settings", '{"model":"not-mine"}', "--bare"]);
    expect(p.stderr).toBe("");
  });

  it("keeps the caller's own crossSessionInbound", async () => {
    const p = await plan(["--settings", '{"crossSessionInbound":"refuse"}']);
    expect(p.settings.crossSessionInbound).toBe("refuse");
  });

  it("puts its --settings before a subcommand, and adds nothing else (-c, --resume, no --session-id)", async () => {
    expect((await plan(["mcp", "list"])).rest).toEqual(["mcp", "list"]);
    expect((await plan(["-c"])).rest).toEqual(["-c"]);
    const resume = await plan(["--bg", "--resume", "abc", "--fork-session"]);
    expect(resume.rest).toEqual(["--bg", "--resume", "abc", "--fork-session"]);
    for (const args of [["-c"], ["-p", "hi"], []]) {
      const p = await plan(args);
      expect(p.rest.some((a) => a.startsWith("--session-id"))).toBe(false);
      expect(p.rest.filter((a) => a === "--settings")).toEqual([]);
    }
  });

  it("warns once on stderr, and still launches, with --bare, --safe-mode or disableAllHooks", async () => {
    const bare = await plan(["--bare", "-p", "x"]);
    expect(bare.stderr).toBe("porch launch: Porch will not see this session: --bare turns off hooks from settings\n");
    const safe = await plan(["--safe-mode"]);
    expect(safe.stderr).toContain("--safe-mode turns off hooks");
    const disabled = await plan(["--safe-mode", "--settings", '{"disableAllHooks":true}']);
    expect(disabled.stderr).toBe(
      "porch launch: Porch will not see this session: --safe-mode and disableAllHooks in --settings turn off hooks from settings\n",
    );
    expect(disabled.settings.disableAllHooks).toBe(true);
  });

  it("refuses settings it cannot read or parse, before anything starts", async () => {
    const env = scratchEnv();
    const dir = path.dirname(env.PORCH_HOME!);
    writeFileSync(path.join(dir, "bad.json"), "{ not json");
    writeFileSync(path.join(dir, "list.json"), "[1]");
    const cases: [string[], RegExp][] = [
      [["--settings", path.join(dir, "missing.json")], /cannot read the --settings file .*missing\.json: no such file/],
      [["--settings", path.join(dir, "bad.json")], /is not valid JSON/],
      [["--settings", path.join(dir, "list.json")], /is not a JSON object/],
      [["--settings", "{oops"], /the --settings JSON is not valid JSON/],
      [["--settings", '{"hooks":[]}'], /"hooks" value is not a JSON object/],
      [["--settings", '{"hooks":{"Stop":{}}}'], /hooks for Stop are not a list/],
      [["-p", "--settings"], /--settings needs a value/],
      [["--settings", path.dirname(env.PORCH_HOME!)], /cannot read the --settings file/],
    ];
    for (const [args, message] of cases) {
      const r = await cli(["launch", "claude", ...args], env);
      expect(r.code, args.join(" ")).toBe(EXIT.usage);
      v.error!(r.json);
      expect(r.json.error.message).toMatch(message);
    }
  });
});
