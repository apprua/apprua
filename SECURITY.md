# Security

Apprua runs code written by AI on people's own machines, so we take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately:

- on GitHub: the **Security** tab of this repository, then **Report a vulnerability**;
- or by email to **security@apprua.com**.

Tell us what you found, how to reproduce it and what an attacker could do with it. We answer within **5 working days**, keep you updated while we fix it, and credit you in the release notes if you wish.

## Supported versions

Only the latest release gets security fixes.

## What is in scope

- The Apprua server and portal (`packages/server`): sign-in, sessions, the gate in front of the apps, personal keys, secrets, the checks on publications.
- The connector (`packages/mcp`).
- The installers and the backup script (`install/`): for example ports left open, files readable by the wrong users.

Problems in Coolify, Docker or WSL themselves should go to those projects; tell us too if they affect Apprua.

## What Apprua already does

- Publications with secrets inside (API keys, `.env` files, private keys) are refused. The check knows the common formats of keys; see the known limits.
- Secret values are never shown again, not even to their owner.
- On a server, the engine's panel (ports 8000, 6001, 6002) is closed to the network on IPv4 and IPv6, from before the engine is installed (on a system without `iptables` the installer adds it first where `apt-get` is there; elsewhere the panel is closed as soon as Docker brings it), and a sign-in stands in front of every app unless its owner opens it to anyone.
- The portal's session cookie is for the portal's address only. Each app gets its own cookie, valid only at its own address and only for that app, through a code for one use that the app never sees: an app can never act as the people who open it, on the portal or on other apps.
- No page of the portal can be shown inside another page (clickjacking).
- Personal keys expire after 90 days and can be revoked by administrators. Wrong passwords are counted: after 10 the address has to wait.
- Every published app runs in its own lane (`install/apprua-guard.sh`): it can answer visits and reach the internet, and reach other apps only through their public address and sign-in, never directly, nor Apprua, the engine, its database, the machine itself or the cloud metadata service. Apps run without raw network access (no forged packets on the internal network). The engine's builds, which run on the machine's own network, cannot open the apps directly either.
- The labels of every app, with the sign-in in front of it, are applied again and checked before every publication: a step that failed before cannot leave an app published without them.
- With a Coolify that was there before Apprua, the lanes and the check of the images apply only to Apprua's apps: the other projects of that Coolify are left alone.
- The request log never shows the values that open something: the "forgot your password?" link, codes for one use, the key of the internal git server.
- An app cannot bring its own instructions for the proxy: Dockerfiles with proxy labels are refused, and a container whose image has them (also from the image it starts from) is removed before it starts.
- Sessions are tied to the password and to the last sign-out: a new password, or signing out, ends the sessions on every device and the sign-in to every app opened with them, and a new password ends any "forgot your password?" link. A new personal key replaces the old one at once. A password that was lost (the "forgot your password?" link, or a new one given by an administrator) also ends the personal key.
- The connector refuses to send folders that are not a project (the home folder, a drive, folders of keys) and never sends keys and credentials of the PC (`.ssh`, `.aws`, `.npmrc` and similar). AI apps install it from npm at the exact version of the server (version 1.0.0 is published by the maintainer; from the next release on it is published from GitHub with provenance); it bundles its dependencies, so a fix in one of them comes with a new release of Apprua.
- Copies on a server hold only Apprua's own data (its Docker volumes, the engine's and the apps', not those of other programs on the machine), carry a SHA-256 fingerprint checked before a restore, and a restore takes back only Apprua's own folders. With a Coolify that was there before Apprua and holds other projects, a copy holds only Apprua's part (not the engine's database), and a restore leaves the engine and its other projects alone.
- With "this machine only", on a Linux server the ports of the apps (80, 443) are closed to the network too: there the apps have no sign-in in front.
- An archived app is closed by the sign-in in front of the apps, also if the engine could not stop it; publications of the same app never run at the same time, and while one runs, archiving, starting and stopping that app are refused with a message to try again when it ends. A publication the engine has taken stays open until the engine says how it ended (finished, failed, or unknown to it): Apprua running out of time, losing contact with the engine or restarting does not close it, and it is followed again at every start. If the answer to the request itself is lost, Apprua asks the engine whether a publication of that app started since the request, and keeps the app reserved until the engine answers. A code for one use handed out before signing out, or before a new password, no longer opens the app.

## Known limits

- On a local network without a certificate of your own, Apprua uses plain HTTP: the personal key and the sign-in travel unencrypted on that network. The portal says so; give the installer a certificate to avoid it.
- The engine builds apps with Docker on the machine's own network: a hostile Dockerfile can reach what that network reaches during its build (services of the machine that need no password, the cloud metadata service), but not the apps. Apprua is meant for people you trust to publish; for publishers you do not fully trust, builds would need a separate build server (not available yet).
- A running app can reach the internet and the other devices of the local network, like any program on the machine. Its lane keeps it away from the other apps, Apprua, the engine and the machine itself.
- An app gets its lane a moment after it starts; connections it opens in that moment are cut as soon as the lane is there. An image with labels for the proxy is removed as soon as Docker reports it, not before.
- The check for secrets knows the common formats of keys and skips files over 2 MB and binary files: it catches the usual mistakes, it does not prove that a folder holds nothing private. What you write in the chat, and the logs an AI app reads, also go to the provider of that AI app.
- The personal key of an administrator has the powers of an administrator, also when used by an AI app.
- When the connector comes from the portal instead of npm (a server built from source, or a version not on npm), whoever controls the portal, or the network when there is no HTTPS, chooses the code that the AI apps run on the PCs.
- No telemetry. What Apprua contacts outside the machine: the npm registry, once at start, to see whether the connector of its version is there; during installation the download sites of Coolify, Docker and, for WSL only, GitHub; Let's Encrypt for certificates on the internet. No data of the people or of the apps is sent. What Apprua keeps about people, for how long, and how to remove an account on request: [docs/guide/privacy.md](docs/guide/privacy.md).
- The fingerprint of a copy finds a copy that was damaged or changed, not one replaced together with its `.sha256` file: keep copies where only you can write.
- What is downloaded during an installation. The archives of a release come with their fingerprints (`SHA256SUMS.txt`, on the same page: they find a damaged download, not a release replaced as a whole), and the installer of a release takes the image of Apprua by its fingerprint. The engine is installed by Coolify's own script, downloaded from Coolify's site at that moment and run as root: Apprua fixes the version of Coolify it asks for, not the content of that script. The installer says so before running it, downloads it whole first, and writes its SHA-256 fingerprint on the screen. The same holds for Docker's installer when a restore needs it.
- On Windows, Apprua lives in a small Linux of its own (WSL) that runs as root and, as WSL does by default, can read and write the files of the Windows user and start Windows programs. Whoever became root inside that Linux (for example through a hostile build, see above) would reach those files too. Publish on a PC only apps you would run on that PC.
- The image of Apprua started by hand, without the installer and without `SETUP_CODE`, lets the first visitor create the administrator: set `SETUP_CODE`, or keep port 3000 closed until the first-run setup is done. The installers always set a code when Apprua can be reached from the network.
