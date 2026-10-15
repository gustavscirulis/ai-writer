# Co-writer

A fast, lightweight app for your workspace's markdown files, with an AI writing partner built in.

It is built with Tauri v2, React, Zustand, CodeMirror, and Rust. The app keeps documents on disk, respects workspace `.gitignore` rules, supports multiple windows, renders extended markdown such as tables and Mermaid diagrams, and ships with a signed macOS release flow.

## About this fork

Co-writer is a fork of [Writer](https://github.com/joelbqz/writer-computer). It adds an AI writing partner and ships as its own app, so it can sit next to Writer without replacing it. The main differences:

- **Co-writer.** A panel (⌘⇧L) that runs your installed Claude Code CLI next to the note, with its own sign-in and permissions. Ask it to edit the note, select text or ⌥-click a paragraph to point it at something, queue messages, attach files, mention other notes with @, and use your Claude Code skills and MCP servers. Each note keeps its own conversation. Claude edits the open note directly, and asks before reading other files, writing other notes or using tools, unless you've allowed that kind of request.
- **Version history.** Go back to earlier versions of a note (⌘⇧H). All of Claude's edits from one reply are saved as a single version.
- **Embeds.** Fenced ` ```html embed ` blocks run live HTML, CSS and JavaScript in a sandbox inside the note, for prototypes, charts and diagrams.
- **No telemetry.** Co-writer sends no usage data.
- **Its own app.** A separate name, bundle identifier and `cowriter` terminal command. On first launch it imports your settings from Writer if you have it installed.
- **Separate releases.** Builds are published on [this repo's releases](https://github.com/gustavscirulis/ai-writer/releases), and the in-app updater follows them instead of upstream's.

Co-writer is experimental and needs the [Claude Code CLI](https://code.claude.com) installed and signed in. Co-writer doesn't bundle it or handle your Claude account. See [`docs/third-party.md`](./docs/third-party.md) for license and attribution notes, and [`CHANGELOG.md`](./CHANGELOG.md) for everything that has changed since 2026-10-10, when this fork started.

## Repository

- `apps/desktop/` — Tauri desktop app.
- `apps/desktop/src/` — React frontend.
- `apps/desktop/src-tauri/src/` — Rust commands, workspace state, watcher, updater, and CLI integration.
- `apps/website/` — landing page.
- `docs/` — project and agent workflow docs.
- `SPECs/` — feature specs and design notes.

## Development

This repo uses Vite+ through the `vp` CLI. Use `vp` instead of calling the package manager or Vite tooling directly.

```bash
vp install
vp dev
```

## Validation

```bash
vp check
vp test
```

Rust validation runs from the Tauri crate:

```bash
cd apps/desktop/src-tauri
cargo test
cargo clippy
cargo fmt --check
```

## Privacy

Co-writer is local-first and stays that way. It sends no telemetry or usage data.

## Releases

macOS releases of this fork are cut locally with `scripts/distribute.sh` and published to this repo's GitHub releases. See [`docs/releasing.md`](./docs/releasing.md) for the one-time signing setup and the release steps.
