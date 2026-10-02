# The fake adapter

A harness that runs nothing, for tests: Porch's own, and those of tools built on Porch (in any language), which can drive it entirely through the CLI. It behaves like a harness with both an inside part and an outside listing, so it exercises every path in the core.

Code: `src/adapters/fake/` (`index.ts` the adapter, `observe.ts` how status is worked out, `state.ts` the harness file, `ops.ts` what can happen to a session, `commands.ts` the `porch fake` commands, `run.ts` a fake session as a process). Conformance driver: `src/conformance/drivers/fake.ts`.

## The fake harness file

`$PORCH_FAKE_STATE`, or `$PORCH_HOME/fake-harness.json`. It stands in for the harness's own view of its sessions. Its format is documented at the top of `src/adapters/fake/state.ts`. Tests may edit it directly or use the commands below. While the file does not exist, `porch adapters` reports the fake as not available and it lists no sessions of its own, so a real `porch list` shows no fake sessions unless a `fake-*` record exists (for example one written by `porch status set` with `PORCH_FAKE_SESSION_ID` set), which then shows as `gone`.

## Commands

`porch --help` lists them with their flags. In short:

- `porch fake start <session> [--no-inside]`: a session starts. Without `--no-inside` its record is written, as a harness with Porch's inside part would.
- `porch fake set <session> starting|busy|idle`: the inside part reports a status (going busy sets `lastTurnStart`; busy to idle sets `lastTurnEnd`). `--last-turn-start`, `--last-turn-end` and `--background-tasks` set those fields directly, for example to model a record that still says busy although its last turn ended long ago.
- `porch fake prompt <session> <text>` and `--clear`: a permission prompt or dialog opens or closes. Only the harness file shows it, as with Claude Code.
- `porch fake kill <session>`: the session dies and leaves its record behind (it shows as `gone`). `porch fake end <session> [--reason <text>] [--exit-code <n>]`: it ends cleanly and its record is marked `ended`, with `--reason` as its `endReason` (null without it); a launched session's process exits with `<n>` (default 0).
- `porch fake run <session> [--no-inside]`: a fake session as a real process, which is what `porch launch fake` starts (below). It runs until the session ends.
- `porch fake fail-deliver <session> <reason>` and `--clear`: deliver fails with that reason.
- `porch fake deliveries [<session>]`: every message delivered, in order.

Each prints the session's observation afterwards (except `run`, which prints nothing) (`schemas/observation.schema.json`), or the deliveries list (`schemas/fake-deliveries.schema.json`).

From Node, the same operations are the `fake` namespace of `@dylankuhlenthal/porch/testing`, with `createFakeAdapter` to pass in `PorchOptions.adapters` (`src/testing.ts`, `docs/reference/library.md`).

## How status is worked out

In order (`fakeObservation` in `observe.ts`):

1. The record's inside part says `ended`: `ended`, with `since` its `endedAt` and its `endReason`.
2. Not in the harness file, or `alive: false`: `gone`. A record left behind does not revive it.
3. A prompt is open: `waiting-on-prompt`.
4. The record's inside part has a status: that status and its `since`. `porch fake set` never changes an ended session's status.
5. Otherwise (a session without the inside part): `unknown`.

A session is attached (`attached: true`) when its record has an inside part, so a session started with `porch fake start <s> --no-inside` shows in `porch list` only with `--all`.

`detail` has `pid`, `prompt`, `hasInsidePart`, `lastTurnStart`, `lastTurnEnd` and `backgroundTasks`. `raw` has the harness file row and the record.

## Launching: `porch launch fake` and `porch fake run`

`porch launch fake <session> [--no-inside]` runs `porch fake run <session> [--no-inside]` with this same Porch (the node running it and its `dist/cli/main.js`), so the per-PR tests can check how `porch launch` handles a harness process without a real harness. The records folder reaches it through `PORCH_HOME` in its environment, which `porch launch --porch-home` sets. `porch fake run` (`runFakeSession` in `run.ts`), run as its own process:

- registers the session with the fake harness, with its own pid, and writes its record unless `--no-inside`;
- reads the fake harness file every 50 ms and follows it: each message delivered to the session is a turn (busy for half a second, then idle, when it has a record); `porch fake end` makes it exit with the `--exit-code` given there; `porch fake kill` makes it die of SIGKILL, like a crash;
- ignores SIGINT and SIGQUIT, like an interactive harness where one Ctrl+C does not end it; on SIGTERM or SIGHUP it ends cleanly (its record is marked `ended`, with the signal's name, for example `SIGTERM`, as `endReason`) and dies of that signal.

The harness file row's `exitCode` holds the code from `porch fake end` (null while running and after a kill).

## Other behaviour

- `current`: the `PORCH_FAKE_SESSION_ID` environment variable.
- `deliver`: `not-running` for a session that is ended or gone, or that the fake harness does not know (a running session whose status is `unknown`, because it has no inside part, is delivered to); `failed` when told to fail; otherwise the message is appended to `deliveries` with the status at the moment of sending. `via` is the recorded address (`fake`), or `fake-listing` with `guessed: true` for a session without the inside part.
- Capabilities: queues while busy, sees prompts, has an outside listing and an inside part, can launch. Watch polls every 2 seconds as a backstop and also watches the harness file.

## What it relies on from the harness

Nothing: the fake harness is Porch's own file. Real adapters list here what they rely on, marked documented or observed, with the harness version (see `docs/patterns/adapter-contract.md`).
