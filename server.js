'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { computePlan, changeoverMs, localDate, ovenCapacity } = require('./scheduler');
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
  // prepStations was a count of people, then a list of names; now [{ name, capacity }].
  if (!Array.isArray(s.settings.prepStations)) {
    const count = Math.max(1, Math.round(Number(s.settings.prepStations) || 1));
    s.settings.prepStations = count === 1 ? ['Cookie Prep'] : Array.from({ length: count }, (_, i) => `Cookie Prep #${i + 1}`);
  }
  s.settings.prepStations = cleanPrepStations(s.settings.prepStations);
  s.recipes ||= [];
  s.batches ||= [];
  s.ovens ||= {};
  s.counters ||= {};
  s.panHistory ||= {};
  s.dismissedAlarms ||= [];
  s.packLog ||= []; // what was actually packed, kept until "start a new day"
  for (const r of s.recipes) if (r.perContainer === undefined) r.perContainer = 6; // alarm keys someone tapped OK on (shared by all tablets)
  for (const b of s.batches) {
    if (b.coolGroups) continue;
    b.coolGroups = ['cooling', 'packing', 'done'].includes(b.stage) ? [{ pans: b.pans, outAt: b.t?.coolStart || Date.now(), ovenId: null }] : [];
  }
  // Each recipe carries its own estimated pans per batch and prep minutes per
  // pan (Cookie Prep still enters the actual pan count). Fill them in for older
  // data from what prep reported before, or the old kitchen-wide defaults.
  for (const r of s.recipes) {
    if (r.pansPerBatch === undefined) r.pansPerBatch = averagePans(s, r.id) ?? Math.max(1, Math.round(Number(s.settings.defaultPansPerBatch) || 4));
    if (r.prepMinutesPerPan === undefined || r.prepMinutesPerPan === null) r.prepMinutesPerPan = Number(s.settings.prepMinutesPerPan) || 4;
  }
  // Each oven has its own pan capacity (older data had one setting for all).
  for (const o of s.settings.ovens) if (o.capacity === undefined) o.capacity = ovenCapacity(o, s.settings);
  for (const o of s.settings.ovens) s.ovens[o.id] ||= { targetTempF: null, readyAt: 0, items: [] };
  // An oven used to hold one load (`current`); it now holds a list of pans
  // from one or more batches at the same temperature (`items`).
  for (const o of Object.values(s.ovens)) {
    if (!o.items) o.items = o.current ? [{ id: crypto.randomBytes(6).toString('hex'), ...o.current }] : [];
    delete o.current;
  }
  return s;
}

// ---------------------------------------------------------------- bake days
/** 'today' | 'tomorrow' | 'YYYY-MM-DD' → YYYY-MM-DD (server's local time zone). */
function resolveBakeDate(v) {
  const now = new Date();
  if (v === undefined || v === null || v === '' || v === 'today') return localDate(now.getTime());
  if (v === 'tomorrow') return localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12).getTime());
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
    if (String(v) < localDate(now.getTime())) fail('Bake day is in the past');
    return String(v);
  }
  fail('Bake day must be today, tomorrow or a date (YYYY-MM-DD)');
}

// ---------------------------------------------------------------- ovens
// Accepts [{ name, capacity }], plain names, or text with one name per line.
// Ovens are identified by position (oven1, oven2, …) so their state carries over.
function cleanOvens(v, current, fallbackCap) {
  const list = Array.isArray(v) ? v : String(v || '').split('\n');
  const out = [];
  for (const item of list) {
    const name = String(typeof item === 'object' && item ? item.name : item || '').trim();
    if (!name) continue;
    const i = out.length;
    const cap = Math.round(Number(typeof item === 'object' && item ? item.capacity : NaN));
    const keep = current[i]?.capacity ?? fallbackCap;
    out.push({ id: 'oven' + (i + 1), name, capacity: Math.min(50, Math.max(1, Number.isFinite(cap) ? cap : keep)) });
  }
  return out;
}

// ---------------------------------------------------------------- prep stations
// Accepts [{ name, capacity }], plain names, or text with one name per line.
function cleanPrepStations(v) {
  const list = Array.isArray(v) ? v : String(v || '').split('\n');
  const out = [];
  for (const item of list) {
    const name = String(typeof item === 'object' && item ? item.name : item || '').trim();
    if (!name || out.some((x) => x.name === name)) continue;
    const cap = Math.round(Number(typeof item === 'object' && item ? item.capacity : 1));
    out.push({ name, capacity: Math.min(20, Math.max(1, Number.isFinite(cap) ? cap : 1)) });
  }
  return out;
}
/** First prep station with room for another batch (or null). */
function prepStationWithRoom(excludeId) {
  const used = {};
  for (const x of state.batches) if (x.stage === 'prepping' && x.id !== excludeId) used[x.location] = (used[x.location] || 0) + 1;
  return S().prepStations.find((st) => (used[st.name] || 0) < st.capacity) || null;
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
/** Average of the pan counts Cookie Prep reported recently (null if none). */
function averagePans(s, recipeId) {
  const list = s.panHistory[recipeId] || [];
  return list.length ? Math.max(1, Math.round(list.reduce((a, b) => a + b, 0) / list.length)) : null;
}
/** Expected pans for a new batch: the recipe's own estimate. */
function estimatePans(s, recipe) {
  return Math.max(1, Math.round(Number(recipe.pansPerBatch) || averagePans(s, recipe.id) || 4));
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
    perContainer: Math.round(n(input.perContainer, 6)), // cookies per container; 0 = not part of shares
    mixMinutes: n(input.mixMinutes, 15),
    ingredients: strList(input.ingredients),
    mixSteps: steps(input.mixSteps),
    chillMinutes: n(input.chillMinutes, 0),
    chillNotes: String(input.chillNotes || ''),
    // Long/overnight chill: mix on the day before the bake day.
    mixDayBefore: input.mixDayBefore === true || input.mixDayBefore === 'true' || input.mixDayBefore === 'on',
    pansPerBatch: Math.round(n(input.pansPerBatch, existing.pansPerBatch ?? 4, 1)), // estimate; prep enters the actual
    prepMinutesPerPan: n(input.prepMinutesPerPan, existing.prepMinutesPerPan ?? 4),
    prepSteps: steps(input.prepSteps),
    panChillMinutes: n(input.panChillMinutes, 0), // chill the panned dough before baking (0 = none)
    panChillNotes: String(input.panChillNotes || ''),
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

// Checklist keys and the recipe field holding their steps. Post-bake checks are
// per cooling group ("finish-0", "finish-1", ...).
const STEP_FIELDS = { mix: 'mixSteps', prep: 'prepSteps', finish: 'finishSteps', pack: 'packSteps' };

/** Push an edited recipe into a batch that is still in progress. */
function applyRecipe(b, r) {
  const texts = (list) => JSON.stringify((list || []).map((s) => s.text));
  for (const [key, field] of Object.entries(STEP_FIELDS)) {
    if (texts(b.recipe[field]) === texts(r[field])) continue;
    // Steps changed: old ticks would line up with the wrong steps, so clear them.
    for (const store of [b.checks, b.stepTimers]) {
      for (const k of Object.keys(store)) if (k === key || k.startsWith(key + '-')) delete store[k];
    }
  }
  b.recipe = structuredClone(r);
  b.label = `${r.name} #${b.number}`;
  if (b.pansEstimated) b.pans = estimatePans(state, r); // not prepped yet: use the new estimate
  for (const o of Object.values(state.ovens)) {
    for (const it of o.items) {
      if (it.batchId !== b.id) continue;
      it.bakeMinutes = r.bakeMinutes;
      it.tempF = r.ovenTempF;
      it.label = b.label;
    }
  }
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
  for (const o of Object.values(state.ovens)) o.items = o.items.filter((it) => it.batchId !== b.id);
  b.pansInOven = 0;
}

// ---------------------------------------------------------------- oven contents
const ovenCap = (ovenId) => ovenCapacity(S().ovens.find((o) => o.id === ovenId), S());
const pansIn = (o) => o.items.reduce((sum, it) => sum + it.pans, 0);
const itemEnd = (it) => it.startedAt + (it.bakeMinutes + (it.extraMinutes || 0)) * 60000;
/** The pans the request means: by itemId, or the only thing in the oven. */
function findItem(o, ovenId, itemId) {
  if (!o.items.length) fail(`${ovenName(ovenId)} is empty`, 409);
  if (itemId) return o.items.find((it) => it.id === itemId) || fail('Those pans are no longer in the oven', 404);
  if (o.items.length === 1) return o.items[0];
  fail(`${ovenName(ovenId)} has pans from more than one batch — say which (itemId)`);
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
  startPrep(b, { station }) {
    need(b, 'chilling', 'ready_prep');
    let st;
    if (station) {
      const def = S().prepStations.find((x) => x.name === station) || fail(`Unknown prep station: ${station}`);
      const inUse = state.batches.filter((x) => x.stage === 'prepping' && x.location === def.name).length;
      if (inUse >= def.capacity) fail(`${def.name} is full (${def.capacity} batch${def.capacity > 1 ? 'es' : ''} at once)`, 409);
      st = def.name;
    } else {
      st = (prepStationWithRoom() || fail('All prep stations are full')).name;
    }
    if (b.stage === 'chilling') b.t.chillEnd = Date.now();
    if (b.bakeDate && b.bakeDate > localDate()) b.bakeDate = localDate(); // pulled forward to today
    b.t.prepStart = Date.now();
    setStage(b, 'prepping', st);
  },
  finishPrep(b, { pans, to }) {
    need(b, 'prepping');
    const filled = Number(pans);
    if (!Number.isInteger(filled) || filled < 1 || filled > 200) fail('Enter how many pans were filled (a whole number, 1 or more)');
    b.pans = filled;
    b.pansEstimated = false;
    rememberPans(state, b.recipeId, filled);
    b.t.prepEnd = Date.now();
    const panChill = Number(b.recipe.panChillMinutes) || 0;
    if (panChill > 0 && to !== 'rack') {
      const loc = to || S().chillLocations[0] || 'Fridge';
      b.t.panChillStart = Date.now();
      setStage(b, 'pan_chilling', loc);
      return { message: `Put ${filled} pans of ${b.label} in the ${loc} — chill ${panChill} min before baking` };
    }
    setStage(b, 'staged', 'Oven Staging Rack');
    return { message: `Put ${filled} pans of ${b.label} on the Oven Staging Rack` };
  },
  finishPanChill(b) {
    need(b, 'pan_chilling');
    b.t.panChillEnd = Date.now();
    setStage(b, 'staged', 'Oven Staging Rack');
    return { message: `Move ${b.pans} pans of ${b.label} to the Oven Staging Rack` };
  },
  loadOven(b, { ovenId }) {
    need(b, 'staged', 'baking', 'pan_chilling'); // baker may load straight from the chiller
    const o = oven(ovenId);
    const room = ovenCap(ovenId) - pansIn(o);
    if (room <= 0) fail(`${ovenName(ovenId)} is full (${ovenCap(ovenId)} pans)`, 409);
    const tempF = n(b.recipe.ovenTempF, 350);
    // Batches can share an oven only at the same temperature.
    const other = o.items.find((it) => it.tempF !== tempF);
    if (other) fail(`${ovenName(ovenId)} is baking ${other.label} at ${other.tempF}°F — ${b.label} bakes at ${tempF}°F`, 409);
    const remaining = b.pans - b.pansBaked - b.pansInOven;
    if (remaining <= 0) fail('All pans of this batch are already baked or in an oven', 409);
    const pans = Math.min(room, remaining);
    b.loadCount = (b.loadCount || 0) + 1;
    o.items.push({
      id: newId(), batchId: b.id, label: b.label, pans, startedAt: Date.now(),
      bakeMinutes: n(b.recipe.bakeMinutes, 10, 1), tempF, loadNo: b.loadCount,
      extraMinutes: 0, // added by the baker while baking
    });
    b.pansInOven += pans;
    if (b.stage === 'pan_chilling') b.t.panChillEnd = Date.now();
    if (b.stage === 'staged' || b.stage === 'pan_chilling') {
      b.t.bakeStart = Date.now();
      setStage(b, 'baking', 'Ovens');
    }
    const sharing = o.items.length > 1;
    return { message: `${pans} pan${pans > 1 ? 's' : ''} of ${b.label} into ${ovenName(ovenId)}${sharing ? ` — now ${pansIn(o)} of ${ovenCap(ovenId)} pans` : ''}` };
  },
  finishCooling(b) {
    need(b, 'cooling');
    b.t.packStart = Date.now();
    setStage(b, 'packing');
  },
  finishPacking(b, { containers, perContainer }) {
    need(b, 'packing');
    const c = Number(containers), per = Number(perContainer);
    if (!Number.isInteger(c) || c < 0 || c > 10000) fail('Enter how many containers you packed (a whole number)');
    if (!Number.isInteger(per) || per < 1 || per > 1000) fail('Enter how many cookies are in each container');
    b.packed = { containers: c, perContainer: per, cookies: c * per };
    state.packLog.push({ batchId: b.id, recipeId: b.recipeId, name: b.recipe.name, label: b.label, ...b.packed, at: Date.now() });
    b.t.done = Date.now();
    setStage(b, 'done', 'Done');
    return { message: `${b.label}: ${c} container${c === 1 ? '' : 's'} × ${per} = ${c * per} cookies packed` };
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
  setBakeDay(b, { bakeDay }) {
    if (!['queued', 'mixing', 'chilling'].includes(b.stage)) fail(`${b.label} is already past chilling — it's being baked today`, 409);
    b.bakeDate = resolveBakeDate(bakeDay);
    return { message: `${b.label} now bakes ${b.bakeDate === localDate() ? 'today' : b.bakeDate === resolveBakeDate('tomorrow') ? 'tomorrow' : b.bakeDate}` };
  },
  // Manager override from the Overview page, for fixing mistakes.
  setStage(b, { stage }) {
    const now = Date.now();
    const order = ['queued', 'mixing', 'chilling', 'ready_prep', 'prepping', 'pan_chilling', 'staged', 'baking', 'cooling', 'packing', 'done'];
    if (!order.includes(stage)) fail('Unknown stage');
    pullFromOvens(b);
    if (stage !== 'done' && b.packed) { // un-doing a packed batch: take its count back out
      state.packLog = state.packLog.filter((e) => e.batchId !== b.id);
      delete b.packed;
    }
    if (order.indexOf(stage) <= order.indexOf('staged')) { b.pansBaked = 0; b.coolGroups = []; }
    if (['cooling', 'packing', 'done'].includes(stage)) {
      const out = b.coolGroups.reduce((sum, g) => sum + g.pans, 0);
      if (out < b.pans) b.coolGroups.push({ pans: b.pans - out, outAt: now, ovenId: null });
    }
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
      case 'prepping': {
        loc = (prepStationWithRoom(b.id) || S().prepStations[0]).name;
        b.t.prepStart = now; break;
      }
      case 'pan_chilling': b.t.panChillStart = now; loc = S().chillLocations[0]; break;
      case 'staged': loc = 'Oven Staging Rack'; break;
      case 'baking': b.t.bakeStart = now; loc = 'Ovens'; break;
      case 'cooling': b.pansBaked = b.pans; b.t.coolStart ||= now; b.t.allOut = now; loc = b.coolingArea ||= pickCoolingArea(); break;
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
  const r = (state.recipes[i] = cleanRecipe(req.body, state.recipes[i]));
  const active = state.batches.filter((b) => b.recipeId === r.id && b.stage !== 'done');
  for (const b of active) applyRecipe(b, r);
  return { recipe: r, message: active.length ? `Updated ${active.length} active batch${active.length > 1 ? 'es' : ''}` : undefined };
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
    if (i >= 0) {
      recipe = state.recipes[i] = cleanRecipe(raw, state.recipes[i]);
      for (const b of state.batches) if (b.recipeId === recipe.id && b.stage !== 'done') applyRecipe(b, recipe);
      updated++;
    }
    else { recipe = cleanRecipe(raw, raw.id ? { id: String(raw.id) } : {}); state.recipes.push(recipe); added++; }
  }
  return { message: `Imported ${added} new, updated ${updated}` };
}));

// Batches
app.post('/api/batches', route((req) => {
  const r = findRecipe(req.body.recipeId);
  const count = Math.min(50, Math.max(1, Math.floor(n(req.body.count, 1, 1))));
  const now = Date.now();
  const pans = estimatePans(state, r);
  // Mix-the-day-before recipes default to baking tomorrow.
  const bakeDate = resolveBakeDate(req.body.bakeDay ?? (r.mixDayBefore ? 'tomorrow' : 'today'));
  for (let k = 0; k < count; k++) {
    const number = (state.counters[r.id] = (state.counters[r.id] || 0) + 1);
    state.batches.push({
      id: newId(),
      recipeId: r.id,
      recipe: structuredClone(r), // copy, so deleting the recipe can't break a running batch (edits are pushed in by applyRecipe)
      number,
      label: `${r.name} #${number}`,
      stage: 'queued',
      location: 'Queue',
      rush: !!req.body.rush,
      bakeDate,
      createdAt: now + k,
      pans, // estimate until Cookie Prep enters the real count
      pansEstimated: true,
      pansBaked: 0,
      pansInOven: 0,
      coolingArea: null,
      coolGroups: [], // one entry per oven load taken out: { pans, outAt, ovenId }
      t: {},
      checks: {},
      stepTimers: {},
      log: [{ stage: 'queued', at: now }],
    });
  }
  const later = bakeDate > localDate();
  return { message: `Queued ${count} × ${r.name}${later ? ` for ${bakeDate === resolveBakeDate('tomorrow') ? 'tomorrow' : bakeDate}${r.mixDayBefore ? ' — mix today, chill overnight' : ''}` : ''}` };
}));
app.post('/api/batches/clear-done', route(() => {
  const before = state.batches.length;
  state.batches = state.batches.filter((b) => b.stage !== 'done');
  return { message: `Cleared ${before - state.batches.length} finished batches` };
}));
app.post('/api/batches/clear-all', route(() => {
  state.batches = [];
  state.counters = {};
  for (const o of Object.values(state.ovens)) o.items = [];
  state.packLog = [];
  return { message: 'All batches and packed counts cleared' };
}));
// "Clear finished batches" keeps the packed counts; this resets them for a new day.
app.post('/api/pack/reset', route(() => {
  state.packLog = [];
  return { message: 'Packed counts reset' };
}));
app.delete('/api/batches/:id', route((req) => {
  const b = findBatch(req.params.id);
  pullFromOvens(b);
  state.batches = state.batches.filter((x) => x !== b);
  state.packLog = state.packLog.filter((e) => e.batchId !== b.id); // deleted by mistake / duplicate
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
  o.readyConfirmed = false;
  return { message: to === null ? `${ovenName(req.params.id)} off` : `${ovenName(req.params.id)} set to ${to}°F` };
}));
app.post('/api/ovens/:id/ready', route((req) => {
  const o = oven(req.params.id);
  o.readyAt = Date.now();
  o.readyConfirmed = true; // baker checked it, no need to alarm
}));
app.post('/api/ovens/:id/extend', route((req) => {
  const o = oven(req.params.id);
  if (!o.items.length) fail('Nothing is baking in this oven', 409);
  const c = findItem(o, req.params.id, req.body.itemId);
  const minutes = Number(req.body.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 120) fail('Add between 0 and 120 minutes');
  c.extraMinutes = (c.extraMinutes || 0) + minutes;
  const end = itemEnd(c);
  const at = new Date(end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return { message: `Added ${minutes} min to ${c.label} — now done at ${at}` };
}));
app.post('/api/ovens/:id/unload', route((req) => {
  const o = oven(req.params.id);
  const c = findItem(o, req.params.id, req.body?.itemId);
  o.items = o.items.filter((it) => it !== c);
  const b = state.batches.find((x) => x.id === c.batchId);
  if (!b) return;
  const now = Date.now();
  b.pansInOven = Math.max(0, b.pansInOven - c.pans);
  b.pansBaked += c.pans;
  b.coolingArea ||= pickCoolingArea();
  // These pans start cooling (and their post-bake clock starts) right now,
  // even if the rest of the batch is still on the rack or in another oven.
  b.coolGroups.push({ pans: c.pans, outAt: now, ovenId: req.params.id });
  b.t.coolStart ||= now;
  if (b.pansBaked >= b.pans && b.pansInOven === 0) {
    b.t.allOut = now;
    setStage(b, 'cooling', b.coolingArea);
  }
  return { message: `Move ${c.pans} pan${c.pans > 1 ? 's' : ''} of ${b.label} to ${b.coolingArea}` };
}));

// Alarms: tapping OK on any tablet silences that alarm on every tablet.
const DISMISSED_KEEP = 1000;
app.post('/api/alarms/dismiss', route((req) => {
  const keys = (Array.isArray(req.body.keys) ? req.body.keys : [])
    .map((k) => String(k).slice(0, 200))
    .filter(Boolean);
  if (!keys.length) fail('No alarm keys given');
  const set = new Set(state.dismissedAlarms);
  for (const k of keys) set.add(k);
  state.dismissedAlarms = [...set].slice(-DISMISSED_KEEP);
}));

// Settings
app.put('/api/settings', route((req) => {
  const body = req.body || {};
  const cur = S();
  const next = {
    ...cur,
    kitchenName: String(body.kitchenName ?? cur.kitchenName).trim() || 'Cookie Kitchen',
    mixStations: strList(body.mixStations ?? cur.mixStations),
    chillLocations: strList(body.chillLocations ?? cur.chillLocations),
    coolingAreas: strList(body.coolingAreas ?? cur.coolingAreas),
    ovens: cleanOvens(body.ovens ?? cur.ovens, cur.ovens, ovenCapacity(null, cur)),
    prepStations: cleanPrepStations(body.prepStations ?? cur.prepStations),
    prepMinutesPerPan: n(body.prepMinutesPerPan, cur.prepMinutesPerPan),
    ovenPansPerLoad: Math.round(n(body.ovenPansPerLoad, cur.ovenPansPerLoad, 1)),
    defaultPansPerBatch: Math.round(n(body.defaultPansPerBatch, cur.defaultPansPerBatch, 1)),
    shares: Math.round(n(body.shares, cur.shares)), // containers of each cookie to pack (0 = not tracking)
    preheatMinutes: n(body.preheatMinutes, cur.preheatMinutes),
    heatUpMinutesPer25F: n(body.heatUpMinutesPer25F, cur.heatUpMinutesPer25F),
    coolDownMinutesPer25F: n(body.coolDownMinutesPer25F, cur.coolDownMinutesPer25F),
  };
  if (!next.mixStations.length) fail('Need at least one mix station');
  if (!next.prepStations.length) fail('Need at least one prep station');
  if (!next.ovens.length) fail('Need at least one oven');
  state.settings = next;
  for (const o of next.ovens) state.ovens[o.id] ||= { targetTempF: null, readyAt: 0, items: [] };
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
