# The Claude Code adapter

Lets Porch see and wake Claude Code sessions. Its inside part is a set of hook commands that keep each session's record up to date; its outside part combines those records with Claude Code's own session listing (`claude agents --json`) and job files, and delivers messages through each session's messaging socket.

Code: `src/adapters/claude/` (`index.ts` the adapter, `hooks.ts` the hook commands and `porch hooks claude`, `listing.ts` reading `claude agents --json` and job files, `observe.ts` how status is worked out, `socket.ts` sending a message). Conformance driver: `src/conformance/drivers/claude.ts`. Checked against Claude Code **2.1.284**.

## Installing the hooks: `porch hooks claude`

`porch hooks claude [--porch-home <dir>]` prints the hook settings; it installs nothing. Callers decide where the hooks go, so nothing changes system-wide unless someone chooses it: sous chef passes them with each session's `--settings` and in its own folder's settings. Porch changes no Claude Code setting by itself, and does not add `crossSessionInbound`; sous chef adds `"crossSessionInbound": "accept"` itself. There is no user-wide install command yet (see "Known limits"). These choices, and the other choices this page gives reasons for, were made while shaping Porch; the shaping record is the Linear issue TRV-1133.

Output (`schemas/claude-hooks.schema.json`):

```json
{
  "schema": 1,
  "harness": "claude",
  "node": "/abs/path/to/node",
  "cli": "/abs/path/to/porch/dist/cli/main.js",
  "porchHome": null,
  "settings": {
    "hooks": {
      "SessionStart":      [{ "hooks": [{ "type": "command", "command": "'/abs/node' '/abs/.../main.js' hooks claude on SessionStart", "timeout": 10 }] }],
      "UserPromptSubmit":  [ ... same shape ... ],
      "Stop":              [ ... ],
      "StopFailure":       [ ... ],
      "PermissionRequest": [ ... ],
      "SessionEnd":        [ ... ]
    }
  }
}
```

- `settings` is exactly what `claude --settings` takes. To combine it with your own hooks, append each event's array entries to your own array for that event (`hooks.Stop = [...yours, ...porch]`); Claude Code runs every matching entry.
- **How the hook finds Porch**: each command is the absolute path of the node running `porch hooks claude` plus the absolute path of that Porch's `dist/cli/main.js`, both quoted for sh. So it works under `claude --bg` and in sessions whose `PATH` has no `porch`. If Porch is moved or reinstalled somewhere else, print the settings again.
- **Where records go**: without `--porch-home`, the hook uses the session's `PORCH_HOME`, or `~/.porch`. `--porch-home <dir>` bakes `PORCH_HOME='<dir>'` into each command. Use it whenever the records folder is not the default: a `claude --bg` session may start in a spare process Claude Code prepared earlier, carrying an earlier launch's environment, so a `PORCH_HOME` set only on the launch command may not reach the hooks.

## What the hooks record

Each hook runs `porch hooks claude on <event>` with Claude Code's hook JSON on stdin, and writes the record's `inside` part (`docs/domains/session-records.md`) for the hook's `session_id`:

| Event | Change to the record |
| --- | --- |
| `SessionStart` | `pid` (from `CLAUDE_PID`, or the number in the socket name), `delivery: { via: "socket", address: $CLAUDE_CODE_MESSAGING_SOCKET }`, `cwd`, `status: idle` (except after a compaction, which may happen mid-turn, when the status is left alone), `backgroundTasks: null` unless the hook runs in the same process that wrote the record (both pids known and equal; a compaction, `/clear` or an in-session `/resume` can be the same process, so the source name is not used; a different or unknown pid means the old count may not apply), and in `data`: `source`, `transcriptPath`, `shortId` (from `CLAUDE_JOB_DIR`), `startedAt` (kept through a compaction) |
| `UserPromptSubmit` | `status: busy`, `lastTurnStart: now`. It fires for every prompt, including a message delivered mid-turn, so `lastTurnStart` is the last prompt, the same as sous chef's `sc hook worker-prompt` recorded |
| `Stop` | `status: idle`, `lastTurnEnd: now`, `backgroundTasks`: the number of entries when the hook's `background_tasks` is a list, the number itself when it is a whole number, and null otherwise (including when the hook gives none) |
| `StopFailure` | `status: idle`, `lastTurnEnd: now`, `data.lastStopFailure: { at, error }` |
| `PermissionRequest` | `data.lastPermissionRequest: { at, tool }` only. Whether a prompt is open comes from the listing; this write makes `porch watch` look again at once |
| `SessionEnd` | the record is removed |

`SessionStart` keeps `lastTurnStart` and `lastTurnEnd` as history, whatever the process.

Only `SessionStart` creates a record. The other events change the record only if it exists, so a hook that runs after `SessionEnd` has removed the record (a late `Stop` or `PermissionRequest`, say) does not bring back a partial record that nothing would remove. A session whose `SessionStart` hook did not run under Porch's hooks therefore has no record, and shows the listing's status (rule 5 below).

**A hook never changes what the session does.** Claude Code reads a hook's exit code 2 as "block" (for `Stop`, the turn keeps going), adds a `SessionStart` or `UserPromptSubmit` hook's stdout to the model's context, and reads JSON on stdout from a `PermissionRequest` hook as an answer to the prompt. So `porch hooks claude on` always exits 0 and prints nothing on stdout, whatever goes wrong (bad input, unknown event, a records folder it cannot write); problems go to stderr only. This matters because Porch's own exit code for a usage error is 2, which Claude Code would read as "block". Apart from help, which prints plain text, this is the only Porch command that does not print JSON (`docs/reference/cli-output.md`).

## How status is worked out

Busy and idle come from the hook record, except that the listing's idle wins over the record's busy; alive, pid and waiting-on-prompt come from `claude agents --json`; the job file only feeds `detail` and `raw`. The record was chosen over the listing because the listing's `busy` has been seen stale for 15 minutes after a turn ended, and Claude Code's docs say the job file is not a stable interface. That reason says nothing against the listing's `idle`, and the record's `busy` goes stale in a known case: `Stop` does not fire when a turn is interrupted, so the record says busy until the next prompt. So the listing's idle wins over the record's busy, and the record's idle still wins over the listing's busy. In order (`claudeObservation` in `observe.ts`):

1. No listing row with a `pid`: `gone`. A record left behind (a crash, `kill -9`) does not revive it. A session Claude Code stopped (`claude stop`) drops out of the listing entirely. Its `SessionEnd` hook normally removes the record too, and then `observe` answers not found (and `deliver` `not-running`); if the record was left, it shows as `gone`. Consumers should read not found as not running.
2. The listing says `waiting`: `waiting-on-prompt` (`since` is null: Claude Code does not say when it started).
3. The record's inside part says `busy`, was written by the listed process, and the listing says `idle`: `idle`, with `since` null, `statusSource: "listing"` and `detail.recordStatus: "busy"`, so a consumer can see the record disagreed. This is what an interrupted turn looks like (see "Known limits").
4. The record's inside part has a status, written by the listed process: that status and its `since`.
5. Otherwise the listing's own `busy` or `idle`, with `since` null. This covers a session without Porch's hooks (no record), a record without an inside status (for example one holding only a `self` part from `porch status set`), and a record written by an earlier process of the session: when the record's `pid` and the listing's `pid` are both known and differ (a resume without the hooks), the record's status belongs to the old process, so it is not used and `detail.recordPid` says which process wrote it. `deliver` ignores that record's socket for the same reason. Sessions without the hooks were always meant to get only this coarser status.
6. Otherwise `unknown`.

**No grace period at the start of a turn.** Rule 3 would report idle during a real turn if the listing showed busy later than the `UserPromptSubmit` hook wrote busy; `porch watch` would then print busy, idle, busy, and `deliver`'s `statusAtSend` would say idle. Measured with Claude Code 2.1.285 on 2026-09-30 (haiku background sessions, polling `claude agents --json` about every 40 ms): 18 turns started through the socket (short replies, `sleep 5`, one `sleep 20`, and two that ran a subagent doing `sleep 8`) and 4 typed through `claude attach`. Every listing read that started after the hook wrote busy, and every read that started up to about 120 ms before it, already said busy, and no read said idle while the record said busy, through the whole of each turn, including while the tool call or the subagent ran. So rule 3 trusts the listing's idle at once. Not measured: a compaction mid-turn, background commands started with `run_in_background`, and a message delivered mid-turn (the conformance case `deliver-while-busy` does check that `statusAtSend` is busy then). If the listing is ever seen saying idle during a real turn, trusting the record's busy for a few seconds after `lastTurnStart` would cover turn start, but not a flicker later in the turn.

With an old process's record, the rest of what comes from the record (`self`, `lastTurnStart`, `lastTurnEnd`, `backgroundTasks`, `shortId`) is still shown.

`detail`:

| Field | Meaning |
| --- | --- |
| `pid` | the session's process, from the listing (null when gone) |
| `shortId`, `name`, `cwd` | from the listing (`shortId` falls back to the record) |
| `prompt` | while waiting: what for, as the listing says (`permission prompt`, `input needed`, `sandbox request`, `worker request`, `dialog open`) |
| `promptNeeds` | while waiting: the exact ask from the job file (for example `approve Bash: touch x`), when it has one |
| `hasInsidePart` | the session has a record written by Porch's hooks |
| `statusSource` | `hooks` (rule 4 above) or `listing` (rule 3 or 5), null otherwise |
| `recordPid` | present only when the record was written by another process than the listed one (rule 5): that process's pid. Left out otherwise, so the committed conformance recordings replay unchanged |
| `recordStatus` | present only when the listing's idle was used over the record's busy (rule 3): the record's status, `busy`. Left out otherwise, for the same reason. Like any change in `detail`, it appearing or going away makes `porch watch` print the session again |
| `lastTurnStart`, `lastTurnEnd`, `backgroundTasks` | from the record (see the hooks table) |
| `activity` | from the job file of a running session, or null: `{ detail, inFlight, running: [{ kind, label, since }] }`: the session's own one-line summary, how many subagents and background commands it started are still running (`inFlight.tasks`; null when the field is missing or odd), and which (the `fan` entries without `doneAt`; `since` as ISO 8601) |

`raw` is `{ listing, job, record }`: the `claude agents --json` row as printed (with the short `id`, `name` and `sessionId`), the job file as read (null for a session that is not running, or when the file names another session), and the record.

Because watch compares `detail`, a change in `activity` (for example the session's summary line) is reported as a change.

**Finding a session**: `observe`, `deliver` and `porch watch --session` take the full session id or the short id (watch matches it against `detail.shortId` in the listing it already has, `sessionIdIn` in `index.ts`); the output always uses the full session id. A short id is also found through the record the `SessionStart` hook wrote, so a killed session whose row has left the listing still shows as `gone` by its short id (a session without the hooks is then not found at all). Listing rows without a `sessionId` are left out (right after `claude --bg` the short id can appear before the session id); they show once the session id does.

## Deliver

`deliver` looks the session up in the listing first: not listed or no `pid` means `not-running`. Otherwise it writes one line, `{"type":"user","message":{"role":"user","content":"<text>"}}`, to the socket the `SessionStart` hook recorded, when the recorded `pid` matches the listing (after a resume without the hooks the recorded socket belongs to an old process). Without a usable record, or when nothing listens on the recorded socket any more, it tries `/tmp/cc-socks/<pid>.sock`, then `/tmp/cc-socks-<uid>/<pid>.sock`, and says `guessed: true` when one of those was used. Before connecting to any of these paths, recorded or guessed, `deliver` checks it with `lstat`: it must be a socket owned by the user running Porch, and not a symlink. `/tmp` is shared, so on a machine with other users someone else could create the path (or the folder) first and receive the message; a path that fails the check is skipped with the reason, and the next one is tried (`checkSocketOwner` in `socket.ts`). Nothing listening on any path, a path refused by the check, or any other socket error, is `failed` with the reasons, never `delivered`. The socket sends nothing back, so `delivered` means written, with `statusAtSend` the status at that moment. `CLAUDE_CODE_MESSAGING_TOKEN` is never used: it proves a message comes from the session's own child process, so using it from outside would get round the approval hold that bypass-mode sessions apply.

What the session does with it (observed with 2.1.284): an idle session starts a turn; a busy one takes it in between tool calls (it appears in the transcript as a `queued_command` attachment); a bypass-mode session without `crossSessionInbound: accept` holds it for approval, which shows as `waiting-on-prompt` with `prompt: "permission prompt"`.

## Other behaviour

- `current`: `CLAUDE_CODE_SESSION_ID`.
- `list` runs `claude agents --json` once (about 0.15 s) and reads the job file of each running session. If the `claude` command does not exist, no Claude session can be running: `list` returns only records, all `gone`. If it fails or prints something unexpected, the error goes to `porch list`'s `errors`.
- `PORCH_CLAUDE_BIN` names the `claude` command (default `claude` on `PATH`). The per-PR tests point it at a command that does not exist, so they never read the real sessions on the machine.
- Job files are read from `$CLAUDE_CONFIG_DIR/jobs/<short id>/state.json`, or `~/.claude/jobs/...`.
- Capabilities: queues while busy, sees prompts, has an outside listing and an inside part. Watch polls every 3 seconds, because a prompt opening and a session dying without `SessionEnd` show only in the listing.

## What it relies on from Claude Code (2.1.284)

**Documented** ([cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging), [agent view](https://code.claude.com/docs/en/agent-view), [hooks](https://code.claude.com/docs/en/hooks)):

- `CLAUDE_CODE_MESSAGING_SOCKET` is set for hooks and Bash commands; `crossSessionInbound` values `accept`, `hold`, `refuse`, and bypass-mode sessions holding outside messages by default.
- `claude agents --json` fields `id`, `sessionId`, `name`, `kind`, `cwd`, `pid` (only while running), `status` (`busy`, `waiting`, `idle`), `waitingFor`, `state`.
- `CLAUDE_CODE_SESSION_ID` in commands a session runs.
- The hook events used and their `session_id`, `source`, `cwd`, `transcript_path`; exit code 2 blocks; stdout on exit 0 is added to context (`SessionStart`, `UserPromptSubmit`); JSON from a `PermissionRequest` hook decides the prompt; `Stop` does not fire when the user interrupts a turn.

**Observed, not documented** (all with 2.1.284):

- The socket line format, and that the socket sends nothing back. The socket file is named after the session's pid (`/tmp/cc-socks/<pid>.sock`) and is left behind when the process is killed.
- `CLAUDE_PID` and `CLAUDE_JOB_DIR` in the hook environment.
- `Stop`'s `background_tasks` is a list, and Porch stores its length. The research before the build described it as a count, so Porch also accepts a plain whole number and stores it as given.
- `UserPromptSubmit` fires for messages delivered through the socket, both when idle and mid-turn.
- A killed session keeps its listing row without a `pid` for a few seconds, then leaves `claude agents --json` (only `--all` still lists it); a session stopped with `claude stop` leaves the listing.
- The job file and its fields (`detail`, `tempo`, `needs`, `inFlight.tasks`, `fan`).
- `claude agents --json --cwd <dir>` filters by the repository the folder belongs to, not by folder, so the conformance driver filters rows by `cwd` itself.
- `claude --bg` refuses to start in a folder that is not trusted, and trust is inherited from a trusted parent folder.
- Claude Code finds its login in the macOS keychain by the `USER` variable; without it, `claude auth status` says not logged in.

## Conformance

`npm run conformance -- --harness claude [--record]` runs the suite against real background sessions (`docs/patterns/conformance.md`). The driver starts each session with `claude --bg --model haiku --permission-mode default --setting-sources project --settings <case file>`, where the case's settings file holds Porch's hooks (with that case's `PORCH_HOME` baked in), `crossSessionInbound: accept` and permission to run `sleep`. `--setting-sources project` keeps the person's own user settings out, so their hooks, permission rules and `crossSessionInbound` cannot hide a failure. Sessions are told by an appended system prompt to follow the test's messages, because a model may otherwise decline instructions that arrive from "another Claude session". The driver tracks each session by short id as soon as `claude --bg` prints it, and cleanup runs `claude stop` and `claude rm` on each and checks none is left.

Requirements: Claude Code logged in, or `ANTHROPIC_API_KEY` set (otherwise the run is skipped, exit 3); and the checkout inside a folder Claude Code trusts, because the sessions run under `.conformance-tmp/` in the checkout.

Last recorded run: Claude Code 2.1.284 on darwin-arm64, 2026-09-29, all nine cases passed (`conformance/reports/claude.json`). Last run: Claude Code 2.1.285, 2026-09-30, without recording, after the listing's idle started winning over the record's busy: all nine passed. The fixtures and report are still from 2.1.284; none of their snapshots has a busy record with an idle listing, so they replay unchanged. No conformance case interrupts a turn, so rule 3 is checked in the per-PR tests only with made-up listings. Fixtures in `conformance/fixtures/claude/`; they keep only the case's own sessions from the listing (`scrubClaudeSnapshot` in `src/conformance/drivers/index.ts`), and a per-PR test checks they hold no other session and no home folder path.

## Known limits

- **An interrupted turn leaves the record saying busy.** `Stop` does not fire when a person interrupts a turn (Escape), so the record's inside part says `busy` until a later turn ends. The status is still right, because the listing's idle wins (rule 3 above): checked with Claude Code 2.1.285 by attaching to a background session through a pseudo-terminal (`claude attach <short id>`) and sending Escape during a `sleep 30` (the other behaviour on this page was observed with 2.1.284 and not rechecked on 2.1.285, apart from what the conformance run covers); `porch observe` said `idle` with `detail.recordStatus: "busy"` from about a second after the Escape. What is still not handled: `lastTurnEnd` is not set for an interrupted turn, and `backgroundTasks` keeps the count from the last `Stop`. Listening to the `Notification` hook's `idle_prompt` event was suggested as a way to record the interrupt, but in one try no `Notification` event fired within 80 seconds of the interrupt.
- **Interactive sessions**: Claude Code's docs say `claude agents --json` lists interactive sessions too, but Porch has only been checked with background sessions (`claude --bg`). An interactive session missing from the listing would show as `gone`.
- **No user-wide install command.** The shaping allowed for an opt-in command that installs the hooks for every session; it is not built yet, so hooks reach sessions only through settings a caller passes.
- **The socket check and the connection are two steps.** Someone who can write to the socket's folder could swap the file between the check and the connection. Claude Code (2.1.284, observed) creates `/tmp/cc-socks` owned by its user with mode 0700, so this needs that folder to have been created by someone else first. Checking the folder's owner as well would close it.
- **The job file is not a stable interface**; when its fields change, `activity` and `promptNeeds` read as null, never as wrong values.
- **The CI run has not happened yet.** The scheduled workflow installs the latest Claude Code, marks the checkout trusted in the runner's own `~/.claude.json` (undocumented fields) and uses the `ANTHROPIC_API_KEY` secret, which is not set yet (`docs/operations/ci.md`).
