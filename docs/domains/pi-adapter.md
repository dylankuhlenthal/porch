# The Pi adapter

Lets Porch see and wake [Pi](https://github.com/earendil-works/pi) sessions. Pi has no outside way into a running session and no listing of its sessions, so everything comes from the inside part: a Pi extension that keeps each session's record up to date and listens on a socket for delivered messages. The outside part reads those records, checks with `ps` that each session's process is still running, and delivers through the recorded socket.

Code: `src/adapters/pi/` (`index.ts` the adapter, `extension.ts` the extension, `protocol.ts` the socket and what is written on it, `process.ts` reading `ps`, `observe.ts` how status is worked out, `launch.ts` the plan for `porch launch pi`, `commands.ts` `porch extension pi`). The socket check before sending is shared with the Claude Code adapter (`checkSocketOwner` in `src/unix-socket.ts`). Conformance driver: `src/conformance/drivers/pi.ts`. Checked against Pi **0.87.1**.

## Attaching the extension: `porch launch pi` and `porch extension pi`

Pi loads an extension for one session with `pi -e <file>`. Porch never installs its extension into Pi's own folders (`~/.pi/agent/extensions`) or changes Pi's settings; it is loaded per session, one of two ways (decision 0011, no user-wide Pi install):

- **`porch launch [--porch-home <dir>] [--dry-run] pi [pi arguments...]`** starts Pi with `-e <extension>` added first and the caller's arguments passed through unchanged (how launch works in general: `docs/architecture.md`, "Launch"). `-e` goes first so it can never land after a `--`, where Pi would read it as the prompt. The one exception is Pi's own subcommands (`install`, `remove`, `uninstall`, `update`, `list`, `config`, `auth`; `PI_SUBCOMMANDS` in `launch.ts`): Pi takes a subcommand only as the first argument, and with `-e` in front it reads `list` as a prompt and starts a session. A subcommand starts no session, so Porch passes its arguments through as they are. `--no-extensions` still loads extensions given with `-e`, so there is no case where Pi skips Porch's extension; `porch launch pi` prints no warnings.
- **`porch extension pi [--porch-home <dir>]`** prints what a tool or person passes to Pi themselves, the Pi counterpart of `porch hooks claude` (`schemas/pi-extension.schema.json`):

  ```json
  { "schema": 2, "harness": "pi", "extension": "/abs/.../dist/adapters/pi/extension.js", "porchHome": null,
    "args": ["-e", "/abs/.../dist/adapters/pi/extension.js"], "env": {} }
  ```

  `args` are exactly what `porch launch pi` adds (`piExtensionArgs` in `launch.ts`, used by both). With `--porch-home`, `env` is `{ "PORCH_HOME": "<dir>" }`: set it in Pi's environment. Unlike Claude Code's hooks, the extension cannot have the records folder written into it, because an extension takes no arguments; it reads `PORCH_HOME` (or uses `~/.porch`) from Pi's environment. `porch launch --porch-home` sets that variable for the Pi it starts. Pi always starts as a new process, so, unlike `claude --bg`, there is no earlier environment that could override it.

```sh
porch launch pi                      # interactive, like running pi
porch launch pi --mode rpc           # a session a tool drives over stdin
alias pi='porch launch pi'           # every pi you start has Porch attached
pi $(porch extension pi | jq -r '.args[]')   # the same, by hand
```

`extension` names this Porch's build (`dist/`), so it works whatever is on Pi's `PATH`; if Porch is moved or reinstalled, print it again. Pi loads it with its own TypeScript loader; the file is plain JavaScript that uses only Node's built-in modules and Porch's own files next to it.

## What the extension records

The extension (`extension.ts`) writes the record's `inside` part (`docs/domains/session-records.md`) for the id Pi gives the session (`ctx.sessionManager.getSessionId()`). Writes happen one after another, in event order.

| Pi event | Change to the record |
| --- | --- |
| `session_start` | `pid` (Pi's process), `status`: `idle`, or `busy` if Pi is already running a turn, `delivery: { via: "socket", address }` (or null if the socket could not be opened), `cwd`, and in `data`: `processStartedAt` (when Pi's process started), `sessionFile` (Pi's session file, null for `--no-session`), `mode` (`tui`, `rpc`, `json` or `print`), `source` (why the session started: `startup`, `reload`, `new`, `resume`, `fork`), `prompt: null`, `lastError` |
| `agent_start` | `status: busy`, `lastTurnStart: now` |
| `agent_settled` | `status: idle`, `lastTurnEnd: now` |
| `ui_prompt_start` | `data.prompt: { kind, title, since }`: an extension dialog is open (Pi's own dialog kinds: `select`, `confirm`, `input`, `editor`, `custom`) |
| `ui_prompt_end` | `data.prompt`: the dialog still open under it, or null |
| `session_shutdown` | `status: ended`, `endedAt: now`, `endReason`: Pi's reason (`quit`, `new`, `resume`, `fork`); then the socket is closed and removed. On a `reload` the record is left as it is for the `session_start` that follows, and only the socket is closed |
| the process exits (Node's `exit` event) | only if the session is still open (`session_shutdown` never ran) and the exit code is 0, 129 or 143 (`CLEAN_EXIT_CODES`): `status: ended`, `endedAt: now`, `endReason: null` (Pi gave none), `data.exitCode`. Also, if `session_shutdown` ran but its write had not finished, that write is done now. Written synchronously (`updateInsideIfExistsSync`), since nothing asynchronous runs once the process is exiting. Any other exit code (Pi exits 1 when it crashes) leaves the record, so the session shows as `gone` |

**Why the exit fallback.** Every normal way of closing Pi was tried with 0.87.1 (2026-09-30), both run directly and under `porch launch pi` (see "Observed" below): all finish `session_shutdown` except closing the terminal while a turn is running. Then the SIGHUP starts `session_shutdown`, but Pi's turn output hits the closed terminal and Pi's handler for a dead terminal calls `process.exit(129)` at once (`emergencyTerminalExit` in Pi's `interactive-mode.js`), before an extension's asynchronous work finishes. Before this fallback, Porch's record was left saying busy, so the session showed as `gone`: very likely what Dylan saw. Node's `exit` event still fires, so the extension finishes its `ended` mark there: the mark is set as the first step of `session_shutdown`, and the fallback writes it if the asynchronous write has not happened. In three runs of this close under `porch launch pi` the session showed `ended` with reason `quit` each time. If Pi ever exited this way before `session_shutdown` started, the fallback would still mark it ended, with no reason (Pi gave none) and `data.exitCode`; that path is pinned by the per-PR tests, not seen in a real run.

Idle comes from `agent_settled`, not `agent_end`: Pi documents `agent_settled` as the point after which it will not continue by itself, while `agent_end` can be followed by a retry, a compaction or a queued message. One `agent_start` to `agent_settled` span covers every follow-up message queued during it, so `lastTurnStart` is when that run started. Only `session_start` creates a record; the other events change it only if it exists. A session replaced in the same process (`/new`, `/resume`, a fork) is marked ended at `session_shutdown` (with that reason), and the new session writes its own record. A late event after the end (an `agent_settled`, say) changes nothing: the record store refuses to change an ended session's inside part except through a new start. `backgroundTasks` is not used.

A handler never disturbs the session: every one catches its own errors, and a problem (the socket not opening, for example) is kept in `data.lastError`.

## How status is worked out

The record is the only source; `ps` only says whether its process is still running. `list` runs one `ps -o pid=,etime= -p <pids>` for every Pi record (`readProcesses` in `process.ts`), through `ctx.io`, so conformance runs record it. A pid is the session's process only when the process with that pid started within 10 seconds of the record's `processStartedAt` (`ps` gives the elapsed time to the second), so a pid reused by another process after a crash does not revive the session. A pid missing from `ps`'s output is not running; `ps` exiting 1 is read the same as 0, because it exits 1 when some or all of the pids are gone (macOS's `ps` exits 1 only when none is running, while Linux's procps may exit 1 and still print the running ones). The extension takes the start time from `performance.timeOrigin`, the wall-clock time its process started, which stays fixed for the process's life (the current time minus `process.uptime()` would drift by however long the machine slept). In order (`piObservation` in `observe.ts`):

1. The inside part says `ended`: `ended`, with `since` its `endedAt` and its `endReason`, whether or not the process still runs (after `/new` it goes on with another session). No `ps` is run for ended records.
2. The record has no inside part or no `pid` (for example only a `self` part from `porch status set`): `unknown`.
3. `ps` could not be run or printed something Porch cannot read: `unknown`.
4. The process is not running, or its pid belongs to a process that started later: `gone`, with `since` null. A record left behind (a crash, `kill -9`) stays until `porch list` or `porch watch` removes it, 24 hours after first seeing it gone (`docs/domains/session-records.md`).
5. An extension dialog is open (`data.prompt`): `waiting-on-prompt`, with `since` when it opened. This wins over busy: a dialog holds the session until a person answers, whatever the turn is doing.
6. The inside part has a status: that status and its `since`.
7. Otherwise `unknown`.

**Attached.** A session is attached (`attached: true`) when its record has an inside part, that is when Porch's extension wrote it; a record holding only a `self` part is not attached and shows in `porch list` only with `--all`. Pi has no outside listing, so every session Porch can see without `--all` is one the extension recorded, and `--all` adds only such `self`-only records (decision 0012, list and watch show attached sessions).

`detail`:

| Field | Meaning |
| --- | --- |
| `pid` | Pi's process, from the record |
| `cwd`, `mode`, `sessionFile` | from the record |
| `prompt` | while a dialog is open: `{ kind, title }` |
| `hasInsidePart` | the record has an inside part (the same as `attached`) |
| `lastTurnStart`, `lastTurnEnd` | from the record (see the events table) |

`raw` is `{ record, ps }`: the record, and the `ps` line for the session's pid as printed (it holds the elapsed time, so it changes on every look; watch ignores `raw`).

## Deliver

`deliver` observes the session first: no record, `ended` or `gone` is `not-running`. Otherwise it connects to the socket the extension recorded, after checking that its path has the shape the extension makes for the recorded process (a folder named `porch-<uid>` for this user, holding `pi-<pid>.sock`), so a record pointing at another of the user's sockets is refused, and that it is a socket owned by this user and not a symlink (`checkSocketOwner`), writes one request line and waits up to 5 seconds for one reply line (`protocol.ts`):

```
request: {"type":"deliver","text":"[from sous chef] ..."}
reply:   {"ok":true,"status":"idle"}     (or "busy", "waiting-on-prompt")
     or  {"ok":false,"error":"..."}
```

The extension hands the text to Pi with `pi.sendUserMessage(text, { deliverAs: "followUp" })`: when Pi is idle this starts a turn; while it is busy the message waits until the current run has finished its work, then Pi takes it in the same run. The reply's `status` is the session's own status at that moment, and becomes `statusAtSend`. So `delivered` means Pi accepted the message, nothing more. No record socket, a refused path, nothing listening, no reply, or an error reply is `failed` with the reason. `guessed` is always false: the address is only ever the recorded one.

The socket is `<tmp>/porch-<uid>/pi-<pid>.sock`, where `<tmp>` is Pi's temporary folder (`TMPDIR`, a per-user folder on macOS; `/tmp` when `TMPDIR` is not set). It is not in `PORCH_HOME` because a socket path has a length limit (104 bytes on macOS) that a deep scratch folder could pass. Before listening, the extension makes the folder with mode 0700 and refuses it if it is a symlink, belongs to another user, or others can write to it (`ensurePrivateDir`), since `/tmp` is shared; the socket file is set to mode 0600. A socket file left by an earlier process with the same pid is replaced. A request over 1 MB (counted in bytes) is refused, and a connection that has not sent its whole request line within 5 seconds is closed (`CONNECTION_TIMEOUT_MS` in `extension.ts`). When the session ends, open connections are closed before the socket, so a client that never finishes cannot hold up the session's end.

## Other behaviour

- `current`: `PI_SESSION_ID`, which Pi sets for commands its bash tool runs (not for commands a person runs with `!`).
- `observe` and `deliver` take the full session id only; Pi's own partial ids are not accepted.
- `list` reads no Pi files and runs no Pi command, only `ps` (and only when there are Pi records).
- `detect` runs `pi --version`. `PORCH_PI_BIN` names the `pi` command (default `pi` on `PATH`), for `detect` and `porch launch pi`; `PORCH_PS_BIN` names `ps`. The per-PR tests point `PORCH_PI_BIN` at a command that does not exist.
- Capabilities: queues while busy, sees prompts (extension dialogs), no outside listing, has an inside part, can launch. Watch polls every 3 seconds, because a process that dies without its shutdown handler shows only in `ps`; every other change is a record write.

## What it relies on from Pi (0.87.1)

**Documented** (in the package's `docs/`: `extensions.md`, `cli.md`, `environment-variables.md`, `session-format.md`; and the exported types in `dist/core/extensions/types.d.ts`):

- `-e <path>` loads an extension for the current process and can be repeated; `--no-extensions` keeps explicit `-e` paths. `--session-id <id>` opens or creates a session with that id.
- Extension events `session_start` (with `reason`), `session_shutdown` (with `reason`: `quit`, `reload`, `new`, `resume`, `fork`), `agent_start`, `agent_settled` ("after an agent run has fully settled and no automatic retry, compaction, or queued continuation will run"), `ui_prompt_start` and `ui_prompt_end` (a blocking extension dialog opens and closes); `ctx.isIdle()`, `ctx.mode`, `ctx.cwd`, `ctx.sessionManager.getSessionId()` and `getSessionFile()`.
- `pi.sendUserMessage(text, { deliverAs: "followUp" })`, and that without `deliverAs` it throws while Pi is busy.
- Long-lived resources such as sockets belong in `session_start` and are closed in `session_shutdown`.
- `PI_SESSION_ID` in the bash tool's environment. Pi asks for no permissions itself; dialogs come only from extensions.

**Observed, not documented** (all with 0.87.1, 2026-09-30):

- A follow-up sent while idle starts a turn; one sent while busy is taken in the same run (no second `agent_start`), and `agent_settled` fires once at the end.
- `session_shutdown` (reason `quit`) runs on SIGTERM, when an RPC session's stdin closes, and on `/quit`; SIGTERM ends an RPC session with exit code 143. A SIGKILLed Pi runs no handler, so its record is left behind.
- How each way of closing the terminal UI ends (checked 2026-09-30 by running each, with an extension logging `session_shutdown` and Node's `exit` event, and with Porch's own extension checking the record; each run directly and under `porch launch pi`, idle unless said):

  | Close | `session_shutdown` | Exit code | Porch shows |
  | --- | --- | --- | --- |
  | `/quit`, Ctrl+C twice, Ctrl+D | runs, reason `quit` | 0 | `ended`, `quit` |
  | SIGHUP or SIGTERM to Pi, or to `porch launch` (which passes them on), or SIGHUP to the whole terminal group | runs, reason `quit` | 0 | `ended`, `quit` |
  | the terminal closing (the pseudo-terminal's controlling side closed), idle | runs, reason `quit` | 129 | `ended`, `quit` |
  | the terminal closing during a turn | starts, but Pi exits 129 on the dead terminal before it finishes | 129 | `ended`, `quit`, written by the exit fallback (3 of 3 runs under `porch launch pi`) |
  | `porch launch` killed with SIGKILL | does not run (Pi exits 1 once its terminal goes) | 1 | `gone` |

  In the terminal UI, SIGTERM exits 0, not 143 (Pi's signal handler shuts down and exits 0).
- A run stopped with RPC's `abort` command fires `agent_end` and `agent_settled` at once, so the record goes back to idle. Escape in the terminal UI (the same "abort") was not tried.
- `ui_prompt_start` fires in RPC mode too, when an extension's dialog is sent to the RPC client.
- The `pi` launcher `exec`s Node, so the process `porch launch` starts is Pi's own and its pid is the one the extension records.
- Pi reads a subcommand only as the first argument; `pi -e <file> list` reads `list` as a prompt and runs a turn.
- In the terminal UI, one Ctrl+C clears the editor and leaves Pi running (a second one exits); `/quit` exits with code 0 and runs `session_shutdown`.
- Extension files written as plain JavaScript ES modules, importing other files next to them, load with `-e`.
- Pi's `package.json` asks for Node 22.19 or later, and this machine runs Pi with it. On Node 22.14, `pi --version` and starting an RPC session (with `session_start`) worked; turns were not tried there.

## Conformance

`npm run conformance -- --harness pi [--record]` runs the suite against real Pi sessions, with Node 22.19 or later first on `PATH` (Pi's own requirement; the sessions start `pi` from `PATH`). Pi has no background mode, so the driver's own sessions run in RPC mode (`pi --mode rpc`) as its child processes, and it gives them prompts on stdin, as a tool driving Pi would. Every session gets `-e` with Porch's extension (or, for the launch cases, only what `porch launch pi` adds), `--no-extensions`, `--no-skills`, `--no-prompt-templates` and `--no-context-files`, so the person's own Pi resources can neither leak in nor hide a failure, its own `--session-dir` in the case's scratch folder, so no test session lands in the person's history, a `--session-id` the driver chooses, the model `openai/gpt-4.1-mini` (`DEFAULT_PI_MODEL`), and an appended system prompt telling it to follow the test's messages. A helper extension adds a command that opens a confirm dialog nobody answers, for the held-at-prompt case. The launch-background case starts `porch launch --porch-home <case folder> pi --mode rpc` with a caller extension that writes a marker file at `session_start`; the launch-interactive case runs `porch launch pi` in its terminal UI in a `node-pty` pseudo-terminal (`src/conformance/drivers/pty.ts`, shared with the Claude driver) and ends it with `/quit`. Cleanup closes each session's stdin (then SIGTERM, then SIGKILL), sends SIGHUP to each terminal, and kills any Pi process of the case that is still running by the pid its record gives.

Requirements: Pi installed and logged in to the model's provider (`pi auth check --model openai/gpt-4.1-mini` says ready; otherwise the run is skipped, exit 3), or `OPENAI_API_KEY` set. Real turns cost a little (about half a US cent each with this model; a full run makes about seven).

Last recorded run: Pi 0.87.1 on darwin-arm64 with Node 22.19, 2026-09-30: eleven cases passed, including `ended-cleanly` (closing an RPC session's stdin gives `endReason` `quit`) and `launch-interactive` ending as `ended` with `quit` after `/quit`, and `without-inside-part` was skipped because Pi has no outside listing (`conformance/reports/pi.json`, fixtures in `conformance/fixtures/pi/`). All fixtures were re-recorded then for TRV-1150, at schema 2.

## Known limits

- **A session without Porch's extension cannot be seen.** Pi has no outside listing, so a Pi session started without `-e` (or `porch launch pi`) is not listed and cannot be delivered to. The `without-inside-part` conformance case is skipped for Pi.
- **No user-wide install command.** Porch does not write into `~/.pi/agent/extensions`. To attach Porch to every Pi a person starts, use `alias pi='porch launch pi'` (decision 0011, no user-wide Pi install). An opt-in install stays allowed for later, for sessions started by tools the person does not control.
- **Some closes still show as `gone`.** A crash (Pi exits 1), `kill -9`, and `porch launch` itself being killed with SIGKILL (Pi then exits 1 without `session_shutdown`) leave the record as it was, so the session shows as `gone`, and its record is removed a day later. A terminal closed mid-turn ends as `ended` only through the exit fallback, which relies on Node's `exit` event firing when Pi calls `process.exit`.
- **The socket check and the connection are two steps.** Someone who can write to the socket's folder could swap the file between the check and the connection; the extension refuses a folder others can write to, so this needs that folder's owner.
- **Pi's timing is not measured.** No case checks how quickly the record says busy after a run starts; the extension writes at each event, so it is as quick as a record write.
- **The CI run has not happened yet.** The scheduled workflow installs the latest Pi from npm and uses the `OPENAI_API_KEY` secret, which is not set yet (`docs/operations/ci.md`).
