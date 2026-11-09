<p align="center"><img src="docs/img/apprua.gif" alt="In a chat someone asks to publish an app on Apprua; the lighthouse lights up and the app is ready to open" width="100%"></p>

<h1 align="center"><img src="brand/logo.svg" alt="" width="40"> Apprua</h1>

<p align="center"><b>You built an app with AI. Now really use it.</b><br>
Apprua puts it on your own PC or your own server, with one sentence to your AI app.</p>

<p align="center"><a href="docs/guide/pc.md"><b>Install on Windows</b></a> &nbsp;·&nbsp; <a href="docs/guide/server.md"><b>Install on a server</b></a> &nbsp;·&nbsp; <a href="README.it.md">Italiano</a></p>

---

A shopping list, a quote calculator, a tool for your team: the AI wrote it and it works, but it lives in a chat or a folder. Apprua gives it a real address that you and the people you choose can open. No Git, Docker, servers or certificates to learn. You don't have to be a developer: if you can ask an AI for an app, you can publish it. Free and open source.

## Three steps, then just ask

**1. Install Apprua** on your Windows PC or on a Linux server. You copy one command; the installer does the rest (the first time it takes a while: it downloads what it needs).

**2. Connect your AI app.** The portal gives you the lines to paste, with your personal key already in them. It works with Claude, OpenAI Codex, Cursor, VS Code and any app that supports MCP connectors.

**3. Tell your AI:**

> "Publish this app on Apprua."

A few minutes later your AI answers with the address of the app. To change it, ask for the change and then "update it on Apprua". Pause it, give it a secret, go back to yesterday's version: you ask in the chat, the same way.

<p align="center"><img src="docs/img/en/06-home-apps.webp" alt="The Apprua portal with the apps of one person: each one with its address and its state" width="85%"></p>

## Why use it

- **It stays yours.** Apprua runs on your machine and has no cloud of its own: your apps and their data stay on your PC or server, and you decide who can open each one.
- **Nothing new to learn.** You keep talking to your AI app as you do now. Apprua packs, checks, builds and publishes.
- **Careful from the start.** A sign-in stands in front of every app on the network; each app runs in its own space with its own memory; a publication with the most common kinds of passwords and keys in its files is refused before it is published.
- **Every version kept.** Each publication is saved: going back is one sentence away, and you can always download the code.
- **For you or for your team.** A personal profile with nothing to set up, or a team profile with accounts, limits and administrators.
- **A home for the apps people already make.** In a company, apps built with AI already pass from hand to hand. With Apprua, IT offers one official place on the company server: every app has an owner, a sign-in and all its versions. Less shadow IT, without saying no to people's ideas.
- **A calm portal.** In English and Italian, light and dark, also on the phone.

## What it is made for

| A good fit | Not made for |
|---|---|
| Tools for you or your office: lists, calculators, forms, dashboards | Sites and services with thousands of visitors |
| Small management tools and archives | AI models running locally |
| Prototypes for other people to try | Video processing and very large databases |
| Apps used by a few dozen people | On a PC: apps that must keep working when the PC is off |

Every app gets its own memory (usually 512 MB to 2 GB), and an administrator can give it more, as far as the machine allows.

## Start here

| Who you are | Where it goes | Guide |
|---|---|---|
| One person who wants a home for their apps | Your Windows PC | [Apprua on your PC](docs/guide/pc.md) |
| A team, a studio, a company | A Linux server | [Apprua on a server](docs/guide/server.md) |

Then [connect your AI app](docs/guide/connect.md), [use it every day](docs/guide/everyday.md), and if something goes wrong, [common problems](docs/guide/problems.md). The whole guide starts [here](docs/guide/README.md).

## How it works

```
AI app ──MCP──▶ Apprua connector (on your PC) ──key──▶ Apprua (your PC or server) ──▶ engine (Coolify) ──▶ your app
                                                              │
                                                              └─ code archive (every version of every app)
```

Apprua checks what arrives, keeps the version and asks the engine to build and run the app. The first engine is [Coolify](https://coolify.io); it sits behind a small driver interface (`packages/server/src/engine`), so others can be added. Security notes and known limits are in [SECURITY](SECURITY.md); what Apprua keeps about people is in [Privacy](docs/guide/privacy.md).

## Repository

| Path | What |
|---|---|
| `packages/server` | Apprua server: API for the connector, portal, checks, code archive, engine drivers |
| `packages/mcp` | The connector: an MCP server (stdio) for AI apps |
| `install/` | Installers for Linux and Windows (WSL2), backups |
| `docs/` | The guide ([English](docs/guide/README.md), [Italiano](docs/guida/README.md)) and the [configuration](docs/configuration.md) |
| `brand/` | The logo and the APPRUA wordmark (see [TRADEMARKS.md](TRADEMARKS.md)) |
| `scripts/` | Release helpers: see [RELEASING](RELEASING.md) and the [changelog](CHANGELOG.md) |

Development: Node.js 24, `npm install`, `npm run build`, `npm test`.

## License

Apprua is free software under the **GNU Affero General Public License v3.0** ([LICENSE](LICENSE)), and its core will stay that way. You can use it, change it and share it; if you offer a changed version to others over a network, you share your changes under the same license. The apps you publish with Apprua stay yours: publishing an app through Apprua does not put that app under the AGPL.

Contributions are welcome, also without writing code: try it, report what doesn't work, suggest ideas, improve the guide. See [CONTRIBUTING](CONTRIBUTING.md). On your first pull request a bot asks you to sign the [Contributor License Agreement](CLA.md) with one comment. For security problems read [SECURITY](SECURITY.md).

The license covers the code, not the brand: the name "Apprua" and the lighthouse logo have their own simple rules in [TRADEMARKS](TRADEMARKS.md).
