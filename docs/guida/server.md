# Apprua su un server per il tuo gruppo

*[Torna alla guida](README.md) · [English](../guide/server.md)*

Questa strada è per chi gestisce l'informatica di un team, di uno studio o di un'azienda: Apprua su un server Linux, un account per ogni persona, regole semplici e, se serve, le app raggiungibili da internet con il vostro dominio.

## Cosa ti serve

| | |
|---|---|
| Server | Ubuntu o Debian, appena installato o quasi. Un server in ufficio, una macchina virtuale o un server in affitto |
| Risorse | almeno 2 CPU, 4 GB di memoria e 30 GB di disco. Ogni app accesa usa di solito da 512 MB a 1 GB |
| Accesso | `ssh` con un utente che può usare `sudo` |
| Per internet | un dominio (per esempio `app.tuaazienda.it`) con un record DNS `*.app.tuaazienda.it` che punta all'indirizzo del server, e le porte 80 e 443 aperte |

L'installazione mette da sola Docker, il motore e Apprua.

## 1. Scegli da dove si aprono le app

| Scelta | Portale | App | Quando |
|---|---|---|---|
| Rete locale | `http://apprua.app.ufficio.lan` | `http://<nome>.app.ufficio.lan` | Solo dall'ufficio. HTTPS se hai un certificato per `*.app.ufficio.lan` |
| Internet | `https://apprua.app.tuaazienda.it` | `https://<nome>.app.tuaazienda.it` | Anche da fuori, con HTTPS automatico (Let's Encrypt) o con il tuo certificato |

In tutti e due i casi i **nomi sono vostri**: chi gestisce il DNS crea `apprua.<nome>` e `*.<nome>` verso l'indirizzo del server (in rete locale nel DNS interno). Apprua non li crea e non usa servizi esterni per farli funzionare; dopo l'installazione, *Impostazioni > Da dove si aprono le app > Verifica* controlla che portino al server.

Chi apre un'app deve entrare con il suo account, a meno che il proprietario non la apra a tutti.

## 2. Installa

Collegati al server e scarica l'ultima versione:

```bash
curl -fsSL https://github.com/apprua/apprua/releases/latest/download/apprua.tar.gz | tar -xz && cd apprua
```

Poi **uno** di questi comandi.

Rete locale:

```bash
sudo APPRUA_PROFILE=team APPRUA_NETWORK=lan APPRUA_DOMAIN=app.ufficio.lan bash install/install.sh
```

Rete locale con HTTPS, con il vostro certificato per `*.app.ufficio.lan` (file PEM; rinnovarlo tocca a voi, le Impostazioni avvisano quando sta per scadere). Senza, gli accessi e le chiavi personali delle app AI passano in chiaro sulla rete dell'ufficio, e il portale lo dice:

```bash
sudo APPRUA_PROFILE=team APPRUA_NETWORK=lan APPRUA_DOMAIN=app.ufficio.lan APPRUA_CERT=/root/cert.pem APPRUA_CERT_KEY=/root/chiave.pem bash install/install.sh
```

Internet, con il vostro dominio:

```bash
sudo APPRUA_PROFILE=team APPRUA_NETWORK=internet APPRUA_DOMAIN=app.tuaazienda.it bash install/install.sh
```

Ci vogliono **da 5 a 15 minuti**. Alla fine l'installazione scrive l'indirizzo del portale e un **codice di configurazione** (per esempio `K7QM-2XPA-9TRB`). Copialo: serve una volta sola e impedisce che qualcun altro si prenda un Apprua appena installato. Lo trovi anche nel file `/root/.apprua/apprua.env`.

L'installazione scarica Apprua già pronto (un'immagine per ogni versione), senza compilare niente sul server.

**Aggiornare:** dalla cartella in cui avevi scaricato Apprua, riscarica l'ultima versione con il primo comando e rilancia `sudo bash install/install.sh`, senza opzioni: le scelte restano salvate, e anche app e dati. Le novità di ogni versione sono nelle [note di rilascio](https://github.com/apprua/apprua/releases).

Chi preferisce partire dal codice può usare `git clone https://github.com/apprua/apprua`: in quel caso l'installazione costruisce Apprua sul server, e per aggiornare basta `git pull`.

## 3. La prima configurazione

Apri il portale e scegli **Per un gruppo di persone**. Poi:

1. scrivi il codice di configurazione;
2. crea l'account amministratore;
3. decidi le **regole per il gruppo**: quante app può pubblicare ogni persona e ogni quanto il proprietario deve confermare che un'app serve ancora (6 mesi, 12 mesi o mai). Un'app non confermata viene messa in pausa, non cancellata.

Le regole si cambiano quando vuoi in **Impostazioni**.

## 4. Aggiungi le persone

In **Impostazioni**, sezione amministrazione, aggiungi ogni persona con la sua email e una password provvisoria, e scegli se è anche amministratore. Ognuno poi entra, crea la sua chiave personale e collega la sua app AI ([Collegare la tua app AI](collegare.md)).

Gli amministratori vedono tutte le app di tutti, possono cambiarne il proprietario, metterle in pausa, rimetterle online o cancellarle, togliere la chiave a una persona e darle una **nuova password** se l'ha dimenticata.

**Email (facoltativa, consigliata):** con un server di posta configurato (vedi [Configurazione](../configuration.md#email-optional)) Apprua manda i promemoria delle revisioni e i link "password dimenticata", così le persone non devono chiedere all'amministratore.

**Accesso con l'account aziendale (Microsoft, Google, Keycloak):** Apprua può fidarsi di un proxy di login davanti al portale (per esempio oauth2-proxy). Si imposta con `AUTH_MODE=proxy`: i dettagli sono in [Configurazione](../configuration.md#sign-in).

## 5. Sicurezza: cosa fa già l'installazione

- **Il pannello del motore è chiuso alla rete** (porte 8000, 6001 e 6002), anche se Docker di solito le apre scavalcando il firewall. Per aprirlo dal tuo PC usa un tunnel: `ssh -L 8000:localhost:8000 utente@server`, poi `http://localhost:8000`. In **Impostazioni > Il motore (per esperti)** trovi il comando per la password.
- **Il login sta davanti a ogni app**: senza account non si apre niente, a meno che il proprietario scelga *Tutti, senza accesso*.
- **Ogni app sta nella sua corsia**: un'app può rispondere alle visite e uscire su internet, ma non può collegarsi direttamente alle altre app (solo dal loro indirizzo, passando dal login), né ad Apprua, al motore, al suo database o al server stesso. Ci pensa un piccolo servizio, `apprua-guard`, che si aggiorna da solo quando le app si accendono e si spengono. Le app possono invece raggiungere la rete dell'ufficio, se ne hanno bisogno.
- **Le pubblicazioni vengono controllate**: se una cartella contiene password, chiavi o file `.env`, Apprua la rifiuta e spiega come spostare quei valori nei segreti dell'app.
- **Ogni azione resta nel registro** (chi ha pubblicato cosa, chi ha cambiato un segreto, chi ha messo in pausa).

## 6. Copie di sicurezza

Dalla cartella `apprua` sul server:

| Cosa vuoi fare | Comando |
|---|---|
| Una copia completa adesso | `sudo bash install/backup.sh` |
| Una copia ogni notte (alle 3:30, tiene le ultime 7) | `sudo bash install/backup.sh --schedule` |
| Smettere con le copie notturne | `sudo bash install/backup.sh --unschedule` |
| Rimettere tutto da una copia, anche su un server nuovo | `sudo bash install/backup.sh --restore /var/backups/apprua/<file>.tar.gz` |

Le copie sono in `/var/backups/apprua/` e contengono anche i segreti delle app: le può leggere solo root. Durante la copia le app restano spente circa un minuto. **Tieni sempre una seconda copia su un'altra macchina**, per esempio con `scp` o con lo strumento di backup del tuo fornitore, insieme al file `.sha256` che le sta accanto: è l'impronta della copia e il ripristino la controlla (una copia cambiata mentre era altrove viene rifiutata). Senza quel file il ripristino mostra l'impronta e chiede di confrontarla con quella stampata quando la copia è stata fatta (oppure imposta `APPRUA_RESTORE_SHA256`).

Dopo un ripristino il motore riparte con i suoi dati e ogni app che era online viene ripubblicata da sola dall'archivio del codice (se una non riparte, viene ritentata ai riavvii successivi, fino a tre volte; poi il portale la mostra da sistemare).

**Se Coolify c'era già prima di Apprua** e ospita anche altri progetti, la copia contiene solo la parte di Apprua: i suoi dati, le sue impostazioni e i dati delle app pubblicate con Apprua. Il database del motore e gli altri progetti non entrano nella copia e il ripristino non li tocca; Docker resta acceso e si fermano solo Apprua e le sue app. Per il motore usa i backup di Coolify stesso.

## 7. Se l'indirizzo del server cambia

I nomi nel DNS portano all'indirizzo del server: se cambia, vanno corretti nel DNS. Meglio quindi dare al server un **indirizzo fisso** (una prenotazione nel router o nel DHCP). Per cambiare nome, rilancia l'installazione con il nuovo `APPRUA_DOMAIN`: le app si spostano da sole agli indirizzi nuovi.

## 8. Togliere Apprua dal server

Dalla cartella `apprua` sul server:

```bash
sudo bash install/uninstall.sh
```

Prima propone una copia completa, poi chiede di scrivere `ELIMINA`. Toglie Apprua, il motore e **tutte le app con i loro dati**, e quello che l'installazione aveva messo sul server (i suoi servizi, le regole del firewall, le copie notturne). **Docker resta** (altri programmi potrebbero usarlo; alla fine compare il comando per toglierlo) e restano le copie in `/var/backups/apprua/`: contengono segreti, quindi cancellale quando non servono più. Per rimettere tutto un giorno: reinstalla Apprua, poi `sudo bash install/backup.sh --restore <copia>`.

Tutte le impostazioni avanzate (memoria delle app, limiti, email di promemoria) sono in [Configurazione](../configuration.md).

**Prossimo passo:** [Collegare la tua app AI](collegare.md)
