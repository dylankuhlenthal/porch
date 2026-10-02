# Architecture

Porch answers two questions about agent sessions on this machine, whatever harness they run in: "what is this session doing, and does it need something?" and "please give it this message". It is a command (`porch`, JSON output) with a library under it. It also starts a harness with its inside part attached (`porch launch`), so the session is visible from the start; it does not store messages, decide when to launch sessions, resume, stop or judge them. Tools built on Porch do that.

## The pieces

```mermaid
flowchart LR
  subgraph session[A session in its harness]
    inside[inside part<br/>hooks or extension]
    selfcmd[porch status set]
  end
  inside -- writes inside part --> rec[(session record<br/>PORCH_HOME/sessions/harness-id.json)]
  selfcmd -- writes self part --> rec
  listing[harness outside listing<br/>e.g. claude agents --json] --> adapter
  rec --> adapter[adapter<br/>src/adapters/harness/]
  adapter --> core[core<br/>src/porch.ts, src/watch.ts]
  core --> cli[porch CLI<br/>src/cli/]
  cli --> consumers[tools built on Porch, people]
  adapter -- deliver --> session
```

- **Adapters** (`src/adapters/<harness>/`, contract in `src/adapter.ts`): one per harness. Each has an inside part that runs within the session and writes its record, and an outside part that lists sessions, observes them, delivers messages and works out which session a command runs in. The adapters Porch ships are listed in `src/adapters/index.ts`: Claude Code (`docs/domains/claude-adapter.md`), Pi (`docs/domains/pi-adapter.md`) and the fake adapter for tests (`docs/domains/fake-adapter.md`). Where the harness has its own listing of sessions (Claude Code), the adapter combines it with the records; where it has none (Pi), the records are the only source and the adapter checks with `ps` that each session's process is still running. How to write one: `docs/patterns/adapter-contract.md`.
- **Session records** (`src/records.ts`): one JSON file per session. The inside part writes its `inside` part; `porch status set` writes its `self` part. When a session ends cleanly its record is marked `ended` rather than deleted; `porch list` and `porch watch` remove the records of ended and gone sessions 24 hours later (`src/prune.ts`). Details: `docs/domains/session-records.md`.
- **The core** (`src/porch.ts`): asks every adapter and combines the answers. `list` reports an adapter whose listing fails, and any session record it cannot read, in `errors` instead of failing the whole command or dropping the record silently. `observe` and `deliver` find the one adapter that knows the session; two adapters knowing the same id is an `ambiguous-session` error unless `--harness` picks one. One adapter failing does not hide a session another adapter knows; if no adapter knows the session and one could not be asked, `deliver` says `failed` (not `not-running`, which would be a guess) and `observe` gives an `internal` error naming the harness. `current` asks every adapter's `current`; if more than one claims the process, it refuses to guess (see "Known limits").
- **Launch** (`src/launch.ts`): runs an adapter's launch plan for `porch launch` (see "Launch" below).
- **The CLI** (`src/cli/run.ts`, run by `src/cli/main.ts`): thin commands over the core, plus any commands adapters add (`porch hooks claude` and the hook commands it prints, `porch extension pi`, `porch fake ...`). The output contract, error shape and exit codes: `docs/reference/cli-output.md`.
- **The library** (`src/index.ts`): the operations of `src/porch.ts` for Node consumers. The supported names are split by import path: the main import, test helpers under `/testing` (`src/testing.ts`), and everything else under `/internal` (`src/internal.ts`), which is not supported. The contract and version rules: `docs/reference/library.md`.
- **The conformance suite** (`src/conformance/`): the same cases run against every adapter through a harness driver, with record and replay of harness output. `docs/patterns/conformance.md`.

## How the main operations work

**Observe and list.** The adapter reads the session records for its harness and, where the harness has one, its outside listing, and combines them into an observation: `attached` (whether Porch's inside part runs in the session), `status` and `since`, a small `detail`, the harness output as it came in `raw`, and the session's self-reported state in `self`. A session that ended cleanly shows as `ended`, with when (`since`) and, where the harness said, why (`endReason`), because its inside part marked the record at the end. Where a harness stops a session on purpose without running its end hook but leaves evidence, the adapter's outside part marks the record instead, on the first look that finds the evidence (Claude Code's idle stop, read from its daemon log, `endReason: "idle"`; decision 0014). Otherwise the outside listing decides whether a session is alive (for a harness without one, such as Pi, whether the recorded process is still running), so a session that crashed and left its record behind shows as `gone`. Where Porch cannot tell, the status is `unknown`. Each adapter's `list` returns every session it can see; the core's `list` keeps only the running attached ones unless the caller passes `--all` (decision 0012, list and watch show attached sessions; decision 0013, ended sessions keep their records for a day). `observe` and `deliver` take any session the adapter knows, attached or not, running or not, because the caller named it. Each `list` also prunes: it removes the records of ended and gone sessions 24 hours after they stopped (`pruneStopped` in `src/prune.ts`, `docs/domains/session-records.md`).

**Deliver.** `porch deliver <session> --from <label> <text>` prefixes the text with `[from <label>] ` (no harness has a sender field for outside senders) and hands it to the adapter, which sends it the harness's way. The result says only what Porch can know: `delivered` with the session's status at the moment of sending, `not-running`, or `failed` with a reason. It never claims the message was read or started a turn; a message held at a prompt shows afterwards through `observe` as `waiting-on-prompt`. `guessed: true` marks a delivery address that was worked out rather than recorded by the session. Porch keeps no copy of the message: callers store it first.

**Status set.** `porch status set <status> [text]` runs inside a session. The core asks each adapter's `current` which session that is (each harness sets its own environment variable: `CLAUDE_CODE_SESSION_ID` for Claude Code, `PI_SESSION_ID` for Pi, `PORCH_FAKE_SESSION_ID` for the fake), then writes the record's `self` part. Nothing else writes that part, and `porch status set` writes nothing else.

**Watch.** `porch watch [--all] [--session <id>] [--harness <h>]` stays running and prints one observation per line whenever a session changes (`src/watch.ts`). It looks again when a file in the records folder changes (a file watch, so an inside part's write shows at once; events for the `.lock`, `.tmp` and `.lock.breaking.*` files a write makes next to a record are skipped, because each look runs every adapter's listing, while an event without a file name, which some platforms send, still counts), when an adapter's extra watched paths change, every `pollIntervalMs` for adapters whose outside listing shows things no record does (a session dying without its end hook, a prompt opening), and on a slow backstop poll in case a file event is missed. Each look compares every session with what it last printed, ignoring `raw`; a session that disappears from its adapter's listing is printed once as `gone`, with `since` and `detail` null because neither is known, and then forgotten, so a long-running watch does not keep every session it ever saw; a session already printed as `ended` or `gone` (whose record is later pruned) is forgotten without another line. It prints the current state of every session when it starts. Like `list`, it reports only running attached sessions unless given `--all`, and prunes on each look; a session it has already reported keeps being followed if it stops counting as attached (a Claude Code session resumed without the hooks), so it is not reported `gone` while it still runs, and when a session it reported ends or goes, it prints that once (`ended` or `gone`) and then leaves the session out. `--session` follows the named session whether it is attached or not, as `observe` does. `--session` takes any id `porch observe` takes (for Claude Code, the short id too): each look finds it in the listing it has just fetched, through the adapter's optional `sessionIdIn`, so looking up an id costs no extra listing, even while the session has not appeared yet. Once found, the watch follows that full id, including after the session has gone. An error from the lookup goes to stderr like a listing error. An adapter whose listing fails keeps its last state, and the error goes to stderr as JSON.

**Launch.** `porch launch [--porch-home <dir>] [--dry-run] <harness> [harness arguments...]` starts the harness with Porch's inside part attached and nothing else (decision 0006, Porch launches with its inside part attached). Porch's own options come before the harness name; everything after it passes through unchanged, so `alias claude='porch launch claude'` works (`claude -c` becomes `porch launch claude -c`). The core asks the harness's adapter for a launch plan (`launch` in `src/adapter.ts`: the program and its arguments, with whatever attaches the inside part added; for Claude Code, see `docs/domains/claude-adapter.md`, for Pi `docs/domains/pi-adapter.md`). A harness whose adapter has no `launch` is a usage error, and `capabilities.launch` in `porch adapters` says which can. `--porch-home` sets the records folder: it is baked into the inside part, and set as `PORCH_HOME` in the harness's environment so commands in the session (`porch status set`) use the same folder; otherwise a `PORCH_HOME` already in the environment is baked in. `--dry-run` prints the plan as JSON and starts nothing.

The core then runs the plan (`runLaunchPlan` in `src/launch.ts`): the harness is a child process sharing the terminal (decision 0007, the harness runs as a child process, since Node 22 cannot replace its own process). While it runs, Porch ignores SIGINT and SIGQUIT, which the terminal sends to the harness too, so one Ctrl+C never ends Porch and leaves the harness behind; it passes SIGTERM and SIGHUP sent to Porch alone on to the harness; and it leaves Ctrl+Z alone, so Porch stops with the harness and `fg` continues both. When the harness exits, Porch exits with its exit code, or dies of the signal that killed it (`endLikeHarness`), so a shell sees what it would have seen running the harness directly. Porch prints nothing of its own once the harness has started (`docs/reference/cli-output.md`). The environment is passed through unchanged, apart from `PORCH_HOME` with `--porch-home`.

## Data

- Records folder: `$PORCH_HOME/sessions/` (default `~/.porch/sessions/`), from `src/home.ts`. Tests always point `PORCH_HOME` at a scratch folder.
- Record format: `schemas/record.schema.json`, described in `docs/domains/session-records.md`.
- Output formats: one JSON Schema per output in `schemas/`.

## Decisions

- Decision 0001 (each adapter's inside part writes a per-session record, and the CLI reads the records).
- Decision 0002 (TypeScript on npm, a JSON CLI first with a thin library on top).
- Decision 0003 (its own repo, private until the second harness passes the shared tests; the timing is changed by decisions 0010 and 0015).
- Decision 0004 (Porch writes self-reported state, with one writer per part of the record).
- Decision 0005 (publishing to npm waits until the second harness passes the shared tests; the timing is changed by decisions 0010 and 0015).
- Decision 0006 (Porch launches a harness with its inside part attached, and nothing else).
- Decision 0007 (`porch launch` runs the harness as a child process sharing the terminal).
- Decision 0008 (`porch launch claude` adds `crossSessionInbound: accept` unless the caller sets it).
- Decision 0009 (no user-wide hook install for now; `alias claude='porch launch claude'` instead).
- Decision 0010 (going public and publishing to npm wait until the first two tools built on Porch run on it; changed by decision 0015).
- Decision 0011 (no user-wide Pi install; `porch extension pi` prints the extension and `porch launch pi` passes it).
- Decision 0012 (`porch list` and `porch watch` show only attached sessions by default; `--all` adds the others).
- Decision 0013 (a session that ends cleanly is marked `ended`, with why, instead of having its record deleted; `list` and `watch` hide ended and gone sessions unless `--all`, and remove their records a day later).
- Decision 0014 (Claude Code's idle stop of a background session, read from its daemon log, ends the session with `endReason: "idle"`).
- Decision 0015 (going public and publishing to npm no longer wait for a second tool built on Porch; the decision records were cleaned once of private names before going public).
- Decision 0016 (the library is part of the contract, alongside the CLI output, and its supported names are set by import path).
- Decision 0017 (releases are published to npm by a GitHub Actions workflow using npm trusted publishing, with no npm token).
- Decision 0018 (below 1.0, a breaking change bumps the minor version and anything else the patch version).

## Known limits

- **Nested sessions.** If a harness session is started from inside another harness's session, a command in the inner one can see both harnesses' session variables. `porch current` then returns an `ambiguous-session` error and `porch status set` refuses, rather than guessing. This could be lifted by having each adapter's `current` also report the harness process id and picking the nearest ancestor process.
- **Record locks.** A writer that crashes while holding a record's lock leaves a `.lock` file. The next writer breaks it once it is older than 2 seconds and its writer's process is no longer running, or once it is older than 30 seconds whatever the process (`withLock` in `src/fsutil.ts`), so writes to that record are delayed, not lost. Breaking moves the lock aside and checks it is still the stale one, and a writer deletes only a lock holding its own token, so in the normal case writers do not delete each other's fresh locks. One narrow case is left: if three writers race around a stale lock at the same instant, one writer can move aside a lock another has just taken, a third can take the lock before it is put back, and two writers then write at once, losing one change. This is accepted as unlikely.
- **Real-harness conformance** runs only where the harness is installed and logged in (for Claude Code, also from a checkout inside a folder Claude Code trusts), and in the scheduled workflow once the API key secret exists. Each adapter's own limits are in its doc (`docs/domains/claude-adapter.md`, `docs/domains/pi-adapter.md`).
