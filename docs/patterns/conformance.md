# The conformance suite

Every adapter is held to the same cases, run against real sessions of its harness. This page is how to write a harness driver, run the suite and keep its recordings. Code: `src/conformance/` (`cases.ts` the cases, `driver.ts` the driver interface, `runner.ts`, `recorder.ts` record and replay, `command.ts` the `npm run conformance` command, `paths.ts` where output goes). The canonical driver is `src/conformance/drivers/fake.ts`.

## The three levels of testing

1. **Every PR** (`npm test`, run by CI on every PR; not yet enforced as a required check, see `docs/operations/ci.md`): unit and contract tests against the fake adapter, the whole conformance suite against the fake adapter, and replay of every committed fixture.
2. **Real harness** (`npm run conformance -- --harness <h>`): the suite against real sessions, on any machine with the harness installed, and in the scheduled workflow (`docs/operations/ci.md`).
3. **Record and replay**: each real run with `--record` saves what the harness returned; level 1 replays it, so PRs from forks, which cannot use the repo's API key, are still tested against real harness output.

## The cases

`CASES` in `src/conformance/cases.ts`. Each is written against the adapter contract and the driver only:

| Case | What it checks |
| --- | --- |
| `which-session-am-i` | `current` inside a session returns that session; outside any session, null; the default `list` shows the session, with `attached: true` |
| `deliver-while-idle` | `delivered` with `statusAtSend: idle`, and the session receives the message |
| `deliver-while-busy` | `delivered` with `statusAtSend: busy`; received if the adapter says it queues while busy |
| `held-at-prompt` | the session shows `waiting-on-prompt`; deliver says `delivered` with that status, and the session still shows it afterwards |
| `killed-session` | a killed session shows `gone` with no `endReason`, and still `gone` when looked at again, with its record not marked ended (reading what the harness left, such as Claude Code's daemon log, must not turn a kill into a clean end); deliver says `not-running`; it is left out of the default `list` but shown as `gone` by `list --all` |
| `ended-cleanly` | a session the driver stops cleanly shows `ended`, with a `since` and the `endReason` the driver says the harness gives (`endReasons.stop`), still `attached`; deliver says `not-running`; it is left out of the default `list` but shown as `ended` by `list --all` |
| `idle-stopped` (slow) | a session given one turn (`makeBusy`, `makeIdle`) is stopped by the harness for being idle within the driver's `timeouts.idleStopMs`, and then shows `ended` with the `endReason` the driver says the adapter gives (`endReasons.idleStop`), a `since`, still `attached`, with its record marked ended; deliver says `not-running`; it is left out of the default `list` but shown as `ended` by `list --all`. Skipped when the driver does not support idle stops (`supports.idleStop`). It snapshots the first look that sees the stop against a copy of the records, before the adapter marks the record, so the fixture replays the adapter reading the harness's evidence |
| `without-inside-part` | a session without the inside part is absent from the default `list`, shown by `list --all` with `attached: false` and not as `gone`, found by `observe` when named, and can still be delivered to |
| `watch-delivers-each-change` | watch reports idle, busy, idle, then waiting-on-prompt (when the adapter sees prompts and the driver can hold at one), then gone, in that order |
| `self-reported-state` | `status set` inside the session writes that session's `self` |
| `launch-background` | a background session started through `porch launch`, with the caller's own settings holding a marker: it shows idle with a record from the inside part, the caller's settings took effect too (the marker ran), and a delivered message reaches it. Skipped when the adapter cannot launch |
| `launch-interactive` | an interactive session started through `porch launch` in a terminal: it shows idle with a record; a delivered message starts a turn (watch reports idle, busy, idle) and reaches it; one Ctrl+C leaves both the harness and `porch launch` running; exiting the harness (`/exit`) makes `porch launch` exit 0; and the session shows `ended`, with the `endReason` the driver says the harness gives (`endReasons.exitInteractive`), which watch reports too. Skipped when the adapter cannot launch |
| `unknown-session` | a made-up id: observe returns null and deliver says `not-running`, from the core and from the adapter itself |

A case the harness or driver cannot take part in (for example no prompts to hold at) is reported as skipped, with the reason. Skips do not fail a run; failures do.

**Slow cases** (`slow: true` on the case) wait on the harness for an hour or more: today only `idle-stopped`, because Claude Code's idle timeout is a fixed hour. They run only when asked for, with `--slow` or by naming them with `--case`; otherwise they are reported as skipped ("a slow case: run with --slow, or name it with --case"), so ordinary runs, including the scheduled workflow, stay short. A slow case's time limit is the driver's `caseMs` plus its `timeouts.idleStopMs`. Re-run a slow case, and commit its fixture, whenever the adapter code it covers changes (for Claude Code: how the adapter reads the daemon log), and at each check against a new harness version. Record it in a full run (`--record --slow`), so the committed report lists every case.

## Writing a harness driver

Implement `HarnessDriver` (`src/conformance/driver.ts`) and add it to `DRIVERS` in `src/conformance/drivers/index.ts`, with the environment variables the harness needs for real turns in `requiredEnv` (for example `ANTHROPIC_API_KEY`) and `needsInstalledHarness: true`. Optional parts of a `DriverEntry`, each harness-neutral:

- `optionalEnv`: variables passed to sessions when set but not required, kept out of fixtures like `requiredEnv`'s (Claude Code: `ANTHROPIC_API_KEY`, since a logged-in Claude Code works without it).
- `unavailableReason(env)`: why real turns cannot run here (for example not logged in and no key); a reason skips the run with exit 3.
- `workRoot()`: where case scratch folders go instead of the system temp folder (Claude Code runs sessions only in folders the person trusts).
- `scrubSnapshot(snapshot)`: drops harness output that is not about the case (for example other sessions running on the machine) from each snapshot before it is saved. It must not change what the adapter makes of the snapshot on replay.

Sessions start from `PATH`, `HOME` and `USER` (Claude Code finds its login in the macOS keychain by user name), plus the variables above and the case's `PORCH_HOME`.

- The runner gives each case a fresh scratch folder (with `PORCH_HOME` at `<folder>/porch-home`) and calls `setup` with its `DriverContext`. **Start sessions with `ctx.env`** (it carries the scratch `PORCH_HOME`) and pass the adapter's inside part to them only through per-session settings. Never write to the person's own harness settings or home folders.
- Only start sessions you own, and stop every one of them in `cleanup`, which the runner always calls, even after a failure or a timeout. After a timeout the runner first waits up to `caseMs` more for the case to finish, so a session that was still starting is stopped too; a start that takes longer than that is not. Keep track of a session as soon as it has a process (before waiting for it to be ready), so `cleanup` can stop one that never finished starting.
- `supports.idleStop`: the harness stops idle sessions by itself and the adapter reports it as `ended`. Set `endReasons.idleStop` to the reason the adapter gives (null when unsupported) and `timeouts.idleStopMs` to how long the harness may take, counted from the end of a turn.
- `stop` ends a session cleanly, the way a tool would (its end hook runs). Set `endReasons` to the `endReason` the harness gives for `stop` and for `exitInteractive`, as seen by running them, or null where it gives none: the `ended-cleanly` and `launch-interactive` cases require exactly those.
- `makeBusy` must start a turn that lasts until `makeIdle` or at least `timeouts.changeMs`. If the harness's model may decline instructions sent from outside, tell the test sessions to follow them (the Claude driver appends a system prompt), so a case fails only for Porch's reasons. `received` returns the messages the session got from outside, as text (for example from its transcript).
- **Launch cases** (`launchBackground`, `callerSettingsApplied`, `launchInteractive`, `interrupt`, `launchRunning`, `exitInteractive`): start sessions through `porch launch` with the case's `PORCH_HOME` (`--porch-home`), running this Porch's own build (`porchCliPath()` in `src/cli/path.ts`). For the background case, pass the harness settings a tool would pass, with a marker the driver can check (the Claude driver's is a `SessionStart` hook that writes a file; the Pi driver's is a caller extension that writes one at `session_start`) and nothing of Porch's, so the case checks that `porch launch` merged the two. Run the interactive case in a terminal: a real harness needs a pseudo-terminal, which the Claude and Pi drivers get from `node-pty` through `loadPty` in `src/conformance/drivers/pty.ts` (a dev dependency, loaded only when that case runs, so the published package does not need it); the fake driver starts `porch launch fake` in its own process group instead and sends Ctrl+C to the whole group, as a terminal does. `interrupt` presses Ctrl+C once; `exitInteractive` exits the harness the way a person would and returns how `porch launch` ended. `cleanup` must also end every interactive session.
- Set `timeouts` to what the harness needs. `caseMs` is a hard limit per case, so a hung harness cannot leave the run waiting.

## Running it

```sh
npm run conformance -- --harness <h>                  # run and print the report
npm run conformance -- --harness <h> --record         # also write fixtures and the report
npm run conformance -- --harness <h> --case deliver-while-idle
npm run conformance -- --harness <h> --record --slow  # every case, including the slow ones (Claude Code: about 80 minutes)
```

Run from the repo root. The report is JSON on stdout; progress goes to stderr. Exit codes are listed at the top of `src/conformance/command.ts` (3 means skipped: a variable the harness needs, such as the API key, is not set, or the driver's `unavailableReason` says real turns cannot run here, for example not logged in and no key).

## Recordings

- **Fixtures**: `conformance/fixtures/<harness>/<case>.json`, one per case that passed and took snapshots. Format: `schemas/fixture.schema.json`. A snapshot holds a copy of the session records at that moment, every outside read the adapter made while listing (commands and files, with results), and the observations it produced. Paths are stored as `$PORCH_HOME`, `$WORK` and `$HOME` (and `$WORK_DASHED` and `$HOME_DASHED` for the same paths written as one folder name with every other character turned into `-`, as Claude Code names its transcript folders) so fixtures replay anywhere and do not carry the recording machine's home folder, and the values of the driver's `requiredEnv` and `optionalEnv` variables (the API key) are replaced with `$REDACTED` (only values of 8 characters or more, so a short value such as `1` does not blank out unrelated text). Other message text and harness output are kept as recorded, except what the driver's `scrubSnapshot` removes.
- **Consistent snapshots** (`takeSnapshot` in `recorder.ts`): the recorder copies the records once, writes that copy into a private folder the same way replay writes them, and runs the adapter's `list` against the copy, never against the live records folder. A session's inside part can write its record while a snapshot is taken (a Pi session starting a turn as it is held at a prompt, for example); the fixture still holds the exact records the observations came from, so it replays. Any path to the copy's folder in what the adapter returned or read is saved as the live records folder (`$PORCH_HOME/sessions`), so fixtures never hold the temporary path. Drivers need do nothing for this. The adapter must read records only through `ctx.records`, as the adapter contract already requires.
- **Report**: `conformance/reports/<harness>.json` (`schemas/conformance-report.schema.json`): harness version, Porch version, platform, and each case's result.
- **Replay** (`replayFixture` in `recorder.ts`, run by `tests/conformance.test.ts` for every committed fixture): writes the records into a scratch folder, answers the adapter's outside reads from the recording (a read that was not recorded is a failure), runs `list` at the recorded time, and requires the same observations. When a replay fails after you change an adapter, either the change broke how it reads real harness output (fix the adapter) or the change is intended (re-record against the real harness and commit the new fixtures).

Only take snapshots (`c.snapshot(label)` in a case) at moments that matter for how the adapter reads harness output; each one adds to the fixture file.
