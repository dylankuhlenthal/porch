# The fake adapter

A harness that runs nothing, for tests: Porch's own, and those of tools built on Porch (sous chef's, for example), which can drive it entirely through the CLI. It behaves like a harness with both an inside part and an outside listing, so it exercises every path in the core.

Code: `src/adapters/fake/` (`index.ts` the adapter, `observe.ts` how status is worked out, `state.ts` the harness file, `ops.ts` what can happen to a session, `commands.ts` the `porch fake` commands). Conformance driver: `src/conformance/drivers/fake.ts`.

## The fake harness file

`$PORCH_FAKE_STATE`, or `$PORCH_HOME/fake-harness.json`. It stands in for the harness's own view of its sessions. Its format is documented at the top of `src/adapters/fake/state.ts`. Tests may edit it directly or use the commands below. While the file does not exist, `porch adapters` reports the fake as not available and it lists nothing, so a real `porch list` shows no fake sessions.

## Commands

`porch --help` lists them with their flags. In short:

- `porch fake start <session> [--no-inside]`: a session starts. Without `--no-inside` its record is written, as a harness with Porch's inside part would.
- `porch fake set <session> starting|busy|idle`: the inside part reports a status (going busy sets `lastTurnStart`; busy to idle sets `lastTurnEnd`). `--last-turn-start`, `--last-turn-end` and `--background-tasks` set those fields directly, for example to model a record that still says busy although its last turn ended long ago.
- `porch fake prompt <session> <text>` and `--clear`: a permission prompt or dialog opens or closes. Only the harness file shows it, as with Claude Code.
- `porch fake kill <session>`: the session dies and leaves its record behind. `porch fake end <session>`: it ends cleanly and its record is removed.
- `porch fake fail-deliver <session> <reason>` and `--clear`: deliver fails with that reason.
- `porch fake deliveries [<session>]`: every message delivered, in order.

Each prints the session's observation afterwards (or the deliveries list).

## How status is worked out

In order (`fakeObservation` in `observe.ts`):

1. Not in the harness file, or `alive: false`: `gone`. A record left behind does not revive it.
2. A prompt is open: `waiting-on-prompt`.
3. The record's inside part has a status: that status and its `since`.
4. Otherwise (a session without the inside part): `unknown`.

`detail` has `pid`, `prompt`, `hasInsidePart`, `lastTurnStart`, `lastTurnEnd` and `backgroundTasks`. `raw` has the harness file row and the record.

## Other behaviour

- `current`: the `PORCH_FAKE_SESSION_ID` environment variable.
- `deliver`: `not-running` for a gone or unknown session; `failed` when told to fail; otherwise the message is appended to `deliveries` with the status at the moment of sending. `via` is the recorded address (`fake`), or `fake-listing` with `guessed: true` for a session without the inside part.
- Capabilities: queues while busy, sees prompts, has an outside listing and an inside part. Watch polls every 2 seconds as a backstop and also watches the harness file.

## What it relies on from the harness

Nothing: the fake harness is Porch's own file. Real adapters list here what they rely on, marked documented or observed, with the harness version (see `docs/patterns/adapter-contract.md`).
