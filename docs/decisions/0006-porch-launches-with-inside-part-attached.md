# 0006: Porch launches a harness with its inside part attached, and nothing else

**Date:** 2026-09-30
**Status:** Accepted

## Context
A session is visible to Porch only when the adapter's inside part runs in it (for Claude Code, Porch's hooks in the session's settings). Until now every caller that started sessions (a tool built on Porch, a person at a terminal) had to fetch the hook settings with `porch hooks claude` and merge them into its own settings itself, and Porch's scope said it does not launch sessions at all. The alternative was to keep launching out of Porch and leave every caller to do that merge.

## Decision
Porch gains `porch launch <harness> [harness arguments...]`, a helper that starts the harness with Porch's inside part attached and does nothing else. Deciding when to launch, and everything around a launch (briefs, kinds, worktrees, resume, stop, cleanup, orchestration), stays with the tools on top of Porch. Attaching the inside part is what makes a session visible to Porch, so it is Porch's job. Each adapter builds its own launch plan (the optional `launch` method in `src/adapter.ts`); the core runs it (`src/launch.ts`).

## Consequences
A person can put `alias claude='porch launch claude'` in their shell and every session they start has Porch attached, and a tool that starts sessions can launch through Porch instead of building Porch's settings. Adapters whose harness cannot load the inside part for one session leave `launch` out. Porch's scope line (`AGENTS.md`, `docs/architecture.md`) now includes this helper.
