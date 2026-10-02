# 0012: `porch list` and `porch watch` show only attached sessions by default

**Date:** 2026-09-30
**Status:** Accepted

## Context
The Claude Code adapter combines its hook records with Claude Code's own listing (`claude agents --json`). Porch's original design had that listing feed `porch list`, so every Claude Code session on the machine appeared, including ones started without Porch. Those sessions have only the listing to go on, and the listing is known to say busy long after a turn ends (seen live: an idle, waiting session listed as busy). Pi has no outside listing, so a Pi session without Porch's extension never appears: the same command meant different things per harness. The maintainer tried Porch by hand and asked why `list` showed every Claude session rather than the ones launched with Porch, and agreed that showing only those is the expected behaviour.

## Decision
A session is **attached** when Porch's inside part runs in it: for Claude Code, the session has a record written by Porch's hooks, from the process the listing shows (a record from an earlier process of the session, after a resume without the hooks, does not count); for Pi, a record written by Porch's extension; for the fake harness, a record with an inside part. A record holding only a `self` part does not count.

- `porch list` and `porch watch` show only attached sessions. `--all` also shows unattached ones, for harnesses with an outside listing (Claude Code today).
- Every observation, in `list`, `watch` and `observe` output, carries `attached: true|false`.
- `porch observe <id>`, `porch deliver <id>` and `porch watch --session <id>` still work on an unattached session when it is named explicitly, because the caller asked for that session. Delivery does not change.
- Adapters keep returning every session they can see, each marked `attached`; the core (`Porch.list`, `watchSessions`) leaves out the unattached ones unless asked. So each adapter decides once what attached means for its harness, and the rule for hiding is the same for all.
- This amends that original design: the listing still supplies alive, pid and waiting-on-prompt for attached sessions, and is how `--all` finds unattached ones, but it no longer adds unattached sessions to the default `list`.
- `schema` stays 1. `docs/reference/cli-output.md` counts an added field as not breaking, and the rule does not cover a change to which sessions a command shows by default. Nothing outside the maintainer's own use depends on Porch yet (it is private and unpublished, decision 0010), so the default changed now while that is cheap.

## Consequences
The default `list` means the same thing for every harness: the sessions Porch is attached to, whose status comes from the inside part. A tool that wants every Claude Code session on the machine passes `--all` and reads `attached`. A Claude Code session started without Porch no longer shows by default, so a person who does not use `porch launch claude` (or pass the hooks another way) sees an empty list; `README.md` and `porch --help` say so. A running `porch watch` that has already reported a session keeps following it if it stops counting as attached, rather than reporting it gone while it still runs.
