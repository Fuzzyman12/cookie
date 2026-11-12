'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { computePlan, changeoverMs } = require('./scheduler');
const { seedState, defaultSettings } = require('./seed');

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const REPLAN_INTERVAL_MS = 20000;

// ---------------------------------------------------------------- state
fs.mkdirSync(DATA_DIR, { recursive: true });
let state = loadState();
let plan = null;
let lastMixOrder = [];

function loadState() {
  try {
    return normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read saved state, starting fresh:', e.message);
    return normalize(seedState());
  }
}

function normalize(s) {
  s.settings = { ...defaultSettings(), ...(s.settings || {}) };
  s.recipes ||= [];
  s.batches ||= [];
  s.ovens ||= {};
  s.counters ||= {};
  s.panHistory ||= {};
  // Pans per batch used to live on the recipe; it's now entered at Cookie Prep.
  // Keep any old value as the first data point for the estimate.
  for (const r of s.recipes) {
    if (r.pansPerBatch !== undefined) {
      rememberPans(s, r.id, r.pansPerBatch, true);
      delete r.pansPerBatch;
    }
  }
  for (const o of s.settings.ovens) s.ovens[o.id] ||= { targetTempF: null, readyAt: 0, current: null };
  return s;
}

// ---------------------------------------------------------------- pan estimates
// Function declarations (not consts): normalize() calls these at startup.
function rememberPans(s, recipeId, pans, onlyIfEmpty = false) {
  const p = Math.round(Number(pans));
  if (!Number.isFinite(p) || p < 1) return;
  const list = (s.panHistory[recipeId] ||= []);
  if (onlyIfEmpty && list.length) return;
  list.push(p);
  const keep = 5; // recent counts to average
  if (list.length > keep) list.splice(0, list.length - keep);
}
/** Expected pans for a new batch: average of what Cookie Prep reported recently. */
function estimatePans(s, recipeId) {
  const list = s.panHistory[recipeId] || [];
  if (!list.length) return Math.max(1, Math.round(Number(s.settings.defaultPansPerBatch) || 4));
  return Math.max(1, Math.round(list.reduce((a, b) => a + b, 0) / list.length));
}

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DATA_FILE);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

function replan() {
  try {
    plan = computePlan(state, Date.now(), lastMixOrder);
    lastMixOrder = plan.mixQueue;
  } catch (e) {
    console.error('Planner error:', e);
  }
}

// ---------------------------------------------------------------- realtime
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const snapshot = () => JSON.stringify({ type: 'state', state, plan, serverTime: Date.now() });
function broadcast() {
  const msg = snapshot();
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.send(snapshot());
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function commit() {
  replan();
  save();
  broadcast();
}

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const fail = (msg, status = 400) => { throw new HttpError(status, msg); };
const newId = () => crypto.randomBytes(6).toString('hex');
const S = () => state.settings;
const findBatch = (id) => state.batches.find((b) => b.id === id) || fail('Batch not found', 404);
const findRecipe = (id) => state.recipes.find((r) => r.id === id) || fail('Recipe not found', 404);
const oven = (id) => state.ovens[id] || fail('Oven not found', 404);
const ovenName = (id) => (S().ovens.find((o) => o.id === id) || {}).name || id;

function n(v, d, min = 0) {
  const x = Number(v);
  return v === '' || v === null || v === undefined || !Number.isFinite(x) ? d : Math.max(min, x);
}
const strList = (v) =>
  (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => String(x).trim()).filter(Boolean);
const steps = (a) =>
  (Array.isArray(a) ? a : [])
    .map((x) => ({ text: String(x?.text || '').trim(), minutes: n(x?.minutes, null) || null }))
    .filter((x) => x.text);

function cleanRecipe(input, existing = {}) {
  return {
    id: existing.id || 'r-' + newId(),
    name: String(input.name || '').trim() || 'Untitled cookie',
    color: /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : existing.color || '#c8814a',
    yieldPerBatch: n(input.yieldPerBatch, 48),
    mixMinutes: n(input.mixMinutes, 15),
    ingredients: strList(input.ingredients),
    mixSteps: steps(input.mixSteps),
    chillMinutes: n(input.chillMinutes, 0),
    chillNotes: String(input.chillNotes || ''),
    prepMinutesPerPan: n(input.prepMinutesPerPan, S().prepMinutesPerPan),
    prepSteps: steps(input.prepSteps),
    ovenTempF: n(input.ovenTempF, 350, 100),
    bakeMinutes: n(input.bakeMinutes, 10, 1),
    bakeSteps: steps(input.bakeSteps),
    coolMinutes: n(input.coolMinutes, 15),
    finishSteps: steps(input.finishSteps),
    packMinutes: n(input.packMinutes, 10),
    packSteps: steps(input.packSteps),
    notes: String(input.notes || ''),
  };
}

function setStage(b, stage, location) {
  b.stage = stage;
  if (location !== undefined) b.location = location;
  b.log.push({ stage, at: Date.now(), location: b.location });
}

function pickCoolingArea() {
  const areas = S().coolingAreas.length ? S().coolingAreas : ['Cooling & Packing'];
  const load = new Map(areas.map((a) => [a, 0]));
  for (const b of state.batches) {
    if (['baking', 'cooling', 'packing'].includes(b.stage) && load.has(b.coolingArea)) load.set(b.coolingArea, load.get(b.coolingArea) + 1);
  }
  return [...load.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

function pullFromOvens(b) {
  for (const o of Object.values(state.ovens)) if (o.current?.batchId === b.id) o.current = null;
  b.pansInOven = 0;
}

// ---------------------------------------------------------------- batch actions
const need = (b, ...stages) => {
  if (!stages.includes(b.stage)) fail(`${b.label} is ${b.stage.replace('_', ' ')}, not ${stages.join(' / ').replace('_', ' ')}`, 409);
};

const actions = {
  startMix(b, { station }) {
    need(b, 'queued');
    const busy = new Set(state.batches.filter((x) => x.stage === 'mixing').map((x) => x.location));
    const st = station || S().mixStations.find((x) => !busy.has(x));
    if (!st) fail('No free mix station');
    if (busy.has(st)) fail(`${st} is already mixing something`, 409);
    b.t.mixStart = Date.now();
    setStage(b, 'mixing', st);
  },
  finishMix(b, { to }) {
    need(b, 'mixing');
    b.t.mixEnd = Date.now();
    if (Number(b.recipe.chillMinutes) > 0 && to !== 'prep') {
      const loc = to || S().chillLocations[0] || 'Fridge';
      b.t.chillStart = Date.now();
      setStage(b, 'chilling', loc);
      return { message: `Put ${b.label} in the ${loc} — chill ${b.recipe.chillMinutes} min` };
    }
    setStage(b, 'ready_prep', 'Cookie Prep');
    return { message: `Take ${b.label} to Cookie Prep` };
  },
  finishChill(b) {
    need(b, 'chilling');
    b.t.chillEnd = Date.now();
    setStage(b, 'ready_prep', 'Cookie Prep');
  },
  startPrep(b) {
    need(b, 'chilling', 'ready_prep');
    if (b.stage === 'chilling') b.t.chillEnd = Date.now();
    b.t.prepStart = Date.now();
    setStage(b, 'prepping', 'Cookie Prep');
  },
  finishPrep(b, { pans }) {
    need(b, 'prepping');
    const filled = Number(pans);
    if (!Number.isInteger(filled) || filled < 1 || filled > 200) fail('Enter how many pans were filled (a whole number, 1 or more)');
    b.pans = filled;
    b.pansEstimated = false;
    rememberPans(state, b.recipeId, filled);
    b.t.prepEnd = Date.now();
    setStage(b, 'staged', 'Oven Staging Rack');
    return { message: `Put ${b.pans} pans of ${b.label} on the Oven Staging Rack` };
  },
  loadOven(b, { ovenId }) {
    need(b, 'staged', 'baking');
    const o = oven(ovenId);
    if (o.current) fail(`${ovenName(ovenId)} already has ${o.current.label} in it`, 409);
    const cap = Math.max(1, Math.floor(n(S().ovenPansPerLoad, 2, 1)));
    const remaining = b.pans - b.pansBaked - b.pansInOven;
    if (remaining <= 0) fail('All pans of this batch are already baked or in an oven', 409);
    const pans = Math.min(cap, remaining);
    b.loadCount = (b.loadCount || 0) + 1;
    o.current = {
      batchId: b.id, label: b.label, pans, startedAt: Date.now(),
      bakeMinutes: n(b.recipe.bakeMinutes, 10, 1), tempF: n(b.recipe.ovenTempF, 350),
      loadNo: b.loadCount, loadsTotal: Math.ceil(b.pans / cap),
    };
    b.pansInOven += pans;
    if (b.stage === 'staged') {
      b.t.bakeStart = Date.now();
      setStage(b, 'baking', 'Ovens');
    }
  },
  finishCooling(b) {
    need(b, 'cooling');
    b.t.packStart = Date.now();
    setStage(b, 'packing');
  },
  finishPacking(b) {
    need(b, 'packing');
    b.t.done = Date.now();
    setStage(b, 'done', 'Done');
  },
  toggleCheck(b, { stage, index }) {
    b.checks[stage] ||= [];
    b.checks[stage][index] = !b.checks[stage][index];
  },
  stepTimer(b, { stage, index }) {
    b.stepTimers[stage] ||= {};
    if (b.stepTimers[stage][index]) delete b.stepTimers[stage][index];
    else b.stepTimers[stage][index] = Date.now();
  },
  setRush(b, { rush }) {
    b.rush = !!rush;
  },
  // Manager override from the Overview page, for fixing mistakes.
  setStage(b, { stage }) {
    const now = Date.now();
    const order = ['queued', 'mixing', 'chilling', 'ready_prep', 'prepping', 'staged', 'baking', 'cooling', 'packing', 'done'];
    if (!order.includes(stage)) fail('Unknown stage');
    pullFromOvens(b);
    if (order.indexOf(stage) <= order.indexOf('staged')) b.pansBaked = 0;
    let loc = b.location;
    switch (stage) {
      case 'queued': b.t = {}; loc = 'Queue'; break;
      case 'mixing': {
        const busy = new Set(state.batches.filter((x) => x.stage === 'mixing' && x.id !== b.id).map((x) => x.location));
        loc = S().mixStations.find((x) => !busy.has(x)) || S().mixStations[0];
        b.t.mixStart = now; break;
      }
      case 'chilling': b.t.chillStart = now; loc = S().chillLocations[0]; break;
      case 'ready_prep': loc = 'Cookie Prep'; break;
      case 'prepping': b.t.prepStart = now; loc = 'Cookie Prep'; break;
      case 'staged': loc = 'Oven Staging Rack'; break;
      case 'baking': b.t.bakeStart = now; loc = 'Ovens'; break;
      case 'cooling': b.pansBaked = b.pans; b.t.coolStart = now; loc = b.coolingArea ||= pickCoolingArea(); break;
      case 'packing': b.pansBaked = b.pans; b.t.packStart = now; loc = b.coolingArea ||= pickCoolingArea(); break;
      case 'done': b.t.done = now; loc = 'Done'; break;
    }
    setStage(b, stage, loc);
  },
};

// ---------------------------------------------------------------- routes
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

const route = (fn) => (req, res) => {
  try {
    const result = fn(req) || {};
    commit();
    res.json({ ok: true, ...result });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    res.status(e.status || 500).json({ error: e.message });
  }
};

app.get('/api/state', (req, res) => res.json({ state, plan, serverTime: Date.now() }));
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Recipes
app.post('/api/recipes', route((req) => {
  const r = cleanRecipe(req.body);
  state.recipes.push(r);
  return { recipe: r };
}));
app.put('/api/recipes/:id', route((req) => {
  const i = state.recipes.findIndex((r) => r.id === req.params.id);
  if (i < 0) fail('Recipe not found', 404);
  state.recipes[i] = cleanRecipe(req.body, state.recipes[i]);
  return { recipe: state.recipes[i] };
}));
app.delete('/api/recipes/:id', route((req) => {
  findRecipe(req.params.id);
  state.recipes = state.recipes.filter((r) => r.id !== req.params.id);
}));
app.get('/api/recipes/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="cookie-recipes.json"');
  res.json(state.recipes);
});
app.post('/api/recipes/import', route((req) => {
  const list = Array.isArray(req.body) ? req.body : fail('Expected a JSON array of recipes');
  let added = 0, updated = 0;
  for (const raw of list) {
    const i = state.recipes.findIndex((r) => r.id === raw.id);
    let recipe;
    if (i >= 0) { recipe = state.recipes[i] = cleanRecipe(raw, state.recipes[i]); updated++; }
    else { recipe = cleanRecipe(raw, raw.id ? { id: String(raw.id) } : {}); state.recipes.push(recipe); added++; }
    // Files exported before pans moved to Cookie Prep: use it as a starting estimate.
    if (raw.pansPerBatch !== undefined) rememberPans(state, recipe.id, raw.pansPerBatch, true);
  }
  return { message: `Imported ${added} new, updated ${updated}` };
}));

// Batches
app.post('/api/batches', route((req) => {
  const r = findRecipe(req.body.recipeId);
  const count = Math.min(50, Math.max(1, Math.floor(n(req.body.count, 1, 1))));
  const now = Date.now();
  const pans = estimatePans(state, r.id);
  for (let k = 0; k < count; k++) {
    const number = (state.counters[r.id] = (state.counters[r.id] || 0) + 1);
    state.batches.push({
      id: newId(),
      recipeId: r.id,
      recipe: structuredClone(r), // snapshot: editing the recipe later won't disturb a running batch
      number,
      label: `${r.name} #${number}`,
      stage: 'queued',
      location: 'Queue',
      rush: !!req.body.rush,
      createdAt: now + k,
      pans, // estimate until Cookie Prep enters the real count
      pansEstimated: true,
      pansBaked: 0,
      pansInOven: 0,
      coolingArea: null,
      t: {},
      checks: {},
      stepTimers: {},
      log: [{ stage: 'queued', at: now }],
    });
  }
  return { message: `Queued ${count} × ${r.name}` };
}));
app.post('/api/batches/clear-done', route(() => {
  const before = state.batches.length;
  state.batches = state.batches.filter((b) => b.stage !== 'done');
  return { message: `Cleared ${before - state.batches.length} finished batches` };
}));
app.post('/api/batches/clear-all', route(() => {
  state.batches = [];
  state.counters = {};
  for (const o of Object.values(state.ovens)) o.current = null;
  return { message: 'All batches cleared' };
}));
app.delete('/api/batches/:id', route((req) => {
  const b = findBatch(req.params.id);
  pullFromOvens(b);
  state.batches = state.batches.filter((x) => x !== b);
}));
app.post('/api/batches/:id/:action', route((req) => {
  const fn = actions[req.params.action] || fail('Unknown action', 404);
  return fn(findBatch(req.params.id), req.body || {});
}));

// Ovens
app.post('/api/ovens/:id/temp', route((req) => {
  const o = oven(req.params.id);
  const raw = req.body.tempF;
  const to = raw === null || raw === '' || raw === undefined ? null : n(raw, null, 100);
  o.readyAt = to === null ? 0 : Date.now() + changeoverMs(o.targetTempF, to, S());
  o.targetTempF = to;
  return { message: to === null ? `${ovenName(req.params.id)} off` : `${ovenName(req.params.id)} set to ${to}°F` };
}));
app.post('/api/ovens/:id/ready', route((req) => {
  oven(req.params.id).readyAt = Date.now();
}));
app.post('/api/ovens/:id/unload', route((req) => {
  const o = oven(req.params.id);
  const c = o.current || fail('Oven is empty', 409);
  o.current = null;
  const b = state.batches.find((x) => x.id === c.batchId);
  if (!b) return;
  b.pansInOven = Math.max(0, b.pansInOven - c.pans);
  b.pansBaked += c.pans;
  b.coolingArea ||= pickCoolingArea();
  if (b.pansBaked >= b.pans) {
    b.t.coolStart = Date.now();
    setStage(b, 'cooling', b.coolingArea);
  }
  return { message: `Move ${c.pans} pan${c.pans > 1 ? 's' : ''} of ${b.label} to ${b.coolingArea}` };
}));

// Settings
app.put('/api/settings', route((req) => {
  const body = req.body || {};
  const cur = S();
  const names = strList(body.ovens ?? cur.ovens.map((o) => o.name));
  const next = {
    ...cur,
    kitchenName: String(body.kitchenName ?? cur.kitchenName).trim() || 'Cookie Kitchen',
    mixStations: strList(body.mixStations ?? cur.mixStations),
    chillLocations: strList(body.chillLocations ?? cur.chillLocations),
    coolingAreas: strList(body.coolingAreas ?? cur.coolingAreas),
    ovens: names.map((name, i) => ({ id: 'oven' + (i + 1), name })),
    prepStations: Math.round(n(body.prepStations, cur.prepStations, 1)),
    prepMinutesPerPan: n(body.prepMinutesPerPan, cur.prepMinutesPerPan),
    ovenPansPerLoad: Math.round(n(body.ovenPansPerLoad, cur.ovenPansPerLoad, 1)),
    defaultPansPerBatch: Math.round(n(body.defaultPansPerBatch, cur.defaultPansPerBatch, 1)),
    preheatMinutes: n(body.preheatMinutes, cur.preheatMinutes),
    heatUpMinutesPer25F: n(body.heatUpMinutesPer25F, cur.heatUpMinutesPer25F),
    coolDownMinutesPer25F: n(body.coolDownMinutesPer25F, cur.coolDownMinutesPer25F),
  };
  if (!next.mixStations.length) fail('Need at least one mix station');
  if (!next.ovens.length) fail('Need at least one oven');
  state.settings = next;
  for (const o of next.ovens) state.ovens[o.id] ||= { targetTempF: null, readyAt: 0, current: null };
  return { message: 'Settings saved' };
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------------------------------------------------------------- start
replan();
setInterval(() => { replan(); broadcast(); }, REPLAN_INTERVAL_MS);

function shutdown() {
  try { saveNow(); } catch (e) { console.error(e); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log(`Cookie Flow listening on http://0.0.0.0:${PORT} (data: ${DATA_FILE})`));
