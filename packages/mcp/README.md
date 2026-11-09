# @apprua/mcp

The connector of [Apprua](https://github.com/apprua/apprua) for AI apps: an MCP server (stdio) that lets Claude, Codex, Cursor, VS Code and any app that supports MCP publish the apps you build with AI on **your own** Apprua, on your PC or your server.

You do not install it by hand: the Apprua portal gives you the exact lines for your AI app (address and personal key included). They look like this:

```json
{
  "command": "npx",
  "args": ["-y", "@apprua/mcp@<the version of your Apprua>"],
  "env": { "APPRUA_URL": "https://apprua.example.com", "APPRUA_TOKEN": "apr_..." }
}
```

Then tell your AI app: "Publish this app on Apprua."

- Needs Node.js 20 or newer and an Apprua server (see the [guide](https://github.com/apprua/apprua/blob/main/docs/guide/README.md)).
- Use the version of the connector that matches your Apprua: the portal always shows the right one.
- It sends only the project folder you ask for, never the home folder, a drive or folders of keys, and leaves out keys and credentials of the PC. See [SECURITY.md](https://github.com/apprua/apprua/blob/main/SECURITY.md).

## License

AGPL-3.0-only (see `LICENSE`). The file `dist/server.mjs` also contains open source libraries under their own licenses (MIT, ISC, BSD-3-Clause, BlueOak-1.0.0): their texts are at the end of that file and in `dist/THIRD_PARTY_LICENSES.txt`.

"Apprua" and its logo are trademarks: see [TRADEMARKS.md](https://github.com/apprua/apprua/blob/main/TRADEMARKS.md).
