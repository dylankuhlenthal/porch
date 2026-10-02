# Porch

## Purpose

Porch lets people, and the tools they build on agents, wake any running agent session with a message and read what it is doing and whether it needs something, through one interface that behaves the same whichever harness the session runs in. It covers two layers only: delivery (one adapter per harness) and state tracking (observed plus self-reported). It also starts a harness with its inside part attached (`porch launch`), so a session is visible from the start. Storing or routing messages, deciding when to launch sessions and everything around a launch (resume, stop, cleanup), judging sessions, and agent GUIs are built on top of Porch elsewhere. How it works: `docs/architecture.md`.

## Stack

TypeScript (Node 22, ES modules, no runtime dependencies), published on npm as `@dylankuhlenthal/porch` with the `porch` command; Vitest, ESLint, Ajv (JSON Schema checks in tests), GitHub Actions.

## Layout & filing

- `src/`: the package. `src/cli/` is the `porch` command, `src/porch.ts` the library's operations, `src/index.ts`, `src/testing.ts` and `src/internal.ts` the three import paths (`@dylankuhlenthal/porch`, `/testing`, `/internal`), `src/adapter.ts` the adapter contract, `src/records.ts` the session records, `src/watch.ts` watch, `src/launch.ts` running a launch plan, `src/unix-socket.ts` the socket check adapters run before delivering, `src/adapters/<harness>/` one folder per adapter, `src/conformance/` the conformance suite.
- `schemas/`: JSON Schema for every output and the record format. Shipped in the package.
- `CHANGELOG.md`: every release, breaking changes first. `SECURITY.md`: how to report a vulnerability. `.github/`: the workflows (`docs/operations/ci.md`) and the ruleset on `main`.
- `tests/`: per-PR tests (`*.test.ts`). `conformance/`: the recorded fixtures and reports from conformance runs, committed.
- `docs/`: filed by lifetime, following the documentation standard in `docs/patterns/documentation.md`: `architecture.md` is the overview; `domains/` says how parts work; `patterns/` sets out the approved way to do things; `operations/` holds runbooks; `reference/` holds contracts; `decisions/` holds append-only decision records (`NNNN-slug.md`, never edited after merge). Plans and specs stay in the maintainer's issue tracker, never in the repo. Every doc names the files it describes. Change the docs in the same PR as the code.

## Terminology

- **Harness**: the program a session runs in (Claude Code, Pi). **Adapter**: Porch's code for one harness.
- **Inside part**: the adapter's code that runs within the session (Claude Code hooks, a Pi extension) and writes the session record. **Outside listing**: the harness's own list of sessions, read from outside (`claude agents --json`).
- **Session record**: `<PORCH_HOME>/sessions/<harness>-<session>.json`. Its `inside` part is written by the inside part, except that an adapter's outside part may mark it ended when the harness skipped its end hook and left evidence (decision 0014); its `self` part only by `porch status set`.
- **Attached**: Porch's inside part runs in the session (`attached` on every observation). `porch list` and `porch watch` show only running attached sessions unless given `--all`; `observe`, `deliver` and `watch --session` take unattached ones by name (decision 0012). Adapters return every session they see, marked; the core does the hiding.
- **Status**: what Porch observed (`starting`, `busy`, `idle`, `waiting-on-prompt`, `ended`, `gone`, `unknown`). `ended`: the session ended cleanly, and the record says why (`endReason`); `gone`: it is not running and did not. The records of both are removed 24 hours later by `porch list` and `porch watch` (decision 0013). **Self-reported state**: what the session said with `porch status set` (`working`, `needs-input`, `blocked`, `done`, `failed`). They are shown side by side, never combined.
- **Harness driver**: what an adapter supplies so the conformance suite can put real sessions into each state. **Fixture**: what a harness returned during a conformance run, replayed by the per-PR tests.

## Development workflow

- `npm ci` installs and builds. `node dist/cli/main.js --help` runs the built command. Script descriptions are the `//` entries in `package.json`.
- To try the CLI by hand, always set a scratch `PORCH_HOME` (`export PORCH_HOME=$(mktemp -d)`), then use the fake harness: `porch fake start s1`, `porch fake set s1 busy`, `porch list`.
- Publish only through the release workflow, started by the maintainer (`docs/operations/releasing.md`); never run `npm publish` yourself and never create an npm token (decision 0017, trusted publishing).

## Testing

- `npm test`: builds, then runs every per-PR test (unit, contract, CLI as a real process, watch, the conformance suite against the fake adapter, and replay of every committed fixture). It is the per-commit gate and must be fully green. CI runs it with `npm run lint`, `npm run typecheck` and `npm pack --dry-run` (`docs/operations/ci.md`).
- `npm run lint -- <files>`: lint the files you touched.
- `npm run conformance -- --harness <h> [--record] [--slow]`: the conformance suite against a real harness on this machine. `--slow` adds the slow cases (Claude Code's `idle-stopped`, about an hour). Read `docs/patterns/conformance.md` first.
- No test may write to the real `~/.porch`, `~/.claude` or `~/.claude.json`. `tests/setup.ts` points `HOME` and `PORCH_HOME` at scratch folders; tests that write files also use `scratchEnv()` from `tests/helpers.ts`.
- Per-PR tests never run the real `claude` or `pi`: `tests/setup.ts` and `scratchEnv()` point `PORCH_CLAUDE_BIN` and `PORCH_PI_BIN` at commands that do not exist, and `tests/setup.ts` removes `CLAUDE_*` and `PI_*` variables so a test run inside a Claude Code or Pi session does not see that session. Adapter tests give the adapter a `HarnessIO` with canned output (for Pi, canned `ps`).
- `npm run conformance -- --harness claude` starts real Claude Code sessions (cheap model, trivial prompts) and must run from a checkout inside a folder Claude Code trusts. Read the Conformance section of `docs/domains/claude-adapter.md` first.
- `npm run conformance -- --harness pi` starts real Pi sessions (cheap OpenAI model, about seven turns, a few cents) and needs Node 22.19 or later first on `PATH` for Pi (`nvm use 22.19`); Porch's own build and tests run on Node 22.14. It never installs anything into `~/.pi`. Read the Conformance section of `docs/domains/pi-adapter.md` first.

## Conventions & patterns

- Every output and every record carries `schema: 2` and has a JSON Schema in `schemas/` that the tests check real output against. A breaking change bumps the schema version. Read `docs/reference/cli-output.md` before changing any output.
- The core talks to harnesses only through the adapter contract. Read `docs/patterns/adapter-contract.md` before writing or changing an adapter.
- Adapters read env, files and commands only through their `AdapterContext` (`ctx.env`, `ctx.io`), so conformance runs can record and replay harness output. Delivery is the one exception; `docs/patterns/adapter-contract.md` says what it covers.
- `unknown` is a valid status and never a guess; deliver reports only what it can know.
- The supported library is exactly what `docs/reference/library.md` lists, and the version number follows its version rules. Read it before adding, removing or changing an export from `src/index.ts` or `src/testing.ts`; `tests/library-exports.test.ts` fails until the doc matches.
- A PR that changes behaviour adds a line under "Unreleased" in `CHANGELOG.md`, breaking changes first.
- No file outside `docs/decisions/` names the maintainer, a private tool or a private ticket; `tests/owner-neutral.test.ts` enforces it (decision 0015).
- Every adapter change comes with a conformance run and fixtures. Read `docs/patterns/conformance.md`.
- Docs are filed by lifetime (plans stay in the issue tracker, durable docs in `docs/`, instructions here), with one home per topic, each doc naming the files it describes, and doc changes in the same PR as the code. Read `docs/patterns/documentation.md` before adding, moving or restructuring a doc.

## Learnings

- Records and the fake harness file are replaced by rename on every write, which breaks a file watch on the file itself. `src/watch.ts` watches the folder and filters by name.
- Claude Code behaviour that has caught us out (folder trust for `claude --bg`, the keychain login found by `USER`, spare processes carrying an earlier launch's environment, how delivered messages arrive and can be refused, `claude agents --json` quirks, `Stop` not firing on an interrupt) is recorded in `docs/domains/claude-adapter.md`, under "What it relies on from Claude Code", "Conformance" and "Known limits". Read it before changing the Claude adapter or its conformance driver.
- Pi behaviour that has caught us out (a subcommand is read only as the first argument, so `pi -e <file> list` runs a paid turn with `list` as the prompt; `agent_settled`, not `agent_end`, is the idle signal; no outside listing, so a session without the extension is invisible) is recorded in `docs/domains/pi-adapter.md`, under "What it relies on from Pi" and "Known limits". Read it before changing the Pi adapter or its driver.
- Pi skips `session_shutdown` when its terminal closes during a turn (it writes to the dead terminal and exits 129 at once), so the Pi extension also marks the session ended on a clean process exit (`docs/domains/pi-adapter.md`). Which close gives which end, for both harnesses, is in each adapter's doc; check there before assuming a close runs the end hook.
- Interactive Claude Code stops at "Allow external CLAUDE.md file imports?" in any new folder when the person's user CLAUDE.md imports a file, and answering saves to `~/.claude.json`. The conformance driver passes `claudeMdExcludes` in each session's settings to keep CLAUDE.md files out; do the same for any hand-run test session. `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` does not stop the dialog.
- Claude Code's idle stop of a background session (after an hour idle) runs no `SessionEnd`; the Claude adapter reads `daemon.log` for its `bg retire <short id>:` line and marks the record ended with `endReason: "idle"`. The line format is undocumented, and its conformance case (`idle-stopped`) takes about an hour, so it runs only with `--slow` (`docs/domains/claude-adapter.md`, "Idle stops").
- `realIO.run` (`src/io.ts`) puts Node's own error text in `stderr` whenever a command exits non-zero, so an adapter must not read "empty stderr" as the harness saying nothing (the Pi adapter's `ps` check once read every killed session as `unknown` because of this).
