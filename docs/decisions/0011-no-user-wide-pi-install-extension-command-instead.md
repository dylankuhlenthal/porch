# 0011: No user-wide Pi install; `porch extension pi` prints the extension, and `porch launch pi` passes it

**Date:** 2026-09-30
**Status:** Accepted

## Context
When Porch was first shaped, `porch install pi` was to copy Porch's extension into Pi's user folder (`~/.pi/agent/extensions`), so every Pi session would have it. Pi can instead load an extension for one session with `pi -e <file>`, which is how `porch launch pi` attaches Porch. Decision 0009 (no user-wide hook install for Claude Code, an alias instead) settled the same question for Claude Code.

## Decision
Porch does not build `porch install pi`, and never writes into Pi's own folders or settings. It has `porch extension pi`, the Pi counterpart of `porch hooks claude`: it prints, as JSON, the Pi arguments that attach the extension to one session (`-e <file>`) and the environment it needs for a records folder other than the default. `porch launch pi` adds exactly those arguments, from the same code (`piExtensionArgs` in `src/adapters/pi/launch.ts`), so the two always name the same file. A person who wants every Pi they start to have Porch attached uses `alias pi='porch launch pi'`. The maintainer chose this over building the install command, and over the command without the launch sharing it.

## Consequences
Nothing Porch does changes Pi for sessions it did not start. A Pi session started without the extension is invisible to Porch (Pi has no outside listing), so tools that start Pi themselves pass `porch extension pi`'s arguments or use `porch launch pi`. An opt-in install stays allowed for later, for sessions started by tools the person does not control.
