# Configuration

Apprua is configured with environment variables. The installers set them for you; this list is for manual installs.

## Basics

| Variable | Default | Meaning |
|---|---|---|
| `APPRUA_PROFILE` | `personal` | `personal` (one person, generous limits, no reviews) or `team` |
| `APPRUA_NETWORK` | from `BASE_DOMAIN` | Where the portal and the apps open: `local` (only this machine), `lan` (the local network, with a name of your network) or `internet` (a domain) |
| `APPRUA_HTTPS` | `off` on `local` and `lan`, `letsencrypt` on `internet` | `off`, `letsencrypt` (internet only) or `own` (the certificate given to the installer) |
| `APPRUA_LAN_IP` | found by the installer | Address of the machine on the local network: Settings shows it and Check compares the names with it |
| `BASE_DOMAIN` | `localhost` | Apps are published at `<name>.<BASE_DOMAIN>` |
| `APP_SCHEME` | `http` without HTTPS, else `https` | Scheme of app addresses |
| `PUBLIC_URL` | `http://localhost:3000` | Address of the portal as users see it |
| `APPRUA_BRAND` | `Apprua` | Name shown in the portal and the connector |
| `DEFAULT_LANG` | `en` | Portal language when the browser does not say (`en`, `it`) |
| `DATA_DIR` | `/data` | Database, code archive, instance secrets |
| `PORT` / `GIT_PORT` | `3000` / `3001` | Portal + API / internal read-only git server |
| `SIGNPOST_PORT` | `3002` | Page shown at app addresses where no app answers (paused, missing, starting); the engine proxy sends those addresses here |

## Where the apps open

Who Apprua is for (`APPRUA_PROFILE`) and where it opens (`APPRUA_NETWORK`) are separate choices: one person can open
the apps on the local network, and a group can start on one PC. The installers remember both: running them again
without the settings keeps the previous choices.

| Network | Portal | Apps | How |
|---|---|---|---|
| `local` | `http://localhost:3000` | `http://<name>.localhost` | default |
| `lan` | `http://apprua.<name>` (and `localhost:3000` on the machine) | `http://<name of the app>.<name>` | Linux: `sudo APPRUA_NETWORK=lan APPRUA_DOMAIN=apps.office.lan bash install/install.sh`. Windows: `install\windows\install-apprua.ps1 -Network lan -Domain apps.office.lan` |
| `internet` | `https://apprua.<domain>` | `https://<name>.<domain>` | `sudo APPRUA_NETWORK=internet APPRUA_DOMAIN=apps.example.com bash install/install.sh` (DNS `*.domain` to the server) |

**Names and certificates are yours.** Apprua does not create DNS names and does not depend on any outside service for
them: whoever manages the network points `apprua.<name>` and `*.<name>` to the machine (on the local network, in its
own DNS). The address of the machine is found by itself (`APPRUA_LAN_IP` to choose it); give it a fixed address. Apps
already published move to new addresses by themselves when the name changes. In the portal, *Settings > Where the apps
open > Check* looks up both names with the DNS of the machine, reads the certificate the proxy serves, and tries a
made-up app name from the browser of the person checking.

**HTTPS.** On `local` it is not needed (browsers treat `localhost` as secure). On `internet` the engine gets free
certificates from Let's Encrypt. On `lan` (or on `internet` instead of Let's Encrypt) you can give your own certificate
for `*.<name>`, as two PEM files: `APPRUA_CERT=/path/cert.pem APPRUA_CERT_KEY=/path/key.pem` (Windows: `-Cert` and
`-CertKey`). The installer checks that it is valid, matches its key and covers `apprua.<name>` and `*.<name>`, keeps a
copy in `/root/.apprua/cert/` and hands it to the proxy (`/data/coolify/proxy/certs`, `dynamic/apprua-cert.yaml`).
Renewing it is up to you: run the installer again with the new files. Settings shows when it ends and warns 30 days
before. `APPRUA_HTTPS=off` goes back to plain http on the local network, `APPRUA_HTTPS=letsencrypt` back to Let's
Encrypt on the internet.

Earlier versions used `sslip.io` for the local network: running the installer again on such an install asks for a
name (or `-Network local` / `APPRUA_NETWORK=local`).

On Windows, `-Network lan` also asks for administrator permission once, to let the other PCs in: port forwardings
from ports 80 and 443 of the PC to WSL and a firewall rule "Apprua (local network)" for private and domain networks
only (`install\windows\network-apprua.ps1`). `-Network local` and `-Uninstall` remove them.

## Who can open each app

On the local network and the internet a sign-in stands in front of every app: the proxy asks Apprua's gate
(`/_apprua/gate`, middleware `apprua-auth` written by the installer) before each request. The session of the portal
stays on the portal: the first time someone opens an app, the gate sends them to the portal (`/_apprua/pass`), which
checks that they are signed in and sends them back with a code for one use; the gate then gives that app its own
cookie, valid for that app only (12 hours). An app can read the cookie of the people who open it, but cannot use it
on the portal or on other apps. Each app is open to:

| Choice | Who opens it |
|---|---|
| Only you (`private`) | the owner and the administrators |
| Everyone with an account (`team`, default) | anyone signed in to this Apprua |
| Anyone, no sign-in (`public`) | anyone who can reach the address |

The owner changes it from the menu of the app in the portal, or by asking the AI (`set_visibility`). It applies at
once. On "only this computer" there is nothing to protect and no sign-in. With `AUTH_MODE=proxy` or
`APP_AUTH_MIDDLEWARE` the login in front of the apps is the one of the company proxy instead.

## Who is using an app

An app where several people change the same data often needs to know who is doing it: to write "changed by" next to
a change, to warn when two people change the same entry, or to show who else is editing. When the gate lets a request
through, the app receives these headers with it:

| Header | What it holds |
|---|---|
| `X-Apprua-User` | the email of the person signed in |
| `X-Apprua-User-Name` | their name, URL-encoded (read it with `decodeURIComponent` or `urllib.parse.unquote`); empty when they have none |
| `X-Apprua-Role` | `admin` or `user` (their role in Apprua) |
| `X-Apprua-Key` | the key of the app, always present |

The proxy removes these headers when a browser sends them, so a person cannot pass for someone else. Other apps on the
same machine, though, could call the app directly and send made-up headers: an app trusts the user headers only when
`X-Apprua-Key` is the same as its variable `APPRUA_APP_KEY`, which Apprua sets at every publication (every app has its
own; an app published before this version gets it at its next publication). With no `X-Apprua-User` nobody is
signed in: a public app opened without signing in, or "only this computer", where there is no sign-in at all.

The headers are there only with Apprua's own sign-in in front of the apps: with `APP_AUTH_MIDDLEWARE` the company
proxy sends its own, if any.

## The Coolify panel

On a server the installer closes the Coolify panel (8000) and its live updates (6001, 6002) to the network, on IPv4
and IPv6, from before Coolify is installed: Docker publishes ports past the usual firewall, so a small service
(`apprua-coolify-lock`, script `install/apprua-coolify-lock.sh`) puts the rules in the `DOCKER-USER` and `INPUT`
chains at every start of Docker. To open the panel from your PC, use an SSH tunnel and then `http://localhost:8000`:

```bash
ssh -L 8000:localhost:8000 root@your-server
```

`APPRUA_COOLIFY_OPEN=1` when running the installer leaves the ports open (and removes the rules). On Windows nothing
changes: WSL brings the ports only to the localhost of the PC (unless `.wslconfig` has `networkingMode=mirrored`:
then the ports are closed as on a server).

## Every app in its own lane

The published apps run code written by AI, so each one is kept apart (`install/apprua-guard.sh`, service `apprua-guard`): an app container (label `coolify.type=application`) can answer visits and reach the internet and the local network, and it reaches other apps only through the proxy (ports 80 and 443, where the sign-in stands). New connections from an app to anything else on the Docker networks of the machine (other apps directly, Apprua, Coolify, its database and Redis), to the machine itself or to the cloud provider's metadata service are dropped, for IPv4 and IPv6. The machine itself (and so the builds of the engine, which run on its network) cannot open the apps directly either (chain `APPRUA-HOST`). Apps run without raw network access (`--cap-drop=NET_RAW`), so they cannot pass for another container on the network. A container whose image carries labels for the proxy (`traefik.*`, `caddy*`) is removed before it starts and written to `/var/lib/apprua/refused.log`. The rules (chain `APPRUA-APPS`, called from `DOCKER-USER` and `INPUT`) are replaced in one step when the service starts, every time a container starts or stops, and once a minute.

| Command | What it does |
|---|---|
| `apprua-guard status` | Shows the rules |
| `apprua-guard off` | Removes them until the next start of the service |
| `APPRUA_GUARD=0` when running the installer | Turns the guard off for good (experts only) |

## Sign-in

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_MODE` | `local` | `local`: accounts with email + password. `proxy`: trust identity headers from a login proxy (e.g. oauth2-proxy with any OIDC provider: Microsoft, Google, Keycloak…) |
| `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` | (none) | Creates the first administrator at start, skipping the first-run setup (for automated installs) |
| `SETUP_CODE` | (none) | One-time code asked by the first-run setup page. The installer sets it whenever Apprua can be reached from the network (local network or internet, any profile), so nobody else can take over a fresh install |
| `AUTH_PROXY_SECRET` | (none) | `proxy` mode: shared secret the proxy must send (header `AUTH_PROXY_SECRET_HEADER`, default `x-apprua-proxy-secret`) |
| `AUTH_EMAIL_HEADER`, `AUTH_NAME_HEADER`, `AUTH_GROUPS_HEADER` | oauth2-proxy names | `proxy` mode: header names |
| `AUTH_ADMIN_GROUP` | (none) | `proxy` mode: members of this group are administrators |
| `SESSION_DAYS` | `14` | Portal session length |
| `TOKEN_DAYS` | `90` | Personal token validity |

## Engine (Coolify)

| Variable | Meaning |
|---|---|
| `COOLIFY_API_URL` | Default `http://coolify:8080` (same Docker network) |
| `COOLIFY_TOKEN` | API token with root permission (the installer creates it) |
| `COOLIFY_PROJECT_UUID`, `COOLIFY_SERVER_UUID` | Where apps are created |
| `GIT_INTERNAL_URL` | How build containers reach Apprua's git server, default `http://apprua:3001` |
| `APP_AUTH_MIDDLEWARE` | Optional Traefik middleware that puts a login in front of every app (team installs) |
| `APPRUA_COOLIFY_VERSION` | Installer only. The Coolify version to install or update to; by default the one this Apprua was tested with (`"apprua": { "coolify" }` in `package.json`). `latest` installs the newest, at your own risk. Coolify never updates by itself: the installer turns its automatic updates off |
| `AUTO_BUILDPACK` | `nixpacks` (default) or `railpack` for projects without a Dockerfile |

## Limits and policies

`DEFAULT_QUOTA`, `DEFAULT_CPUS`, `DEFAULT_MEMORY`, `MAX_CPUS`, `MAX_MEMORY_MB`, `REVIEW_MONTHS` (0 = no reviews),
`MAX_ARCHIVE_MB`, `MAX_EXTRACTED_MB`, `MAX_FILES`, `DEPLOY_TIMEOUT_MIN`, `RESERVED_NAMES`.

Administrators can change the apps per person (`DEFAULT_QUOTA`), the reviews (`REVIEW_MONTHS`) and the memory
for each new app (`DEFAULT_MEMORY`) on the **Settings** page of the portal.

Without `DEFAULT_MEMORY` the memory of new apps is **automatic**: the largest size (from 512 MB to 2 GB) that still
lets at least 8 apps stay on together, after 2 GB kept for the platform. 8 GB machine: 512 MB; 16 GB: 1 GB; 32 GB: 2 GB. A value set as an environment variable
wins, and the page shows it as fixed by the installation.

The memory of **one app** is changed by an administrator on the page of the app (it is saved and the app restarts),
or by the AI with `admin_set_limits`. The most one app can get is `MAX_MEMORY_MB`, or without it about half of the
memory left after the 2 GB for the platform: 8 GB machine: 2 GB; 16 GB: 4 GB; 32 GB: 8 GB; 64 GB: 16 GB.

**Out of memory.** `apprua-guard` (the service installed next to Apprua) writes every Docker `oom` event of an app
to `/var/lib/apprua/oom.log`, mounted read-only into the Apprua container (`APPRUA_OOM_FILE`, default
`/apprua-host/oom.log`). Every 2 minutes Apprua reads it: the app shows "Ran out of memory" for 7 days (or until its
memory or version changes), `app_status` tells the AI, and the owner gets one email when emails are set up.

## Resources

The Settings page shows the memory and disk space Apprua can use, and a cautious estimate of how many apps fit
(2 GB kept for the platform, each app counted at its full memory limit, about 1 GB of disk for each app).

| Variable | Meaning |
|---|---|
| `HOST_MEMORY_GB` | RAM of the whole PC, set by the Windows installer (so the page can say how much more Apprua can get) |
| `HOST_DISK_PATH` | A read-only, empty folder of the Windows drive mounted in the container: the Linux disk can grow up to 1 TB, so the real limit is the free space of that drive. Set by the Windows installer |

On Windows, the memory of the hidden Linux is chosen at install time (by default half of the RAM, between 4 and
16 GB) and changed later with `install\windows\install-apprua.ps1 -SetMemoryGB 12`. Apprua restarts, and the apps
are back online in about a minute. On a server, Apprua uses the memory of the server.

The Windows installer also adds an **Apprua** icon to the Start menu and the desktop. It opens the portal, and if
the hidden Linux is stopped it starts it first (`%LOCALAPPDATA%\Apprua\open-apprua.ps1`).

An icon next to the clock (`tray-apprua.ps1`, started at every sign-in from the Startup folder) shows whether
Apprua answers: the lighthouse lit when it is on, dark while it starts, grey when it is stopped. Click: open the portal. Right click:
open, restart, stop or start Apprua, close the icon. "Stop" stops the Linux "Apprua"; if no other Linux is on,
it stops WSL too, so all its memory goes back to Windows. "Start Apprua with Windows" (with a tick) turns the
start at sign-in on or off: off, Apprua stays off at sign-in and the icon (grey) turns it on with a click.

In the portal, a dot next to the name says "On" when the portal and the engine answer, or "Engine stopped" (with a
notice) when Coolify does not. The page checks every 30 seconds that the portal still answers: if not, it says so and
how to turn it on again, and it refreshes by itself when the portal is back. It can be turned off in Task Manager > Startup apps. This first version is a
PowerShell script; a small signed program will replace it together with the graphical installer.

## Copies on a Linux server

| Command (from the Apprua folder) | What it does |
|---|---|
| `sudo bash install/backup.sh` | A full copy in `/var/backups/apprua/apprua-<date>.tar.gz`: Apprua (database, code archive), the engine (its database, settings and keys), the data of the apps and the installer settings. Docker stops for the copy, so the apps are offline for about a minute. With a Coolify that was there before Apprua and holds other projects, the copy holds only Apprua's part (its data, its settings, the data of its apps) and Docker keeps running; the engine goes with Coolify's own backups |
| `sudo bash install/backup.sh --schedule` | A copy every night at 03:30, keeping the newest 7 (`APPRUA_BACKUP_KEEP`, `APPRUA_BACKUP_DIR`). `--unschedule` stops them |
| `sudo bash install/backup.sh --restore <file>` | Everything back from a copy, also on a new server (it installs Docker if missing, asks to type RESTORE): the engine starts on its own data and every app that was online is published again from the code archive. A copy of only Apprua's part needs Coolify already running on that server; a full copy is refused on a server whose Coolify holds other projects |

A copy contains secrets (keys and passwords of the apps): it is readable by root only. Keep a second copy on
another machine (for example with `scp`, or the backup tool of your provider).

## Copies and removal (Windows)

| Command (from the Apprua folder) | What it does |
|---|---|
| `install\windows\install-apprua.ps1 -Backup` | Saves the whole Linux "Apprua" (Coolify, Apprua, apps, data, code) to `%USERPROFILE%\Apprua-backups\Apprua-<date>.tar`. The apps are offline for a few minutes |
| `install\windows\install-apprua.ps1 -RestoreFrom <file.tar>` | Brings everything back from a copy, then sets up the rest (memory, start at sign-in, icons) |
| `install\windows\install-apprua.ps1 -Uninstall` | Offers a copy first, asks to type `DELETE` (`ELIMINA` on Italian Windows), then removes the Linux "Apprua", the icons and the start at sign-in, and restores `.wslconfig`. WSL and other Linux are never removed |

## Connecting AI apps

The connector is an MCP server that runs on the person's PC (it must read the local folder it publishes). The settings
the portal gives run `npx -y @apprua/mcp@<version>`: the AI app downloads it from npm, at the exact version of this
server, and starts it by itself (needs Node.js on the PC). When that version is not on npm (an Apprua built from the
source, whose installer sets `APPRUA_CONNECTOR_SOURCE=server`; a server that cannot reach npm; a release whose npm
step did not run: Apprua checks once at start), the settings use the copy served by the portal instead. The portal
serves it in three forms:

| Address | For |
|---|---|
| `/connector/apprua-mcp-<version>-c<fingerprint>.tgz` | `npx -y --package <address> apprua-mcp`, used only with `APPRUA_CONNECTOR_SOURCE=server`. Public on purpose (open-source code only: no address, key or data inside) |
| `/download/apprua.mcpb` | Claude Desktop extension, with this portal's address pre-filled (signed-in users) |
| `/download/apprua-mcp.mjs` | The single file, for people who prefer to keep it themselves (signed-in users) |

Step 2 of the portal has one tab per app (Claude Desktop, Claude Code, Codex, Cursor, VS Code, other apps). Right after a
new key is created, Cursor and VS Code get a one-click button (`cursor://...mcp/install`, `vscode:mcp/install`) with
the key already in it; Claude Code gets one command (with `cmd /c npx` on Windows).

## Email (optional)

`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `ADMIN_EMAIL`. Without `SMTP_HOST` no email is sent.

With email, Apprua sends the review reminders, a message to the owner when an app that is on has not been running for 5 minutes (checked every 2 minutes; the portal shows it as "Not answering" after 2), and the "Forgot your password?" links (valid one hour, one use). Without it, the sign-in page says to ask an administrator (**Settings**, **New password**), and the administrator can get a new password with `install\windows\install-apprua.ps1 -ResetPassword` (Windows) or `sudo bash install/reset-password.sh [email]` (Linux).
