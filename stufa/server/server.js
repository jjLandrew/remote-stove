'use strict';

/*
 * Bridge locale per stufe a pellet.
 * - espone una REST API + stream SSE usata dalla PWA
 * - esegue il programma settimanale 24/7, anche a telefono spento
 * - parla con la stufa tramite un adattatore sostituibile
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 8787);
// '::' significa dual-stack: risponde sia in IPv4 sia in IPv6 (reti moderne, 5 GHz,
// mesh che assegnano solo IPv6). Se IPv6 non c'è si ripiega su IPv4.
let HOST = process.env.HOST || '::';
const ADAPTER_NAME = (process.env.ADAPTER || 'simulator').toLowerCase();
const DEV_NO_AUTH = process.env.DEV_NO_AUTH === '1';

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Persistenza                                                         */
/* ------------------------------------------------------------------ */

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(name, value) {
  const tmp = path.join(DATA_DIR, name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, path.join(DATA_DIR, name));
}

/* ------------------------------------------------------------------ */
/* Token                                                               */
/* ------------------------------------------------------------------ */

let TOKEN = String(process.env.TOKEN || '').trim();
const tokenFile = path.join(DATA_DIR, 'token.txt');
if (!TOKEN) {
  if (fs.existsSync(tokenFile)) {
    TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
  } else {
    TOKEN = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  }
}

if (DEV_NO_AUTH && ADAPTER_NAME !== 'simulator') {
  console.error('DEV_NO_AUTH=1 è permesso solo con ADAPTER=simulator: nessuna autenticazione su una stufa vera.');
  process.exit(1);
}

function authorized(req, urlObj) {
  if (DEV_NO_AUTH) return true;
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const supplied = bearer || urlObj.searchParams.get('token') || '';
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Stato                                                               */
/* ------------------------------------------------------------------ */

const state = {
  on: false,
  target: 21,
  level: 2,
  room: null,
  alarm: null,
  reachable: true,
  stale: false,
  updatedAt: null,
};

const weekdaySlots = () => [
  { s: '06:00', e: '08:30', t: 21 },
  { s: '17:00', e: '22:30', t: 21.5 },
];

const defaultSchedule = () => ({
  enabled: false,
  days: {
    mon: weekdaySlots(), tue: weekdaySlots(), wed: weekdaySlots(),
    thu: weekdaySlots(), fri: weekdaySlots(),
    sat: [{ s: '08:00', e: '23:00', t: 21.5 }],
    sun: [{ s: '08:00', e: '22:00', t: 21.5 }],
  },
});

let schedule = readJson('schedule.json', defaultSchedule());
let events = readJson('events.json', []);
let history = readJson('history.json', []);
const saved = readJson('state.json', { on: false, target: 21, level: 2 });
state.on = !!saved.on;
state.target = Number(saved.target) || 21;
state.level = Number(saved.level) || 2;

function log(kind, text) {
  const entry = { t: Date.now(), kind, text };
  events.push(entry);
  if (events.length > 300) events = events.slice(-300);
  writeJson('events.json', events);
  broadcast({ type: 'event', event: entry });
}

/* ------------------------------------------------------------------ */
/* Adattatori                                                          */
/* ------------------------------------------------------------------ */

function getPath(obj, dotted) {
  return String(dotted || '')
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function truthy(value, onValues) {
  const list = onValues || ['on', 'heat', 'true', '1', 1, true, 'ON', 'acceso'];
  return list.some((v) => String(v).toLowerCase() === String(value).toLowerCase());
}

function httpAdapter(config) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, config.headers || {});
  const timeout = Number(config.timeoutMs) || 5000;

  async function request(entry, value) {
    if (!entry || !entry.url) throw new Error('endpoint non configurato');
    const url = String(entry.url).replace(/\{\{value\}\}/g, encodeURIComponent(value == null ? '' : value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: entry.method || 'POST',
        headers,
        body: entry.body ? String(entry.body).replace(/\{\{value\}\}/g, String(value == null ? '' : value)) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' da ' + url);
      const type = res.headers.get('content-type') || '';
      return type.includes('json') ? res.json() : res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  const map = config.map || {};

  return {
    name: 'http',
    describe() {
      return 'HTTP · ' + (config.state && config.state.url ? config.state.url : 'stato non configurato');
    },
    async probe() {
      if (!config.state || !config.state.url) return { ok: false, error: 'sorgente di stato non configurata' };
      const started = Date.now();
      try {
        await request(config.state);
        return { ok: true, latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, error: err.message || 'non raggiungibile', latencyMs: Date.now() - started };
      }
    },
    async getState() {
      if (!config.state || !config.state.url) throw new Error('sorgente di stato non configurata');
      const raw = await request(config.state);
      const alarm = map.alarm ? getPath(raw, map.alarm) : null;
      return {
        on: map.on ? truthy(getPath(raw, map.on), map.onValues) : state.on,
        target: map.target ? Number(getPath(raw, map.target)) : state.target,
        level: map.level ? Number(getPath(raw, map.level)) : state.level,
        room: map.room ? Number(getPath(raw, map.room)) : state.room,
        alarm: alarm ? String(alarm) : null,
        reachable: true,
        stale: false,
      };
    },
    async setPower(on) {
      await request(on ? config.commands.on : config.commands.off);
    },
    async setTarget(value) {
      await request(config.commands.target, value);
    },
    async setLevel(value) {
      await request(config.commands.level, value);
    },
  };
}

function simulatorAdapter() {
  const sim = {
    on: state.on,
    target: state.target,
    level: state.level,
    room: typeof state.room === 'number' ? state.room : 19.4,
  };
  let last = Date.now();

  return {
    name: 'simulator',
    describe() {
      return 'Simulatore (nessuna stufa collegata)';
    },
    async probe() {
      return { ok: true, latencyMs: 0, simulated: true };
    },
    async getState() {
      const now = Date.now();
      const dt = Math.min(60, (now - last) / 1000);
      last = now;
      const goal = sim.on ? sim.target : 16;
      sim.room += (goal - sim.room) * Math.min(0.6, dt * 0.0025);
      sim.room = Math.max(8, Math.min(32, sim.room));
      return {
        on: sim.on,
        target: sim.target,
        level: sim.level,
        room: Math.round(sim.room * 10) / 10,
        alarm: null,
        reachable: true,
        stale: false,
      };
    },
    async setPower(on) {
      sim.on = !!on;
    },
    async setTarget(value) {
      sim.target = value;
    },
    async setLevel(value) {
      sim.level = value;
    },
  };
}

let adapter;
if (ADAPTER_NAME === 'http') {
  adapter = httpAdapter(readJson('adapter.json', {}));
} else {
  adapter = simulatorAdapter();
}

/* ------------------------------------------------------------------ */
/* Programma settimanale                                               */
/* ------------------------------------------------------------------ */

const JS_TO_KEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function minutesOf(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function activeSlot(now) {
  const slots = (schedule.days || {})[JS_TO_KEY[now.getDay()]] || [];
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const slot of slots) {
    const s = minutesOf(slot.s);
    const e = minutesOf(slot.e);
    if (s === null || e === null) continue;
    if (e > s && minutes >= s && minutes < e) return slot;
    if (e <= s && (minutes >= s || minutes < e)) return slot;
  }
  return null;
}

let lastDesired = null;

async function applySchedule() {
  if (!schedule.enabled) {
    lastDesired = null;
    return;
  }
  const slot = activeSlot(new Date());
  const desired = slot ? 'on' : 'off';
  if (desired === lastDesired) return;
  lastDesired = desired;
  if (slot) {
    if (Math.abs(state.target - slot.t) > 0.01) await command('target', slot.t, 'programma');
    if (!state.on) await command('on', 1, 'programma');
    log('info', `Programma: fascia ${slot.s}–${slot.e} a ${slot.t} °C`);
  } else if (state.on) {
    await command('off', 0, 'programma');
    log('info', 'Programma: fine fascia, stufa spenta');
  }
}

/* ------------------------------------------------------------------ */
/* Comandi                                                             */
/* ------------------------------------------------------------------ */

let commandQueue = Promise.resolve();

function command(action, value, source) {
  commandQueue = commandQueue.then(async () => {
    try {
      if (action === 'on') {
        await adapter.setPower(true);
        state.on = true;
      } else if (action === 'off') {
        await adapter.setPower(false);
        state.on = false;
      } else if (action === 'target') {
        const t = Math.min(30, Math.max(7, Number(value)));
        if (Number.isNaN(t)) throw new Error('set point non valido');
        await adapter.setTarget(t);
        state.target = t;
      } else if (action === 'level') {
        const l = Math.min(5, Math.max(1, Math.round(Number(value))));
        if (Number.isNaN(l)) throw new Error('potenza non valida');
        await adapter.setLevel(l);
        state.level = l;
      } else {
        throw new Error('azione sconosciuta: ' + action);
      }
      state.updatedAt = Date.now();
      state.stale = false;
      writeJson('state.json', { on: state.on, target: state.target, level: state.level });
      if (source !== 'programma') {
        const label = {
          on: 'Accensione', off: 'Spegnimento',
          target: 'Set point ' + state.target + ' °C',
          level: 'Potenza ' + state.level,
        }[action];
        log('comando', label + (source ? ' (' + source + ')' : ''));
      }
      broadcast({ type: 'state', payload: snapshot() });
      return { ok: true };
    } catch (err) {
      log('errore', 'Comando fallito: ' + (err.message || err));
      throw err;
    }
  });
  return commandQueue;
}

/* ------------------------------------------------------------------ */
/* Snapshot e broadcast                                                */
/* ------------------------------------------------------------------ */

function snapshot() {
  return {
    now: Date.now(),
    state: { ...state },
    schedule,
    events: events.slice(-40),
    history: history.slice(-144),
    adapter: { name: adapter.name, description: adapter.describe() },
  };
}

const clients = new Set();

function broadcast(message) {
  const line = 'data: ' + JSON.stringify(message) + '\n\n';
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      clients.delete(res);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Ciclo                                                               */
/* ------------------------------------------------------------------ */

async function tick() {
  try {
    const next = await adapter.getState();
    const wasOn = state.on;
    Object.assign(state, next);
    state.updatedAt = Date.now();
    if (next.on !== wasOn) {
      log('info', next.on ? 'Stufa accesa' : 'Stufa spenta');
    }
    if (next.alarm) log('allarme', 'Allarme stufa: ' + next.alarm);
    if (state.reachable) state.stale = false;
    broadcast({ type: 'state', payload: snapshot() });
  } catch (err) {
    state.reachable = false;
    state.stale = true;
    broadcast({ type: 'state', payload: snapshot() });
  }

  if (state.reachable && typeof state.room === 'number') {
    const last = history[history.length - 1];
    if (!last || Date.now() - last.t > 55000) {
      history.push({ t: Date.now(), v: state.room });
      if (history.length > 1440) history = history.slice(-1440);
      writeJson('history.json', history);
    }
  }

  await applySchedule();
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('corpo troppo grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('JSON non valido'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Non trovato');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = urlObj.pathname;

  if (!pathname.startsWith('/api/')) {
    serveStatic(req, res, pathname);
    return;
  }

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, adapter: adapter.name });
    return;
  }

  if (!authorized(req, urlObj)) {
    sendJson(res, 401, { error: 'token mancante o errato' });
    return;
  }

  try {
    if (pathname === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, snapshot());
      return;
    }

    if (pathname === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      res.write('data: ' + JSON.stringify({ type: 'state', payload: snapshot() }) + '\n\n');
      clients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* connessione chiusa */
        }
      }, 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (pathname === '/api/command' && req.method === 'POST') {
      const body = await readBody(req);
      if (!['on', 'off', 'target', 'level'].includes(body.action)) {
        sendJson(res, 400, { error: 'azione non valida' });
        return;
      }
      await command(body.action, body.value, 'app');
      sendJson(res, 200, { ok: true, state });
      return;
    }

    if (pathname === '/api/schedule' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || typeof body.days !== 'object') {
        sendJson(res, 400, { error: 'programma non valido' });
        return;
      }
      schedule = { enabled: !!body.enabled, days: body.days };
      lastDesired = null;
      writeJson('schedule.json', schedule);
      log('info', schedule.enabled ? 'Programma settimanale attivato' : 'Programma settimanale disattivato');
      broadcast({ type: 'state', payload: snapshot() });
      sendJson(res, 200, { ok: true, schedule });
      return;
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      sendJson(res, 200, { events });
      return;
    }

    if (pathname === '/api/network' && req.method === 'GET') {
      let device = null;
      if (typeof adapter.probe === 'function') device = await adapter.probe();
      sendJson(res, 200, {
        port: PORT,
        listener: HOST,
        dualStack: HOST === '::',
        addresses: addressList(),
        device,
      });
      return;
    }

    sendJson(res, 404, { error: 'endpoint sconosciuto' });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'errore interno' });
  }
});

function addressList() {
  const result = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const info of entries || []) {
      if (info.family !== 'IPv4' && info.family !== 'IPv6') continue;
      const host = info.family === 'IPv6' ? `[${info.address}]` : info.address;
      const linkLocal = info.address.startsWith('fe80') || info.address.startsWith('169.254');
      result.push({
        interface: name,
        family: info.family,
        address: info.address,
        internal: !!info.internal,
        linkLocal,
        // indirizzi usabili da un altro dispositivo della rete (telefono su 5 GHz compreso)
        usable: !info.internal && !linkLocal,
        url: `http://${host}:${PORT}`,
      });
    }
  }
  return result;
}

function ready() {
  console.log(`Bridge stufa in ascolto su ${HOST}:${PORT} · adattatore: ${adapter.name}`);
  for (const entry of addressList()) {
    const note = entry.internal ? '  (solo locale)' : entry.linkLocal ? '  (link-local, non usabile da altri dispositivi)' : '  <-- usa questo dal telefono';
    console.log(`  ${entry.family.padEnd(4)} ${entry.url}${note}   [${entry.interface}]`);
  }
  console.log(`Dati in ${DATA_DIR}`);
  if (DEV_NO_AUTH) {
    console.log('ATTENZIONE: DEV_NO_AUTH attivo (solo simulatore, nessun token richiesto)');
  } else {
    console.log('Token di accesso: ' + path.join(DATA_DIR, 'token.txt'));
  }
  console.log('Telefono e bridge possono stare su 5 GHz; la stufa va di solito in 2,4 GHz. Basta che siano nella stessa rete.');
}

function startListening(host, isFallback) {
  server.listen(PORT, host, () => {
    HOST = host;
    ready();
  });
  server.once('error', (err) => {
    if (!isFallback && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL' || err.code === 'ENOTSUP')) {
      console.warn('IPv6 non disponibile, ascolto solo su IPv4');
      startListening('0.0.0.0', true);
      return;
    }
    console.error('Avvio fallito: ' + err.message);
    process.exit(1);
  });
}

startListening(HOST, false);

setInterval(() => {
  tick().catch(() => {});
}, 15000);

tick().catch(() => {});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
