# 0008: `porch launch claude` adds `crossSessionInbound: accept` unless the caller sets it

**Date:** 2026-09-30
**Status:** Accepted

## Context
When Porch was first shaped it changed no harness settings: `porch hooks claude` prints hooks only, and callers such as sous chef added `"crossSessionInbound": "accept"` themselves. Without it, a Claude Code session in bypass-permissions mode holds every message from outside for approval, so a background session with nobody attached never gets woken. A launch helper that attaches Porch but leaves the session unwakeable in one permission mode would not do its job.

## Decision
For launch only, `porch launch claude` adds `"crossSessionInbound": "accept"` to the settings it passes, unless the caller's own `--settings` sets `crossSessionInbound` (any value), in which case the caller's value is kept (`mergeSettings` in `src/adapters/claude/launch.ts`). `porch hooks claude` still prints hooks only.

## Consequences
Every session started through `porch launch claude` can be woken whatever its permission mode. Because `--settings` outranks a person's user settings for single values like this one, a user-level `crossSessionInbound: refuse` is overridden in launched sessions; a caller who wants something else passes it in its own `--settings`. Sous chef stops adding the setting for sessions it starts through `porch launch`.
