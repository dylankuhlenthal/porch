# Contributing to Porch

Thanks for helping. Porch is small, and it has consumers in other languages that parse its output, so changes are held to a few firm rules.

## Setup

```sh
npm ci          # installs and builds
npm test        # builds, then runs every per-PR test
npm run lint    # ESLint; pass file paths to lint only the files you touched
npm run typecheck
```

Node 22 or later. Tests never touch your real `~/.porch`, `~/.claude` or other home folders: `tests/setup.ts` points `PORCH_HOME` and `HOME` at scratch folders, and every test that writes files makes its own.

## Every PR

- CI runs lint, type-check, the full test suite and `npm pack --dry-run` (`.github/workflows/ci.yml`). It must pass.
- If you change a documented flow, contract or pattern, change the doc in the same PR. The docs follow the standard summarised in `AGENTS.md`.
- Output shapes are a contract. [docs/reference/cli-output.md](docs/reference/cli-output.md) says what counts as a breaking change and what to bump; if you make one, say so in the PR.

## A PR that adds or changes an adapter

Read [docs/patterns/adapter-contract.md](docs/patterns/adapter-contract.md) and [docs/patterns/conformance.md](docs/patterns/conformance.md) first. The PR must include:

1. **A conformance run against the real harness.** Run `npm run conformance -- --harness <name> --record` on a machine with the harness installed and logged in (for Claude Code, from a checkout inside a folder Claude Code trusts; see `docs/domains/claude-adapter.md`). It writes the report to `conformance/reports/<name>.json` (harness version, Porch version, the result of each case). Commit it. Every case must pass or be skipped with a stated reason.
2. **The recorded fixtures** it wrote to `conformance/fixtures/<name>/`. The per-PR tests replay them, which is how PRs from forks (which cannot use the repo's API key) still get tested against real harness output. Check them for anything private before committing: the recorder replaces some values, such as home folder paths and the API key, but keeps the rest as recorded ([docs/patterns/conformance.md](docs/patterns/conformance.md#recordings) says exactly what).
3. **The adapter's doc** at `docs/domains/<name>-adapter.md`, including what it relies on from the harness, marked documented or observed, with the harness version it was checked against.

A reviewer re-runs the conformance suite if the report looks stale or incomplete. The scheduled conformance workflow also runs it against the latest harness versions (see [docs/operations/ci.md](docs/operations/ci.md)).
