# Contributing to Apprua

Thank you for helping. Apprua is built for people who are not developers, so every change is judged by one question: *does it make publishing an app simpler and safer for them?*

*Italiano: le issue e le pull request si possono scrivere anche in italiano.*

## Ways to help

- **Try it and tell us.** Install it on your PC or server and [open an issue](https://github.com/apprua/apprua/issues/new/choose) with what was hard, confusing or broken. This is the most useful help of all right now.
- **Improve the guide.** The guide lives in `docs/guida` (Italian) and `docs/guide` (English). Keep both in step.
- **Translate.** The portal texts are in `packages/server/src/i18n.ts`.
- **Code.** Look for issues labelled `good first issue`. For anything bigger, open an issue first so we can agree on the approach before you spend time on it.

## Development

You need Node.js 24 and npm.

```bash
npm install
npm run build
npm test
```

| Path | What |
|---|---|
| `packages/server` | Apprua server: API for the connector, portal, checks, code archive, engine drivers |
| `packages/mcp` | The connector: an MCP server (stdio) for AI apps |
| `install/` | Installers for Linux and Windows (WSL2), backups |
| `brand/` | The logo and the APPRUA wordmark |

To try a change end to end, run the installer on a test machine: on Linux `sudo bash install/install.sh` from your copy of the repository, on Windows `install\windows\install-apprua.ps1` (it keeps apps and data).

## How we write

- **Speak human.** In the portal and the docs, use the words people know ("personal key", "what's happening"), not internal ones ("token", "logs"). See `PRODUCT.md`.
- **Follow the design system.** Colours, type and illustrations are in `DESIGN.md` ("Bicromia"). Never ask an image AI to redraw the lighthouse, the boat or the people: they come from the brand kit.
- **No long dashes** (the "em dash" and "en dash") anywhere: use a comma, a colon, a full stop or brackets. A test checks the portal texts.
- **Italian texts are neutral** about grammatical gender ("Apprua è pronto/pronta" is avoided).
- **No secrets** in code, tests or screenshots. Ever.
- Small, focused pull requests with a clear title. Add or update tests for what you change.

## The Contributor License Agreement

On your first pull request a bot asks you to sign the [Contributor License Agreement](CLA.md) with one comment. You keep the copyright of your work. The CLA lets the project also offer Apprua under other licenses (for example to companies that cannot use the AGPL), which funds its development, while the project itself stays open source under the AGPL-3.0.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). For security problems, do not open a public issue: read [SECURITY.md](SECURITY.md).
