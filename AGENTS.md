# Porch

## Purpose

Porch lets Dylan, and the tools he builds on agents (sous chef and shape-gui first), wake any running agent session with a message and read what it is doing and whether it needs something, through one interface that behaves the same whichever harness the session runs in. It covers two layers only: delivery (one adapter per harness) and state tracking (observed plus self-reported). It also starts a harness with its inside part attached (`porch launch`), so a session is visible from the start. Storing or routing messages, deciding when to launch sessions and everything around a launch (resume, stop, cleanup), judging sessions, and agent GUIs are built on top of Porch elsewhere. How it works: `docs/architecture.md`.

## Stack

TypeScript (Node 22, ES modules, no runtime dependencies), published as `@dylankuhlenthal/porch` with the `porch` command; Vitest, ESLint, Ajv (JSON Schema checks in tests), GitHub Actions.

## Layout & filing

- `src/`: the package. `src/cli/` is the `porch` command, `src/porch.ts` the library, `src/adapter.ts` the adapter contract, `src/records.ts` the session records, `src/watch.ts` watch, `src/launch.ts` running a launch plan, `src/adapters/<harness>/` one folder per adapter, `src/conformance/` the conformance suite.
- `schemas/`: JSON Schema for every output and the record format. Shipped in the package.
- `tests/`: per-PR tests (`*.test.ts`). `conformance/`: the recorded fixtures and reports from conformance runs, committed.
- `docs/`: filed by lifetime, following the documentation standard in `docs/patterns/documentation.md`: `architecture.md` is the overview; `domains/` says how parts work; `patterns/` sets out the approved way to do things; `operations/` holds runbooks; `reference/` holds contracts; `decisions/` holds append-only decision records (`NNNN-slug.md`, never edited after merge). Plans and specs stay in Linear, never in the repo. Every doc names the files it describes. Change the docs in the same PR as the code.

## Terminology

- **Harness**: the program a session runs in (Claude Code, Pi). **Adapter**: Porch's code for one harness.
- **Inside part**: the adapter's code that runs within the session (Claude Code hooks, a Pi extension) and writes the session record. **Outside listing**: the harness's own list of sessions, read from outside (`claude agents --json`).
- **Session record**: `<PORCH_HOME>/sessions/<harness>-<session>.json`. Its `inside` part is written only by the inside part; its `self` part only by `porch status set`.
- **Status**: what Porch observed (`starting`, `busy`, `idle`, `waiting-on-prompt`, `gone`, `unknown`). **Self-reported state**: what the session said with `porch status set` (`working`, `needs-input`, `blocked`, `done`, `failed`). They are shown side by side, never combined.
- **Harness driver**: what an adapter supplies so the conformance suite can put real sessions into each state. **Fixture**: what a harness returned during a conformance run, replayed by the per-PR tests.

## Development workflow

- `npm ci` installs and builds. `node dist/cli/main.js --help` runs the built command. Script descriptions are the `//` entries in `package.json`.
- To try the CLI by hand, always set a scratch `PORCH_HOME` (`export PORCH_HOME=$(mktemp -d)`), then use the fake harness: `porch fake start s1`, `porch fake set s1 busy`, `porch list`.
- Never run `npm publish` or create an npm token: publishing waits until the Pi adapter passes the shared tests (decision 0005, publishing to npm waits for the second harness).

## Testing

- `npm test`: builds, then runs every per-PR test (unit, contract, CLI as a real process, watch, the conformance suite against the fake adapter, and replay of every committed fixture). It is the per-commit gate and must be fully green. CI runs it with `npm run lint`, `npm run typecheck` and `npm pack --dry-run` (`docs/operations/ci.md`).
- `npm run lint -- <files>`: lint the files you touched.
- `npm run conformance -- --harness <h> [--record]`: the conformance suite against a real harness on this machine. Read `docs/patterns/conformance.md` first.
- No test may write to the real `~/.porch`, `~/.claude`, `~/.claude.json` or `~/.sous-chef`. `tests/setup.ts` points `HOME` and `PORCH_HOME` at scratch folders; tests that write files also use `scratchEnv()` from `tests/helpers.ts`.
- Per-PR tests never run the real `claude`: `tests/setup.ts` and `scratchEnv()` point `PORCH_CLAUDE_BIN` at a command that does not exist, and `tests/setup.ts` removes `CLAUDE_*` variables so a test run inside a Claude Code session does not see that session. Claude adapter tests give it a `HarnessIO` with canned output.
- `npm run conformance -- --harness claude` starts real Claude Code sessions (cheap model, trivial prompts) and must run from a checkout inside a folder Claude Code trusts. Read the Conformance section of `docs/domains/claude-adapter.md` first.

## Conventions & patterns

- Every output and every record carries `schema: 1` and has a JSON Schema in `schemas/` that the tests check real output against. A breaking change bumps the schema version. Read `docs/reference/cli-output.md` before changing any output.
- The core talks to harnesses only through the adapter contract. Read `docs/patterns/adapter-contract.md` before writing or changing an adapter.
- Adapters read env, files and commands only through their `AdapterContext` (`ctx.env`, `ctx.io`), so conformance runs can record and replay harness output. Delivery is the one exception; `docs/patterns/adapter-contract.md` says what it covers.
- `unknown` is a valid status and never a guess; deliver reports only what it can know.
- Every adapter change comes with a conformance run and fixtures. Read `docs/patterns/conformance.md`.
- Docs are filed by lifetime (plans stay in Linear, durable docs in `docs/`, instructions here), with one home per topic, each doc naming the files it describes, and doc changes in the same PR as the code. Read `docs/patterns/documentation.md` before adding, moving or restructuring a doc.

## Learnings

- Records and the fake harness file are replaced by rename on every write, which breaks a file watch on the file itself. `src/watch.ts` watches the folder and filters by name.
- Claude Code behaviour that has caught us out (folder trust for `claude --bg`, the keychain login found by `USER`, spare processes carrying an earlier launch's environment, how delivered messages arrive and can be refused, `claude agents --json` quirks, `Stop` not firing on an interrupt) is recorded in `docs/domains/claude-adapter.md`, under "What it relies on from Claude Code", "Conformance" and "Known limits". Read it before changing the Claude adapter or its conformance driver.
