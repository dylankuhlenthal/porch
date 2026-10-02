# 0016: The library is part of the contract, split by import path

**Date:** 2026-10-02
**Status:** Accepted
**Extends:** decision 0002 (TypeScript on npm, a JSON CLI first with a thin library on top), which made only the CLI output a contract.

## Context
The main import exported every module: the operations, but also the record store's internals, `runCli`, the built-in adapters and the fake adapter. Once Porch is on npm, anything exported there is something a consumer can come to rely on. The alternatives were a written list of supported names with the rest marked `@internal` in comments, which nothing enforces, or declaring every export supported, which would lock internals such as `runCli` and the record store's errors.

## Decision
The import path is the boundary. `@dylankuhlenthal/porch` exports exactly the supported library; `@dylankuhlenthal/porch/testing` exports supported helpers for testing code built on Porch (the fake adapter, the record store); everything else is at `@dylankuhlenthal/porch/internal` and may change in any release. `@dylankuhlenthal/porch/conformance` stays as it is, also unsupported. The supported names are listed in `docs/reference/library.md`, and `tests/library-exports.test.ts` fails unless the built exports match that list.

## Consequences
The version number now covers the library as well as the CLI output (decision 0018). Consumers that imported test helpers or internals from the main import change their import paths; the first consumer's production imports are all on the main import. Adding or removing an export means changing `docs/reference/library.md` in the same PR.
