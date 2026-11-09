# Privacy: cosa tiene Apprua

*[English](../guide/privacy.md)*

Questa pagina è per chi installa e gestisce Apprua per altre persone (un'azienda, una scuola, un gruppo). Dice cosa tiene Apprua delle persone che lo usano, dove, per quanto tempo, chi può vederlo e cosa esce dalla macchina, così puoi scrivere la tua informativa privacy e rispondere alle richieste delle persone.

**Chi ne risponde.** Apprua gira tutto sulla tua macchina. Il progetto Apprua non riceve niente dalla tua installazione: niente telemetria, niente account da noi, niente copie. Chi gestisce l'installazione decide perché e come si usano i dati, ed è il riferimento per le richieste delle persone (per il GDPR, di solito il titolare del trattamento). Questa pagina descrive il programma: non è una consulenza legale e da sola non rende un'installazione conforme.

## Cosa tiene Apprua

| Cosa | Contenuto | Dove |
|---|---|---|
| **Account** | Email, nome (se indicato), ruolo, un'impronta della password (scrypt: la password non viene mai tenuta), un'impronta della chiave personale con i primi caratteri e la scadenza, l'ultimo uso della chiave, la data di creazione | Il database di Apprua (`apprua.db`) |
| **Cronologia delle azioni** | Chi ha fatto cosa e quando: accessi, accessi falliti (con l'email scritta e l'indirizzo IP), pubblicazioni, modifiche ai segreti (il nome, mai il valore), cambi di proprietario, cambi di password, richieste "password dimenticata" per email sconosciute (con l'email e l'indirizzo IP) | Il database di Apprua (tabella `audit`) |
| **Pubblicazioni** | Per ogni pubblicazione: l'app, chi l'ha pubblicata, quando, l'esito e un breve estratto del log di costruzione | Il database di Apprua |
| **Link "password dimenticata"** | Un'impronta del link, l'email, la scadenza (un'ora) e quando è stato usato | Il database di Apprua |
| **Archivio del codice** | Ogni versione del codice di ogni app, con il nome e l'email di chi l'ha pubblicata (cronologia git) | La cartella dei dati di Apprua (`repos/`) |
| **Segreti delle app** | I valori che le app usano mentre girano (password, chiavi) | Il database del motore (Coolify). Apprua non li mostra mai più |
| **Dati delle app** | Quello che ogni app salva (il suo database, i file caricati). Apprua non ci guarda dentro | I volumi Docker di ogni app |
| **Registro delle richieste del portale** | Per ogni richiesta: metodo, indirizzo visitato (senza codici, chiavi e link che aprono qualcosa), host, indirizzo IP | L'output del container `apprua` |
| **Log del motore** | Log di costruzione e output delle app | Il motore (Coolify) |
| **Copie** | Tutto quello sopra, al momento della copia | `/var/backups/apprua` su un server; `%USERPROFILE%\Apprua-backups` su Windows |

**Cookie e memoria del browser.** Solo quello che serve per funzionare: il cookie di accesso al portale, un cookie di accesso per ogni app aperta (valido solo per quell'app) e la lingua scelta (`apprua_lang`). Il tema chiaro o scuro resta nel browser (`localStorage`). Niente tracciamento, niente statistiche, niente font o script da altri siti.

## Per quanto tempo

Apprua 1.0 non cancella niente da solo a scadenza:

| Cosa | Per quanto |
|---|---|
| Account | Finché non viene tolto (vedi "Quando qualcuno chiede"). Una chiave personale scade dopo 90 giorni |
| Cronologia delle azioni e pubblicazioni | Finché esiste l'installazione. Quando un account viene tolto, la sua email nella cronologia viene sostituita da un'etichetta casuale |
| Link "password dimenticata" | Valido un'ora; la riga resta finché l'account non viene tolto |
| Archivio del codice | Finché un amministratore non cancella l'app per sempre. Allora una copia del codice resta da parte in `repos/.deleted/`, per poter rimediare a un errore: va tolta a mano quando non serve più |
| Registro delle richieste del portale | Al massimo 5 file da 10 MB su un server installato o aggiornato con la versione 1.0.0 o successiva; riparte vuoto a ogni aggiornamento di Apprua |
| Copie | Le 7 copie notturne più recenti su un server (`APPRUA_BACKUP_KEEP`); su Windows, finché non le cancelli |

Se ti servono tempi più brevi (per esempio per la cronologia degli accessi falliti), decidili nelle tue regole e applicali; se un'impostazione ti aiuterebbe, diccelo in una issue.

## Chi vede cosa

- **Ogni persona** vede il suo account, le sue app e la cronologia delle loro versioni.
- **Gli amministratori di Apprua** gestiscono tutti gli account e tutte le app, possono leggere la cronologia delle azioni, dare un'app a un'altra persona e impostare una nuova password per un account. Possono aprire tutte le app.
- **Chi amministra la macchina** (root sul server, o l'account di Windows sul PC) può leggere tutto, anche il pannello del motore, i segreti delle app e le copie.

## Cosa esce dalla macchina

| Dove va | Cosa | Quando |
|---|---|---|
| **Il fornitore di ogni app AI** (Anthropic, OpenAI, Cursor, Microsoft e altri) | Quello che le persone scrivono in chat, e quello che l'app AI legge: il codice del progetto, le risposte di Apprua, i log delle app che chiede | Ogni volta che qualcuno lavora con un'app AI. Riguarda quella persona e il suo fornitore di AI, con le condizioni del fornitore |
| **Il tuo servizio email** (SMTP) | Indirizzo email, nome dell'app, il link "password dimenticata", i promemoria | Solo se l'email è configurata |
| **npm** (registry.npmjs.org) | Solo la domanda "c'è il connettore di questa versione?"; nessun dato delle persone | Una volta all'avvio di Apprua. Poi le app AI dei PC scaricano il connettore da npm |
| **Let's Encrypt** | I nomi degli indirizzi che hanno bisogno di un certificato | Solo su internet, con HTTPS automatico |
| **Siti di download** (Coolify, Docker, GitHub per WSL) | Niente sulle persone | Solo durante l'installazione o l'aggiornamento |

Il connettore manda la cartella del progetto dal PC al tuo Apprua, mai da altre parti.

## Quando qualcuno chiede

**Di vedere i suoi dati.** Un amministratore può leggere l'account (Impostazioni), le app e le loro versioni (il portale) e la cronologia delle azioni (`GET /v1/admin/audit` con una chiave da amministratore). Il codice di un'app si scarica dalla sua pagina.

**Di essere tolto.**

1. Dai ogni app di quella persona a qualcun altro (un amministratore lo chiede alla sua app AI, per esempio "dai l'app lista-spesa ad anna@example.com": usa lo strumento da amministratore `admin_change_owner`), oppure cancellala per sempre in Impostazioni.
2. Togli l'account. Su un server Linux:

   ```bash
   sudo bash install/remove-account.sh persona@example.com
   ```

   Su un PC Windows (in PowerShell):

   ```powershell
   wsl -d Apprua -u root -- docker exec apprua node dist/src/cli/admin.js forget persona@example.com
   ```

   L'account sparisce e la sua email nella cronologia di Apprua viene sostituita da un'etichetta casuale come `removed-1a2b3c4d`. Non è un anonimato completo: il resto della cronologia (per esempio gli indirizzi IP degli accessi falliti, le date, i nomi delle app) resta, e può ancora ricondurre alla persona; se serve, togli a mano quelle righe.

   Con gli account di Apprua (`AUTH_MODE=local`) la persona non può più entrare. Con un proxy di accesso davanti ad Apprua (`AUTH_MODE=proxy`, per esempio account Microsoft o Google) Apprua ricrea l'account la prossima volta che quella persona passa dal proxy: togli il suo accesso anche nel sistema di identità (il gruppo o la registrazione dell'app che la fa entrare).
3. Cosa il comando non può cambiare: la cronologia delle versioni dentro l'archivio del codice delle app che quella persona ha pubblicato (tiene il suo nome e la sua email; sparisce quando quelle app vengono cancellate per sempre, poi da `repos/.deleted/`), i dati che le app stesse hanno salvato su di lei, e le copie fatte prima (vengono sostituite nei giorni seguenti, oppure cancellale).

## Buone abitudini

- Tieni le copie dove possono leggerle solo le persone che gestiscono Apprua: contengono tutto.
- Usa HTTPS quando le persone usano Apprua in rete (vedi [Apprua su un server](server.md)).
- Ricorda a chi pubblica app che un'app che salva dati di altre persone (un modulo, un elenco di clienti) ha bisogno delle sue attenzioni: Apprua la tiene al sicuro sulla tua macchina, ma quello che l'app raccoglie è responsabilità di chi la gestisce.
