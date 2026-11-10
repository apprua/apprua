# Apprua on a server for your group

*[Back to the guide](README.md) · [Italiano](../guida/server.md)*

This path is for whoever runs IT for a team, a studio or a company: Apprua on a Linux server, an account for each person, simple rules and, if you need it, apps reachable from the internet with your own domain.

## What you need

| | |
|---|---|
| Server | Ubuntu or Debian, fresh or nearly. A server in the office, a virtual machine or a rented server |
| Resources | at least 2 CPUs, 4 GB of memory and 30 GB of disk. Each running app usually takes 512 MB to 1 GB |
| Access | `ssh` with a user who can use `sudo` |
| For the internet | a domain (for example `apps.yourcompany.com`) with a DNS record `*.apps.yourcompany.com` pointing to the server, and ports 80 and 443 open |

The installer sets up Docker, the engine and Apprua by itself.

## 1. Choose where the apps open

| Choice | Portal | Apps | When |
|---|---|---|---|
| Local network | `http://apprua.apps.office.lan` | `http://<name>.apps.office.lan` | Only from the office. HTTPS if you have a certificate for `*.apps.office.lan` |
| Internet | `https://apprua.apps.yourcompany.com` | `https://<name>.apps.yourcompany.com` | From anywhere, with automatic HTTPS (Let's Encrypt) or your own certificate |

Either way the **names are yours**: whoever runs the DNS points `apprua.<name>` and `*.<name>` to the server's address (on the local network, in the internal DNS). Apprua does not create them and uses no outside service to make them work; after installing, *Settings > Where the apps open > Check* tells whether they lead to the server.

Whoever opens an app has to sign in with their account, unless the owner opens it to anyone.

## 2. Install

Connect to the server and download the latest version:

```bash
curl -fsSL https://github.com/apprua/apprua/releases/latest/download/apprua.tar.gz | tar -xz && cd apprua
```

If you prefer to check the download before opening it, use these three lines instead: the second file holds the fingerprints of the release, and the third line stops if the archive does not match.

```bash
curl -fsSLO https://github.com/apprua/apprua/releases/latest/download/apprua.tar.gz
curl -fsSLO https://github.com/apprua/apprua/releases/latest/download/SHA256SUMS.txt
sha256sum -c --ignore-missing SHA256SUMS.txt && tar -xzf apprua.tar.gz && cd apprua
```

The installer inside the archive then downloads the image of Apprua by its fingerprint, not only by its name: another image put under the same name is not taken for it.

Then **one** of these commands.

Local network:

```bash
sudo APPRUA_PROFILE=team APPRUA_NETWORK=lan APPRUA_DOMAIN=apps.office.lan bash install/install.sh
```

Local network with HTTPS, with your certificate for `*.apps.office.lan` (PEM files; renewing it is up to you, Settings warns when it is about to end). Without it, sign-ins and the personal keys of the AI apps travel unencrypted on the office network, and the portal says so:

```bash
sudo APPRUA_PROFILE=team APPRUA_NETWORK=lan APPRUA_DOMAIN=apps.office.lan APPRUA_CERT=/root/cert.pem APPRUA_CERT_KEY=/root/key.pem bash install/install.sh
```

Internet, with your domain:

```bash
sudo APPRUA_PROFILE=team APPRUA_NETWORK=internet APPRUA_DOMAIN=apps.yourcompany.com bash install/install.sh
```

It takes **5 to 15 minutes**. At the end the installer prints the portal address and a **setup code** (for example `K7QM-2XPA-9TRB`). Copy it: it is needed once and stops anyone else from taking over a fresh Apprua. It is also in `/root/.apprua/apprua.env`.

The installer downloads Apprua ready to run (an image for each version): nothing is compiled on the server (only if that download fails, the installer builds Apprua from the code in the folder).

**Updating:** go to the folder that holds the `apprua` folder (the one where you ran the first command), download the latest version again with that command and run `sudo bash install/install.sh` again, with no options: your choices are saved, and so are apps and data. What is new in each version is in the [release notes](https://github.com/apprua/apprua/releases).

If you prefer to start from the code, use `git clone https://github.com/apprua/apprua`: then the installer builds Apprua on the server, and `git pull` updates it.

## 3. First-run setup

Open the portal and choose **For a group of people**. Then:

1. type the setup code;
2. create the administrator account;
3. set the **rules for the group**: how many apps each person can publish, and how often the owner confirms an app is still needed (6 months, 12 months or never). An app that is not confirmed is paused, not deleted.

You can change the rules any time in **Settings**.

## 4. Add people

In **Settings**, administration section, add each person with their email and a temporary password, and choose whether they are an administrator too. Then each person signs in, creates their personal key and connects their AI app ([Connect your AI app](connect.md)).

Administrators see every app of everyone, can change an app's owner, pause it, bring it back or delete it, take a person's key away, and give them a **new password** when they forgot it.

**Email (optional, recommended):** with a mail server set up (see [Configuration](../configuration.md#email-optional)) Apprua sends the review reminders and the "forgot your password" links, so people do not have to ask an administrator.

**Signing in with the company account (Microsoft, Google, Keycloak):** Apprua can trust a login proxy in front of the portal (for example oauth2-proxy). Set `AUTH_MODE=proxy`: the details are in [Configuration](../configuration.md#sign-in).

## 5. Security: what the installer already does

- **The engine's panel is closed to the network** (ports 8000, 6001 and 6002), even though Docker usually opens ports past the firewall. To open it from your PC use a tunnel: `ssh -L 8000:localhost:8000 user@server`, then `http://localhost:8000`. **Settings > The engine (for experts)** shows the command for the password.
- **A sign-in stands in front of every app**: without an account nothing opens, unless the owner chooses *Anyone, no sign-in*.
- **Every app stays in its own lane**: an app can answer visits and reach the internet, but it cannot connect directly to the other apps (only through their address, past the sign-in), nor to Apprua, the engine, its database or the server itself. A small service, `apprua-guard`, keeps this up to date as apps start and stop. Apps can still reach the office network, if they need it.
- **Publications are checked**: if a folder contains keys in the common formats (API keys, private keys) or `.env` files, Apprua refuses it and explains how to move those values into the app's secrets. It catches the usual mistakes; it cannot recognise a password written in the code.
- **Every action is logged** (who published what, who changed a secret, who paused an app).

## 6. Backups

From the `apprua` folder on the server:

| What you want | Command |
|---|---|
| A full copy now | `sudo bash install/backup.sh` |
| A copy every night (at 03:30, keeping the newest 7) | `sudo bash install/backup.sh --schedule` |
| Stop the nightly copies | `sudo bash install/backup.sh --unschedule` |
| Bring everything back, also on a new server | `sudo bash install/backup.sh --restore /var/backups/apprua/<file>.tar.gz` |

Copies go to `/var/backups/apprua/` and include the apps' secrets: only root can read them. During a copy the apps are off for about a minute. **Always keep a second copy on another machine**, for example with `scp` or your provider's backup tool, together with the `.sha256` file next to it: it is the copy's fingerprint, and a restore checks it (a copy changed while it was kept elsewhere is refused). Without that file the restore shows the fingerprint and asks you to compare it with the one printed when the copy was made (or set `APPRUA_RESTORE_SHA256`).

After a restore the engine starts on its own data and every app that was online is published again by itself from the code archive (one that does not start is tried again at the next starts, up to three times; then the portal shows it as needing a fix).

**If Coolify was there before Apprua** and also holds other projects, a copy holds only Apprua's part: its data, its settings and the data of the apps published with Apprua. The engine's database and the other projects are not in the copy and a restore leaves them alone; Docker keeps running and only Apprua and its apps stop. For the engine, use Coolify's own backups.

## 7. If the server's address changes

The names in the DNS point to the server's address: if it changes, they have to be fixed in the DNS. So better give the server a **fixed address** (a reservation in the router or DHCP). To change the name, run the installer again with the new `APPRUA_DOMAIN`: the apps move to the new addresses by themselves.

## 8. Remove Apprua from the server

From the `apprua` folder on the server:

```bash
sudo bash install/uninstall.sh
```

It offers a full copy first, then asks you to type `DELETE`. It removes Apprua, the engine and **all the apps with their data**, and what the installer set up on the server (its services, firewall rules and nightly copies). **Docker stays** (other programs may use it; the command to remove it is printed at the end) and so do the copies in `/var/backups/apprua/`: they contain secrets, so delete them when you no longer need them. To bring everything back one day: install Apprua again, then `sudo bash install/backup.sh --restore <copy>`.

All the advanced settings (app memory, limits, reminder emails) are in [Configuration](../configuration.md).

**Next:** [Connect your AI app](connect.md)
