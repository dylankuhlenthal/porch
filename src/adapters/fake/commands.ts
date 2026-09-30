/**
 * `porch fake ...`: drive the fake harness from a shell, so tests in other repos
 * (sous chef's, for example) can use it through the CLI alone. Each command prints
 * the session's observation afterwards, or the deliveries list.
 */
import { parseArgs } from "node:util";

import type { AdapterCommand, CommandContext } from "../../adapter.js";
import { jsonLine } from "../../cli/output.js";
import { PorchError } from "../../errors.js";
import { InvalidIdError } from "../../records.js";
import { SCHEMA_VERSION } from "../../types.js";
import { fakeObservation } from "./observe.js";
import { runFakeSession } from "./run.js";
import { fakeStatePath, parseState } from "./state.js";
import {
  endSession,
  FakeSessionError,
  killSession,
  readDeliveries,
  setFailDeliver,
  setInsideStatus,
  setPrompt,
  startSession,
  type FakeInsideStatus,
} from "./ops.js";

const INSIDE_STATUSES: FakeInsideStatus[] = ["starting", "busy", "idle"];

async function printObservation(ctx: CommandContext, session: string): Promise<number> {
  const state = parseState(await ctx.adapter.io.readFile(fakeStatePath(ctx.adapter.env)));
  const rec = await ctx.adapter.records.read("fake", session);
  ctx.stdout(jsonLine(fakeObservation(session, state.sessions[session], rec)));
  return 0;
}

function one(positionals: string[], usage: string): string {
  const [session, ...rest] = positionals;
  if (session === undefined || rest.length > 0) throw new PorchError("usage", `usage: ${usage}`);
  return session;
}

async function guard(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof FakeSessionError) throw new PorchError("not-found", err.message);
    if (err instanceof InvalidIdError) throw new PorchError("usage", err.message);
    throw err;
  }
}

function command(
  name: string,
  summary: string,
  usage: string,
  run: (args: string[], ctx: CommandContext) => Promise<number>,
): AdapterCommand {
  return { path: ["fake", name], summary, usage, run: (args, ctx) => guard(() => run(args, ctx)) };
}

export const fakeCommands: AdapterCommand[] = [
  command(
    "start",
    "start a fake session (with its record unless --no-inside)",
    "porch fake start <session> [--no-inside] [--pid <n>] [--status starting|busy|idle]",
    async (args, ctx) => {
      const usage = "porch fake start <session> [--no-inside] [--pid <n>] [--status starting|busy|idle]";
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { "no-inside": { type: "boolean" }, pid: { type: "string" }, status: { type: "string" } },
      });
      const session = one(positionals, usage);
      const pid = values.pid === undefined ? null : Number(values.pid);
      if (pid !== null && !Number.isInteger(pid)) throw new PorchError("usage", `--pid must be a whole number`);
      const status = (values.status ?? "idle") as FakeInsideStatus;
      if (!INSIDE_STATUSES.includes(status)) throw new PorchError("usage", `--status must be one of ${INSIDE_STATUSES.join(", ")}`);
      await startSession(ctx.adapter, session, { inside: !values["no-inside"], pid, status });
      return printObservation(ctx, session);
    },
  ),
  command(
    "set",
    "the session's inside part reports a status (and, optionally, turn times)",
    "porch fake set <session> starting|busy|idle [--last-turn-start <iso>] [--last-turn-end <iso>] [--background-tasks <n>]",
    async (args, ctx) => {
      const usage =
        "porch fake set <session> starting|busy|idle [--last-turn-start <iso>] [--last-turn-end <iso>] [--background-tasks <n>]";
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          "last-turn-start": { type: "string" },
          "last-turn-end": { type: "string" },
          "background-tasks": { type: "string" },
        },
      });
      const [session, status, ...rest] = positionals;
      if (session === undefined || status === undefined || rest.length > 0 || !INSIDE_STATUSES.includes(status as FakeInsideStatus)) {
        throw new PorchError("usage", `usage: ${usage}`);
      }
      const iso = (v: string | undefined, flag: string) => {
        if (v === undefined) return undefined;
        if (Number.isNaN(Date.parse(v))) throw new PorchError("usage", `${flag} must be an ISO 8601 time`);
        return new Date(v).toISOString();
      };
      let backgroundTasks: number | undefined;
      if (values["background-tasks"] !== undefined) {
        backgroundTasks = Number(values["background-tasks"]);
        if (!Number.isInteger(backgroundTasks) || backgroundTasks < 0) {
          throw new PorchError("usage", "--background-tasks must be a whole number, 0 or more");
        }
      }
      await setInsideStatus(ctx.adapter, session, status as FakeInsideStatus, {
        lastTurnStart: iso(values["last-turn-start"], "--last-turn-start"),
        lastTurnEnd: iso(values["last-turn-end"], "--last-turn-end"),
        backgroundTasks,
      });
      return printObservation(ctx, session);
    },
  ),
  command(
    "prompt",
    "open a permission prompt or dialog on the session, or close it with --clear",
    "porch fake prompt <session> (<text> | --clear)",
    async (args, ctx) => {
      const usage = "porch fake prompt <session> (<text> | --clear)";
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { clear: { type: "boolean" } } });
      const [session, text, ...rest] = positionals;
      if (session === undefined || rest.length > 0 || (text === undefined) === !values.clear) throw new PorchError("usage", `usage: ${usage}`);
      await setPrompt(ctx.adapter, session, values.clear ? null : (text ?? null));
      return printObservation(ctx, session);
    },
  ),
  command("kill", "the session dies and leaves its record behind", "porch fake kill <session>", async (args, ctx) => {
    const session = one(args, "porch fake kill <session>");
    await killSession(ctx.adapter, session);
    return printObservation(ctx, session);
  }),
  command(
    "end",
    "the session ends cleanly: its record says ended, with --reason (a launched one exits with --exit-code, default 0)",
    "porch fake end <session> [--reason <text>] [--exit-code <n>]",
    async (args, ctx) => {
      const usage = "porch fake end <session> [--reason <text>] [--exit-code <n>]";
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { "exit-code": { type: "string" }, reason: { type: "string" } },
      });
      const session = one(positionals, usage);
      let exitCode: number | undefined;
      if (values["exit-code"] !== undefined) {
        exitCode = Number(values["exit-code"]);
        if (!/^\d+$/.test(values["exit-code"]) || exitCode > 255) throw new PorchError("usage", "--exit-code must be a whole number from 0 to 255");
      }
      if (values.reason !== undefined && values.reason.trim() === "") throw new PorchError("usage", "--reason must not be empty");
      await endSession(ctx.adapter, session, { exitCode, reason: values.reason ?? null });
      return printObservation(ctx, session);
    },
  ),
  command(
    "run",
    "a fake session as a process, as `porch launch fake` starts it; exits when the session ends (see docs/domains/fake-adapter.md)",
    "porch fake run <session> [--no-inside]",
    async (args, ctx) => {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "no-inside": { type: "boolean" } } });
      const session = one(positionals, "porch fake run <session> [--no-inside]");
      return runFakeSession(ctx.adapter, session, { inside: !values["no-inside"] });
    },
  ),
  command(
    "fail-deliver",
    "make deliver to the session fail with a reason, or work again with --clear",
    "porch fake fail-deliver <session> (<reason> | --clear)",
    async (args, ctx) => {
      const usage = "porch fake fail-deliver <session> (<reason> | --clear)";
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { clear: { type: "boolean" } } });
      const [session, reason, ...rest] = positionals;
      if (session === undefined || rest.length > 0 || (reason === undefined) === !values.clear) throw new PorchError("usage", `usage: ${usage}`);
      await setFailDeliver(ctx.adapter, session, values.clear ? null : (reason ?? null));
      return printObservation(ctx, session);
    },
  ),
  command("deliveries", "every message delivered to fake sessions", "porch fake deliveries [<session>]", async (args, ctx) => {
    if (args.length > 1) throw new PorchError("usage", "usage: porch fake deliveries [<session>]");
    const deliveries = await readDeliveries(ctx.adapter, args[0]);
    ctx.stdout(jsonLine({ schema: SCHEMA_VERSION, deliveries }));
    return 0;
  }),
];
