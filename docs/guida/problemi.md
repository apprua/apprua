# Problemi comuni

*[Torna alla guida](README.md) · [English](../guide/problems.md)*

Prima regola, che risolve più cose di quanto sembri: **rilancia l'installazione**. È fatta per essere rilanciata: aggiorna, ripara e tiene app e dati.

## Durante l'installazione (Windows)

| Messaggio | Cosa fare |
|---|---|
| *Windows 10 version 2004 (build 19041) or newer is needed* | Aggiorna Windows da *Impostazioni > Windows Update*, poi rilancia |
| *Virtualization is turned off in the BIOS/UEFI* | Va accesa la virtualizzazione (Intel VT-x o AMD-V) nel BIOS del PC. Se non sai come, chiedi a chi ti segue il PC: è una sola impostazione |
| *Only ... GB free on C:* | Libera spazio sul disco C: (servono almeno 15 GB) |
| *WSL is not installed* | Rilancia il comando da un terminale **come amministratore**, riavvia il PC, poi rilancialo normalmente |
| *Could not create the Linux 'Apprua'* | WSL è vecchio: in un terminale scrivi `wsl --update`, poi rilancia |
| *no internet connection or DNS* | Controlla la connessione. Nelle reti aziendali l'installazione sceglie da sola server DNS che funzionano; se si ferma lo stesso, chiedi a chi gestisce la rete se blocca i DNS esterni |
| Avviso su **un altro Docker** | Spegni Docker Desktop (o l'altro Linux con Docker) mentre usi Apprua. Vedi sotto, *Le app non rispondono più* |

## Il portale non si apre

- Guarda l'**icona vicino all'orologio**: se è grigia, Apprua non è in funzione (con il faro spento sta ancora partendo). Clicca con il tasto destro e scegli **Avvia Apprua**, poi aspetta un minuto.
- Se l'icona non c'è, apri **Apprua** dal menu Start: accende anche il Linux nascosto.
- Se ancora niente, rilancia l'installazione.

## Le app non rispondono più

Succede soprattutto se sul PC si è acceso **un altro Docker** (Docker Desktop o un altro Linux con Docker): i Linux di WSL condividono la rete e due Docker possono togliersela a vicenda. Spegni l'altro Docker e rilancia l'installazione di Apprua: ripara la rete da sola.

## Un'app è "da sistemare"

L'ultima pubblicazione non è andata a buon fine. Clicca **Apri il diario** per leggere cosa è successo, oppure chiedi direttamente alla tua AI:

> «Guarda il diario di questa app su Apprua e sistemala.»

L'AI legge il diario, ti propone una correzione e pubblica di nuovo.

## Un'app "non risponde"

Apprua controlla ogni 2 minuti che le app accese funzionino davvero. Se una si è bloccata, nel portale compare **Non risponde** e, se Apprua può mandare email, il proprietario riceve un messaggio. Clicca **Riavvia**. Se si ferma di nuovo, guarda **Cosa sta succedendo** dal menu dell'app, oppure chiedi alla tua AI:

> «Guarda cosa scrive questa app su Apprua e sistemala.»

## La pubblicazione viene rifiutata

| Motivo | Cosa fare |
|---|---|
| **Contiene segreti** | Nella cartella ci sono password, chiavi o file `.env`. Chiedi all'AI di toglierli dai file e di darli all'app come segreti |
| **Il nome non va bene** | Il nome diventa un indirizzo: da 3 a 31 caratteri, lettere minuscole, numeri e trattini, e deve iniziare con una lettera (`lista-spesa` va bene, `Lista Spesa` no) |
| **Non capisce come avviarla** | Serve un `index.html` (per un sito), un `package.json` o un `requirements.txt` (per un programma), oppure un `Dockerfile` |
| **È cambiata da un'altra parte** | L'app è stata aggiornata da un altro PC o da un'altra persona: chiedi all'AI di scaricare l'ultima versione, applicare le modifiche e riprovare |
| **Hai raggiunto il limite** | Nei gruppi ogni persona può avere un certo numero di app: archiviane una che non serve o chiedi all'amministratore |

## La tua app AI non vede Apprua

- **"npx non trovato"**: installa Node.js da [nodejs.org](https://nodejs.org) e riavvia l'app AI.
- **"Chiave non valida" o scaduta**: le chiavi durano 90 giorni. Nel portale crea una nuova chiave e ripeti il passo della tua app AI.
- **Dopo aver aggiunto il connettore**, chiudi e riapri del tutto l'app AI: molte leggono i connettori solo all'avvio.

## Gli altri PC della rete non aprono le app

- In Windows la rete deve essere **Privata**, non Pubblica (*Impostazioni > Rete e Internet*): su una rete pubblica la porta resta chiusa.
- Premi **Verifica** in *Impostazioni > Da dove si aprono le app*: dice se `apprua.<nome>` e `*.<nome>` portano a questo PC, e se il certificato va bene.
- Manca la riga **`*.<nome>`** nel DNS? Senza, il portale si apre ma le app no.
- L'**indirizzo del PC è cambiato**? I nomi nel DNS portano ancora al vecchio: chiedi un indirizzo fisso per il PC e correggi il DNS.
- Da un dispositivo sì e da un altro no? Probabilmente quel dispositivo usa un altro DNS (per esempio quello del telefono invece di quello dell'ufficio).
- Con un **certificato aziendale** il browser avvisa? Il dispositivo deve riconoscere l'autorità che l'ha emesso: di solito chi gestisce i PC dell'azienda lo ha già fatto.

## Apprua usa troppa memoria

Apprua usa al massimo la memoria che gli hai dato (di solito metà di quella del PC). Puoi:

- mettere in pausa le app che non usi: non occupano memoria;
- dargliene meno: `powershell -ExecutionPolicy Bypass -File install\windows\install-apprua.ps1 -SetMemoryGB 6`;
- fermarlo quando non serve: tasto destro sull'icona vicino all'orologio, **Arresta Apprua**.

## Hai dimenticato la password

Nella pagina di accesso clicca **Password dimenticata?**.

- **Se Apprua può mandare email** (sui server, se è stata configurata), scrivi la tua email: arriva un link valido un'ora per sceglierne una nuova. Anche la chiave personale smette di funzionare: dopo l'accesso creane una nuova e mettila nella tua app AI.
- **Altrimenti chiedi a un amministratore:** in **Impostazioni**, accanto alla tua email, c'è **Nuova password**. Apprua ne crea una e la mostra una volta sola all'amministratore, che te la comunica di persona o per telefono. Anche la chiave personale smette di funzionare: dopo l'accesso creane una nuova e mettila nella tua app AI.
- **Se l'amministratore sei tu**, lancia uno di questi comandi dalla cartella di Apprua. Scrive una nuova password: entra con quella, poi cambiala in **Il tuo account**.

Sul PC Windows:

```powershell
powershell -ExecutionPolicy Bypass -File install\windows\install-apprua.ps1 -ResetPassword
```

Sul server:

```bash
sudo bash install/reset-password.sh
```

Se ci sono più amministratori, i comandi chiedono di quale account si tratta: aggiungi `-Email tu@esempio.it` (Windows) oppure l'email in fondo (server).

## Non trovi la risposta

Apri una segnalazione su [GitHub](https://github.com/apprua/apprua/issues): scrivi cosa stavi facendo, cosa ti aspettavi e cosa è successo, e se puoi aggiungi l'ultima parte dei messaggi dell'installazione. **Togli sempre chiavi e password** prima di incollare qualcosa.
