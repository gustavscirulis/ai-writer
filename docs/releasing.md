# Releasing Co-writer

How to cut a signed, notarized macOS release of this fork and publish it to `gustavscirulis/co-writer` so the in-app updater picks it up. Releases run locally on the maintainer's Mac, not in CI, because they need the Developer ID certificate in the keychain.

## One-time setup

1. **Developer ID certificate.** A `Developer ID Application` certificate must be in the login keychain. The script finds it automatically; if there are several, set `APPLE_SIGNING_IDENTITY` to the one to use.
2. **Notary credentials.** Store them in the keychain once. It prompts for an [app-specific password](https://support.apple.com/en-us/102654), and nothing is written to the repo:

   ```sh
   xcrun notarytool store-credentials writer-notary --apple-id <apple-id> --team-id <TEAMID>
   ```

   A different profile name works if you set `WRITER_NOTARY_PROFILE`.

3. **Updater signing key.** Generate it outside the repo and back it up. If you lose it, nobody who installed Co-writer can update again.

   ```sh
   cd apps/desktop && vp exec tauri signer generate -w ~/.tauri/writer-updater.key
   ```

   Paste the contents of `~/.tauri/writer-updater.key.pub` into `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json` and commit it. The script refuses to release while the two disagree. A key stored elsewhere can be passed with `TAURI_SIGNING_PRIVATE_KEY=/path/to/key`.

4. `gh auth login` with push access to `gustavscirulis/co-writer`.

## Step 1 — Bump the version

`vp check` and `vp test` should pass and `CHANGELOG.md` should have an entry for what's shipping.

The authoritative version lives in `apps/desktop/src-tauri/tauri.conf.json`; the script derives the tag (`v<version>`) from it. Keep these in sync:

1. `apps/desktop/src-tauri/tauri.conf.json` — `version` field
2. `apps/desktop/src-tauri/Cargo.toml` — `[package].version`
3. `apps/desktop/package.json` — `version` field
4. `apps/desktop/src-tauri/Cargo.lock` — refresh with `cargo update -p desktop --offline` from `apps/desktop/src-tauri/`

Use a patch bump for fixes, a minor bump for new user-visible features. Commit as `Bump version to <version>` on `master`. Do not push or tag manually; the script does both.

## Step 2 — Run distribute.sh

From the repo root, on a clean `master`:

```sh
./scripts/distribute.sh
```

By default the release notes are the latest dated section of `CHANGELOG.md`. To write shorter, user-facing notes instead, pass `--notes-file /path/to/notes.md`.

The script:

1. Checks you're on `master` with a clean tree, then checks signing: the Developer ID identity, the notary profile, the updater key, and that the key matches the pubkey and endpoint in `tauri.conf.json`. It asks for the updater key password (press Enter if it has none; set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to skip the prompt).
2. Checks that local `master` is a fast-forward of origin and that the tag doesn't exist, then pushes `master`.
3. Builds `Co-writer.app` and the DMG with `vp exec tauri build --bundles app,dmg`. Tauri signs them with the hardened runtime and produces the updater tarball and its signature.
4. Signs the DMG, submits it to Apple with `notarytool`, and waits. Anything other than `Accepted` stops the script and prints Apple's log.
5. Staples the ticket to the DMG and checks it with `spctl`.
6. Writes `latest.json` and creates a **draft** release on `gustavscirulis/co-writer` with the DMG, `Co-writer.app.tar.gz`, and `latest.json`.
7. Tags the commit `v<version>`, pushes the tag, and prints the DMG path and draft URL.

Expect several minutes, mostly the release build and notarization.

## Step 3 — Publish

Open the draft URL, check the three assets and the notes, and click **Publish release**. The in-app updater ignores drafts. Share the DMG's download link from the published release.

Confirm `https://github.com/gustavscirulis/co-writer/releases/latest/download/latest.json` shows the new version.

## When things go wrong

- **Pre-flight check fails.** Nothing irreversible has happened. Fix what it reports and re-run.
- **Notarization fails.** The script prints the submission ID and Apple's log. Common causes are an entitlement mismatch, an unsigned binary in the bundle, or an expired identity. Don't retry blindly.
- **Build fails after the bump is committed.** Fix it, commit, and re-run. Leave the bump commit alone.
- **`gh release create` fails because the release exists.** An earlier run got that far. Check the existing release before deleting anything, since it may already be live.
- **The tag push failed.** The draft exists; run `git push origin v<version>`.
- **You don't publish the draft.** Delete it on GitHub, then `git tag -d v<version> && git push origin :refs/tags/v<version>`.

## App icon

`apps/desktop/src-tauri/icons/icon.icon` is the Icon Composer source; edit it in Icon Composer. The build doesn't read it. It bundles the compiled `icons/Assets.car`, which macOS 26 and later use, and `icon.icns` for older macOS. After you change the icon, regenerate those files and the PNG and `icon.ico` fallbacks with Xcode 26 or later:

```sh
./scripts/app-icon.sh
```

The build doesn't compile `icon.icon` because Tauri runs `actool` with stdin closed. `actool` then fails with "Bad file descriptor", and the shared `ibtoold` daemon keeps failing every later call until it restarts. The script runs `actool` with stdin open. If it still reports "Bad file descriptor", run `pkill -x ibtoold` and try again.

## Merging from upstream

Upstream (`joelbqz/writer-computer`) uses its own updater endpoint, pubkey, and release repo. When merging from it, keep this fork's values in `tauri.conf.json` (`plugins.updater`) and `RELEASE_REPO` in `scripts/distribute.sh`.

## Not covered

- Intel or universal builds. The build is arm64-only.
- CI releases.
- Rolling back a published release.
