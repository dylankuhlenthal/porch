/**
 * The `porch` command, as a function so tests can run it in-process. src/cli/main.ts
 * wires it to the real process. Every command prints JSON on stdout (one document
 * per line); errors are JSON too, `{ schema, error: { code, message } }`, with the
 * exit codes in exit-codes.ts.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import type { Adapter, AdapterCommand } from "../adapter.js";
import { PorchError } from "../errors.js";
import { errorMessage } from "../fsutil.js";
import type { Env } from "../home.js";
import type { HarnessIO } from "../io.js";
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
];

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
        const text = words.length === 0 || (words.length === 1 && words[0] === "-") ? await io.readStdin() : words.join(" ");
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
    const porchErr = err instanceof PorchError ? err : new PorchError("internal", errorMessage(err));
    const body: ErrorResult = { schema: SCHEMA_VERSION, error: { code: porchErr.code, message: porchErr.message } };
    out(body);
    return exitCodeFor(porchErr.code);
  }
}
