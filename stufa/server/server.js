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
const net = require('net');

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

/* ------------------------------------------------------------------ */
/* Adattatore Brahma (cloud FTP, app Magic Stove)                       */
/* ------------------------------------------------------------------ */

// Il cloud Brahma non ha una API: l'app scrive e legge file su un FTP, in una
// cartella per dispositivo. Questo adattatore fa lo stesso senza l'app.

// realtime.txt: 235 byte, lo scrive la stufa. Campi separati da ';':
//   [0] MAC di chi scrive   [1] ora HH:MM esadecimale   [2] giorno 0-6 (0 = lunedì)
//   [3] potenza 1-5         [4] set point esadecimale    [5] temperatura ambiente
//   [6] fase della scheda   [7] modo (0 manuale, 1 automatico)   [8] 1 accesa / 0 spenta
//   [9] campo non decodificato (oggi "00")   [10] carattere di stato (oggi "O")
//   [11] crono settimanale
//   [12] parametri della scheda
// Le posizioni vengono dal codice dell'app (MainActivity, metodo che scarica
// realtime.txt): substring(19,20) giorno, (21,22) potenza, (23,25) set point,
// (26,28) temperatura, (29,31) fase, (32,33) modo, (34,35) acceso/spento.
// Nomi delle fasi: la scheda manda un codice numerico e l'APK non contiene le
// etichette (le risorse del layout sono state rimosse). Qui vanno SOLO i codici
// verificati guardando la stufa, altrimenti meglio il numero nudo.
const BRAHMA_STAGES = {
  // 5: 'cooling',
};

function brahmaParseRealtime(text) {
  const line = String(text).split(/\r?\n/)[0];
  const f = line.split(';');
  if (f.length < 11) throw new Error('realtime.txt non riconosciuto');
  const hex = (v) => parseInt(String(v || '').trim(), 16);
  const dec = (v) => parseInt(String(v || '').trim(), 10);
  const room = hex(f[5]);
  const on = dec(f[8]) === 1;
  return {
    on,
    target: hex(f[4]),
    level: dec(f[3]),
    room: Number.isFinite(room) && room > -20 && room < 60 ? room : null,
    mode: dec(f[7]) === 1 ? 'auto' : 'manual',
    stage: hex(f[6]),
    stageName: BRAHMA_STAGES[hex(f[6])] || null,
    status: on ? 'accesa' : 'spenta',
    // I codici delle fasi di lavoro e degli allarmi non sono documentati:
    // meglio nessun allarme che un allarme inventato.
    alarm: null,
  };
}

function ftpConnect(cfg) {
  const timeout = Number(cfg.timeoutMs) || 15000;
  const sock = net.createConnection({ host: cfg.host, port: Number(cfg.port) || 21 });
  let buffer = '';
  const replies = [];
  let waiter = null;
  let failure = null;

  function fail(err) {
    failure = failure || err;
    if (waiter) {
      const current = waiter;
      waiter = null;
      current.reject(failure);
    }
  }

  sock.setEncoding('latin1');
  sock.setTimeout(timeout, () => sock.destroy(new Error('timeout FTP')));
  sock.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (!/^\d{3} /.test(line)) continue;
      const reply = { code: Number(line.slice(0, 3)), text: line.slice(4) };
      if (waiter) {
        const current = waiter;
        waiter = null;
        current.resolve(reply);
      } else {
        replies.push(reply);
      }
    }
  });
  sock.on('error', fail);
  sock.on('close', () => fail(new Error('connessione FTP chiusa')));

  function next() {
    if (replies.length) return Promise.resolve(replies.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = null;
        reject(new Error('timeout FTP'));
      }, timeout);
      waiter = {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
    });
  }

  function cmd(line, ok) {
    sock.write(line + '\r\n');
    return next().then((reply) => {
      if (ok && !ok.includes(reply.code)) {
        throw new Error('FTP ' + line.split(' ')[0] + ': ' + reply.code + ' ' + reply.text);
      }
      return reply;
    });
  }

  async function pasv() {
    const reply = await cmd('PASV', [227]);
    const found = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(reply.text);
    if (!found) throw new Error('risposta PASV non riconosciuta: ' + reply.text);
    return Number(found[5]) * 256 + Number(found[6]);
  }

  async function transfer(verb, name, body) {
    const port = await pasv();
    const data = net.createConnection({ host: cfg.host, port });
    data.setEncoding('latin1');
    data.setTimeout(timeout, () => data.destroy(new Error('timeout trasferimento FTP')));
    const chunks = [];
    const ended = new Promise((resolve, reject) => {
      data.on('data', (chunk) => chunks.push(chunk));
      data.on('end', resolve);
      data.on('error', reject);
    });
    sock.write(verb + ' ' + name + '\r\n');
    const opening = await next();
    if (opening.code !== 150 && opening.code !== 125) {
      data.destroy();
      throw new Error(verb + ' ' + name + ': ' + opening.code + ' ' + opening.text);
    }
    if (verb === 'STOR') data.end(body, 'latin1');
    else data.end();
    await ended;
    const closing = await next();
    if (closing.code !== 226 && closing.code !== 250) {
      throw new Error(verb + ' ' + name + ': ' + closing.code + ' ' + closing.text);
    }
    return chunks.join('');
  }

  async function open() {
    const greeting = await next();
    if (greeting.code !== 220) throw new Error('FTP: ' + greeting.code + ' ' + greeting.text);
    const user = await cmd('USER ' + cfg.user, [230, 331]);
    if (user.code === 331) await cmd('PASS ' + cfg.pass, [230, 202]);
    await cmd('TYPE I', [200]);
    return {
      cwd: (dir) => cmd('CWD ' + dir, [250, 200]),
      retr: (name) => transfer('RETR', name),
      stor: (name, body) => transfer('STOR', name, body),
      quit() {
        try {
          sock.write('QUIT\r\n');
        } catch {
          /* già chiusa */
        }
        sock.destroy();
      },
    };
  }

  return { open };
}

function brahmaAdapter(config) {
  const cfg = config || {};
  const mac = String(cfg.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!cfg.host || !cfg.user || !cfg.pass || mac.length !== 12) {
    throw new Error('brahma.json incompleto: servono host, user, pass e mac (12 cifre esadecimali)');
  }
  const base = (cfg.dir || '/WebServer/BTouchPellet/0001/').replace(/\/+$/, '') + '/' + mac + '/';
  const link = { host: cfg.host, port: cfg.port, user: cfg.user, pass: cfg.pass, timeoutMs: cfg.timeoutMs };

  async function withSession(work) {
    const session = await ftpConnect(link).open();
    try {
      await session.cwd(base);
      return await work(session);
    } finally {
      session.quit();
    }
  }

  // config.txt: 224 byte, campi a posizione fissa (stesse posizioni di realtime.txt).
  // MAC;HH:MM;giorno;potenza;setpoint(hex);modo;acceso;crono(42);parametri;scheda
  // ';' fissi a 12, 18, 20, 22, 25, 27, 29, 72, 223: se non tornano non si scrive.
  function buildConfig(line, patch) {
    const f = line.split(';');
    if (line.length !== 224 || f.length !== 10) {
      throw new Error('config.txt inatteso: ' + line.length + ' byte invece di 224');
    }
    const hex2 = (n) => String(Math.round(n).toString(16)).toUpperCase().padStart(2, '0');
    const now = new Date();
    f[1] = hex2(now.getHours()) + ':' + hex2(now.getMinutes());
    f[2] = String(now.getDay() === 0 ? 6 : now.getDay() - 1);
    if (patch.level != null) f[3] = String(patch.level);
    if (patch.target != null) f[4] = hex2(patch.target);
    if (patch.mode != null) f[5] = String(patch.mode);
    // accensione/spegnimento: l'app scrive 1 o 0 in questo campo (Switch "Stato")
    if (patch.power != null) f[6] = patch.power ? '1' : '0';
    const next = f.join(';');
    // stessi separatori che l'app si aspetta: se non tornano, non si scrive nulla
    const marks = [12, 18, 20, 22, 25, 27, 29, 72, 223];
    if (next.length !== 224 || marks.some((i) => next.charAt(i) !== ';')) {
      throw new Error('config.txt ricostruito non valido: scrittura annullata');
    }
    return next;
  }

  // Rilegge config.txt, cambia solo i campi richiesti e lo ricarica: crono e
  // parametri della scheda restano quelli della stufa.
  async function patchConfig(patch) {
    return withSession(async (session) => {
      const raw = await session.retr('config.txt');
      const line = String(raw).split(/\r?\n/)[0];
      await session.stor('config.txt', buildConfig(line, patch));
    });
  }

  return {
    name: 'brahma',
    describe() {
      return 'Brahma cloud FTP · ' + cfg.host + ' · ' + mac;
    },
    async probe() {
      const started = Date.now();
      try {
        await withSession((session) => session.retr('realtime.txt'));
        return { ok: true, latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, error: err.message || 'non raggiungibile', latencyMs: Date.now() - started };
      }
    },
    async getState() {
      const raw = await withSession((session) => session.retr('realtime.txt'));
      return { ...brahmaParseRealtime(raw), reachable: true, stale: false };
    },
    async setPower(on) {
      await patchConfig({ power: !!on });
    },
    async setTarget(value) {
      const target = Math.round(Number(value));
      if (!Number.isFinite(target) || target < 5 || target > 35) {
        throw new Error('set point fuori intervallo (5–35 °C)');
      }
      await patchConfig({ target });
    },
    async setLevel(value) {
      const level = Math.round(Number(value));
      if (!(level >= 1 && level <= 5)) throw new Error('potenza fuori intervallo (1–5)');
      await patchConfig({ level });
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
} else if (ADAPTER_NAME === 'brahma') {
  adapter = brahmaAdapter(readJson('brahma.json', {}));
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
