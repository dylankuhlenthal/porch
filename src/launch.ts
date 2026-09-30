/**
 * Runs a launch plan (`porch launch`): the harness starts as a child process on the
 * same terminal, and Porch stays in between only to pass back how it ended.
 *
 * - The keyboard signals the terminal sends to the whole foreground group (SIGINT
 *   from Ctrl+C, SIGQUIT from Ctrl+\) reach the harness directly, so Porch ignores
 *   them while the harness runs. One Ctrl+C must not end Porch and leave the
 *   harness without its parent.
 * - Signals sent to Porch alone (SIGTERM, SIGHUP) are passed on to the harness.
 * - Ctrl+Z (SIGTSTP) is left alone: it stops Porch along with the harness, as the
 *   shell expects of a job, and `fg` continues both.
 * - When the harness exits, Porch exits with its exit code, or, when a signal killed
 *   it, dies of the same signal (see `endLikeHarness`), so the shell sees what it
 *   would have seen running the harness directly.
 *
 * Node 22 has no `process.execve`, so Porch cannot replace itself with the harness.
 * docs/architecture.md ("Launch") and decision 0007 explain the choice.
 */
import { spawn } from "node:child_process";
import os from "node:os";

import type { LaunchPlan } from "./adapter.js";
import { PorchError } from "./errors.js";
import type { Env } from "./home.js";

export const IGNORED_SIGNALS = ["SIGINT", "SIGQUIT"] as const;
export const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP"] as const;

/** How the harness ended: its exit code, or the signal that killed it. */
export interface LaunchOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Start the plan's program with stdin, stdout and stderr shared, and resolve once it
 * has exited. A program that cannot be started at all (not found, not executable)
 * rejects with a PorchError before anything ran, so the caller can print Porch's
 * usual JSON error.
 */
export function runLaunchPlan(plan: LaunchPlan, env: Env): Promise<LaunchOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, { stdio: "inherit", env: env as NodeJS.ProcessEnv });
    let started = false;
    const ignore = () => undefined;
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    const handlers = new Map<NodeJS.Signals, (signal: NodeJS.Signals) => void>([
      ...IGNORED_SIGNALS.map((s) => [s, ignore] as const),
      ...FORWARDED_SIGNALS.map((s) => [s, forward] as const),
    ]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const done = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once("spawn", () => {
      started = true;
    });
    child.once("error", (err: NodeJS.ErrnoException) => {
      if (started) return; // an error after start (a failed kill) does not end the run
      done();
      reject(new PorchError("internal", `could not start ${plan.command}: ${err.code ?? err.message}`));
    });
    child.once("exit", (code, signal) => {
      done();
      resolve({ code, signal });
    });
  });
}

/** The exit status a shell reports for a process killed by `signal` (128 + its number). */
export function signalExitCode(signal: NodeJS.Signals): number {
  const n = os.constants.signals[signal];
  return typeof n === "number" ? 128 + n : 1;
}

/**
 * End this process the way the harness ended: set its exit code, or die of the same
 * signal. Every listener for that signal is removed first (Porch's own, which would
 * otherwise catch it). If the process is still alive afterwards (a signal Node
 * cannot die of), it exits with 128 plus the signal's number.
 */
export function endLikeHarness(outcome: LaunchOutcome): void {
  if (outcome.signal === null) {
    process.exitCode = outcome.code ?? 1;
    return;
  }
  process.removeAllListeners(outcome.signal);
  process.exitCode = signalExitCode(outcome.signal);
  try {
    process.kill(process.pid, outcome.signal);
  } catch {
    // the exit code set above stands
  }
}
