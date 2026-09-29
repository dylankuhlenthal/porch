# CI

Two GitHub Actions workflows, both in `.github/workflows/`.

## `ci.yml`: every PR

Runs on every pull request, on pushes to `main` and `dyl/TRV-1133-porch`, and on demand. One job, named **unit and contract tests**: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` (which builds and runs every per-PR test, including the fake-adapter conformance run and replay of every committed fixture) and `npm pack --dry-run`. It needs no secrets, so it runs the same on PRs from forks.

### Making it a required check

It is meant to be required on `main` and `dyl/TRV-1133-porch`, so nothing merges without it passing. **This is not enforced yet.** GitHub refuses both rulesets and branch protection on private repositories on Dylan's plan ("Upgrade to GitHub Pro or make this repository public to enable this feature", HTTP 403). Until then the check runs on every PR and reviewers must not merge a PR where it failed.

This lifts when the repo goes public (planned once the Pi adapter passes the shared tests) or the plan changes. Then apply the prepared ruleset:

```sh
gh api -X POST repos/dylankuhlenthal/porch/rulesets --input .github/rulesets/required-checks.json
```

The ruleset requires the check by its job name, so renaming the job in `ci.yml` means updating `.github/rulesets/required-checks.json` and the live ruleset too.

## `conformance.yml`: real harnesses

Runs the conformance suite (`docs/patterns/conformance.md`) against each harness that has a driver in `src/conformance/drivers/index.ts`: daily at 06:17 UTC, and on demand (Actions tab, optionally for one harness). It never runs on pull requests, because it needs the API key.

- **When a harness version comes out**: each run installs the latest harness, so a new version is tested within a day. There is no separate trigger on a new release.
- **The API key**: the repo secret `ANTHROPIC_API_KEY`. It is not set yet. When a harness needs a variable (its `requiredEnv`) that is not set, the conformance command exits 3 and the workflow marks that harness skipped with a notice instead of failing. The fake harness needs none, so it always runs.
- **Output**: each harness's report and fixtures are uploaded as the `conformance-<harness>` artifact. The workflow commits nothing; a person reviews the files and commits them in a PR.
- **Not run on GitHub yet**: GitHub starts scheduled and on-demand workflows only from the default branch (`main`), so this workflow first runs once the work reaches `main`. Until then it has been checked only locally: the fake harness passing through `npm run conformance`, and the skip path (a required variable unset or empty, as GitHub passes an unset secret) giving exit 3, which the step turns into a notice and success. Check the first real run in the Actions tab.
- **Claude Code**: the job installs the latest `@anthropic-ai/claude-code` from npm, then marks the checkout trusted and onboarding done in the runner's own `~/.claude.json` (`projects.<checkout>.hasTrustDialogAccepted`, `hasCompletedOnboarding`), because Claude Code starts background sessions only in trusted folders and the suite runs them under `.conformance-tmp/`. Those fields are not documented by Claude Code, and none of this has run on GitHub yet: on the first run, check whether sessions start, and whether Claude Code asks to approve the API key (it may need `customApiKeyResponses` in the same file). The driver skips the run (exit 3) when Claude Code is not logged in and `ANTHROPIC_API_KEY` is empty.
- **Adding a harness**: add its driver to `DRIVERS` (the workflow reads the list from the built package) and its install step to the conformance job where the workflow's comment shows.
