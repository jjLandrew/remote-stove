# Stufa

Sostituto completo dell'app del produttore per una stufa a pellet: PWA installabile su iPhone
+ un piccolo bridge che parla con la stufa, esegue il programma 24/7 e tiene il log eventi.
Nessun cloud di terzi, nessun account, nessuna dipendenza: solo Node.js.

```
iPhone (PWA installata)  ──HTTPS──▶  bridge (Raspberry Pi / NAS / PC)  ──▶  stufa
```

## Perché serve un bridge

Una PWA da sola non può controllare una stufa: iOS sospende le app in background e il browser
non può parlare con una scheda elettronica. Il bridge è la parte che resta sempre accesa,
esegue gli orari, registra gli eventi e media l'accesso al dispositivo. L'app è solo l'interfaccia.

## Funzioni

- Accensione/spegnimento, set point a passi di 0,5 °C, potenza 1–5, temperatura ambiente.
- **Programma settimanale eseguito dal bridge**: funziona anche con il telefono spento.
- **Log eventi e allarmi** (comandi, cambi di stato, allarmi riportati dalla stufa, errori).
- Andamento della temperatura delle ultime 24 ore.
- Aggiornamento in tempo reale via SSE, con riconnessione automatica.
- Autenticazione a token, dati persistenti su file, stato "non raggiungibile" quando la stufa non risponde.
- **Demo locale** dentro l'app: interfaccia usabile anche senza bridge.

## Avvio rapido

Serve Node.js 18 o successivo (usa `fetch` nativo). Nessun `npm install`.

```bash
cd stufa
PORT=8787 ADAPTER=simulator node server/server.js
```

Il bridge stampa dove ha salvato il token (`server/data/token.txt`). Apri l'app all'indirizzo
del bridge, ingranaggio → incolla indirizzo e token → **Collega**.

Con `ADAPTER=simulator` (default) non serve alcuna stufa: utile per provare l'interfaccia.

## Adattatori

L'adattatore è l'unico punto che conosce il dispositivo.

| Adattatore | Uso |
| --- | --- |
| `simulator` | demo, sviluppo, test |
| `http` | qualsiasi dispositivo con una API HTTP: firmware ESP, gateway, StufaSmart in locale |

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
Aggiungere un protocollo nuovo (per esempio un client diretto per una scheda specifica) significa
scrivere un altro adattatore con gli stessi quattro metodi: `getState`, `setPower`, `setTarget`, `setLevel`.

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

## Installazione su iPhone

1. Metti il bridge dietro HTTPS (reverse proxy Caddy/nginx, oppure Tailscale) — una PWA
   installabile richiede HTTPS.
2. Apri l'indirizzo in Safari → **Condividi** → **Aggiungi alla schermata Home**.
3. Inserisci indirizzo del bridge e token nelle impostazioni.

## Avvio automatico (systemd)

```ini
[Unit]
Description=Bridge stufa
After=network-online.target

[Service]
WorkingDirectory=/opt/stufa
Environment=PORT=8787
Environment=ADAPTER=http
ExecStart=/usr/bin/node server/server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

## Reti 2,4 GHz e 5 GHz

L'app e il bridge **funzionano su qualsiasi banda**: sono solo HTTP, quindi il telefono può stare
serenamente su 5 GHz. Il limite a 2,4 GHz riguarda solo il modulo Wi-Fi **dentro la stufa**: è
hardware, nessun software può cambiarlo (lo dichiara la stessa app del produttore).

| Pezzo | Banda |
| --- | --- |
| iPhone con la PWA | 5 GHz o 2,4 GHz, indifferente |
| Bridge (Raspberry Pi, NAS, PC) | Ethernet, 5 GHz o 2,4 GHz |
| Modulo Wi-Fi della stufa | **solo 2,4 GHz** |

L'unica condizione è che telefono e bridge si vedano: stessa rete IP, anche se su bande diverse.
Il bridge ascolta in dual-stack (IPv4 + IPv6) e all'avvio stampa tutti i suoi indirizzi, così sai
quale usare. Nell'app, in impostazioni, c'è la stessa lista: tocca un indirizzo per usarlo.

Casi tipici in cui "non si vede" e come risolverli:

- **Bande su sottoreti diverse**: molti router e mesh tengono 2,4 e 5 GHz su subnet separate o
  con isolamento client attivo. Metti il bridge sulla stessa subnet della stufa (cavo Ethernet,
  o la rete 2,4 GHz) e lascia il telefono su 5 GHz: se il routing tra le due è consentito funziona,
  altrimenti serve togliere l'isolamento o usare un'unica rete.
- **Rete solo IPv6**: funziona, perché il bridge accetta anche IPv6. In alternativa usa un
  indirizzo IPv6 nella lista invece dell'IPv4.
- **Isolamento client / AP isolation** attivo sulla 5 GHz: il telefono non raggiunge nessun altro
  dispositivo della rete, quindi nemmeno il bridge.
- **SSID diversi per banda**: nessun problema, l'importante è che la rete risultante sia la stessa.

## Sicurezza

- Il token è generato al primo avvio in `server/data/token.txt` (permessi 600). Ruotalo
  cancellando il file e riavviando.
- Non esporre il bridge su internet senza HTTPS. Meglio VPN (Tailscale/WireGuard) o rete locale.
- `DEV_NO_AUTH=1` disattiva l'autenticazione ed è accettato **solo** con `ADAPTER=simulator`:
  usato per l'anteprima, mai con una stufa vera.
- I dati (`state`, `schedule`, `events`, `history`, `token`) stanno in `server/data/`, escluso da git.

## Stato e limiti

Verificato con il simulatore e con un dispositivo HTTP finto: autenticazione, comandi,
programma eseguito dal bridge, persistenza, adattatore HTTP, PWA servita dal bridge.
**Mai provato su una stufa reale.** Per le schede Brahma (app Magic Stove) non esiste un
protocollo pubblico documentato: l'adattatore `http` è il punto in cui innestare il
protocollo una volta noto, senza toccare app né interfaccia.

## File

| File | Ruolo |
| --- | --- |
| `index.html`, `style.css`, `app.js` | PWA: dashboard, programma, eventi, grafico |
| `sw.js`, `manifest.webmanifest`, `icons/` | installazione e cache offline |
| `server/server.js` | bridge: API, scheduler, store, adattatori |
| `server/adapter.example.json` | esempio di mappatura HTTP |
