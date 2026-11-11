# Stufa

Sostituto completo dell'app del produttore per una stufa a pellet: PWA installabile su iPhone
+ un piccolo bridge che parla con la stufa, esegue il programma 24/7 e tiene il log eventi.
Nessun cloud di terzi, nessun account, nessuna dipendenza: solo Node.js.

```
iPhone (PWA installata)  ──HTTPS──▶  bridge (server Ubuntu sempre acceso)  ──FTP──▶  cloud Brahma  ◀──  stufa
```

## Perché serve un bridge

Una PWA da sola non può controllare una stufa: iOS sospende le app in background e il browser
non può parlare con una scheda elettronica. Il bridge è la parte che resta sempre accesa,
esegue gli orari, registra gli eventi e media l'accesso al dispositivo. L'app è solo l'interfaccia.

## Funzioni

- Accensione/spegnimento, set point, potenza 1–5, temperatura ambiente.
- **Programma settimanale eseguito dal bridge**: funziona anche con il telefono spento.
- **Log eventi e allarmi** (comandi, cambi di stato, errori).
- Andamento della temperatura delle ultime 24 ore.
- Aggiornamento in tempo reale via SSE, con riconnessione automatica.
- Autenticazione a token, dati persistenti su file, stato "non raggiungibile" quando la stufa non risponde.
- **Demo locale** dentro l'app: interfaccia usabile anche senza bridge.

## Avvio rapido

Serve Node.js 18 o successivo (usa `fetch` nativo). Nessun `npm install`.

```bash
cd stufa
PORT=8787 ADAPTER=simulator node server/server.js     # demo, nessuna stufa
PORT=8787 ADAPTER=brahma    node server/server.js     # stufa vera (server/data/brahma.json)
```

Il bridge stampa gli indirizzi su cui ascolta e dove ha salvato il token (`server/data/token.txt`).
Apri l'app all'indirizzo del bridge, ingranaggio → incolla indirizzo e token → **Collega**.

## Adattatori

L'adattatore è l'unico punto che conosce il dispositivo.

| Adattatore | Uso |
| --- | --- |
| `simulator` | demo, sviluppo, test |
| `http` | qualsiasi dispositivo con una API HTTP: firmware ESP, gateway, altri marchi |
| `brahma` | stufe Brahma con scheda BTouch (app Magic Stove), via cloud FTP |

Configurazione dell'adattatore HTTP in `server/data/adapter.json`
(parti da `server/adapter.example.json`):

```json
{
  "state": { "url": "http://192.168.1.50/api/stato", "method": "GET" },
  "map": { "on": "acceso", "target": "setpoint", "room": "temperatura",
           "level": "potenza", "alarm": "allarme" },
  "commands": {
    "on":     { "url": "http://192.168.1.50/api/accendi", "method": "POST" },
    "off":    { "url": "http://192.168.1.50/api/spegni",  "method": "POST" },
    "target": { "url": "http://192.168.1.50/api/setpoint", "body": "{\"valore\": {{value}}}" },
    "level":  { "url": "http://192.168.1.50/api/potenza",  "body": "{\"valore\": {{value}}}" }
  }
}
```

`map` usa percorsi puntati nel JSON di stato; `{{value}}` viene sostituito dal valore del comando.
Aggiungere un protocollo nuovo significa scrivere un altro adattatore con gli stessi quattro
metodi: `getState`, `setPower`, `setTarget`, `setLevel`.

### Adattatore `brahma` (schede BTouch, app Magic Stove)

Il cloud Brahma non espone una API: l'app del produttore scrive e legge file su un FTP, in una
cartella per dispositivo, e la stufa fa lo stesso da sola. `brahma` replica quel comportamento,
senza app e senza account.

```json
{
  "host": "ftp16.cloud.brahma.it",
  "user": "UTENTE_FTP",
  "pass": "PASSWORD_FTP",
  "mac": "0123456789ab",
  "dir": "/WebServer/BTouchPellet/0001/"
}
```

Configurazione in `server/data/brahma.json` (parti da `server/brahma.example.json`, il file vero è
escluso da git). La cartella del dispositivo è `dir` + MAC della stufa senza separatori, in minuscolo.
Le credenziali FTP sono le stesse per tutti i dispositivi e sono in chiaro dentro l'app del
produttore: non sono un segreto vostro, ma restano fuori dal repository.

#### `realtime.txt` — lo scrive la stufa, 235 byte

Campi separati da `;`. Posizioni verificate leggendo il codice dell'app (classe `MainActivity`,
metodo che scarica il file: `substring(19,20)`, `substring(21,22)`, …):

| Campo | Byte | Esempio | Significato |
| --- | --- | --- | --- |
| MAC | 0–11 | `000000000000` | chi ha scritto il file: `000000000000` la stufa, `FFFFFFFFFFFF` il cloud |
| ora | 13–17 | `07:33` | HH:MM **in esadecimale** |
| giorno | 19 | `3` | 0 = lunedì … 6 = domenica |
| potenza | 21 | `1` | 1–5 |
| set point | 23–24 | `23` | °C **in esadecimale** (`23` = 35 °C) |
| temperatura | 26–27 | `1D` | temperatura ambiente in esadecimale (`1D` = 29 °C) |
| fase | 29–30 | `05` | fase di lavoro della scheda (codici non documentati) |
| modo | 32 | `0` | 0 = manuale, 1 = automatico |
| acceso | 34 | `1` | 1 = accesa, 0 = spenta |
| scheda | 39 | `O` | lettera del modello di scheda |
| crono | 41–82 | | programma settimanale della stufa (42 caratteri) |
| parametri | 84–… | | parametri della scheda |

Il file viene aggiornato dalla stufa quando è online: se la stufa è spenta dalla presa o senza
Wi-Fi, quello che si legge è l'ultimo stato noto (la data di modifica si vede con `MDTM`/`LIST`).

#### `config.txt` — lo scrive l'app, 224 byte

Stesse posizioni per i primi campi (`MAC;HH:MM;giorno;potenza;setpoint;modo;acceso;…`), poi crono
a 30–71 e parametri della scheda da 73 a 222. I `;` devono stare a 12, 18, 20, 22, 25, 27, 29, 72,
223: l'app rifiuta il file se non tornano, e lo rifiuta anche il bridge.

Il bridge **non riscrive** il file da zero: lo riscarica, cambia solo il campo del comando
(`potenza`, `setpoint`, `acceso`), verifica le posizioni dei `;` e solo allora lo ricarica. Crono
settimanale e parametri della scheda restano quelli della stufa.

- Il set point viaggia a **gradi interi in esadecimale** (5–35 °C): i mezzi gradi dell'app
  vengono arrotondati.
- Accensione/spegnimento = il campo "acceso" (`1`/`0`), lo stesso che l'app scrive dallo Switch
  "Stato" della schermata *Altro*.
- Quando la stufa prende il file, ne salva una copia in `confbk.txt`: è la conferma che il
  comando è arrivato (osservato ~1 minuto dopo la scrittura).

Nella cartella ci sono anche `log.txt` (registro della stufa: `MAC;ora;tipo;codice`), `devices.txt`
e `info.txt` (contiene la password della stufa: non va mai copiato nel repository).

#### Cosa è stato verificato su una stufa vera (PG315C, scheda BTouch)

- Lettura: stato, potenza, set point, temperatura e modo, confrontati con `realtime.txt`.
- **Accensione/spegnimento: verificato sul campo l'11/11/2026** — scritto `0` nel campo "acceso"
  la stufa si è spenta, scritto `1` si riaccende. Quindi `1` = accesa, `0` = spenta, esattamente
  come lo Switch "Stato" della schermata *Altro* dell'app.
- La stufa prende il file entro circa un minuto (lo copia in `confbk.txt`) e poi esegue: la
  reazione non è istantanea perché la scheda attraversa le sue fasi (accensione, regime, cooling),
  che `realtime.txt` riporta nel campo "fase".
- Crono settimanale e parametri della scheda non vengono toccati da nessun comando.

Punti ancora aperti, da verificare guardando la stufa e l'app del produttore:

- se il campo "temperatura" di `realtime.txt` è l'ambiente o i fumi;
- i codici delle fasi (accensione, regime, *cooling*) e degli allarmi: l'adattatore non li inventa,
  `alarm` resta `null` e lo stato riporta solo accesa/spenta.

## Installazione su iPhone

Una PWA installabile richiede **HTTPS**: l'indirizzo `http://192.168.x.x:8787` funziona nel
browser ma iOS non offre "Aggiungi alla schermata Home" e la modalità a schermo intero non parte.
Due modi che funzionano davvero, senza aprire porte sul router.

### A. Tailscale (consigliato: certificato valido, nessuna porta aperta)

1. Sul server Ubuntu:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. Nella console di amministrazione Tailscale abilita **MagicDNS** e **HTTPS certificates**
   (DNS → HTTPS Certificates → Enable).
3. Sempre sul server, pubblica il bridge sulla rete privata:
   ```bash
   sudo tailscale serve --bg 8787
   ```
   Il comando stampa l'indirizzo da usare, del tipo
   `https://<nome-macchina>.<vostra-tailnet>.ts.net`.
4. Sull'iPhone installa **Tailscale** dall'App Store e accedi con lo stesso account.
5. Apri quell'indirizzo **in Safari** (Chrome su iOS non installa le PWA).
6. Tocca **Condividi** → **Aggiungi alla schermata Home** → **Aggiungi**.
7. Apri l'icona "Stufa": parte a schermo intero, senza barra di Safari.
   Ingranaggio → indirizzo (`https://<nome-macchina>.<tailnet>.ts.net`, senza `/` finale) e token
   letto sul server con `cat /opt/stufa/stufa/server/data/token.txt` → **Collega**.
   In alto deve comparire `Collegato · brahma`.

### B. Dominio + reverse proxy (Caddy)

Se preferite un dominio pubblico, Caddy prende il certificato da solo:

```
stufa.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Poi gli stessi passi 5–7 qui sopra con `https://stufa.example.com`.

### Note iOS

- Il programma settimanale lo esegue il **bridge**, non il telefono: la PWA può restare chiusa.
- Il token è salvato in locale sul telefono: reinstallando l'app va reinserito.
- Per aggiornare l'interfaccia basta riaprire l'app (il service worker scarica la nuova versione);
  se resta quella vecchia, chiudila dallo switcher e riaprila.
- Se compare "Serve il token", il token nel telefono non combacia: riapri le impostazioni e
  incollalo di nuovo (è cambiato se avete cancellato `server/data/token.txt`).

## Il bridge sul server Ubuntu (cosa gira, dove)

Un solo processo Node, nessun database, nessun servizio esterno.

| Percorso | Contenuto |
| --- | --- |
| `/opt/stufa` | clone del repository (`git pull` per aggiornare) |
| `/opt/stufa/stufa/server/server.js` | il bridge: HTTP + SSE, scheduler, store, adattatori |
| `/opt/stufa/stufa/index.html`, `app.js`, `style.css`, `sw.js`, `manifest.webmanifest`, `icons/` | la PWA, servita dallo stesso processo |
| `/opt/stufa/stufa/server/data/brahma.json` | credenziali FTP + MAC della stufa (600, fuori da git) |
| `/opt/stufa/stufa/server/data/token.txt` | token di accesso, generato al primo avvio (600) |
| `/opt/stufa/stufa/server/data/state.json`, `schedule.json`, `events.json`, `history.json` | dati persistenti (fuori da git) |

Cosa fa, in continuo: legge lo stato dalla stufa (`realtime.txt`), esegue il programma settimanale,
registra gli eventi, tiene lo storico temperature e serve la PWA/le API su `0.0.0.0:8787`
(IPv4 + IPv6). Consumo trascurabile: una connessione FTP ogni pochi secondi, nessuna CPU.

### Installazione

```bash
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs                      # Node 18+ (qui 20 LTS)
sudo git clone https://github.com/jjLandrew/remote-stove.git /opt/stufa
sudo mkdir -p /opt/stufa/stufa/server/data
sudo nano /opt/stufa/stufa/server/data/brahma.json   # copia da server/brahma.example.json
sudo chmod 600 /opt/stufa/stufa/server/data/brahma.json
```

Prova a mano prima di metterlo in servizio:

```bash
cd /opt/stufa/stufa
ADAPTER=brahma PORT=8787 node server/server.js
curl -s http://127.0.0.1:8787/api/health
```

### Servizio systemd

`/etc/systemd/system/stufa-bridge.service` (sostituite `UTENTE` con chi possiede `/opt/stufa`,
ad esempio l'utente con cui avete fatto il clone):

```ini
[Unit]
Description=Bridge stufa (PWA + adattatore brahma)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=UTENTE
WorkingDirectory=/opt/stufa/stufa
Environment=PORT=8787
Environment=ADAPTER=brahma
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now stufa-bridge
systemctl status stufa-bridge            # deve dire active (running)
journalctl -u stufa-bridge -f            # log in diretta
```

### Manutenzione

```bash
cd /opt/stufa && sudo git pull && sudo systemctl restart stufa-bridge   # aggiornare
sudo systemctl restart stufa-bridge                                     # riavviare
sudo cp -a /opt/stufa/stufa/server/data /var/backups/stufa-$(date +%F)  # backup dati
sudo rm /opt/stufa/stufa/server/data/token.txt && sudo systemctl restart stufa-bridge  # nuovo token
```

Il bridge non apre porte verso l'esterno: lascia attivo solo SSH e Tailscale. Se non usate
Tailscale, mettete il reverse proxy HTTPS davanti e **non** esponete la 8787 su internet.

## API del bridge

Tutte le rotte `/api/*` richiedono `Authorization: Bearer <token>` (o `?token=` per lo stream).
`GET /api/health` è libera.

| Metodo | Rotta | Descrizione |
| --- | --- | --- |
| GET | `/api/state` | stato, programma, eventi, storico |
| GET | `/api/stream` | stream SSE con stato ed eventi |
| POST | `/api/command` | `{"action":"on\|off\|target\|level","value":…}` |
| PUT | `/api/schedule` | `{"enabled":true,"days":{…}}` |
| GET | `/api/events` | log completo (ultimi 300) |

## Reti 2,4 GHz e 5 GHz

L'app e il bridge **funzionano su qualsiasi banda**: sono solo HTTP, quindi il telefono può stare
serenamente su 5 GHz. Il limite a 2,4 GHz riguarda solo il modulo Wi-Fi **dentro la stufa**: è
hardware, nessun software può cambiarlo (lo dichiara la stessa app del produttore).

| Pezzo | Banda |
| --- | --- |
| iPhone con la PWA | 5 GHz o 2,4 GHz, indifferente |
| Bridge (server Ubuntu) | Ethernet, 5 GHz o 2,4 GHz |
| Modulo Wi-Fi della stufa | **solo 2,4 GHz** |

Con l'adattatore `brahma` la stufa non deve nemmeno essere raggiungibile dal bridge: passano
entrambi dal cloud del produttore, quindi il bridge può stare ovunque abbia internet.

## Sicurezza

- Il token è generato al primo avvio in `server/data/token.txt` (permessi 600). Ruotalo
  cancellando il file e riavviando.
- Non esporre il bridge su internet senza HTTPS. Meglio VPN (Tailscale/WireGuard) o rete locale.
- `DEV_NO_AUTH=1` disattiva l'autenticazione ed è accettato **solo** con `ADAPTER=simulator`:
  usato per l'anteprima, mai con una stufa vera.
- I dati (`state`, `schedule`, `events`, `history`, `token`, `brahma.json`) stanno in `server/data/`,
  escluso da git. Nessuna credenziale nel codice o nei file versionati.

## Stato e limiti

Verificato con il simulatore: autenticazione, comandi, programma eseguito dal bridge, persistenza,
adattatore HTTP, PWA servita dal bridge.Verificato su una stufa reale (Brahma PG315C / BTouch): lettura dello stato via cloud FTP,
accensione e spegnimento, scrittura di `config.txt` senza alterare crono e parametri.
Non ancora verificato: se il campo "temperatura" è l'ambiente o i fumi, e i codici di
fase/allarme (vedi sopra).

## File

| File | Ruolo |
| --- | --- |
| `index.html`, `style.css`, `app.js` | PWA: dashboard, programma, eventi, grafico |
| `sw.js`, `manifest.webmanifest`, `icons/` | installazione e cache offline |
| `server/server.js` | bridge: API, scheduler, store, adattatori |
| `server/adapter.example.json` | esempio di mappatura HTTP |
| `server/brahma.example.json` | esempio di configurazione per l'adattatore `brahma` |
