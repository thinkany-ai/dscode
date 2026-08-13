# Releasing DSCode

DSCode uses two long-lived branches:

- `dev`: default branch for daily development
- `main`: release-ready history only

## Normal release flow

1. Develop and validate on `dev`.
2. Update the matching versions in `package.json` and `packages/core/package.json` on `dev`:

   ```bash
   npm version patch --no-git-tag-version
   npm version patch --no-git-tag-version --prefix packages/core
   pnpm install --lockfile-only
   pnpm check
   ```

3. Open a pull request from `dev` to `main`. CI rejects the release if its version was not changed or
   if that package version already exists on npm.
4. Merge after CI passes. The successful `main` CI run triggers `.github/workflows/release.yml`, which
   creates the matching `vX.Y.Z` tag and GitHub Release automatically. CI rejects mismatched CLI/Core
   versions.

After creating the GitHub Release, `.github/workflows/release.yml` directly calls
`.github/workflows/publish.yml`. The publishing workflow verifies that the tagged commit belongs to
`main`, checks that `vX.Y.Z` matches both package manifests, runs the complete test and packed-install
suite, creates the `@thinkany/dscode` and `@thinkany/dscode-core` tarballs, uploads them as workflow
artifacts, and publishes those exact tarballs to npm. The CLI tarball embeds the matching Core build,
so CLI users do not depend on a separate Core registry download. Existing npm versions are detected
independently and skipped so retries can recover if only one package was published.

## npm authentication

Both npm packages use Trusted Publishing; no `NPM_TOKEN` repository secret is required. The one-time
publisher configuration for each package is:

1. In both package settings pages on npmjs.com, add a GitHub Actions trusted publisher:
   - Organization: `thinkany-ai`
   - Repository: `dscode`
   - Workflow filename: `release.yml`
   - Allowed action: `npm publish`
2. Keep `id-token: write` on both `release.yml` and the reusable `publish.yml` workflow. Because npm
   validates the calling workflow for reusable workflows, the trusted publisher must name
   `release.yml`.
3. Use npm 11.5.1 or newer in the runner. The workflow pins npm 11.19.0.

Trusted Publishing exchanges GitHub's short-lived OIDC identity directly with npm and automatically
adds provenance. Future releases do not require an npm token or a one-time password.

## Recommended GitHub settings

Protect `main` with these repository rules:

- require a pull request before merging
- require the `CI / check` status check
- block force pushes and branch deletion
- allow releases only from tags created on `main`

Keep `dev` as the repository default branch.

## Desktop releases

The Electron application under `apps/desktop` has an independent version and release line. Desktop
changes merge through `dev` like the rest of the repository, but they do not require a CLI/Core version
bump. Push a tag matching `desktop-v<version>` (for example, `desktop-v0.1.0`) from a commit on `main`
to build the macOS, Windows, and Linux artifacts and create a draft GitHub Release.

The Desktop workflow also runs compatibility builds when either `apps/desktop` or `packages/core`
changes. Keep `apps/desktop/package.json` on `workspace:*` for Core so a single pull request validates
both sides of an RPC or API change before either product is released.
