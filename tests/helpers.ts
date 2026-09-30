import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import type { Adapter } from "../src/adapter.js";
import { runCli } from "../src/cli/run.js";
import type { Env } from "../src/home.js";
import type { HarnessIO } from "../src/io.js";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(REPO, "dist", "cli", "main.js");

/** A `claude` command that does not exist, so the Claude adapter sees no Claude Code installed. */
export const NO_CLAUDE = "/nonexistent/porch-tests-have-no-claude";

/** A fresh scratch PORCH_HOME and HOME. Every test that touches files uses one. */
export function scratchEnv(extra: Env = {}): Env {
  const dir = mkdtempSync(path.join(os.tmpdir(), "porch-scratch-"));
  return {
    PATH: process.env.PATH,
    HOME: path.join(dir, "home"),
    PORCH_HOME: path.join(dir, "porch-home"),
    PORCH_CLAUDE_BIN: NO_CLAUDE,
    ...extra,
  };
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as one JSON document (throws if it is not exactly one). */
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  lines: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function parseOutput(code: number, stdout: string, stderr: string): CliRun {
  const parseLines = () =>
    stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  return {
    code,
    stdout,
    stderr,
    get lines() {
      return parseLines();
    },
    get json() {
      const lines = parseLines();
      if (lines.length !== 1) throw new Error(`expected one JSON line, got ${lines.length}: ${stdout}`);
      return lines[0];
    },
  };
}

/** Run the CLI in this process. */
export async function cli(
  argv: string[],
  env: Env,
  options: { stdin?: string; adapters?: Adapter[]; harnessIO?: HarnessIO; now?: () => Date } = {},
): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    argv,
    {
      env,
      stdout: (t) => {
        stdout += t;
      },
      stderr: (t) => {
        stderr += t;
      },
      readStdin: async () => options.stdin ?? "",
    },
    { adapters: options.adapters, harnessIO: options.harnessIO, now: options.now },
  );
  return parseOutput(code, stdout, stderr);
}

/** Run the built `porch` binary as a separate process (needs `npm run build`). */
export function bin(argv: string[], env: Env, stdin?: string): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...argv], { env: env as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve(parseOutput(code ?? -1, stdout, stderr)));
    child.stdin.end(stdin ?? "");
  });
}

/** Validators for every schema in schemas/, keyed by file name without ".schema.json". */
export function schemaValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats.default(ajv);
  const dir = path.join(REPO, "schemas");
  const files = readdirSync(dir).filter((f) => f.endsWith(".schema.json"));
  const schemas = files.map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
  for (const s of schemas) ajv.addSchema(s);
  const validators: Record<string, (value: unknown) => void> = {};
  files.forEach((f, i) => {
    const validate = ajv.getSchema(schemas[i].$id)!;
    validators[f.replace(".schema.json", "")] = (value: unknown) => {
      if (!validate(value)) {
        throw new Error(`${f}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value, null, 2)}`);
      }
    };
  });
  return validators;
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000, intervalMs = 20): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > deadline) throw new Error(`waitFor timed out${lastErr ? `: ${String(lastErr)}` : ""}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
