# Writing an adapter

This is the approved way to add support for a harness to Porch. The contract itself is the `Adapter` interface in `src/adapter.ts`; read it alongside this page. The canonical example is the fake adapter (`src/adapters/fake/`, described in `docs/domains/fake-adapter.md`).

## What an adapter is made of

1. **An inside part** that runs within each session and keeps the session's record up to date: for example Claude Code hook commands or a Pi extension. It is how Porch sees busy and idle as they happen, and how it learns the delivery address.
2. **An outside part**: the `Adapter` object, which the core calls from any process.
3. **A harness driver** for the conformance suite (`docs/patterns/conformance.md`).
4. **A doc** at `docs/domains/<harness>-adapter.md`.

Register the adapter in `builtinAdapters()` (`src/adapters/index.ts`) and its driver in `DRIVERS` (`src/conformance/drivers/index.ts`).

## The inside part

- Write the record only through `RecordStore` (`src/records.ts`): `updateInside(harness, session, patch)` on each event and `remove(harness, session)` when the session ends cleanly. If an event can arrive after the session's end removed the record (Claude Code hooks can), use `updateInsideIfExists` for every event but the session's start, so the late event does not bring back a record nobody will remove. Never write the file yourself, and never touch the `self` part: `porch status set` owns it (decision 0004, Porch writes self-reported state).
- Use the shared fields where they fit: `pid`, `status` (`starting`, `busy` or `idle`; `since` is filled in when status changes), `delivery` (`{ via, address }`), `cwd`, `lastTurnStart`, `lastTurnEnd`, `backgroundTasks`. Put anything else in `data`.
- If the inside part is a set of commands the harness runs (hooks), add them as adapter commands (below), so they run as `porch ...` and get a `CommandContext` whose `adapter.records` is the record store for the right `PORCH_HOME`.
- Anything the inside part installs is printed or installed only when a person or tool asks (`porch hooks claude`, `porch install pi`). Porch changes no harness settings by itself.

## The outside part

Every method gets an `AdapterContext`. **Read the environment only from `ctx.env`, and read harness files and run harness commands only through `ctx.io`** (never `process.env`, `fs` or `child_process` directly). That is what lets a conformance run record what the harness returned and the per-PR tests replay it. Session records are read through `ctx.records`. Sending a message in `deliver` (writing to a socket, for example) is not a read and does not go through `ctx.io`.

- `detect`: whether the harness is installed, and its version. It may be slow; nothing on the `list` path may depend on it.
- `list`: every session the adapter can see, as observations. It must be fast (consumers call `porch list` every few seconds) and must not throw just because the harness is not installed: return an empty list.
- `observe(session)`: one observation, or null when the adapter does not know the session (including ids the record store would refuse).
- `current`: the session this process runs in, from the harness's own environment variable (for example `CLAUDE_CODE_SESSION_ID`, `PI_SESSION_ID`), or null.
- `deliver(session, text)`: `text` already carries the `[from <label>]` prefix. See the rules below.
- `watchPaths` (optional): extra files or folders watch should react to, besides the records folder.
- `capabilities`: say honestly what the harness can do. `pollIntervalMs` is how often watch polls `list` for what only the outside listing shows; null when record changes are enough.
- `commands` (optional): CLI subcommands, each with a `path` such as `["hooks", "claude"]` (run as `porch hooks claude`). Longer paths win, so `["hooks", "claude", "x"]` can sit beside `["hooks", "claude"]`. Print JSON on stdout like every other command and throw `PorchError` for failures, so the CLI turns them into the standard error output and exit code.

Use the `observation()` and `deliverResult()` helpers from `src/adapter.ts`; they fill in `schema` and the defaults.

### Working out status

- Combine the record with the outside listing where the harness has one. The listing decides whether the session is alive: a record without a live session is `gone`, however recently it was written.
- Use `waiting-on-prompt` only when the harness says the session is held by something only a person can answer.
- When you cannot tell, say `unknown`. Never turn a missing signal into `idle`.
- `since` is when the session entered its status, or null when you cannot tell.
- `detail` is small and stable, and documented in the adapter's doc: watch compares it, so a value that changes every poll (a counter, a timestamp of the last poll) would report a change every time. Put volatile or bulky data in `raw`, which watch ignores; `raw` holds what the harness returned, as it returned it.
- `self` is the record's `self` part, as it is. Never mix it into `status`.

### Delivering

- Report only what you can know: `delivered` with `statusAtSend` (the status at the moment of sending), `not-running` when the session is gone or unknown to you, or `failed` with a reason. Never claim the message was read, started a turn or was queued (decision 0001 has the background).
- Set `via` to the mechanism used. Set `guessed: true` when the address was worked out rather than recorded by the session's inside part.
- Open any connection only when the text is ready, and never use credentials meant for the session itself.
- Porch keeps no copy of the message; do not add one.

## Before the PR

Run the conformance suite against the real harness and commit its report and fixtures (`docs/patterns/conformance.md`, `CONTRIBUTING.md`). In the adapter's doc, list what the adapter relies on from the harness, each item marked **documented** (with a link) or **observed** (seen working, not promised), with the harness version it was checked against.
