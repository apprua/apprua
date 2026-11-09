# Privacy: what Apprua keeps

*[Italiano](../guida/privacy.md)*

This page is for whoever installs and runs Apprua for other people (a company, a school, a team). It says what Apprua keeps about the people who use it, where, for how long, who can see it and what leaves the machine, so you can write your own privacy notice and answer people's requests.

**Who is responsible.** Apprua runs entirely on your machine. The Apprua project receives nothing from your installation: no telemetry, no accounts with us, no copies. Whoever runs the installation decides why and how the data is used, and is the one people turn to (under the GDPR, usually the data controller). This page describes the software; it is not legal advice and does not make an installation compliant by itself.

## What Apprua keeps

| What | Contents | Where |
|---|---|---|
| **Accounts** | Email, name (if given), role, a hash of the password (scrypt, the password itself is never kept), a hash of the personal key with its first characters and expiry date, when the key was last used, creation date | Apprua's database (`apprua.db`) |
| **History of actions** | Who did what and when: sign-ins, failed sign-ins (with the email typed and the IP address), publications, changes of secrets (the name, never the value), changes of owner, password changes, "forgot your password?" requests for unknown emails (with the email and the IP address) | Apprua's database (table `audit`) |
| **Publications** | For each publication: the app, who published it, when, the result and a short excerpt of the build log | Apprua's database |
| **"Forgot your password?" links** | A hash of the link, the email, expiry (one hour) and when it was used | Apprua's database |
| **Code archive** | Every version of the code of every app, with the name and email of who published it (git history) | Apprua's data folder (`repos/`) |
| **Secrets of the apps** | The values the apps use while they run (passwords, keys) | The engine's database (Coolify). Apprua never shows them again |
| **Data of the apps** | Whatever each app stores (its own database, uploaded files). Apprua does not look inside | Docker volumes of each app |
| **Request log of the portal** | For each request: method, address visited (without codes, keys and links that open something), host, IP address | The output of the `apprua` container |
| **Logs of the engine** | Build logs and the output of the apps | The engine (Coolify) |
| **Copies** | Everything above, at the moment of the copy | `/var/backups/apprua` on a server; `%USERPROFILE%\Apprua-backups` on Windows |

**Cookies and browser storage.** Only what is needed to work: the portal's sign-in cookie, one sign-in cookie for each app opened (valid only for that app), and the language chosen (`apprua_lang`). The light or dark theme is remembered in the browser (`localStorage`). No tracking, no analytics, no fonts or scripts from other sites.

## How long

Apprua 1.0 deletes nothing by itself on a schedule:

| What | How long |
|---|---|
| Accounts | Until removed (see "When someone asks"). A personal key expires after 90 days |
| History of actions and publications | As long as the installation exists. When an account is removed, its email in the history is replaced by a random label |
| "Forgot your password?" links | Valid one hour; the row stays until the account is removed |
| Code archive | Until the app is deleted for good by an administrator. Then a copy of its code is kept aside in `repos/.deleted/` so a mistake can be undone: remove it by hand when it is no longer needed |
| Request log of the portal | At most 5 files of 10 MB on a server installed or updated with version 1.0.0 or newer; it starts empty at every update of Apprua |
| Copies | The newest 7 nightly copies on a server (`APPRUA_BACKUP_KEEP`); on Windows, until you delete them |

If you need shorter times (for example for the history of failed sign-ins), decide them in your own rules and apply them; tell us in an issue if a setting would help.

## Who can see what

- **Each person** sees their own account, their apps and their history of versions.
- **Administrators of Apprua** manage every account and every app, can read the history of actions, give an app to someone else and set a new password for an account. They can open every app.
- **Whoever administers the machine** (root on the server, or the Windows account on a PC) can read everything, also the engine's panel, the secrets of the apps and the copies.

## What leaves the machine

| Where it goes | What | When |
|---|---|---|
| **The provider of each AI app** (Anthropic, OpenAI, Cursor, Microsoft and others) | What people write in the chat, and what the AI app reads: the code of the project, the answers of Apprua, the logs of the apps it asks for | Every time someone works with an AI app. This is between that person and their AI provider, under the provider's terms |
| **Your email provider** (SMTP) | Email address, name of the app, the "forgot your password?" link, reminders | Only if email is set up |
| **npm** (registry.npmjs.org) | Only the question "is the connector of this version there?"; no data of people | Once when Apprua starts. The AI apps on the PCs then download the connector from npm |
| **Let's Encrypt** | The names of the addresses that need a certificate | Only on the internet, with automatic HTTPS |
| **Download sites** (Coolify, Docker, GitHub for WSL) | Nothing about people | Only while installing or updating |

The connector sends the project folder from the PC to your Apprua, never anywhere else.

## When someone asks

**To see their data.** An administrator can read the account (Settings), the apps and their versions (the portal), and the history of actions (`GET /v1/admin/audit` with an administrator key). The code of an app can be downloaded from its page.

**To be removed.**

1. Give each app of that person to someone else (an administrator asks their AI app, for example "give the app lista-spesa to anna@example.com": it uses the administrator tool `admin_change_owner`), or delete it for good in Settings.
2. Remove the account. On a Linux server:

   ```bash
   sudo bash install/remove-account.sh person@example.com
   ```

   On a Windows PC (in PowerShell):

   ```powershell
   wsl -d Apprua -u root -- docker exec apprua node dist/src/cli/admin.js forget person@example.com
   ```

   The account goes and their email in the history of Apprua is replaced by a random label like `removed-1a2b3c4d`. This is not full anonymity: the rest of the history (for example the IP addresses of failed sign-ins, dates, app names) stays, and can still point to the person; remove those rows by hand if you need to.

   With accounts (`AUTH_MODE=local`) the person can no longer sign in. With a login proxy in front of Apprua (`AUTH_MODE=proxy`, for example Microsoft or Google accounts) Apprua creates the account again the next time that person gets through the proxy: remove their access in the identity system too (the group or the app registration that lets them in).
3. What the command cannot change: the history of versions inside the code archive of the apps that person published (it keeps their name and email; it goes when those apps are deleted for good, then from `repos/.deleted/`), the data the apps themselves stored about them, and the copies made before (they are replaced over the following days, or delete them).

## Good practice

- Keep the copies where only the people who run Apprua can read them: they hold everything.
- Use HTTPS when people use Apprua over the network (see [Apprua on a server](server.md)).
- Tell the people who publish apps that an app which stores data about others (a form, a list of customers) needs its own care: Apprua keeps it safe on your machine, but what the app collects is up to whoever runs it.
