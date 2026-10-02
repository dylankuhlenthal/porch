# 0018: Below 1.0, a breaking change bumps the minor version

**Date:** 2026-10-02
**Status:** Accepted

## Context
Porch's version number has to tell consumers when an update can break them, across the supported library (decision 0016) and the CLI contract (output shapes and their `schema` number, the record format, exit codes). Only one tool has used the library so far, so it may still need to change. `v0.1.0` was already tagged on GitHub. The alternatives were 1.0.0 now, which promises a stable library before a second tool has used it, or 0.1.1 for the first npm release, which would hide that the library split is breaking.

## Decision
The first npm release is 0.2.0. Below 1.0, a breaking change bumps the minor version (0.2.x to 0.3.0) and anything else bumps the patch version; adding is not breaking. 1.0.0 comes once a second tool runs on the library; from then on breaking changes bump the major version. The rules are written in `docs/reference/library.md`.

## Consequences
Consumers depending on `^0.2.0` get fixes and additions but never a breaking change, because npm reads a caret below 1.0 as "this minor version only". Every release lists its breaking changes first in `CHANGELOG.md`.
