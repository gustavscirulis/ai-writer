# Rename the app to Co-writer

## Why

This fork shipped under upstream's name ("Writer") and bundle identifier (`com.writer-computer`). Installing it would replace upstream Writer and share its settings folder, and two apps called Writer are confusing. The first release (0.8.0) hasn't been published, so renaming now costs nobody their install.

## Decisions

- App name: **Co-writer**. The AI panel keeps the name Co-writer too.
- Bundle identifier: `com.gustavscirulis.cowriter`. The bundle becomes `Co-writer.app`, the DMG `Co-writer_<version>_aarch64.dmg`, and the updater tarball `Co-writer.app.tar.gz`.
- Terminal command: `cowriter` (was `writer`), installed at `/usr/local/bin/cowriter`. The override variable becomes `COWRITER_APP_PATH`.
- Icon: unchanged for now.
- Unchanged on purpose: the "Writer" theme preset (a saved setting value), the `writer-embed:` protocol and other internal names, and the e2e build's identifier.

## Settings import

A new identifier means a new app data folder (`~/Library/Application Support/com.gustavscirulis.cowriter`). On launch, before Tauri starts, if that folder doesn't exist and upstream's `com.writer-computer` folder does, its contents are copied over once. That covers settings, recents, pins, Co-writer conversations and window state.

- It copies rather than moves, so an upstream Writer install keeps working.
- It copies into a staging folder and renames that into place, so a failed copy leaves no half-imported folder and is retried on the next launch.
- `telemetry.json` and `updater-dismissed-version.json` are skipped.
- A failure is logged and the app starts with fresh settings; it never blocks launch.
- macOS only, the only platform this fork ships.

## Release

Delete the unpublished `v0.8.0` draft and its tag, then re-run `scripts/distribute.sh` after this merges.
