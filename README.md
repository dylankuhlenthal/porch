<p align="center"><img src="https://raw.githubusercontent.com/dylankuhlenthal/porch/main/assets/porch.png" alt="Porch" width="160"></p>

# Porch

Porch lets you wake a running agent session with a message and read what it is doing and whether it needs something, through one command that behaves the same whichever harness (Claude Code, Pi, ...) the session runs in.

It is a command-line tool with JSON output (`porch`), plus a thin TypeScript library on top. Each harness is supported by an adapter. This version ships the harness-neutral core, adapters for Claude Code and Pi, and a fake adapter for tests.

## Install

```sh
npm install -g @dylankuhlenthal/porch     # the porch command
npm install @dylankuhlenthal/porch        # the library, in a project
```

Needs Node 22 or later, on macOS or Linux. Porch has no runtime dependencies.

## Use

```sh
porch list                                   # the running sessions Porch is attached to
porch list --all                             # also ones that ended or died, and Claude Code sessions started without Porch
porch observe <session>                      # one session's state, attached or not, running or not
porch watch                                  # one JSON line per change, until stopped (--all as for list)
porch deliver <session> --from "reviewer" "please look at the PR"
porch current                                # the session this command runs in
porch status set needs-input "which branch?" # run inside a session: say what you need
porch launch claude [claude arguments...]    # start a harness with Porch attached
porch launch pi [pi arguments...]
```

For Claude Code, give sessions Porch's hooks so it sees busy and idle as they happen and learns each session's socket. The simplest way is to start them with `porch launch claude`, which runs `claude` with your arguments and Porch's hooks merged into its settings. To have every session you start attached:

```sh
alias claude='porch launch claude'
```

A tool that builds its own settings can instead use `porch hooks claude`, which prints JSON whose `settings` field is what to pass with `claude --settings`. Both are described in [docs/domains/claude-adapter.md](docs/domains/claude-adapter.md). `porch list` and `porch watch` show only sessions Porch is attached to: ones with its hooks (or, for Pi, its extension). A Claude Code session without the hooks shows only with `--all`, marked `"attached": false`, with a coarser status taken from Claude Code's own listing; it can still be observed and woken by naming it.

For Pi, Porch's inside part is a Pi extension, loaded for one session with `pi -e`. Start Pi with `porch launch pi` (or `alias pi='porch launch pi'`), or pass the arguments `porch extension pi` prints. Porch installs nothing into Pi's own folders. Pi has no list of its sessions that Porch could read, so a Pi session started without the extension is invisible to Porch. See [docs/domains/pi-adapter.md](docs/domains/pi-adapter.md).

A session that stops shows as `ended` when it ended cleanly (with `endReason`, why, where the harness says; `idle` for a Claude Code background session that Claude Code stopped for being idle) and `gone` when it did not (a crash, `kill -9`). `porch list` and `porch watch` leave both out unless given `--all`, though `watch` reports the end of a session it was showing; `porch observe` still answers for them. Their records are removed 24 hours later.

`porch --help` lists every command, including the harness commands. All output is JSON with `"schema": 2`; errors are JSON too, with documented exit codes. Session records live in `~/.porch/sessions/` (set `PORCH_HOME` to move them).

## Library

```ts
import { Porch } from "@dylankuhlenthal/porch";

const porch = new Porch();
const { sessions } = await porch.list();
for (const s of sessions) {
  if (s.self?.status === "needs-input") {
    await porch.deliver(s.session, "please look at the PR", { from: "reviewer", harness: s.harness });
  }
}
```

The main import has the same operations as the command, returning the same shapes. Helpers for testing code built on Porch without a real harness (a fake adapter, the record store) are at `@dylankuhlenthal/porch/testing`. [docs/reference/library.md](docs/reference/library.md) lists everything that is supported and how the version number signals a breaking change; [CHANGELOG.md](CHANGELOG.md) lists what changed in each release.

## Docs

- [docs/architecture.md](docs/architecture.md): how Porch works.
- [docs/reference/cli-output.md](docs/reference/cli-output.md): the output contract and exit codes, for tools that call `porch`.
- [docs/patterns/adapter-contract.md](docs/patterns/adapter-contract.md): writing an adapter for a harness.
- [docs/reference/library.md](docs/reference/library.md): the supported library and the version rules.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute, and what an adapter PR must include.
- [SECURITY.md](SECURITY.md): how to report a vulnerability privately.

## Licence

MIT, see [LICENSE](LICENSE).
