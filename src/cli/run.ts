/**
 * The `porch` command, as a function so tests can run it in-process. src/cli/main.ts
 * wires it to the real process. Every command prints JSON on stdout (one document
 * per line); errors are JSON too, `{ schema, error: { code, message } }`, with the
 * exit codes in exit-codes.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import type { Adapter, AdapterCommand, LaunchPlan } from "../adapter.js";
import { PorchError } from "../errors.js";
import { errorMessage } from "../fsutil.js";
import type { Env } from "../home.js";
import type { HarnessIO } from "../io.js";
import { runLaunchPlan, signalExitCode } from "../launch.js";
import { Porch } from "../porch.js";
import { SCHEMA_VERSION, SELF_STATUSES, type ErrorResult } from "../types.js";
import { EXIT, exitCodeFor } from "./exit-codes.js";
import { jsonLine } from "./output.js";

export interface CliIO {
  env: Env;
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  /** Ends `porch watch`. main.ts aborts it on SIGINT and SIGTERM. */
  signal?: AbortSignal;
  /**
   * Runs `porch launch`'s plan and returns the exit code to end with. main.ts runs it
   * on the real terminal and, when a signal killed the harness, dies of that signal
   * (src/launch.ts). Default: run it and return the harness's exit code, or 128 plus
   * the signal's number.
   */
  runHarness?(plan: LaunchPlan, env: Env): Promise<number>;
}

export interface CliOptions {
  adapters?: Adapter[];
  harnessIO?: HarnessIO;
  now?: () => Date;
}

const CORE_USAGE = [
  "porch list [--harness <h>]                          every session Porch can see",
  "porch observe <session> [--harness <h>]             one session's state",
  "porch watch [--session <id>] [--harness <h>]        one JSON line per change, until stopped",
  "porch deliver <session> --from <label> [--harness <h>] (<text...> | -)",
  "                                                    send a message (- reads it from stdin)",
  "porch current                                       the session this command runs in",
  `porch status set <${SELF_STATUSES.join("|")}> [text...]`,
  "                                                    self-reported state of the calling session",
  "porch adapters                                      which harnesses are installed here",
  "porch launch [--porch-home <dir>] [--dry-run] <harness> [harness arguments...]",
  "                                                    start the harness with Porch attached",
];

const LAUNCH_USAGE = "porch launch [--porch-home <dir>] [--dry-run] <harness> [harness arguments...]";

/**
 * `porch launch`'s own options, up to the harness name. Everything after the harness
 * name belongs to the harness and passes through unchanged, so there is no `--`.
 */
export function parseLaunchArgs(args: string[]): { porchHome: string | null; dryRun: boolean; harness: string; rest: string[] } {
  let porchHome: string | null = null;
  let dryRun = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--porch-home" || arg.startsWith("--porch-home=")) {
      const value = arg === "--porch-home" ? args[++i] : arg.slice("--porch-home=".length);
      // A flag-shaped value is another option the caller forgot the folder before, not a folder.
      if (value === undefined || value.trim() === "" || value.startsWith("-")) throw new PorchError("usage", "--porch-home needs a folder");
      porchHome = value;
    } else if (arg.startsWith("-")) throw new PorchError("usage", `unknown option '${arg}' before the harness name; usage: ${LAUNCH_USAGE}`);
    else break;
  }
  const harness = args[i];
  if (harness === undefined) throw new PorchError("usage", `no harness given; usage: ${LAUNCH_USAGE}`);
  return { porchHome, dryRun, harness, rest: args.slice(i + 1) };
}

async function defaultRunHarness(plan: LaunchPlan, env: Env): Promise<number> {
  const outcome = await runLaunchPlan(plan, env);
  return outcome.signal !== null ? signalExitCode(outcome.signal) : (outcome.code ?? 1);
}

export function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

function helpText(adapters: Adapter[]): string {
  const extra = adapters.flatMap((a) => a.commands ?? []).map((c) => `${c.usage.padEnd(52)}${c.summary}`);
  return [
    "porch: wake any agent session and read its state, across harnesses.",
    "",
    "Usage:",
    ...CORE_USAGE.map((l) => `  ${l}`),
    ...(extra.length > 0 ? ["", "Harness commands:", ...extra.map((l) => `  ${l}`)] : []),
    "",
    "All output is JSON on stdout with \"schema\": 1. Errors are JSON too. Exit codes:",
    "  0 ok, 1 internal error, 2 usage, 3 session not found, 4 message not delivered,",
    "  5 not inside a session, 6 more than one session matches.",
    "porch launch prints nothing of its own once the harness has started: the output and",
    "  exit code are the harness's. Examples: alias claude='porch launch claude', alias pi='porch launch pi'.",
    "Records folder: $PORCH_HOME/sessions (default ~/.porch/sessions).",
    "",
  ].join("\n");
}

function findAdapterCommand(adapters: Adapter[], argv: string[]): { command: AdapterCommand; rest: string[] } | null {
  let best: AdapterCommand | null = null;
  for (const command of adapters.flatMap((a) => a.commands ?? [])) {
    const matches = command.path.every((part, i) => argv[i] === part);
    if (matches && (best === null || command.path.length > best.path.length)) best = command;
  }
  return best === null ? null : { command: best, rest: argv.slice(best.path.length) };
}

function parse(args: string[], options: Record<string, { type: "string" | "boolean" }>) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new PorchError("usage", errorMessage(err));
  }
}

/** node:util parseArgs failures (unknown flag, missing value), wherever an adapter command calls it. */
function isParseArgsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}

function noPositionals(positionals: string[], usage: string): void {
  if (positionals.length > 0) throw new PorchError("usage", `usage: ${usage}`);
}

export async function runCli(argv: string[], io: CliIO, options: CliOptions = {}): Promise<number> {
  const porch = new Porch({ env: io.env, adapters: options.adapters, io: options.harnessIO, now: options.now });
  const out = (value: unknown) => io.stdout(jsonLine(value));
  try {
    const [cmd, ...args] = argv;
    switch (cmd) {
      case undefined:
        io.stderr(helpText(porch.adapters));
        throw new PorchError("usage", "no command given; run porch --help");
      case "--help":
      case "-h":
      case "help":
        io.stdout(helpText(porch.adapters));
        return EXIT.ok;
      case "--version":
      case "-v":
        out({ schema: SCHEMA_VERSION, version: version() });
        return EXIT.ok;
      case "list": {
        const { values, positionals } = parse(args, { harness: { type: "string" } });
        noPositionals(positionals, "porch list [--harness <h>]");
        out(await porch.list(values.harness as string | undefined));
        return EXIT.ok;
      }
      case "observe": {
        const { values, positionals } = parse(args, { harness: { type: "string" } });
        if (positionals.length !== 1) throw new PorchError("usage", "usage: porch observe <session> [--harness <h>]");
        out(await porch.observe(positionals[0]!, values.harness as string | undefined));
        return EXIT.ok;
      }
      case "deliver": {
        const { values, positionals } = parse(args, { from: { type: "string" }, harness: { type: "string" } });
        const [session, ...words] = positionals;
        const usage = "porch deliver <session> --from <label> [--harness <h>] (<text...> | -)";
        if (session === undefined || typeof values.from !== "string") throw new PorchError("usage", `usage: ${usage}`);
        // A message piped in usually ends with a newline the sender did not mean to send.
        const text =
          words.length === 0 || (words.length === 1 && words[0] === "-")
            ? (await io.readStdin()).replace(/[\r\n]+$/, "")
            : words.join(" ");
        const result = await porch.deliver(session, text, {
          from: values.from,
          harness: values.harness as string | undefined,
        });
        out(result);
        return result.result === "delivered" ? EXIT.ok : EXIT.notDelivered;
      }
      case "current": {
        noPositionals(args, "porch current");
        out(await porch.current());
        return EXIT.ok;
      }
      case "status": {
        const [sub, status, ...words] = args;
        if (sub !== "set" || status === undefined) {
          throw new PorchError("usage", `usage: porch status set <${SELF_STATUSES.join("|")}> [text...]`);
        }
        out(await porch.statusSet(status, words.length > 0 ? words.join(" ") : null));
        return EXIT.ok;
      }
      case "watch": {
        const { values, positionals } = parse(args, { session: { type: "string" }, harness: { type: "string" } });
        noPositionals(positionals, "porch watch [--session <id>] [--harness <h>]");
        const signal = io.signal ?? new AbortController().signal;
        await porch.watch({
          harness: values.harness as string | undefined,
          session: values.session as string | undefined,
          signal,
          onObservation: (obs) => out(obs),
          onError: (harness, err) =>
            io.stderr(jsonLine({ schema: SCHEMA_VERSION, error: { code: "internal", message: `${harness}: ${errorMessage(err)}` } })),
        });
        return EXIT.ok;
      }
      case "adapters": {
        noPositionals(args, "porch adapters");
        const adapters = await Promise.all(
          porch.adapters.map(async (a) => {
            const detected = await a.detect(porch.ctx).catch((err: unknown) => ({
              available: false,
              version: null,
              reason: errorMessage(err),
            }));
            return { harness: a.harness, ...detected, capabilities: a.capabilities, inside: a.inside };
          }),
        );
        out({ schema: SCHEMA_VERSION, adapters });
        return EXIT.ok;
      }
      case "launch": {
        const parsed = parseLaunchArgs(args);
        // --porch-home also reaches the harness's environment, so commands run in the
        // session (`porch status set`) use the same records folder as its inside part.
        const env = parsed.porchHome === null ? io.env : { ...io.env, PORCH_HOME: path.resolve(parsed.porchHome) };
        const launcher = new Porch({ env, adapters: porch.adapters, io: options.harnessIO, now: options.now });
        const plan = await launcher.launchPlan(parsed.harness, parsed.rest, {
          warn: (message) => io.stderr(`porch launch: ${message}\n`),
        });
        if (parsed.dryRun) {
          out(plan);
          return EXIT.ok;
        }
        // From here on the harness owns stdout, stderr and the exit code (docs/reference/cli-output.md).
        return await (io.runHarness ?? defaultRunHarness)({ command: plan.command, args: plan.args }, env);
      }
      default: {
        const found = findAdapterCommand(porch.adapters, argv);
        if (found === null) throw new PorchError("usage", `unknown command '${cmd}'; run porch --help`);
        return await found.command.run(found.rest, {
          adapter: porch.ctx,
          stdout: io.stdout,
          stderr: io.stderr,
          readStdin: io.readStdin,
        });
      }
    }
  } catch (err) {
    const porchErr =
      err instanceof PorchError
        ? err
        : isParseArgsError(err)
          ? new PorchError("usage", errorMessage(err))
          : new PorchError("internal", errorMessage(err));
    const body: ErrorResult = { schema: SCHEMA_VERSION, error: { code: porchErr.code, message: porchErr.message } };
    out(body);
    return exitCodeFor(porchErr.code);
  }
}
