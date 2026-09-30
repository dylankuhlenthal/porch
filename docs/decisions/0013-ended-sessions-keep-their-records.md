# 0013: A session that ends cleanly is marked ended, and ended and gone records are removed a day later

**Date:** 2026-09-30
**Status:** Accepted

## Context
Dylan tested Porch by hand and found that closed Pi sessions stayed in `porch list` as `gone` while closed Claude Code sessions disappeared (TRV-1150). Claude Code's `SessionEnd` hook deleted the record, so `observe` answered not found and how the session ended was lost; a Pi session closed without Pi running `session_shutdown`, and a crashed session of either harness, left a record that showed as `gone` for ever. Sous chef, the first consumer, needs the difference: it resumes a session Claude Code stopped for being idle, leaves alone one that finished or was quit, and reports one that died.

## Decision
- New status `ended`: the session ended cleanly. Its inside part marks the record `ended` instead of deleting it, with `endedAt` and `endReason`, the harness's own reason (Claude Code: the `SessionEnd` hook's `reason`; Pi: the `session_shutdown` reason), or null when it gives none. Observations carry it as `endReason`, with `since` the end time.
- `gone` keeps its meaning: not running, and did not end cleanly.
- `porch list` and `porch watch` leave out ended and gone sessions unless `--all`; `watch` still prints the end of a session it was showing. `observe`, `deliver` and `watch --session` take them by name.
- The records of ended and gone sessions are removed 24 hours after they ended, or after `list` or `watch` first saw them gone (a `goneSeenAt` field those two write), when `list` or `watch` reads the records. Not configurable for now.
- Every normal way of closing a session should end as `ended`. Where the harness skips its end hook for a normal close, the adapter covers it if it can: the Pi extension marks the session ended when Pi's process exits cleanly without having run `session_shutdown` (a terminal closed mid-turn).
- `schema` goes to 2 for every output and the record format, following the versioning rule in `docs/reference/cli-output.md`: schema 1's JSON Schema rejects the new status, and `porch watch` printed a clean end as `gone`. Porch still reads schema 1 records, so records already on disk keep working. Nothing outside Dylan's own use depends on Porch yet (decision 0010), so the break is taken now.

## Consequences
A tool can tell a finished session from a crashed one on every harness, and read why it finished where the harness says. Records no longer pile up: a stopped session's record lasts a day, as long as something runs `list` or `watch`. Claude Code gives the same `endReason` (`other`) for `claude stop`, a closed terminal and SIGTERM, so for Claude Code `endReason` separates a person quitting (`prompt_input_exit`) from everything else, not one outside stop from another. `porch list` and `porch watch` now write to the records folder (`goneSeenAt`, removals), so they are no longer read-only.
