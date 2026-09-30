# CLI output contract

What tools that call `porch` as a subprocess can rely on. `porch --help` lists the commands and flags; this page covers the output. Code: `src/cli/run.ts`, `src/cli/exit-codes.ts`, `src/types.ts`.

## Rules

- Every command prints JSON on stdout, one document per line, and every document has `"schema": 1`. `porch watch` prints one line per change; every other command prints exactly one line. The exceptions are help (`porch --help`, `-h` or `help`), which prints text (`porch` with no command prints the help text to stderr and a `usage` error on stdout), `porch hooks claude on <event>`, the command Claude Code's hooks run inside a session, which prints nothing on stdout and always exits 0, because Claude Code would read its output and exit code as instructions (`docs/domains/claude-adapter.md`), and `porch launch` (below).
- When a command fails it prints an error document instead, `{ "schema": 1, "error": { "code", "message" } }`, on stdout, and exits with the code's exit status. The message is for people; match on `code`.
- A breaking change to any output, the record format or an exit code bumps `schema`: removing or renaming a field, changing its meaning, or changing an exit code. Bump `SCHEMA_VERSION` in `src/types.ts` and the `schema` constant in every file in `schemas/`. Adding an optional field is not a breaking change.
- `porch watch` reports errors that do not stop it (an adapter's listing failing) as error documents on stderr, and keeps running. It exits 0 on SIGINT or SIGTERM, or when its stdout is closed; it notices a closed stdout at its next write, so after the reader goes away it keeps running until the next change.

## `porch launch`

`porch launch <harness> [harness arguments...]` should look exactly like running the harness directly, so it is the third exception:

- **Before the harness starts**, a failure is Porch's usual error document on stdout with its usual exit code: a usage error (exit 2) for an unknown harness, a harness whose adapter cannot launch, an unknown Porch option before the harness name, or harness arguments the adapter refuses (for Claude Code, a `--settings` file it cannot read or parse); an `internal` error (exit 1) when the harness program cannot be started at all (for example it is not installed).
- **Once the harness has started**, Porch prints nothing of its own on stdout: the harness owns stdout, stderr and the terminal. Porch exits with the harness's exit code, or, when a signal killed the harness, dies of the same signal (a shell reports 128 plus the signal's number). So after start, exit code 2 is the harness's, not a Porch usage error, and a caller cannot tell Porch's exit codes from the harness's by the number alone. Background launches (`porch launch claude --bg ...`) pass the harness's own output through unchanged; there is no JSON mode.
- **Warnings**, such as that Porch will not see the session (`docs/domains/claude-adapter.md`), are one line each on stderr, starting `porch launch: `, printed before the harness starts.
- `porch launch --dry-run <harness> ...` starts nothing and prints the launch plan, `{ schema, harness, command, args }` (`schemas/launch-plan.schema.json`), with exit 0, or the same errors as above.

## Outputs and their schemas

| Command | Output | Schema |
| --- | --- | --- |
| `porch list` | `{ schema, sessions: [observation...], errors: [{ harness, message }] }` | `schemas/list.schema.json` |
| `porch observe <session>` | an observation | `schemas/observation.schema.json` |
| `porch watch` | one observation per line | `schemas/observation.schema.json` |
| `porch deliver ...` | `{ schema, harness, session, result, statusAtSend, via, guessed, reason }` | `schemas/deliver.schema.json` |
| `porch current` | `{ schema, harness, session }`, both null outside a session | `schemas/current.schema.json` |
| `porch status set ...` | `{ schema, harness, session, self }` | `schemas/status-set.schema.json` |
| `porch adapters` | each adapter's detect result, capabilities (including `launch`: whether `porch launch` can start it) and inside part | `schemas/adapters.schema.json` |
| `porch launch --dry-run <harness> ...` | `{ schema, harness, command, args }`: what `porch launch` would run | `schemas/launch-plan.schema.json` |
| `porch --version` | `{ schema, version }` | `schemas/version.schema.json` |
| `porch hooks claude [--porch-home <dir>]` | `{ schema, harness, node, cli, porchHome, settings }`; `settings` is Claude Code `--settings` JSON with Porch's hooks | `schemas/claude-hooks.schema.json` |
| `porch fake ...` (test harness) | the session's observation; `porch fake deliveries` prints `{ schema, deliveries }` | `schemas/observation.schema.json`, `schemas/fake-deliveries.schema.json` |
| any failure | `{ schema, error: { code, message } }` | `schemas/error.schema.json` |

An observation is `{ schema, harness, session, status, since, detail, raw, self }`. `detail` is adapter-specific and documented in each adapter's doc; `raw` is the harness output for debugging and may change with the harness. Consumers should not depend on `raw`.

`errors` in `porch list` means one adapter could not list its sessions (for example the harness command failed), or a session record could not be read (`harness` is the record's harness, or `porch` if the records folder itself could not be read). Those sessions are missing or incomplete in `sessions`; they are not gone.

`porch deliver` answers `failed` (exit 4) rather than `not-running` when no adapter knows the session but one of them could not be asked; `porch observe` then gives an `internal` error (exit 1) naming the harness.

## Exit codes

| Code | Meaning | Error code |
| --- | --- | --- |
| 0 | success | |
| 1 | unexpected internal error | `internal` |
| 2 | usage: bad arguments or flags (including on harness commands), unknown command or harness, a harness that cannot launch, invalid sender label, invalid session id where a session id is written (`porch status set`, `porch fake ...`) | `usage` |
| 3 | `porch observe`: no adapter knows the session (including an id that is not a valid session id); `porch fake ...`: the fake session was never started | `not-found` |
| 4 | `porch deliver` ran but the result is `not-running` or `failed`; the deliver result is printed, not an error document | |
| 5 | `porch status set` did not run inside a session Porch can identify | `not-in-session` |
| 6 | more than one session matches: the same id in two harnesses (pass `--harness`), or two harnesses both claim the calling process | `ambiguous-session` |

Once `porch launch` has started the harness, its exit code is the harness's (see above).

`porch deliver` to a session no adapter knows is exit 4 with `result: "not-running"`, not exit 3: from the caller's side the session is not running.
