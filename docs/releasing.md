# Releasing

This guide covers the automated release pipeline, the one-time npm and GHCR
setup, and how to cut a release. It is the single home for release
instructions; CONTRIBUTING.md only points here.

## What a `v*` tag triggers

Pushing a tag that starts with `v` (for example `v1.2.0`) runs
`.github/workflows/release.yml`. The tag must match the `version` field in
`package.json`; the workflow fails before publishing anything otherwise.

| Job | Produces |
| --- | --- |
| CI Checks | The reusable `ci.yml` run: lint, format check, typecheck, tests, build, and a Docker build plus smoke test. |
| Verify Version | A single release decision: the tag matches `package.json`, and the release is stable or prerelease. Every publishing job consumes this one classification. |
| Create GitHub Release | A GitHub release named `vX.Y.Z`, with the matching `CHANGELOG.md` section as its body (falling back to `git log` if the section is missing) and a Full Changelog link against the previous reachable `v*` tag. |
| Publish to npm | `fortimanager-code-mode-mcp` on the public npm registry with provenance. If that exact version is already on npm, the step skips and the job succeeds. |
| Publish GHCR Image | A `linux/amd64` and `linux/arm64` image at `ghcr.io/jmpijll/fortimanager-code-mode-mcp`, with SBOM and provenance attestations. |

The publishing jobs run in parallel after the version check. A failure in one
does not cancel the others.

### Prereleases

A release is a prerelease when the version has a suffix (`v1.2.0-rc.1`) or the
major version is zero (`v0.9.0`). Prereleases:

- publish to npm under the `next` dist-tag instead of `latest`;
- do not move the GHCR `latest` tag;
- are marked as pre-releases on the GitHub release.

### GHCR tags

For the stable tag `v1.2.0` the image gets `1.2.0`, `1.2`, `1` and `latest`.
For the prerelease `v1.2.0-rc.1` the only tag is `1.2.0-rc.1`. `0.x` versions
count as prereleases, so the bare major tag and `latest` are suppressed:
`v0.3.0` produces `0.3.0` and `0.3` only.

## One-time npm setup

Trusted publishing is configured on the published package's settings page, so
the package must exist on npm first. The steps below cover both halves:
claiming the name with the first publish, then switching the workflow to OIDC.

### Step 1: claim the name with the first publish

Pick one path for the first publish.

Path A, publish from CI (recommended, keeps the first release automatic and
provenance-bearing):

1. On npmjs.com open your avatar menu, then **Access tokens**, then **Generate
   new token**, then **Granular access token**.
2. Under **Permissions**, select **Read and write (publish and stage)** for all
   packages. A token that can only stage cannot run this workflow's `npm
   publish`. A granular token cannot be scoped to a package that does not
   exist yet, and this publish creates it.
3. Tick **Bypass two-factor authentication (2FA)** and set a short expiry, for
   example 30 days.
4. Store the token as a repository secret: GitHub repo **Settings**, then
   **Secrets and variables**, then **Actions**, then **New repository secret**
   named `NPM_TOKEN`. The release workflow passes it to npm as
   `NODE_AUTH_TOKEN`.
5. Push the next `v*` tag. The publish step uses the token, and because it runs
   on a GitHub-hosted runner the package still gets provenance. Once a trusted
   publisher is configured, npm prefers the workflow's OIDC identity and falls
   back to the token only when OIDC is unavailable
   (https://docs.npmjs.com/trusted-publishers).

Path B, publish by hand (no CI involvement for the first version):

1. On a trusted machine with two-factor authentication enabled:
   `npm login`, then `npm ci`, then `npm run build`.
2. Inspect the file list with `npm pack --dry-run`: `dist/` plus README,
   LICENSE and CHANGELOG, with no spec files and no source maps.
3. `npm publish --access public`. Do not pass `--provenance`: npm only
   generates provenance on a supported CI runner.
4. The next automated release must use a new version. The workflow skips a
   version that is already on npm, so re-tagging the hand-published version
   would not publish anything.

### Step 2: configure the trusted publisher

Do this once the package exists, and create the next release shortly after.
A newly created trusted publisher configuration must complete its first
successful publish within 2 days, or it expires and has to be recreated.

1. On npmjs.com open **Packages**, then `fortimanager-code-mode-mcp`, then
   **Settings**, then **Trusted publishing**, then **Add trusted publisher**,
   then **GitHub Actions**.
2. Fill in the fields. They are case-sensitive and are not validated when you
   save them, so errors only appear when a publish runs:
   - **Organization or user**: `jmpijll`
   - **Repository**: `fortimanager-code-mode-mcp`
   - **Workflow filename**: `release.yml` (the filename only, with `.yml`)
   - **Environment name**: leave empty
   - **Allowed actions**: tick **npm publish**. Configurations created after
     2026-09-03 allow only `npm stage publish` by default, and this workflow
     uses plain `npm publish`.

### Step 3: after the first OIDC publish succeeds

1. Confirm the release run published via OIDC: the npm package page shows a
   provenance badge, and the workflow log shows the OIDC exchange.
2. Delete the `NPM_TOKEN` repository secret and revoke the token on npmjs.com,
   under **Access tokens**.
3. On npmjs.com open **Packages**, then `fortimanager-code-mode-mcp`, then
   **Settings**, then **Publishing access**, and select **Require two-factor
   authentication and disallow tokens**. Trusted publishing keeps working;
   this setting only disables publishing with traditional tokens.

## One-time GHCR setup

The first image push creates the GHCR package as private, which is the default
for user-owned packages.

1. Open github.com/jmpijll, then the **Packages** tab, then
   `fortimanager-code-mode-mcp`, then **Package settings**, then **Change
   visibility**, then **Public**.
2. Confirm the package is linked to the repository. The
   `org.opencontainers.image.source` label set by the workflow handles the
   link automatically, and the settings page then shows the linked repository.
3. Confirm the repository has Actions access on the same page. Publishing from
   this repository's workflow with `GITHUB_TOKEN` grants the repository
   package access automatically, so it should already appear under
   **Manage Actions access**.

## Cutting a release

1. Open a release PR against `main` that moves the CHANGELOG `Unreleased`
   entries under a new `## [X.Y.Z]` heading with the release date, leaves an
   empty `Unreleased` heading on top, and bumps `package.json` with
   `npm version X.Y.Z --no-git-tag-version`.
2. Merge the PR (squash merge is the repository convention).
3. Tag the merge commit: `git tag -a vX.Y.Z -m "vX.Y.Z"`, then
   `git push origin vX.Y.Z`. The tag must point at the merged commit on
   `main`.
4. Watch the run in the repository's **Actions** tab, under **Release**.
5. Verify the release:
   - `npm view fortimanager-code-mode-mcp version` and
     `npm view fortimanager-code-mode-mcp dist-tags`
   - `docker buildx imagetools inspect ghcr.io/jmpijll/fortimanager-code-mode-mcp:X.Y.Z`
     (check both platforms, the labels and the attestations)
   - the GitHub release page: correct title, changelog notes, and a Full
     Changelog link that resolves.

If something fails, use **Re-run failed jobs** on the run page. A full re-run
also converges (the npm job skips a published version and the GHCR push
overwrites the same tags), but re-running failed jobs only is faster.

For a prerelease, tag `vX.Y.Z-rc.1` with the same package.json version. The
package publishes under npm's `next` dist-tag, the image gets only the version
tag, and the GitHub release is marked as a pre-release. Publish the final
`X.Y.Z` afterwards to update `latest`.

## Rerunning the local dry runs

The release pipeline can be exercised locally before tagging:

- `npm ci && npm run check`: lint, format, typecheck, tests and build.
- `npm pack --dry-run`: inspect the tarball file list. Expect `dist/` (no
  `dist/spec`, no source maps), README, LICENSE and CHANGELOG.
- `scripts/pack-smoke.sh`: packs the checkout, installs the tarball into a
  temporary project, and verifies the MCP `initialize` and `tools/list`
  handshake over stdio from both the documented `npx fortimanager-code-mode-mcp`
  entry point and the installed `fortimanager-mcp` bin. It then runs
  `npx --yes --package=<tarball> fortimanager-mcp` from an empty directory with
  a throwaway npm cache and expects the `API SPEC NOT FOUND` failure, proving
  the published bin resolves from the tarball alone. It exits nonzero on any
  failure.
- `docker buildx build --load -t fmg-mcp:smoke .` followed by
  `scripts/docker-smoke.sh fmg-mcp:smoke`: builds the image and checks
  `/health` plus an MCP `initialize` request with a minimal spec fixture
  mounted at runtime.
- `npm publish --dry-run` (or `npm publish --dry-run --provenance` to mirror
  the workflow): outside CI the dry run succeeds; provenance attestations are
  only generated during a real publish on a supported CI runner.
- `actionlint .github/workflows/*.yml`: validates the workflow files.
