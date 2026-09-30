# 0007: `porch launch` runs the harness as a child process sharing the terminal

**Date:** 2026-09-30
**Status:** Accepted

## Context
The simplest way for a launcher to disappear is to replace its own process with the harness (`execve`). Node 22.14, Porch's stack, has no `process.execve`; later Node versions add it as an experimental API. A shell function that `exec`s a command printed by Porch would work, but needs setup in every shell, and tools would not use it.

## Decision
Porch starts the harness as a child process with stdin, stdout and stderr shared (`runLaunchPlan` in `src/launch.ts`). While the harness runs, Porch ignores the keyboard signals the terminal sends to the whole foreground group anyway (SIGINT from Ctrl+C, SIGQUIT from Ctrl+\\), passes on the signals sent to Porch alone (SIGTERM, SIGHUP), and leaves Ctrl+Z (SIGTSTP) alone so it stops Porch along with the harness. When the harness exits, Porch exits with its exit code, or dies of the same signal that killed it (`endLikeHarness`). This was checked end to end with a real interactive Claude Code session, including Ctrl+Z and `fg` through a shell with job control.

## Consequences
One code path, the same for every harness, tested once in the core with the fake adapter. There is an extra Node process for the life of each launched session. Moving to `execve` later, once Porch's Node has it as a stable API, would change nothing callers can see.
