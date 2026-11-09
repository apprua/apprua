# Third-party notices

Apprua is licensed under AGPL-3.0-only (see `LICENSE`). It includes, or is built on, the following open source work, each under its own license. That license applies to that work, not to Apprua as a whole, and the AGPL of Apprua does not replace it.

## Included in what Apprua distributes

| Work | Where in Apprua | License | Text |
|---|---|---|---|
| Libraries of the connector (Model Context Protocol SDK, Zod, Ajv, tar, ignore and their dependencies) | bundled into `packages/mcp/dist/server.mjs` | MIT, ISC, BSD-3-Clause, BlueOak-1.0.0 | at the end of `dist/server.mjs` and in `dist/THIRD_PARTY_LICENSES.txt`, written there by `packages/mcp/build.mjs` |
| Libraries of the server (Fastify, nodemailer, fflate and their dependencies) | `node_modules` of the server image | their own (mostly MIT) | in each package folder inside `node_modules` |
| Atkinson Hyperlegible Next (The Atkinson Hyperlegible Next Project Authors) | `packages/server/assets/fonts` | SIL Open Font License 1.1 | `packages/server/assets/fonts/OFL-AtkinsonHyperlegibleNext.txt` |
| Lilita One (Juan Montoreano) | `packages/server/assets/fonts`; the outline of its letter A is the base of the Apprua logo, as the OFL allows | SIL Open Font License 1.1 | `packages/server/assets/fonts/OFL-LilitaOne.txt` |
| Lucide icons | drawn inline in the portal (`packages/server/src/views.ts`) | ISC; the icons derived from Feather also MIT | below |

## Used but not included

- **Coolify** (Apache-2.0), the engine that builds and runs the apps: the installer downloads it from its own project, with its own license and notices. Apprua does not modify or redistribute it.
- **Docker Engine** and **WSL**: installed from their official sources by the installers, under their own terms.

## Lucide

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

Some Lucide icons are derived from the Feather project:

```
The MIT License (MIT) (for the icons derived from Feather)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
