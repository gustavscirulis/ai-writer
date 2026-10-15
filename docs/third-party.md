# Third-party and fork notes

Writer derives from [joelbqz/writer-computer](https://github.com/joelbqz/writer-computer). Its license remains [GNU GPL version 3](../LICENSE). Preserve upstream copyright/license notices, identify fork modifications, and provide corresponding source and build information for any distributed binaries under that license. The 2026-10-10 chat-panel spike modifies the desktop frontend/backend; [the changelog](../CHANGELOG.md) records those changes. This document is not a complete dependency license inventory.

The vendored [ProseMark license](../apps/desktop/src/lib/prosemark-core/LICENSE) remains MIT and must accompany copies of that code. Keep all other dependency notices when packaging a release.

## External Claude Code

Co-writer runs the user's installed unmodified CLI. No Anthropic binary or SDK is bundled. Writer does not collect credentials or implement Claude account login; the CLI handles its own authentication and direct billing. This fork is independent of Anthropic.

Anthropic's current [legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance), checked 2026-10-10, permits running unmodified Claude Code inside products subject to Commercial Terms and its stated conditions. Preserve every built-in authentication method; users authenticate and pay directly. Do not resell/intermediate usage or collect subscription tokens. Users may sign in to the unmodified binary with their own subscription. That permission does not authorize a third-party app's own Claude login flow or credential proxy.

Use Claude Code only as accurate descriptive plain text, not the fork's product/feature name, logo or implied endorsement. Review the linked terms before distribution; installing externally alone does not establish compliance.

## External Codex

Co-writer can run the user's installed, unmodified `codex` CLI through `codex app-server` (see [codex-provider.md](../SPECs/codex-provider.md)). No OpenAI binary or SDK is bundled. Codex handles its own login and billing, and Co-writer never reads its credentials. Its [CLI source license](https://github.com/openai/codex/blob/main/LICENSE) is Apache-2.0. If Codex is ever redistributed or modified, include the license, any attribution or NOTICE material, and modification notices. The source license alone doesn't grant permission for authentication, hosted service use or trademarks, so review those terms before distributing. Use "Codex" only as accurate plain text, never as a product name or a suggestion of endorsement.

Use a distinct fork name, icon, bundle identifier and updater/release endpoints before publishing a separate app. Keep upstream attribution and ship the required source/license notices with binary releases.
