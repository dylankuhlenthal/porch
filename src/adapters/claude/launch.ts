/**
 * `porch launch claude ...`: the launch plan for Claude Code. It passes the caller's
 * arguments through and adds one thing, a single `--settings` holding Porch's hooks
 * merged with the caller's own settings:
 *
 * - The caller's `--settings` (a file path or a JSON string, written `--settings x`
 *   or `--settings=x`) is found up to a bare `--`. Claude Code keeps only the last
 *   one (observed with 2.1.285), so Porch does the same, and removes every one.
 * - Per hook event, the caller's entries come first, then Porch's. Every other key
 *   the caller set is kept.
 * - `crossSessionInbound: "accept"` is added unless the caller's settings set
 *   `crossSessionInbound`, so a launched session can be woken whatever its
 *   permission mode (decision 0008).
 * - The merged settings go first, as inline JSON, so a subcommand still works
 *   (`claude --settings '{}' mcp list` works, `claude mcp list --settings '{}'` does
 *   not) and a background session resumed later still has them (no temp file).
 *
 * With `--bare`, `--safe-mode` or `disableAllHooks`, Claude Code skips hooks from
 * settings, so the session still starts but one warning line says Porch will not see it.
 * docs/domains/claude-adapter.md ("Launching: porch launch claude") describes it.
 */
import path from "node:path";

import type { AdapterContext, LaunchOptions, LaunchPlan } from "../../adapter.js";
import { PorchError } from "../../errors.js";
import { errorMessage } from "../../fsutil.js";
import { claudeHookSettings } from "./hooks.js";
import { claudeBin } from "./listing.js";

/** Flags after which Claude Code runs no hooks from settings (from `claude --help`, 2.1.285). */
export const HOOKLESS_FLAGS = ["--bare", "--safe-mode"] as const;

interface FoundSettings {
  /** The value of the last `--settings`, or null when there is none. */
  value: string | null;
  /** The arguments with every `--settings` (and its value) removed. */
  rest: string[];
}

/** Find and remove the caller's `--settings`, up to a bare `--`. */
export function takeSettingsArgs(args: string[]): FoundSettings {
  const rest: string[] = [];
  let value: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      rest.push(...args.slice(i));
      break;
    }
    if (arg === "--settings") {
      const next = args[i + 1];
      if (next === undefined) throw new PorchError("usage", "--settings needs a value (a settings file or a JSON string)");
      value = next;
      i++;
    } else if (arg.startsWith("--settings=")) {
      value = arg.slice("--settings=".length);
    } else {
      rest.push(arg);
    }
  }
  return { value, rest };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The caller's settings as an object: parsed as JSON when the value starts with `{`
 * (as a JSON string passed on the command line does), otherwise read as a file,
 * relative to the current folder. Anything Porch cannot read or parse is a usage
 * error, before anything starts.
 */
export async function readCallerSettings(ctx: AdapterContext, value: string): Promise<Record<string, unknown>> {
  const inline = value.trimStart().startsWith("{");
  let text: string | null;
  const where = inline ? "the --settings JSON" : `the --settings file ${value}`;
  if (inline) text = value;
  else {
    const file = path.resolve(value);
    try {
      text = await ctx.io.readFile(file);
    } catch (err) {
      throw new PorchError("usage", `cannot read ${where}: ${errorMessage(err)}`);
    }
    if (text === null) throw new PorchError("usage", `cannot read ${where}: no such file`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PorchError("usage", `${where} is not valid JSON: ${errorMessage(err)}`);
  }
  if (!isObject(parsed)) throw new PorchError("usage", `${where} is not a JSON object`);
  return parsed;
}

/** The caller's settings with Porch's hooks appended per event, and crossSessionInbound unless the caller set it. */
export function mergeSettings(caller: Record<string, unknown>, porch: { hooks: Record<string, unknown[]> }): Record<string, unknown> {
  const callerHooks = caller.hooks ?? {};
  if (!isObject(callerHooks)) throw new PorchError("usage", "the --settings \"hooks\" value is not a JSON object");
  const hooks: Record<string, unknown> = { ...callerHooks };
  for (const [event, entries] of Object.entries(porch.hooks)) {
    const mine = callerHooks[event] ?? [];
    if (!Array.isArray(mine)) throw new PorchError("usage", `the --settings hooks for ${event} are not a list`);
    hooks[event] = [...mine, ...entries];
  }
  return {
    ...caller,
    hooks,
    ...("crossSessionInbound" in caller ? {} : { crossSessionInbound: "accept" }),
  };
}

export async function claudeLaunchPlan(ctx: AdapterContext, args: string[], options: LaunchOptions): Promise<LaunchPlan> {
  const found = takeSettingsArgs(args);
  const caller = found.value === null ? {} : await readCallerSettings(ctx, found.value);
  const settings = mergeSettings(caller, claudeHookSettings({ porchHome: options.porchHome }));
  const beforeDashes = found.rest.slice(0, found.rest.includes("--") ? found.rest.indexOf("--") : undefined);
  const hookless = HOOKLESS_FLAGS.filter((flag) => beforeDashes.includes(flag)) as string[];
  if (caller.disableAllHooks === true) hookless.push("disableAllHooks in --settings");
  if (hookless.length > 0) {
    options.warn(`Porch will not see this session: ${hookless.join(" and ")} ${hookless.length > 1 ? "turn" : "turns"} off hooks from settings`);
  }
  return { command: claudeBin(ctx.env), args: ["--settings", JSON.stringify(settings), ...found.rest] };
}
