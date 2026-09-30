/**
 * How adapters read from the harness from outside: run a command (for example
 * `claude agents --json`) or read a file the harness owns. Adapters must do all such
 * reads through the HarnessIO in their context, never directly, so that a
 * conformance run can record what the harness returned and the per-PR tests can
 * replay it (see src/conformance/recorder.ts).
 *
 * Session records are not read through this: they are Porch's own files, and a
 * recording captures them separately.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";

import type { Env } from "./home.js";

export interface RunResult {
  /** Exit code, or null when the command could not be started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  env?: Env;
}

export interface HarnessIO {
  run(cmd: string, args: string[], options?: RunOptions): Promise<RunResult>;
  /** The file's text, or null when it does not exist. */
  readFile(file: string): Promise<string | null>;
}

export const realIO: HarnessIO = {
  run(cmd, args, options = {}) {
    return new Promise((resolve) => {
      execFile(
        cmd,
        args,
        {
          timeout: options.timeoutMs ?? 10000,
          env: options.env as NodeJS.ProcessEnv | undefined,
          maxBuffer: 16 * 1024 * 1024,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          if (err) {
            const code = typeof err.code === "number" ? err.code : null;
            resolve({ code, stdout: stdout ?? "", stderr: stderr || err.message });
            return;
          }
          resolve({ code: 0, stdout, stderr });
        },
      );
    });
  },
  async readFile(file) {
    try {
      return await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  },
};
