# Library contract

What Node consumers of `@dylankuhlenthal/porch` can rely on, and how a breaking change is signalled. The CLI's own contract (output, exit codes) is in `docs/reference/cli-output.md`; this page covers the library and the version number shared by both. Code: `src/index.ts` (the main import), `src/testing.ts` (`/testing`), `src/internal.ts` (`/internal`), the `exports` field of `package.json`. Decision 0016 (the library is part of the contract, split by import path) records why.

## Import paths

| Import path | Supported | What it holds |
| --- | --- | --- |
| `@dylankuhlenthal/porch` | yes | The operations, their results and options, and the helpers a consumer needs around them. Listed below. |
| `@dylankuhlenthal/porch/testing` | yes | Helpers for testing code built on Porch without a real harness. Listed below. |
| `@dylankuhlenthal/porch/schemas/*` | yes | The JSON Schema files for every CLI output and the record format (`schemas/`). Part of the CLI contract. |
| `@dylankuhlenthal/porch/internal` | no | Everything else: the adapter contract's parts, the built-in adapters, the record store's errors and checks, `watchSessions`, `runCli`. |
| `@dylankuhlenthal/porch/conformance` | no | The conformance suite, for adapter authors (`docs/patterns/conformance.md`). |

Anything not listed in the two tables below can change or go in any release, including patch releases. A name's type signature is part of what is supported, as the published `.d.ts` files give it.

`tests/library-exports.test.ts` reads the names in the two tables below and fails unless they are exactly what `dist/index.d.ts` and `dist/testing.d.ts` export (values and types). Adding or removing an export means changing this page in the same PR, and deciding whether it is breaking (below).

## `@dylankuhlenthal/porch`

| Name | What it is |
| --- | --- |
| `Porch` | The operations: `list`, `observe`, `deliver`, `current`, `statusSet`, `launchPlan`, `launch`, `watch`. Each does what the CLI command of the same name does and returns the same shape, without the JSON printing. |
| `PorchOptions` | `new Porch(options)`: `env` (defaults to `process.env`), `adapters` (defaults to the built-in ones; tests pass the fake adapter from `/testing`), `io`, `now`. |
| `PorchError` | What the operations throw for an expected failure; `code` is one of `ERROR_CODES`. |
| `ERROR_CODES` | The error codes, as in the CLI's error document. |
| `ErrorCode` | One of `ERROR_CODES`. |
| `ErrorResult` | The CLI's error document. |
| `EXIT` | The CLI's exit codes by name (`docs/reference/cli-output.md`). |
| `SCHEMA_VERSION` | The `schema` number every output and record carries. |
| `SchemaVersion` | The type of `SCHEMA_VERSION`. |
| `SESSION_STATUSES` | Every observed status. |
| `SessionStatus` | One of `SESSION_STATUSES`. |
| `SELF_STATUSES` | Every self-reported state. |
| `SelfStatus` | One of `SELF_STATUSES`. |
| `SelfReport` | The `self` part of an observation. |
| `Observation` | What `observe` returns, and each session in `list` and `watch`. |
| `notRunning` | Whether a status means the session is not running (`ended` or `gone`). |
| `shownByDefault` | Whether `list` and `watch` show an observation without `all`. |
| `ListResult` | What `list` returns. |
| `DELIVER_RESULTS` | Every deliver result. |
| `DeliverResultKind` | One of `DELIVER_RESULTS`. |
| `DeliverResult` | What `deliver` returns. |
| `CurrentResult` | What `current` returns. |
| `StatusSetResult` | What `statusSet` returns. |
| `LaunchPlanResult` | What `launchPlan` returns: the command and arguments `launch` would run. |
| `runLaunchPlan` | Runs a launch plan as `porch launch` does: the harness as a child process sharing the terminal. |
| `LaunchOutcome` | How a launched harness ended: its exit code or the signal that killed it. |
| `signalExitCode` | The exit status a shell reports for a process killed by a signal (128 plus its number). |
| `WatchOptions` | The options of `watch` (it takes them without `adapters` and `ctx`, which the `Porch` instance supplies). |
| `formatMessage` | The text a session receives from `deliver`: the sender label in brackets, then the message. |
| `MAX_FROM_LENGTH` | The longest sender label `deliver` accepts. |
| `porchHome` | Porch's folder for an environment (`PORCH_HOME`, or `~/.porch`). |
| `sessionsDir` | The session records folder inside it. |
| `Env` | An environment, as passed to `porchHome` and `PorchOptions.env`. |
| `HarnessIO` | How adapters run commands and read harness files; replace it to give adapters canned output. |
| `realIO` | The `HarnessIO` that really runs commands and reads files. |
| `RunResult` | What `HarnessIO.run` returns. |
| `RunOptions` | The options of `HarnessIO.run`. |

## `@dylankuhlenthal/porch/testing`

| Name | What it is |
| --- | --- |
| `createFakeAdapter` | The fake adapter (`docs/domains/fake-adapter.md`), to pass in `PorchOptions.adapters`. |
| `FAKE_HARNESS` | The fake adapter's harness name, `fake`. |
| `FAKE_SESSION_ENV` | The environment variable that makes a process count as inside a fake session (`PORCH_FAKE_SESSION_ID`). |
| `fake` | What can happen to a fake session (start, set status, prompt, kill, end, fail deliveries, read deliveries), the same operations as the `porch fake` commands. Each takes a `Porch` instance's `ctx`. |
| `fakeStatePath` | Where the fake harness file is for an environment. |
| `RecordStore` | Reads and writes session records in a records folder (`docs/domains/session-records.md`), for setting up or checking records in a scratch `PORCH_HOME`. |
| `SessionRecord` | A session record. |
| `InsidePart` | The `inside` part of a record. |
| `DeliveryAddress` | Where a record says a session takes deliveries. |
| `RecordProblem` | A record `RecordStore.list` could not read, and why. |
| `RecordStoreOptions` | The options of `new RecordStore(dir, options)`. |
| `Adapter` | The adapter type, for typing `PorchOptions.adapters`. Its members are not supported on their own; writing an adapter uses `/internal` (`docs/patterns/adapter-contract.md`). |
| `AdapterContext` | The type of `Porch.ctx`, which the `fake` operations take. |

## Version rules

Porch's version number covers the supported library above and the CLI contract (`docs/reference/cli-output.md`: the output shapes and their `schema` number, the record format, exit codes). Decision 0018 (version rules below 1.0) records why.

Below 1.0.0:

- **A breaking change bumps the minor version** (0.2.x to 0.3.0). Breaking means: removing or renaming a supported name, changing its signature or meaning in a way that can break a caller, or anything that bumps the CLI's `schema` number or changes an exit code.
- **Anything else bumps the patch version** (0.2.0 to 0.2.1): fixes, and additions. Adding a name, an optional option or an optional output field is not breaking.
- Consumers should depend on `^0.x.y`, which npm reads as "this minor version only", so they get fixes and additions but never a breaking change.

From 1.0.0, the usual semantic versioning applies: breaking bumps the major version. 1.0.0 comes once a second tool runs on the library.

Every release has an entry in `CHANGELOG.md`, with its breaking changes listed first. How a release is made: `docs/operations/releasing.md`.
