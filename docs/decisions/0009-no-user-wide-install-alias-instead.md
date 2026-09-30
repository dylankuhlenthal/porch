# 0009: No user-wide hook install for now; `alias claude='porch launch claude'` instead

**Date:** 2026-09-30
**Status:** Accepted

## Context
When Porch was first shaped, an opt-in command to install Porch's hooks for every session a person starts (writing `~/.claude/settings.json`) was allowed for later. With `porch launch`, the same result is possible without Porch writing anyone's user settings.

## Decision
Porch does not build `porch install claude` (or an uninstall) now. A person who wants every session they start to have Porch attached uses `alias claude='porch launch claude'`. The alias does not loop, because shells apply aliases only to what is typed, not inside `porch launch`. The opt-in install stays allowed for later, for example for sessions started by tools the person does not control.

## Consequences
Porch still never writes Claude Code's user settings. Sessions started without the alias, or by other tools that do not use `porch launch`, get Porch's hooks only if their caller passes them; they can still be listed and woken, with a coarser status.
