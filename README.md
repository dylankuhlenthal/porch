# Porch

Porch lets you wake a running agent session with a message and read what it is doing and whether it needs something, through one command that behaves the same whichever harness (Claude Code, Pi, ...) the session runs in.

It is a command-line tool with JSON output (`porch`), plus a thin TypeScript library on top. Each harness is supported by an adapter. This version ships the harness-neutral core, adapters for Claude Code and Pi, and a fake adapter for tests.

## Install

Porch is not on npm yet. Until it is, install it from GitHub (you need access to the private repo):

```sh
npm install git+ssh://git@github.com/dylankuhlenthal/porch.git
```

Node 22 or later. Installing builds the package, so `node_modules/.bin/porch` is ready afterwards.

## Use

```sh
porch list                                   # the sessions Porch is attached to
porch list --all                             # also Claude Code sessions started without Porch
porch observe <session>                      # one session's state, attached or not
porch watch                                  # one JSON line per change, until stopped (--all as for list)
porch deliver <session> --from "sous chef" "please look at the PR"
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

`porch --help` lists every command, including the harness commands. All output is JSON with `"schema": 1`; errors are JSON too, with documented exit codes. Session records live in `~/.porch/sessions/` (set `PORCH_HOME` to move them).

## Docs

- [docs/architecture.md](docs/architecture.md): how Porch works.
- [docs/reference/cli-output.md](docs/reference/cli-output.md): the output contract and exit codes, for tools that call `porch`.
- [docs/patterns/adapter-contract.md](docs/patterns/adapter-contract.md): writing an adapter for a harness.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute, and what an adapter PR must include.
