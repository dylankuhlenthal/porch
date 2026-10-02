# Changelog

Every release of `@dylankuhlenthal/porch`, newest first. Breaking changes are listed first in each entry. What counts as breaking, and how it changes the version number: [docs/reference/library.md](docs/reference/library.md#version-rules).

## Unreleased

## 0.2.0

The first release on npm.

### Breaking

- The library is split by import path. The main import (`@dylankuhlenthal/porch`) now exports only the supported library listed in [docs/reference/library.md](docs/reference/library.md). Test helpers moved to `@dylankuhlenthal/porch/testing`: `createFakeAdapter`, `FAKE_HARNESS`, `FAKE_SESSION_ENV`, `fake`, `fakeStatePath`, `RecordStore` and the record types, and the `Adapter` and `AdapterContext` types. Everything else moved to `@dylankuhlenthal/porch/internal`, which is not supported and may change in any release: the rest of the adapter contract (`observation`, `deliverResult`, `Capabilities` and the other adapter types), `RecordError`, `InvalidIdError`, `CorruptRecordError`, `validateHarness`, `validateSessionId`, `watchSessions`, `comparisonKey`, `builtinAdapters`, `runCli`, `CliIO`, `CliOptions`.

### Added

- `@dylankuhlenthal/porch/testing` and `@dylankuhlenthal/porch/internal` import paths.
- Releases are published to npm from GitHub Actions with provenance ([docs/operations/releasing.md](docs/operations/releasing.md)).

## 0.1.0

Tagged on GitHub only (`v0.1.0`), never published to npm. The CLI with JSON output (`schema: 2`), adapters for Claude Code and Pi, a fake adapter for tests, `porch launch`, and the library with every module exported from the main import.
