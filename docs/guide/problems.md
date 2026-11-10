# Common problems

*[Back to the guide](README.md) · [Italiano](../guida/problemi.md)*

First rule, and it fixes more than you would think: **run the installer again**. It is made to be run again: it updates, repairs and keeps apps and data.

## During the installation (Windows)

| Message | What to do |
|---|---|
| *Windows 10 version 2004 (build 19041) or newer is needed* | Update Windows from *Settings > Windows Update*, then run it again |
| *Virtualization is turned off in the BIOS/UEFI* | Virtualization (Intel VT-x or AMD-V) has to be turned on in the PC's BIOS. If you do not know how, ask whoever looks after your PC: it is one setting |
| *Only ... GB free on C:* | Free some space on C: (at least 15 GB are needed) |
| *WSL is not installed* | Run the command from a terminal **as administrator**, restart the PC, then run it again normally |
| *Could not create the Linux 'Apprua'* | WSL is old: in a terminal type `wsl --update`, then run it again |
| *no internet connection or DNS* | Check the connection. On company networks the installer picks working DNS servers by itself; if it stops anyway, ask whoever runs the network whether it blocks outside DNS |
| Warning about **another Docker** | Turn Docker Desktop (or the other Linux with Docker) off while you use Apprua. See *The apps stopped answering* below |

## The portal does not open

- Look at the **icon next to the clock**: if it is grey, Apprua is stopped (with the lighthouse dark it is still starting). Right-click it and choose **Start Apprua**, then wait a minute.
- If the icon is not there, open **Apprua** from the Start menu: it also turns on the hidden Linux.
- If still nothing, run the installer again.

## The apps stopped answering

It happens mostly when **another Docker** started on the PC (Docker Desktop or another Linux with Docker): the Linux of WSL share one network, and two Docker engines can take it from each other. Turn the other Docker off and run the Apprua installer again: it repairs the network by itself.

## An app "needs a fix"

The last publication did not go through. Click **Open the diary** to read what happened, or just ask your AI:

> "Look at the diary of this app on Apprua and fix it."

The AI reads the diary, suggests a fix and publishes again.

## An app is "not answering"

Every 2 minutes Apprua checks that the apps that are on really run. If one crashed, the portal shows **Not answering** and, if Apprua can send emails, its owner gets a message. Click **Restart**. If it stops again, open **What's happening** from the app menu, or ask your AI:

> "Look at what this app writes on Apprua and fix it."

## The publication is refused

| Reason | What to do |
|---|---|
| **It contains secrets** | The folder has passwords, keys or `.env` files. Ask the AI to take them out of the files and give them to the app as secrets |
| **The name is not valid** | The name becomes an address: 3 to 31 characters, lowercase letters, digits and dashes, starting with a letter (`shopping-list` is fine, `Shopping List` is not) |
| **It cannot tell how to run it** | It needs an `index.html` (for a website), a `package.json` or a `requirements.txt` (for a program), or a `Dockerfile` |
| **It changed somewhere else** | The app was updated from another PC or by another person: ask the AI to download the latest version, apply the changes and try again |
| **You reached the limit** | In groups each person can have a set number of apps: archive one you no longer need, or ask the administrator |

## Your AI app does not see Apprua

- **"npx not found"**: install Node.js from [nodejs.org](https://nodejs.org) and restart the AI app.
- **"Invalid key" or expired**: keys last 90 days. Create a new key in the portal and repeat the step for your AI app.
- **After adding the connector**, close the AI app completely and open it again: many read their connectors only at start.

## Other PCs on the network cannot open the apps

- In Windows the network must be **Private**, not Public (*Settings > Network & internet*): on a public network the port stays closed.
- Press **Check** in *Settings > Where the apps open*: it tells whether `apprua.<name>` and `*.<name>` lead to this PC, and whether the certificate is right.
- Is the **`*.<name>`** line missing from the DNS? Without it the portal opens but the apps do not.
- Did the **PC's address change**? The names in the DNS still lead to the old one: ask for a fixed address for the PC and fix the DNS.
- Works from one device and not from another? That device probably uses another DNS (for example the phone's instead of the office's).
- Browsers warn with a **company certificate**? The device must know the authority that issued it: usually whoever runs the company PCs has already done it.

## Apprua uses too much memory

Apprua uses at most the memory you gave it (usually half of the PC's). You can:

- pause the apps you do not use: they take no memory;
- give it less: `powershell -ExecutionPolicy Bypass -File install\windows\install-apprua.ps1 -SetMemoryGB 6`;
- stop it when you do not need it: right-click the icon next to the clock, **Stop Apprua**.

## You forgot your password

On the sign-in page, click **Forgot your password?**.

- **If Apprua can send emails** (on servers, when it has been set up), type your email: a link valid for one hour arrives to choose a new one. Your personal key stops working too: after signing in, create a new one and put it in your AI app.
- **Otherwise ask an administrator:** in **Settings**, next to your email, there is **New password**. Apprua makes one up and shows it once to the administrator, who tells it to you in person or on the phone. Your personal key stops working too: after signing in, create a new one and put it in your AI app.
- **If you are the administrator**, run one of these commands from the Apprua folder. It writes a new password: sign in with it, then change it in **Your account**.

On a Windows PC:

```powershell
powershell -ExecutionPolicy Bypass -File install\windows\install-apprua.ps1 -ResetPassword
```

On a server:

```bash
sudo bash install/reset-password.sh
```

With more than one administrator, the commands ask which account: add `-Email you@example.com` (Windows) or the email at the end (server).

## Still stuck

Open an issue on [GitHub](https://github.com/apprua/apprua/issues): write what you were doing, what you expected and what happened, and if you can, add the last part of the installer's messages. **Always remove keys and passwords** before pasting anything.
