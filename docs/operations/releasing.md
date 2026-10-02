# Releasing

How Porch goes public (once), how its first version reaches npm (once, by hand), and how every later release is published (by the release workflow). Files: `.github/workflows/release.yml`, `.github/rulesets/main.json`, `package.json` (`version`, `files`, `exports`), `CHANGELOG.md`. Why it works this way: decision 0015 (going public now), decision 0017 (trusted publishing, no npm token), decision 0018 (version rules).

Only the maintainer publishes. Never create an npm token: the release workflow needs none, and the npm package is set to refuse them.

## Going public (once)

Do these in order. The repo must be public before the ruleset can be applied (GitHub refuses rulesets on private repos on a free plan) and before npm can link a release to it.

1. **Maintainer: merge the PR** that adds this runbook.
2. **Maintainer: GitHub email settings.** In GitHub's Settings, Emails, turn on "Keep my email addresses private" and "Block command line pushes that expose my email". New commits in this repo use the GitHub no-reply address (`git config user.email` in the checkout). Older commits keep the address they were made with; history is not rewritten, because that would change every commit id, including the `v0.1.0` tag a consumer installs from.
3. **Maintainer: make the repo public.**

   ```sh
   gh repo edit dylankuhlenthal/porch --visibility public --accept-visibility-change-consequences
   ```

4. **On the maintainer's go, an agent or the maintainer applies the settings below**, then reads each one back.

   The branch ruleset (`docs/operations/ci.md`, "Branch rules on `main`"):

   ```sh
   gh api -X POST repos/dylankuhlenthal/porch/rulesets --input .github/rulesets/main.json
   gh api repos/dylankuhlenthal/porch/rulesets   # one ruleset named "main", enforcement "active"
   ```

   Secret scanning, push protection (GitHub refuses a push that contains a secret it recognises) and private vulnerability reporting (`SECURITY.md` points reporters at it):

   ```sh
   gh api -X PATCH repos/dylankuhlenthal/porch \
     -f 'security_and_analysis[secret_scanning][status]=enabled' \
     -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
   gh api -X PUT repos/dylankuhlenthal/porch/private-vulnerability-reporting
   gh api repos/dylankuhlenthal/porch --jq .security_and_analysis
   gh api repos/dylankuhlenthal/porch/private-vulnerability-reporting   # {"enabled": true}
   ```

   Repo metadata, and deleting a PR's branch when it merges:

   ```sh
   gh repo edit dylankuhlenthal/porch \
     --description "Wake any agent session with a message and read its state, across harnesses." \
     --homepage https://www.npmjs.com/package/@dylankuhlenthal/porch \
     --add-topic claude-code,ai-agents,cli,developer-tools,typescript \
     --enable-issues --enable-projects=false --enable-wiki=false --enable-discussions=false \
     --delete-branch-on-merge
   gh repo view dylankuhlenthal/porch --json description,homepageUrl,repositoryTopics,hasIssuesEnabled,hasProjectsEnabled,hasWikiEnabled,hasDiscussionsEnabled,deleteBranchOnMerge
   ```

   Delete the remote branches already merged into `main`. List them, check each one is merged (the second command prints nothing for a merged branch), then delete:

   ```sh
   git fetch --prune origin
   git branch -r --merged origin/main | grep -v -e 'origin/main$' -e 'origin/HEAD'
   git log --oneline origin/main..origin/<branch>
   git push origin --delete <branch>
   ```

5. **Maintainer: the npm account.** The package scope `@dylankuhlenthal` is the npm user `dylankuhlenthal`, which exists. Check two-factor authentication is on for sign-in and writes (npmjs.com, Account, Two-Factor Authentication), and that the terminal is logged in as that user: `npm whoami` prints `dylankuhlenthal` (if not, `npm login`).

## The first publish (once, by hand)

npm sets up a trusted publisher only for a package that already exists (its `npm trust` documentation says so). The first version is therefore published by hand from a clean checkout of the merged commit. It has no provenance (provenance needs a CI build); every later version has it.

1. **Maintainer: publish 0.2.0.**

   ```sh
   git clone https://github.com/dylankuhlenthal/porch.git porch-release
   cd porch-release
   git log -1 --format=%H        # the merged commit, with version 0.2.0 in package.json
   npm ci
   npm test
   npm pack --dry-run            # dist/, schemas/, README.md, CHANGELOG.md, LICENSE, package.json
   npm publish                   # asks for a one-time code; publishConfig makes it public
   ```

2. **Maintainer: tag it.** The release workflow runs on the tag, runs the full gate on the tagged commit, finds 0.2.0 already on npm, and passes without publishing.

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. **Agent: check the published package** in an empty folder: `npm install @dylankuhlenthal/porch@0.2.0`, then `npx porch --version` prints version 0.2.0, and a small script imports `@dylankuhlenthal/porch` and `@dylankuhlenthal/porch/testing`.
4. **Maintainer: make the release workflow the trusted publisher.** npm allows this only once the package exists, which is why the first publish is by hand. From the terminal (it needs npm 11.15 or later, and asks for a one-time code):

   ```sh
   npx npm@11 trust github @dylankuhlenthal/porch --file release.yml --repo dylankuhlenthal/porch --allow-publish
   npx npm@11 trust list @dylankuhlenthal/porch
   ```

   Or on npmjs.com, the package's Settings, Trusted publishing, GitHub Actions: organization or user `dylankuhlenthal`, repository `porch`, workflow filename `release.yml`, no environment, and allow `npm publish`. Then, under Publishing access, choose "Require two-factor authentication and disallow tokens".

## A routine release

1. **A PR that sets the version.** Pick the number by the version rules (`docs/reference/library.md`), run `npm version <x.y.z> --no-git-tag-version` (it updates `package.json` and `package-lock.json`), and move the changelog's "Unreleased" entries under a new `## <x.y.z>` heading, breaking changes first. Merge it.
2. **Tag the merged commit and push the tag.**

   ```sh
   git fetch origin
   git tag v<x.y.z> origin/main
   git push origin v<x.y.z>
   ```

3. **Watch the workflow** (`gh run list --workflow release.yml`, then `gh run watch <id>`). It publishes only if the tag is `v` plus `package.json`'s version, the tagged commit is on `main`, and the gate passes.
4. **Check** `npm view @dylankuhlenthal/porch version`, and that the version's page on npmjs.com shows provenance.

If the workflow fails before publishing, nothing reached npm. Fix the cause in a PR, then delete the tag (`git push origin :refs/tags/v<x.y.z>`, `git tag -d v<x.y.z>`) and tag the new merged commit. A version that did reach npm is never republished or unpublished; fix forward with the next patch version.
