# Embeds Spec

## Summary

Show live content inside a note: interactive HTML (prototypes, diagrams, visualizations, which Co-writer can write), video and audio, players from known services, and web pages. Every kind goes through one editor widget and a provider registry, so adding the next kind is one small provider file.

## Syntax

| Markdown                                               | Result                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| ` ```html embed ` fence                                | Live HTML in a sandboxed frame that fits its content            |
| `![](clip.mp4)`, `![](https://…/talk.webm)`            | Native video; `.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac` use audio |
| `![](https://youtu.be/…)` and other supported services | The service's official player                                   |
| `![](https://any.site/page)`                           | The live page if the site allows framing, otherwise a link card |
| `![](pic.png)`                                         | Unchanged: an image                                             |
| `[text](url)`, a bare URL, a plain ` ```html ` fence   | Unchanged: links and code                                       |

The `!` makes something an embed, as in Obsidian. A plain ` ```html ` fence stays code so notes that show HTML snippets keep working, and opening someone else's note never runs a script unless its author asked for it.

## Editing

The replace ↔ widget shape from `fold/image.ts`:

- Selection outside the source: the source is replaced by the embed.
- Selection spans the whole source: the embed is selected as a block, outlined in the accent colour, and its source stays closed. Backspace deletes it and ⌘L or the selection pill adds it to Co-writer. Clicking the edge around the frame selects it this way, as does a shift-arrow or select-all selection across it.
- Selection ends inside the source (arrow keys into it, or the Edit button): the source shows and the live embed stays below it. Edits reload the embed after 300 ms.
- Clicks inside a frame go to the frame, never to CodeMirror, so using a prototype doesn't open its source.

The widget keeps its DOM across those switches, so the embed keeps its state when its source opens. Unlike `fold/image.ts`, a range selection over an embed selects it instead of opening its source (`embedMode` in `embed-decorations.ts`).

## Architecture

- `embeds/embed-providers.ts`: `EmbedSource` (a fence or a URL), `EmbedSpec` (what to draw), the provider list and `resolveEmbed`. Providers are pure: source in, spec out. First match wins.
- `embeds/providers/*.ts`: one file per kind.
- `embeds/embed-decorations.ts`: fold specs for `FencedCode` (and `Image`, for URLs) that ask the registry and place the widget.
- `embeds/embed-widget.ts`: the one widget. It owns rendering per spec kind, sandboxing, sizing, the measured-height cache, the toolbar (Edit, Reload) and the error badge.
- `embeds/frame-messages.ts`: the `postMessage` contract with the frame page.

### Adding a provider

Write `providers/<name>.ts` exporting an `EmbedProvider` whose `resolve` returns a spec for the sources it recognises and `null` otherwise, and add it to the list in `embed-providers.ts`. Put specific providers before the generic website fallback. Add its URL → spec cases to `tests/embeds.test.ts`.

## Security model

Embed code is untrusted: a note may come from anyone.

- **Inline HTML** runs in `<iframe sandbox="allow-scripts allow-forms">` with no `allow-same-origin`, so it has an opaque origin. Never add `allow-same-origin` to a frame the app serves: the embed would share the app's origin and reach Tauri IPC.
- The frame loads `writer-embed://localhost/frame`, a fixed page served by Rust (`src-tauri/src/embed_protocol.rs`) with its own CSP: `https: http: ws: wss: data: blob:` plus inline and eval. On macOS that excludes `asset:`, `ipc:` and `tauri:`, so embed code can't read local files (the asset protocol scope is `**`) or call native commands. The page receives the fence body by `postMessage` and writes it with `document.write`, then reports height and errors back.
- `srcdoc` and `blob:` frames can't be used: they inherit the app's CSP, which blocks inline scripts (Tauri adds hashes, which cancel `'unsafe-inline'`) and CDNs.
- Tauri injects its IPC scripts into the main frame only, and the IPC protocol rejects requests whose `Origin` isn't the app's.
- The app CSP allows frames only from `writer-embed:` (and `http://writer-embed.localhost`, the Windows form).
- Messages from frames are accepted only from the widget's own frame and only in the known shapes; heights are clamped to 40–2000 px.
- Windows caveat: there the asset protocol is `http://asset.localhost`, which the frame CSP's `http:` matches. Revisit before shipping Windows builds.

`e2e/specs/embed.spec.js` checks these from inside a real frame: no `__TAURI_INTERNALS__`, no access to the parent document or top navigation, and `asset:`, `ipc:` and `tauri:` fetches fail while the network works.

## Co-writer

`EMBED_AUTHORING_GUIDE` in `embed_protocol.rs` is appended to Co-writer's system prompt. It tells Claude to write one self-contained document in an `html embed` fence, that it runs sandboxed, that its height fits its content (so no `100vh`), and to use a transparent background with `prefers-color-scheme`. Script errors and unhandled rejections inside an embed show in an error badge, so broken generated code is visible and can be pasted back to Co-writer.

## Known limits

- An embed's state resets when it scrolls far out of view (CodeMirror drops widgets outside its viewport) and when its source changes.
- While focus is inside a frame, the editor's keyboard shortcuts don't fire. Native menu shortcuts still do.
- An HTML embed that sizes itself to the viewport (`height: 100vh`) fits the frame's current height, 150 px by default.
- Links in HTML embeds don't open: the sandbox has no `allow-popups`.
- Version history previews show embeds as source and run nothing.
- The playground serves the frame page without its CSP, so check isolation in the desktop app.

## Status

- [x] Registry, widget and inline HTML embeds, with the Co-writer guide.
- [ ] Video and audio files.
- [ ] Service players: YouTube, Vimeo, Loom, Figma, CodePen, Google Maps, Spotify.
- [ ] Web pages: live when framing is allowed, otherwise a link card.
