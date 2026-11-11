'use strict';

/* ------------------------------------------------------------------ */
/* Costanti, storage, stato                                            */
/* ------------------------------------------------------------------ */

const KEYS = {
  cfg: 'stufa.config.v3',
  sched: 'stufa.schedule.v3',
  hist: 'stufa.history.v3',
  events: 'stufa.events.v3',
};

const DAYS = [
  ['mon', 'Lun'], ['tue', 'Mar'], ['wed', 'Mer'], ['thu', 'Gio'],
  ['fri', 'Ven'], ['sat', 'Sab'], ['sun', 'Dom'],
];
const JS_TO_KEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const DEFAULT_CFG = { url: '', token: '', demo: false };

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

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage pieno o bloccato */
  }
}

let cfg = Object.assign({}, DEFAULT_CFG, load(KEYS.cfg, DEFAULT_CFG));
let schedule = load(KEYS.sched, defaultSchedule());
let history = load(KEYS.hist, []);
let events = load(KEYS.events, []);

const stove = {
  on: false, target: 21, level: 2, room: null, alarm: null,
  reachable: true, stale: false, mode: null, stage: null, stageName: null,
};

const STAGE_LABELS = {
  // Solo codici osservati: il codice della scheda non è documentato.
};

let mode = 'none'; // 'bridge' | 'local' | 'none'
let stream = null;
let selectedDay = JS_TO_KEY[new Date().getDay()];
let local = { room: 19.4, on: false, target: 21, level: 2 };
let lastSchedulePush = 0;
let scheduleTimer = null;
let lastSample = 0;

/* ------------------------------------------------------------------ */
/* Utility                                                             */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const round1 = (v) => Math.round(v * 10) / 10;

function toast(message, isError) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}

function minutesOf(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function timeLabel(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* ------------------------------------------------------------------ */
/* Bridge                                                              */
/* ------------------------------------------------------------------ */

function baseUrl() {
  return String(cfg.url || '').trim().replace(/\/+$/, '');
}

function apiUrl(path) {
  return (baseUrl() || location.origin) + path;
}

async function api(path, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
  const res = await fetch(apiUrl(path), { ...options, headers });
  if (!res.ok) {
    let message = 'HTTP ' + res.status;
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch { /* risposta non JSON */ }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function setConn(text, kind) {
  const el = $('connState');
  el.textContent = text;
  el.dataset.kind = kind || '';
}

async function connect() {
  if (cfg.demo) {
    goLocal('Demo locale');
    return;
  }

  setConn('Connessione…', 'wait');
  try {
    const data = await api('/api/state');
    mode = 'bridge';
    applySnapshot(data);
    setConn('Collegato · ' + (data.adapter ? data.adapter.name : 'bridge'), 'ok');
    $('schedState').textContent = schedule.enabled ? 'attivo sul bridge' : 'in pausa';
    $('connInfo').textContent = 'Adattatore: ' + (data.adapter ? data.adapter.description : 'n/d');
    subscribe();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      mode = 'none';
      setConn('Serve il token', 'warn');
      const len = String(cfg.token || '').length;
      $('connInfo').textContent = len
        ? 'Token rifiutato (ricevuti ' + len + ' caratteri): ricontrolla di averlo copiato tutto da server/data/token.txt.'
        : 'Token mancante: incollalo qui sotto.';
      openSheet('settingsSheet');
      render();
      return;
    }
    goLocal('Demo locale · bridge non raggiungibile');
  }
}

function subscribe() {
  if (stream) stream.close();
  const suffix = cfg.token ? '?token=' + encodeURIComponent(cfg.token) : '';
  try {
    stream = new EventSource(apiUrl('/api/stream') + suffix);
  } catch {
    return;
  }
  stream.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'state') {
      applySnapshot(msg.payload);
      setConn('Collegato · ' + (msg.payload.adapter ? msg.payload.adapter.name : 'bridge'), 'ok');
    }
  };
  stream.onerror = () => {
    if (mode === 'bridge') setConn('Riconnessione…', 'warn');
  };
}

function applySnapshot(data) {
  if (!data || !data.state) return;
  const s = data.state;
  stove.on = !!s.on;
  stove.target = Number(s.target) || 21;
  stove.level = Number(s.level) || 2;
  stove.room = typeof s.room === 'number' ? s.room : null;
  stove.alarm = s.alarm || null;
  stove.reachable = s.reachable !== false;
  stove.stale = !!s.stale;
  stove.mode = s.mode || null;
  stove.stage = typeof s.stage === 'number' ? s.stage : null;
  stove.stageName = s.stageName || STAGE_LABELS[s.stage] || null;

  if (Array.isArray(data.events)) {
    events = data.events.slice(-40);
    renderEvents();
  }
  if (Array.isArray(data.history)) history = data.history.slice(-288);
  if (data.schedule && Date.now() - lastSchedulePush > 1500) {
    schedule = data.schedule;
    $('autoToggle').checked = !!schedule.enabled;
    renderDays();
    renderSlots();
  }
  render();
  drawChart();
}

async function command(action, value) {
  if (mode !== 'bridge') {
    localCommand(action, value);
    return;
  }
  try {
    await api('/api/command', { method: 'POST', body: JSON.stringify({ action, value }) });
  } catch (err) {
    toast(err.message, true);
    refresh();
  }
}

async function refresh() {
  if (mode !== 'bridge') return;
  try {
    applySnapshot(await api('/api/state'));
  } catch {
    setConn('Riconnessione…', 'warn');
  }
}

/* ------------------------------------------------------------------ */
/* Comandi                                                             */
/* ------------------------------------------------------------------ */

function setOn(next) {
  stove.on = next;
  render();
  command(next ? 'on' : 'off', next ? 1 : 0);
}

function setTarget(value) {
  const next = clamp(Math.round(value * 2) / 2, 7, 30);
  if (next === stove.target) return;
  stove.target = next;
  render();
  command('target', next);
}

function setLevel(value) {
  const next = clamp(Math.round(value), 1, 5);
  if (next === stove.level) return;
  stove.level = next;
  render();
  command('level', next);
}

function localCommand(action, value) {
  if (action === 'on') {
    local.on = true;
    addLocalEvent('comando', 'Accensione');
  } else if (action === 'off') {
    local.on = false;
    addLocalEvent('comando', 'Spegnimento');
  } else if (action === 'target') {
    local.target = value;
    addLocalEvent('comando', 'Set point ' + value + ' °C');
  } else if (action === 'level') {
    local.level = value;
    addLocalEvent('comando', 'Potenza ' + value);
  }
  stove.on = local.on;
  stove.target = local.target;
  stove.level = local.level;
  render();
}

function addLocalEvent(kind, text) {
  events.push({ t: Date.now(), kind, text });
  events = events.slice(-40);
  save(KEYS.events, events);
  renderEvents();
}

/* ------------------------------------------------------------------ */
/* Demo locale                                                         */
/* ------------------------------------------------------------------ */

function goLocal(label) {
  if (stream) {
    stream.close();
    stream = null;
  }
  mode = 'local';
  local.on = stove.on;
  local.target = stove.target;
  local.level = stove.level;
  if (local.room == null) local.room = typeof stove.room === 'number' ? stove.room : 19.4;
  stove.reachable = true;
  stove.stale = false;
  stove.mode = 'manual';
  stove.stage = null;
  stove.stageName = null;
  setConn(label, 'warn');
  $('schedState').textContent = 'solo questo dispositivo';
  $('connInfo').textContent = 'Nessun bridge collegato: comandi e programma restano su questo dispositivo.';
  localTick();
}

function localTick() {
  if (mode !== 'local') return;
  const goal = local.on ? local.target : 16;
  local.room += (goal - local.room) * 0.02;
  local.room += (Math.random() - 0.5) * 0.08;
  local.room = clamp(local.room, 8, 32);
  stove.room = round1(local.room);
  stove.on = local.on;
  render();
  sampleHistory(true);
}

function sampleHistory(force) {
  if (typeof stove.room !== 'number') return;
  const now = Date.now();
  if (!force && now - lastSample < 60000) return;
  lastSample = now;
  history.push({ t: now, v: round1(stove.room) });
  history = history.filter((p) => p.t > now - 24 * 3600 * 1000);
  save(KEYS.hist, history);
  drawChart();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  const status = $('stoveStatus');
  status.textContent = stove.on ? 'Accesa' : 'Spenta';
  status.classList.toggle('on', stove.on);

  $('alertBadge').hidden = !stove.alarm;
  $('staleBadge').hidden = !stove.stale;
  $('alertBadge').textContent = 'Allarme';

  const strip = $('alertStrip');
  const messages = [];
  if (!stove.reachable) messages.push('Stufa non raggiungibile: mostro l\'ultimo stato conosciuto.');
  if (stove.alarm) messages.push('Allarme riportato dalla stufa: ' + stove.alarm);
  strip.textContent = messages.join(' · ');
  strip.hidden = messages.length === 0;

  $('roomTemp').textContent = typeof stove.room === 'number' ? stove.room.toFixed(1) : '--';
  $('targetTemp').textContent = stove.target.toFixed(stove.target % 1 === 0 ? 0 : 1);

  const stageText = stove.stage == null
    ? '—'
    : (stove.stageName || 'Fase ' + stove.stage);
  $('stageLabel').textContent = stageText;
  $('modeLabel').textContent = stove.on
    ? (stove.mode === 'auto' ? 'Automatica' : 'Manuale')
    : '—';

  const btn = $('powerBtn');
  btn.textContent = stove.on ? 'Spegni' : 'Accendi';
  btn.classList.toggle('is-on', stove.on);

  [...$('powerSeg').children].forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.level) === stove.level);
  });
  $('powerHint').textContent = stove.on ? 'in funzione' : 'in attesa';
}

function renderPowerSeg() {
  const seg = $('powerSeg');
  seg.innerHTML = '';
  for (let i = 1; i <= 5; i += 1) {
    const b = document.createElement('button');
    b.textContent = String(i);
    b.dataset.level = String(i);
    b.addEventListener('click', () => setLevel(i));
    seg.appendChild(b);
  }
}

function renderDays() {
  const wrap = $('days');
  wrap.innerHTML = '';
  DAYS.forEach(([key, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.role = 'tab';
    b.classList.toggle('active', key === selectedDay);
    b.classList.toggle('has-slots', ((schedule.days || {})[key] || []).length > 0);
    b.addEventListener('click', () => {
      selectedDay = key;
      renderDays();
      renderSlots();
    });
    wrap.appendChild(b);
  });
}

function renderSlots() {
  const wrap = $('slots');
  wrap.innerHTML = '';
  if (!schedule.days) schedule.days = defaultSchedule().days;
  const slots = schedule.days[selectedDay] || [];

  if (!slots.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nessuna fascia per questo giorno.';
    wrap.appendChild(p);
    return;
  }

  slots.forEach((slot, index) => {
    const row = document.createElement('div');
    row.className = 'slot';

    const start = document.createElement('input');
    start.type = 'time';
    start.value = slot.s;
    start.addEventListener('change', () => { slot.s = start.value; persistSchedule(); });

    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '→';

    const end = document.createElement('input');
    end.type = 'time';
    end.value = slot.e;
    end.addEventListener('change', () => { slot.e = end.value; persistSchedule(); });

    const temp = document.createElement('input');
    temp.type = 'number';
    temp.min = '7';
    temp.max = '30';
    temp.step = '0.5';
    temp.value = String(slot.t);
    temp.title = 'Set point';
    temp.className = 'deg';
    temp.addEventListener('change', () => {
      slot.t = clamp(parseFloat(temp.value) || 21, 7, 30);
      temp.value = String(slot.t);
      persistSchedule();
    });

    const del = document.createElement('button');
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Elimina fascia');
    del.addEventListener('click', () => {
      schedule.days[selectedDay] = slots.filter((_, i) => i !== index);
      persistSchedule();
      renderDays();
      renderSlots();
    });

    row.append(start, sep, end, temp, del);
    wrap.appendChild(row);
  });
}

function renderEvents() {
  const list = $('eventsList');
  if (!list) return;
  list.innerHTML = '';
  const items = events.slice(-12).reverse();
  $('eventsCount').textContent = events.length ? events.length + ' in memoria' : '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'event empty-event';
    li.textContent = 'Nessun evento registrato.';
    list.appendChild(li);
    return;
  }
  items.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'event ' + (entry.kind || 'info');
    const time = document.createElement('span');
    time.className = 'event-time';
    time.textContent = timeLabel(entry.t);
    const text = document.createElement('span');
    text.textContent = entry.text;
    li.append(time, text);
    list.appendChild(li);
  });
}

function persistSchedule() {
  schedule.enabled = $('autoToggle').checked;
  save(KEYS.sched, schedule);
  lastSchedulePush = Date.now();
  clearTimeout(scheduleTimer);
  scheduleTimer = setTimeout(pushSchedule, 600);
}

async function pushSchedule() {
  if (mode !== 'bridge') {
    $('schedState').textContent = 'solo questo dispositivo';
    toast('Programma salvato su questo dispositivo');
    return;
  }
  try {
    await api('/api/schedule', { method: 'PUT', body: JSON.stringify(schedule) });
    $('schedState').textContent = schedule.enabled ? 'attivo sul bridge' : 'in pausa';
    toast('Programma salvato sul bridge');
  } catch (err) {
    toast('Programma non salvato sul bridge: ' + err.message, true);
  }
}

/* ------------------------------------------------------------------ */
/* Grafico                                                             */
/* ------------------------------------------------------------------ */

function drawChart() {
  const canvas = $('chart');
  if (!canvas) return;
  const points = history.slice(-288);
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320;
  const cssH = 120;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (points.length < 2) {
    ctx.fillStyle = 'rgba(154,154,164,0.9)';
    ctx.font = '13px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Raccolgo dati…', cssW / 2, cssH / 2);
    return;
  }

  const values = points.map((p) => p.v);
  const min = Math.min(...values) - 0.5;
  const max = Math.max(...values) + 0.5;
  const span = Math.max(1, max - min);
  const pad = 8;

  ctx.strokeStyle = 'rgba(154,154,164,0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i += 1) {
    const y = pad + ((cssH - pad * 2) * i) / 3;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cssW, y);
    ctx.stroke();
  }

  const xOf = (i) => (i / (points.length - 1)) * cssW;
  const yOf = (v) => pad + (1 - (v - min) / span) * (cssH - pad * 2);

  const grad = ctx.createLinearGradient(0, 0, 0, cssH);
  grad.addColorStop(0, 'rgba(255,122,26,0.32)');
  grad.addColorStop(1, 'rgba(255,122,26,0)');

  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(xOf(i), yOf(p.v)) : ctx.lineTo(xOf(i), yOf(p.v))));
  ctx.lineTo(cssW, cssH);
  ctx.lineTo(0, cssH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(xOf(i), yOf(p.v)) : ctx.lineTo(xOf(i), yOf(p.v))));
  ctx.strokeStyle = '#ff7a1a';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.fillStyle = 'rgba(154,154,164,0.9)';
  ctx.font = '11px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'right';
  const last = values[values.length - 1];
  ctx.fillText(last.toFixed(1) + '°', cssW - 2, yOf(last) - 6);
}

/* ------------------------------------------------------------------ */
/* Fogli                                                               */
/* ------------------------------------------------------------------ */

function openSheet(id) {
  $('overlay').hidden = false;
  ['settingsSheet'].forEach((x) => { $(x).hidden = x !== id; });
  document.body.style.overflow = 'hidden';
}

function closeSheets() {
  $('overlay').hidden = true;
  $('settingsSheet').hidden = true;
  document.body.style.overflow = '';
}

async function loadAddresses() {
  const wrap = $('addrList');
  if (!wrap) return;
  wrap.textContent = 'Cerco gli indirizzi…';
  try {
    const data = await api('/api/network');
    wrap.innerHTML = '';
    const all = data.addresses || [];
    const usable = all.filter((a) => a.usable !== false && !a.internal && !a.linkLocal);
    const items = usable.length ? usable : all.filter((a) => !a.internal);
    if (!items.length) {
      wrap.textContent = 'Nessun indirizzo di rete utilizzabile: il bridge sembra raggiungibile solo in locale.';
    }
    items.forEach((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'addr';
      const family = document.createElement('span');
      family.className = 'addr-fam';
      family.textContent = entry.family === 'IPv6' ? 'IPv6' : 'IPv4';
      const url = document.createElement('span');
      url.textContent = entry.url;
      button.append(family, url);
      button.addEventListener('click', () => {
        $('srvUrl').value = entry.url;
        toast('Indirizzo inserito');
      });
      wrap.appendChild(button);
    });
    if (data.device) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = data.device.ok
        ? 'Stufa raggiungibile dal bridge' + (data.device.latencyMs ? ' (' + data.device.latencyMs + ' ms)' : '') + '.'
        : 'Stufa non raggiungibile dal bridge: ' + (data.device.error || 'errore sconosciuto');
      wrap.appendChild(note);
    }
  } catch (err) {
    wrap.textContent = err.status === 401
      ? 'Serve il token per elencare gli indirizzi.'
      : 'Indirizzi non disponibili: ' + err.message;
  }
}

function fillSettings() {
  $('srvUrl').value = cfg.url || '';
  $('srvToken').value = cfg.token || '';
  loadAddresses();
  $('connInfo').textContent = mode === 'bridge'
    ? 'Bridge collegato.'
    : 'Nessun bridge collegato: al momento i comandi restano su questo dispositivo.';
  openSheet('settingsSheet');
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

function bind() {
  $('powerBtn').addEventListener('click', () => setOn(!stove.on));
  $('plusBtn').addEventListener('click', () => setTarget(stove.target + 0.5));
  $('minusBtn').addEventListener('click', () => setTarget(stove.target - 0.5));

  $('autoToggle').addEventListener('change', (e) => {
    schedule.enabled = e.target.checked;
    persistSchedule();
    toast(schedule.enabled ? 'Programma attivo' : 'Programma in pausa');
  });

  $('addSlotBtn').addEventListener('click', () => {
    if (!schedule.days) schedule.days = {};
    const slots = schedule.days[selectedDay] || (schedule.days[selectedDay] = []);
    slots.push({ s: '06:00', e: '08:00', t: stove.target || 21 });
    persistSchedule();
    renderDays();
    renderSlots();
  });

  $('settingsBtn').addEventListener('click', fillSettings);
  $('saveBtn').addEventListener('click', () => {
    cfg = {
      url: $('srvUrl').value.trim().replace(/\/+$/, ''),
      token: $('srvToken').value.trim(),
      demo: false,
    };
    save(KEYS.cfg, cfg);
    closeSheets();
    connect();
  });

  $('demoBtn').addEventListener('click', () => {
    cfg = { url: '', token: '', demo: true };
    save(KEYS.cfg, cfg);
    closeSheets();
    goLocal('Demo locale');
  });

  $('overlay').addEventListener('click', (e) => { if (e.target === $('overlay')) closeSheets(); });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));

  window.addEventListener('resize', drawChart);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}

// Token passato nell'URL (?token=...): utile per aprire l'app da un link senza
// digitare 47 caratteri sul telefono. Viene salvato e poi tolto dall'indirizzo.
function tokenFromUrl() {
  let params;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return;
  }
  const token = (params.get('token') || '').trim();
  if (!token) return;
  cfg = Object.assign({}, cfg, { token, demo: false });
  save(KEYS.cfg, cfg);
  try {
    history.replaceState({}, '', location.pathname + location.hash);
  } catch { /* storico non disponibile */ }
}

function start() {
  tokenFromUrl();
  renderPowerSeg();
  renderDays();
  renderSlots();
  renderEvents();
  $('autoToggle').checked = !!schedule.enabled;
  render();
  drawChart();

  connect();

  setInterval(() => {
    if (document.hidden) return;
    if (mode === 'local') localTick();
    else if (mode === 'bridge') sampleHistory();
  }, 15000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

bind();
start();
