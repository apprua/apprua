# Releasing Apprua

A release is made by pushing a tag; GitHub does the rest (`.github/workflows/release.yml`).

1. **Write the changes** in `CHANGELOG.md`, in a new section `## [0.2.0]` at the top, in English and Italian. That section becomes the text of the release.
2. **Set the version** of every package at once:
   ```bash
   npm version 0.2.0 --workspaces --include-workspace-root --no-git-tag-version
   ```
   A test checks that the repository, the server, the connector, the lock file and the changelog agree.
3. **Commit** ("Apprua 0.2.0") and push to `main`. Wait for the tests to pass.
4. **Tag and push the tag:**
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

GitHub then checks the version, builds and tests, publishes the image `ghcr.io/apprua/apprua:0.2.0` (also `:0.2` and `:latest`, for Intel/AMD and ARM), attaches `apprua.zip` (Windows), `apprua.tar.gz` (Linux), `apprua.mcpb` (Claude Desktop) and `SHA256SUMS.txt`, and publishes the connector `@apprua/mcp` on npm when the repository variable `NPM_PUBLISH` is `true` (see below).

A version with a suffix (`0.2.0-rc.1`) is a pre-release: no `:latest` image, npm tag `next`.

**Try it on your PC first** (nothing is published):

```bash
npm run build
node scripts/release.mjs files 0.2.0 ghcr.io/apprua/apprua:0.2.0
node scripts/release.mjs notes 0.2.0
```

The files end up in `release/` (ignored by git).

## How people update

| Where | How |
|---|---|
| Windows | Download `apprua.zip` from the latest release, extract it, run `install\windows\install-apprua.ps1` again. Apps and data stay |
| Linux server | Download and extract `apprua.tar.gz`, run `sudo bash install/install.sh` again. The choices made at install time are remembered |

The installer of a release downloads the image made for it; a copy of the code from git builds Apprua from the source instead (so local changes are what runs). `APPRUA_BUILD=1` builds from the source anyway, `APPRUA_IMAGE` runs any image.

## The version of Coolify

Apprua keeps Coolify on the version it was tested with (`"apprua": { "coolify": "4.6.0" }` in `package.json`) and turns Coolify's own automatic updates off, so a new Coolify never changes its API under Apprua. To move to a newer Coolify: change that version, run the installer on a test machine (it updates Coolify and keeps the apps), check publishing, pausing, logs and secrets, then release. Installs with a newer Coolify than the tested one are left as they are.

## Once, before the first public release

- The image package (`ghcr.io/apprua/apprua`) must be **public**: GitHub, organization *Packages*, the package, *Package settings*, *Change visibility*.
- npm, with **trusted publishing** (GitHub proves to npm who it is: no token to keep or renew; npm stops direct publishing with tokens in January 2027). The account and the organization `apprua` exist.
  1. npm links a package to GitHub only once the package exists, so the **first version** of `@apprua/mcp` is published by hand, from the release commit, on a PC with Node 24: `npm login`, then `npm run build` and `npm publish --workspace @apprua/mcp --access public` (2FA asks for a code).
  2. **Just before the next release** (npm wants the first publish from GitHub within 2 days): on npmjs.com, the package, *Settings*, *Trusted Publisher*, GitHub Actions, organization `apprua`, repository `apprua`, workflow `release.yml` (exact names, case-sensitive). Then in the repository, *Settings*, *Secrets and variables*, *Actions*, *Variables*: `NPM_PUBLISH` = `true`.
  3. Once a release has published from GitHub: in the package settings choose to require 2FA and disallow tokens.
  4. If the repository is ever recreated, delete the trusted publisher and add it again (it is bound to the repository, not to its name).
