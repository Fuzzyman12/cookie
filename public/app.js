'use strict';
/* Cookie Flow tablet client. Vanilla JS, re-renders on every server push. */

const App = { state: null, plan: null, offset: 0, connected: false, audio: null, fired: new Set(), locked: false, routeKey: null };
const MIN = 60000;
const now = () => Date.now() + App.offset;
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const attr = (o) => esc(JSON.stringify(o));

const STATIONS = [
  { key: 'mixing', name: 'Mixing', icon: '🥣', desc: 'Mix Stations #1–#4' },
  { key: 'chilling', name: 'Chilling', icon: '❄️', desc: 'Fridge & Outdoor Chiller' },
  { key: 'prep', name: 'Cookie Prep', icon: '🍪', desc: 'Scoop & pan the dough' },
  { key: 'baking', name: 'Baking', icon: '🔥', desc: 'Ovens & staging rack' },
  { key: 'cooling', name: 'Cooling & Packing', icon: '📦', desc: 'Cool, finish, pack' },
];
const ADMIN = [
  { key: 'overview', name: 'Overview', icon: '📋' },
  { key: 'recipes', name: 'Recipes', icon: '📖' },
  { key: 'settings', name: 'Settings', icon: '⚙️' },
];
const STAGES = ['queued', 'mixing', 'chilling', 'ready_prep', 'prepping', 'staged', 'baking', 'cooling', 'packing', 'done'];
const STAGE_LABEL = {
  queued: 'Queued', mixing: 'Mixing', chilling: 'Chilling', ready_prep: 'Waiting for prep', prepping: 'Prepping',
  staged: 'On staging rack', baking: 'Baking', cooling: 'Cooling', packing: 'Finishing & packing', done: 'Done',
};

// ------------------------------------------------------------------ formatting
const pad = (x) => String(x).padStart(2, '0');
function fmtDur(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function fmtMin(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  return m >= 60 ? `${Math.floor(m / 60)}h ${pad(m % 60)}m` : `${m} min`;
}
const fmtTime = (t) => (t ? new Date(t - App.offset).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—');
const rel = (t) => (t <= now() + 30000 ? 'now' : `in ${fmtMin(t - now())}`);

// ------------------------------------------------------------------ data helpers
const S = () => App.state.settings;
const B = (id) => App.state.batches.find((b) => b.id === id);
const P = (id) => (App.plan && App.plan.batches[id]) || { loads: [] };
const inStage = (...st) => App.state.batches.filter((b) => st.includes(b.stage));
const ovenName = (id) => (S().ovens.find((o) => o.id === id) || {}).name || id;
const remainingPans = (b) => b.pans - b.pansBaked - b.pansInOven;
const chillDone = (b) => b.stage === 'chilling' && now() >= b.t.chillStart + b.recipe.chillMinutes * MIN;
const readyForPrep = (b) => b.stage === 'ready_prep' || chillDone(b);

// ------------------------------------------------------------------ UI snippets
const btn = (label, act, data = {}, cls = '') =>
  `<button class="btn ${cls}" data-act="${act}" ${Object.entries(data).map(([k, v]) => `data-${k}="${esc(typeof v === 'object' ? JSON.stringify(v) : v)}"`).join(' ')}>${label}</button>`;
const batchBtn = (b, action, label, body = {}, cls = '', confirm = '') =>
  btn(label, 'batch', { id: b.id, action, body, ...(confirm ? { confirm } : {}) }, cls);

const timerDown = (end, alertKey, msg) =>
  `<span class="timer" data-end="${end}"${alertKey ? ` data-alert="${esc(alertKey)}" data-msg="${esc(msg)}"` : ''}>${fmtDur(end - now())}</span>`;
const timerUp = (start) => `<span class="timer up" data-start="${start}">${fmtDur(now() - start)}</span>`;
const progress = (start, end) => `<div class="progress"><div data-pstart="${start}" data-pend="${end}"></div></div>`;
const relTime = (t) => `<span class="rel" data-at="${t}">${rel(t)}</span>`;

function title(b, extra = '') {
  return `<div class="btitle" style="--c:${esc(b.recipe.color)}"><span class="swatch"></span><span class="bname">${esc(b.label)}</span>${b.rush ? '<span class="badge rush">RUSH</span>' : ''}${extra}</div>`;
}
const chips = (items) => `<div class="chips">${items.filter(Boolean).map((c) => `<span class="chip">${c}</span>`).join('')}</div>`;
const recipeChips = (r, pans) => chips([
  r.chillMinutes > 0 ? `❄️ chill ${r.chillMinutes}m` : 'no chill',
  `🔥 ${r.ovenTempF}°F · ${r.bakeMinutes}m`,
  `${pans ?? r.pansPerBatch} pans`,
  `≈${r.yieldPerBatch} cookies`,
]);

function stepList(b, key, list, { timers = true } = {}) {
  if (!list || !list.length) return '';
  const checks = b.checks[key] || [];
  const tmr = b.stepTimers[key] || {};
  return `<ol class="steps">${list.map((s, i) => {
    let t = '';
    if (timers && s.minutes) {
      t = tmr[i]
        ? `${timerDown(tmr[i] + s.minutes * MIN, `step-${b.id}-${key}-${i}-${tmr[i]}`, `${b.label}: "${s.text}" timer done`)} ${btn('reset', 'batch', { id: b.id, action: 'stepTimer', body: { stage: key, index: i } }, 'tiny ghost')}`
        : btn(`⏱ ${s.minutes} min`, 'batch', { id: b.id, action: 'stepTimer', body: { stage: key, index: i } }, 'tiny');
    }
    return `<li class="${checks[i] ? 'checked' : ''}"><button class="check" data-act="batch" data-id="${b.id}" data-action="toggleCheck" data-body="${attr({ stage: key, index: i })}">${checks[i] ? '✓' : ''}</button><span class="stext">${esc(s.text)}</span>${t}</li>`;
  }).join('')}</ol>`;
}
const empty = (msg) => `<div class="empty">${msg}</div>`;
const section = (h, body, extra = '') => `<section class="section"><h2>${h}${extra}</h2>${body}</section>`;

// ------------------------------------------------------------------ pages
const pages = {};

pages.home = () => `
  <div class="home">
    <h1>Pick this tablet's station</h1>
    <p class="muted">Bookmark the station page (or add it to the home screen) on each tablet.</p>
    <div class="tiles">${STATIONS.map((s) => `<a class="tile" href="#/${s.key}"><span class="ticon">${s.icon}</span><b>${s.name}</b><span class="muted">${s.desc}</span><span class="tcount">${stationCount(s.key)}</span></a>`).join('')}</div>
    <div class="tiles small">${ADMIN.map((s) => `<a class="tile" href="#/${s.key}"><span class="ticon">${s.icon}</span><b>${s.name}</b></a>`).join('')}</div>
  </div>`;

function stationCount(key) {
  const c = {
    mixing: inStage('queued', 'mixing').length,
    chilling: inStage('chilling').length,
    prep: inStage('ready_prep', 'prepping').length + inStage('chilling').filter(chillDone).length,
    baking: inStage('staged', 'baking').length,
    cooling: inStage('cooling', 'packing').length,
  }[key];
  return c ? `${c} active` : '';
}

// ---------- Mixing
pages.mixing = () => {
  const mixing = inStage('mixing');
  const queue = App.plan.mixQueue.map(B).filter(Boolean);
  const busy = new Set(mixing.map((b) => b.location));
  const free = S().mixStations.filter((x) => !busy.has(x));
  let html = '';

  if (queue.length) {
    const b = queue[0], r = b.recipe;
    const startBtns = free.length
      ? free.map((st) => batchBtn(b, 'startMix', `Start at ${esc(st)}`, { station: st }, 'primary big')).join('')
      : `<div class="muted">All mix stations busy — next one frees up ${relTime(P(b.id).mixStart)}.</div>`;
    html += `<div class="card next" style="--c:${esc(r.color)}">
      <div class="eyebrow">Up next to mix</div>${title(b)}${recipeChips(r, b.pans)}
      ${why(b)}
      <h4>Gather ingredients</h4>
      <ul class="ingredients">${r.ingredients.map((i) => `<li>${esc(i)}</li>`).join('') || '<li class="muted">No ingredients listed</li>'}</ul>
      <div class="btnrow">${startBtns}</div></div>`;
  } else {
    html += empty('Nothing queued to mix. Add batches from <a href="#/overview">Overview</a>.');
  }

  html += section('Mix stations', `<div class="grid">${S().mixStations.map((st) => {
    const b = mixing.find((x) => x.location === st);
    if (!b) return `<div class="card idle"><div class="eyebrow">${esc(st)}</div><div class="muted big">Free</div></div>`;
    const r = b.recipe;
    const target = b.t.mixStart + r.mixMinutes * MIN;
    const done = r.chillMinutes > 0
      ? S().chillLocations.map((loc) => batchBtn(b, 'finishMix', `Done → ${esc(loc)}`, { to: loc }, 'primary')).join('')
      : batchBtn(b, 'finishMix', 'Done → Cookie Prep', { to: 'prep' }, 'primary');
    return `<div class="card active" style="--c:${esc(r.color)}"><div class="eyebrow">${esc(st)}</div>${title(b)}
      <div class="meta">Mixing ${timerUp(b.t.mixStart)} · planned ${r.mixMinutes} min ${progress(b.t.mixStart, target)}</div>
      <details><summary>Ingredients (${r.ingredients.length})</summary><ul class="ingredients">${r.ingredients.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></details>
      ${stepList(b, 'mix', r.mixSteps)}
      ${r.chillMinutes > 0 ? `<div class="hint">❄️ Needs ${r.chillMinutes} min chill. ${esc(r.chillNotes)}</div>` : '<div class="hint">No chill needed — goes straight to Cookie Prep.</div>'}
      <div class="btnrow">${done}</div></div>`;
  }).join('')}</div>`);

  html += section('Mixing queue', queue.length > 1 ? table(['#', 'Batch', 'Planned start', 'Chill', 'Oven'], queue.slice(1).map((b, i) => [
    i + 2, title(b), `${fmtTime(P(b.id).mixStart)} <span class="muted">(${relTime(P(b.id).mixStart)})</span>`,
    b.recipe.chillMinutes ? `${b.recipe.chillMinutes}m` : '—', `${b.recipe.ovenTempF}°F`,
  ])) : empty('No more batches waiting.'));
  return html;
};

function why(b) {
  const p = P(b.id);
  const bits = [];
  if (b.rush) bits.push('marked rush');
  if (b.recipe.chillMinutes >= 30) bits.push(`long chill (${b.recipe.chillMinutes} min) — starting it early keeps the ovens busy`);
  const first = p.loads[0];
  if (first) bits.push(`planned for ${ovenName(first.ovenId)} at ${first.temp}°F around ${fmtTime(first.start)}`);
  return bits.length ? `<div class="why">Why now: ${bits.join('; ')}.</div>` : '';
}

// ---------- Chilling
pages.chilling = () => {
  const chilling = inStage('chilling').sort((a, b) => P(a.id).prepStart - P(b.id).prepStart);
  const prepRank = new Map(App.plan.prepQueue.map((id, i) => [id, i + 1]));
  let html = '';
  const byLoc = {};
  for (const b of chilling) (byLoc[b.location] ||= []).push(b);
  const locs = [...new Set([...S().chillLocations, ...Object.keys(byLoc)])];

  html += locs.map((loc) => section(`❄️ ${esc(loc)}`, (byLoc[loc] || []).length ? `<div class="grid">${byLoc[loc].map((b) => {
    const r = b.recipe;
    const end = b.t.chillStart + r.chillMinutes * MIN;
    const ready = now() >= end;
    return `<div class="card ${ready ? 'ready' : 'active'}" style="--c:${esc(r.color)}">${title(b)}
      <div class="bigtimer">${timerDown(end, `chill-${b.id}`, `${b.label} is chilled — take it to Cookie Prep`)}</div>
      ${progress(b.t.chillStart, end)}
      <div class="meta">In since ${fmtTime(b.t.chillStart)} · ${r.chillMinutes} min chill · prep order #${prepRank.get(b.id) || '—'} · planned prep ${fmtTime(P(b.id).prepStart)}</div>
      ${r.chillNotes ? `<div class="hint">${esc(r.chillNotes)}</div>` : ''}
      <div class="btnrow">${batchBtn(b, 'finishChill', 'Take to Cookie Prep →', {}, ready ? 'primary big' : '', ready ? '' : `${b.label} still has chill time left. Move it anyway?`)}</div>
    </div>`;
  }).join('')}</div>` : empty('Empty'))).join('');

  const incoming = [...inStage('mixing'), ...App.plan.mixQueue.map(B).filter(Boolean)].filter((b) => b.recipe.chillMinutes > 0).slice(0, 8);
  html += section('Coming to chill', incoming.length ? table(['Batch', 'Status', 'Arrives', 'Chill'], incoming.map((b) => [
    title(b), STAGE_LABEL[b.stage], `${fmtTime(P(b.id).mixEnd)} (${relTime(P(b.id).mixEnd)})`, `${b.recipe.chillMinutes} min`,
  ])) : empty('Nothing headed to the chillers.'));
  return html;
};

// ---------- Prep
pages.prep = () => {
  const prepping = inStage('prepping');
  const queue = App.plan.prepQueue.map(B).filter((b) => b && b.stage !== 'prepping');
  let html = '';

  html += prepping.map((b) => {
    const r = b.recipe;
    const target = b.t.prepStart + b.pans * r.prepMinutesPerPan * MIN;
    return `<div class="card active" style="--c:${esc(r.color)}"><div class="eyebrow">Prepping now</div>${title(b)}
      <div class="meta">Make <b>${b.pans} pans</b> · ${timerUp(b.t.prepStart)} elapsed · planned ${fmtMin(target - b.t.prepStart)} ${progress(b.t.prepStart, target)}</div>
      ${stepList(b, 'prep', r.prepSteps)}
      <div class="hint">Oven: ${r.ovenTempF}°F for ${r.bakeMinutes} min — oven loads ${S().ovenPansPerLoad} pans at a time.</div>
      <div class="btnrow">${batchBtn(b, 'finishPrep', 'Done → Oven Staging Rack', {}, 'primary big')}</div></div>`;
  }).join('');

  const next = queue[0];
  if (next) {
    const r = next.recipe;
    const ready = readyForPrep(next);
    const p = P(next.id);
    html += `<div class="card next" style="--c:${esc(r.color)}"><div class="eyebrow">Up next to prep</div>${title(next)}${recipeChips(r, next.pans)}
      <div class="meta">${ready ? `Dough is ready in <b>${esc(next.location)}</b>.` : `${STAGE_LABEL[next.stage]}${next.stage === 'chilling' ? ` in ${esc(next.location)}` : ''} — ready ${fmtTime(p.prepReady)} (${relTime(p.prepReady)})`}</div>
      <h4>Prep steps</h4><ol class="steps preview">${r.prepSteps.map((s) => `<li><span class="stext">${esc(s.text)}</span></li>`).join('')}</ol>
      <div class="btnrow">${ready ? batchBtn(next, 'startPrep', 'Start prepping', {}, 'primary big') : ''}</div></div>`;
    const alsoReady = queue.slice(1).filter(readyForPrep);
    if (!ready && alsoReady.length) {
      html += section('Ready now (out of planned order)', `<div class="grid">${alsoReady.map((b) => `<div class="card">${title(b)}${recipeChips(b.recipe, b.pans)}<div class="meta">In ${esc(b.location)}</div><div class="btnrow">${batchBtn(b, 'startPrep', 'Start prepping', {}, '')}</div></div>`).join('')}</div>`);
    }
  } else if (!prepping.length) {
    html += empty('Nothing to prep yet.');
  }

  html += section('Prep queue', queue.length > 1 ? table(['#', 'Batch', 'Status', 'Dough ready', 'Planned prep'], queue.slice(1).map((b, i) => [
    i + 2, title(b), `${STAGE_LABEL[b.stage]}${b.stage === 'chilling' ? ` (${esc(b.location)})` : ''}`,
    readyForPrep(b) ? '<b>Ready</b>' : fmtTime(P(b.id).prepReady), fmtTime(P(b.id).prepStart),
  ])) : empty('No more batches behind this one.'));
  return html;
};

// ---------- Baking
pages.baking = () => {
  let html = `<div class="grid ovens">${S().ovens.map(ovenCard).join('')}</div>`;

  const staged = inStage('staged', 'baking').filter((b) => remainingPans(b) > 0)
    .sort((a, b) => (P(a.id).loads.find((l) => !l.inOven)?.start ?? 0) - (P(b.id).loads.find((l) => !l.inOven)?.start ?? 0));
  html += section('Oven Staging Rack', staged.length ? `<div class="grid">${staged.map((b) => {
    const next = P(b.id).loads.find((l) => !l.inOven);
    return `<div class="card" style="--c:${esc(b.recipe.color)}">${title(b)}
      <div class="meta"><b>${remainingPans(b)}</b> of ${b.pans} pans waiting · ${b.recipe.ovenTempF}°F · ${b.recipe.bakeMinutes} min${next ? ` · planned: ${esc(ovenName(next.ovenId))} ${fmtTime(next.start)}` : ''}</div>
      <div class="btnrow">${S().ovens.map((o) => {
        const os = App.state.ovens[o.id] || {};
        if (os.current) return `<button class="btn" disabled>${esc(o.name)} busy</button>`;
        const mismatch = os.targetTempF !== b.recipe.ovenTempF;
        return btn(`Load into ${esc(o.name)}`, 'batch', { id: b.id, action: 'loadOven', body: { ovenId: o.id }, ...(mismatch ? { confirm: `${o.name} is set to ${os.targetTempF ?? 'off'}${os.targetTempF ? '°F' : ''}, but ${b.label} bakes at ${b.recipe.ovenTempF}°F. Load anyway?` } : {}) }, next?.ovenId === o.id && !mismatch ? 'primary' : '');
      }).join('')}</div></div>`;
  }).join('')}</div>` : empty('Rack is empty.'));

  const coming = App.plan.prepQueue.map(B).filter(Boolean).slice(0, 6);
  html += section('Coming from prep', coming.length ? table(['Batch', 'Status', 'On rack', 'Oven'], coming.map((b) => [
    title(b), STAGE_LABEL[b.stage], `${fmtTime(P(b.id).prepEnd)} (${relTime(P(b.id).prepEnd)})`, `${b.recipe.ovenTempF}°F × ${b.pans} pans`,
  ])) : empty('Nothing else coming.'));
  return html;
};

function ovenCard(o) {
  const os = App.state.ovens[o.id] || {};
  const sched = (App.plan.ovens[o.id] || {}).schedule || [];
  const cur = os.current;
  const heating = os.targetTempF && os.readyAt > now();
  let tempLine;
  if (!os.targetTempF) tempLine = '<span class="temp off">OFF</span>';
  else if (heating) tempLine = `<span class="temp heating">→ ${os.targetTempF}°F</span> <span class="muted">ready in</span> ${timerDown(os.readyAt, `oven-ready-${o.id}-${os.readyAt}`, `${o.name} should be at ${os.targetTempF}°F`)} ${btn("It's at temp", 'ovenReady', { oven: o.id }, 'tiny')}`;
  else tempLine = `<span class="temp">${os.targetTempF}°F</span>`;

  let body = '';
  const next = sched[0];
  if (cur) {
    const b = B(cur.batchId);
    const end = cur.startedAt + cur.bakeMinutes * MIN;
    const bakeSteps = (b?.recipe.bakeSteps || []).map((s, i) => {
      if (!s.minutes) return `<li><span class="stext">${esc(s.text)}</span></li>`;
      const at = cur.startedAt + s.minutes * MIN;
      const past = now() >= at;
      return `<li class="${past ? 'checked' : ''}"><span class="stext">${esc(s.text)}</span> <span class="muted">@ ${s.minutes} min</span> ${past ? '' : timerDown(at, `bakestep-${o.id}-${cur.startedAt}-${i}`, `${o.name}: ${s.text}`)}</li>`;
    }).join('');
    body = `<div class="eyebrow">Baking</div>${b ? title(b) : esc(cur.label)}
      <div class="meta">Load ${cur.loadNo} of ${cur.loadsTotal} · ${cur.pans} pan${cur.pans > 1 ? 's' : ''} at ${cur.tempF}°F</div>
      <div class="bigtimer">${timerDown(end, `bake-${o.id}-${cur.startedAt}`, `PULL ${cur.label} from ${o.name}!`)}</div>${progress(cur.startedAt, end)}
      ${bakeSteps ? `<ul class="steps">${bakeSteps}</ul>` : ''}
      <div class="btnrow">${btn(`Unload → cooling`, 'unload', { oven: o.id }, now() >= end ? 'primary big' : 'big')}</div>
      ${next && next.temp !== cur.tempF ? `<div class="hint warn">After this load: change to <b>${next.temp}°F</b> for ${esc(B(next.batchId)?.label || '')}</div>` : ''}`;
  } else if (next) {
    const nb = B(next.batchId);
    const onRack = nb && ['staged', 'baking'].includes(nb.stage) && remainingPans(nb) > 0;
    const needTemp = os.targetTempF !== next.temp;
    body = `<div class="eyebrow">Next load</div>${nb ? title(nb) : ''}
      <div class="meta">${next.pans} pan${next.pans > 1 ? 's' : ''} at <b>${next.temp}°F</b> · planned ${fmtTime(next.start)} (${relTime(next.start)})</div>
      <div class="btnrow">
        ${needTemp ? btn(`Set oven to ${next.temp}°F`, 'ovenTemp', { oven: o.id, temp: next.temp }, `${next.changeoverAt && next.changeoverAt > now() + 60000 ? '' : 'primary'} big`) : ''}
        ${onRack ? btn(`Load ${esc(nb.label)}`, 'batch', { id: nb.id, action: 'loadOven', body: { ovenId: o.id }, ...(needTemp || heating ? { confirm: `${o.name} isn't at ${next.temp}°F yet. Load anyway?` } : {}) }, needTemp || heating ? 'big' : 'primary big') : `<span class="muted">Waiting on prep — on rack ${nb ? relTime(P(nb.id).prepEnd) : ''}</span>`}
      </div>
      ${needTemp && next.changeoverAt ? `<div class="hint">Start changing temp at ${fmtTime(next.changeoverAt)}${next.changeoverAt > now() ? ` (${relTime(next.changeoverAt)})` : ' — now'}.</div>` : ''}`;
  } else {
    body = `<div class="muted big">Nothing planned</div>${os.targetTempF ? `<div class="btnrow">${btn('Turn off', 'ovenTemp', { oven: o.id, temp: '' }, '')}</div>` : ''}`;
  }

  const upcoming = sched.slice(cur ? 0 : 1, (cur ? 0 : 1) + 4);
  return `<div class="card oven ${cur ? 'active' : ''}">
    <div class="ovenhead"><h3>${esc(o.name)}</h3>${tempLine}</div>
    ${body}
    ${upcoming.length ? `<div class="upcoming"><div class="eyebrow">Then</div>${upcoming.map((l) => `<div class="uprow"><span class="swatch" style="--c:${esc(B(l.batchId)?.recipe.color)}"></span>${esc(B(l.batchId)?.label)} <span class="muted">${l.pans}p · ${l.temp}°F · ${fmtTime(l.start)}</span></div>`).join('')}</div>` : ''}
    <details class="manual"><summary>Manual temperature</summary>
      <div class="btnrow"><input type="number" id="mt-${o.id}" step="5" placeholder="°F" inputmode="numeric">${btn('Set', 'ovenTempInput', { oven: o.id }, 'tiny')}${btn('Off', 'ovenTemp', { oven: o.id, temp: '' }, 'tiny ghost')}</div>
    </details>
  </div>`;
}

// ---------- Cooling & Packing
pages.cooling = () => {
  let html = '';
  const cooling = inStage('cooling').sort((a, b) => a.t.coolStart - b.t.coolStart);
  const packing = inStage('packing').sort((a, b) => a.t.packStart - b.t.packStart);

  html += section('Finishing & packing', packing.length ? `<div class="grid">${packing.map((b) => {
    const r = b.recipe;
    return `<div class="card active" style="--c:${esc(r.color)}">${title(b)}
      <div class="meta">${esc(b.location)} · ${b.pans} pans · ≈${r.yieldPerBatch} cookies · ${timerUp(b.t.packStart)} elapsed (planned ${r.packMinutes} min)</div>
      ${r.finishSteps.length ? `<h4>Post-bake prep</h4>${stepList(b, 'finish', r.finishSteps)}` : ''}
      <h4>Packing</h4>${stepList(b, 'pack', r.packSteps) || '<div class="muted">No packing steps</div>'}
      ${r.notes ? `<div class="hint">${esc(r.notes)}</div>` : ''}
      <div class="btnrow">${batchBtn(b, 'finishPacking', 'Packed ✓ Done', {}, 'primary big')}</div></div>`;
  }).join('')}</div>` : empty('Nothing being packed.'));

  html += section('Cooling', cooling.length ? `<div class="grid">${cooling.map((b) => {
    const r = b.recipe;
    const end = b.t.coolStart + r.coolMinutes * MIN;
    const ready = now() >= end;
    return `<div class="card ${ready ? 'ready' : 'active'}" style="--c:${esc(r.color)}">${title(b)}
      <div class="meta">${esc(b.location)} · ${b.pans} pans</div>
      <div class="bigtimer">${timerDown(end, `cool-${b.id}`, `${b.label} has cooled — ready to finish & pack`)}</div>${progress(b.t.coolStart, end)}
      ${r.finishSteps.length ? `<div class="hint">Then: ${r.finishSteps.map((s) => esc(s.text)).join(' → ')}</div>` : ''}
      <div class="btnrow">${batchBtn(b, 'finishCooling', 'Cooled → Finish & pack', {}, ready ? 'primary big' : '', ready ? '' : `${b.label} hasn't finished cooling. Start packing anyway?`)}</div></div>`;
  }).join('')}</div>` : empty('Nothing cooling.'));

  const coming = inStage('baking', 'staged', 'prepping').sort((a, b) => P(a.id).bakeEnd - P(b.id).bakeEnd);
  html += section('Coming out of the ovens', coming.length ? table(['Batch', 'Pans out', 'Area', 'All out'], coming.map((b) => [
    title(b), `${b.pansBaked} / ${b.pans}`, esc(b.coolingArea || '—'), `${fmtTime(P(b.id).bakeEnd)} (${relTime(P(b.id).bakeEnd)})`,
  ])) : empty('Nothing in the ovens.'));

  const done = inStage('done');
  if (done.length) {
    const total = done.reduce((s, b) => s + (Number(b.recipe.yieldPerBatch) || 0), 0);
    html += section(`Done today <span class="muted">— ${done.length} batches, ≈${total} cookies</span>`, `<div class="chips">${done.map((b) => `<span class="chip" style="--c:${esc(b.recipe.color)}"><span class="swatch"></span>${esc(b.label)}</span>`).join('')}</div>`);
  }
  return html;
};

// ---------- Overview
pages.overview = () => {
  const active = App.state.batches.filter((b) => b.stage !== 'done');
  const recipes = App.state.recipes;
  let html = `<div class="tiles stats">
    <div class="stat"><b>${inStage('queued').length}</b><span>queued</span></div>
    <div class="stat"><b>${active.length - inStage('queued').length}</b><span>in progress</span></div>
    <div class="stat"><b>${inStage('done').length}</b><span>done</span></div>
    <div class="stat"><b>${active.length ? fmtTime(App.plan.finishAt) : '—'}</b><span>projected finish</span></div>
    <div class="stat"><b>${App.plan.changeovers}</b><span>oven temp changes</span></div>
  </div>`;

  html += section('Add batches', recipes.length ? `<div class="addform">
    <select id="add-recipe">${recipes.map((r) => `<option value="${esc(r.id)}">${esc(r.name)} (${r.ovenTempF}°F${r.chillMinutes ? `, chill ${r.chillMinutes}m` : ''})</option>`).join('')}</select>
    <input id="add-count" type="number" min="1" max="50" value="1" inputmode="numeric" aria-label="Number of batches">
    <label class="inline"><input id="add-rush" type="checkbox"> Rush</label>
    ${btn('Add to queue', 'addBatches', {}, 'primary')}
  </div><p class="muted">The planner re-sorts the queue automatically: long chills start first, same oven temps are grouped, and ovens are kept busy.</p>` : empty('Create a recipe first on the <a href="#/recipes">Recipes</a> page.'));

  html += section('Timeline', active.length ? gantt(active) : empty('No active batches.'));

  const all = [...App.state.batches].sort((a, b) => STAGES.indexOf(b.stage) - STAGES.indexOf(a.stage) || (P(a.id).mixStart ?? 0) - (P(b.id).mixStart ?? 0));
  html += section('All batches', all.length ? table(['Batch', 'Stage', 'Where', 'Done by', ''], all.map((b) => [
    title(b),
    `<select class="stage-select" data-id="${b.id}">${STAGES.map((s) => `<option value="${s}" ${s === b.stage ? 'selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}</select>`,
    esc(b.location),
    b.stage === 'done' ? `✓ ${fmtTime(b.t.done)}` : fmtTime(P(b.id).doneAt),
    `${btn(b.rush ? 'Un-rush' : 'Rush', 'batch', { id: b.id, action: 'setRush', body: { rush: !b.rush } }, 'tiny')} ${btn('Delete', 'deleteBatch', { id: b.id }, 'tiny danger')}`,
  ])) + `<div class="btnrow">${btn('Clear finished batches', 'clearDone', {}, '')}</div>` : empty('No batches yet.'));
  return html;
};

function gantt(active) {
  const t0 = now() - 10 * MIN;
  const ends = active.map((b) => P(b.id).doneAt || now());
  const t1 = Math.max(t0 + 60 * MIN, ...ends) + 5 * MIN;
  const x = (t) => ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * 100;
  const bar = (a, b, cls, label = '', style = '') => (a && b && b > t0 && b > a ? `<div class="gbar ${cls}" style="left:${x(a)}%;width:${Math.max(0.3, x(b) - x(a))}%;${style}" title="${esc(label)}">${esc(label)}</div>` : '');

  const rows = [...active].sort((a, b) => (P(a.id).mixStart ?? a.t.mixStart ?? 0) - (P(b.id).mixStart ?? b.t.mixStart ?? 0)).map((b) => {
    const p = P(b.id), t = b.t;
    const mixS = p.mixStart ?? t.mixStart, mixE = p.mixEnd ?? t.mixEnd;
    const chillE = b.recipe.chillMinutes ? (p.chillEnd ?? t.chillEnd ?? t.prepStart) : null;
    const prepS = p.prepStart ?? t.prepStart, prepE = p.prepEnd ?? t.prepEnd;
    const bakeS = t.bakeStart ?? p.bakeStart, bakeE = p.bakeEnd ?? t.coolStart;
    const coolE = p.coolEnd ?? t.packStart;
    return `<div class="grow"><div class="glabel">${title(b)}</div><div class="gtrack">
      ${bar(mixS, mixE, 'mix', 'mix')}${chillE ? bar(mixE, chillE, 'chill', 'chill') : ''}${bar(prepS, prepE, 'prep', 'prep')}
      ${bar(bakeS, bakeE, 'bake', 'bake')}${bar(bakeE, coolE, 'cool', 'cool')}${bar(coolE, p.doneAt, 'pack', 'pack')}
    </div></div>`;
  }).join('');

  const ovenRows = S().ovens.map((o) => {
    const os = App.state.ovens[o.id] || {};
    const loads = [...((App.plan.ovens[o.id] || {}).schedule || [])];
    if (os.current) loads.unshift({ batchId: os.current.batchId, start: os.current.startedAt, end: os.current.startedAt + os.current.bakeMinutes * MIN, temp: os.current.tempF });
    return `<div class="grow oven-row"><div class="glabel"><b>🔥 ${esc(o.name)}</b></div><div class="gtrack">${loads.map((l) => {
      const c = B(l.batchId)?.recipe.color || '#999';
      return (l.changeoverAt ? bar(l.changeoverAt, l.start, 'changeover', `→${l.temp}°`) : '') + bar(l.start, l.end, 'load', `${l.temp}°`, `background:${esc(c)}`);
    }).join('')}</div></div>`;
  }).join('');

  const ticks = [];
  const step = t1 - t0 > 6 * 60 * MIN ? 60 * MIN : 30 * MIN;
  for (let t = Math.ceil(t0 / step) * step; t < t1; t += step) ticks.push(`<div class="gtick" style="left:${x(t)}%">${fmtTime(t)}</div>`);

  return `<div class="gantt">
    <div class="grow gaxis"><div class="glabel"></div><div class="gtrack">${ticks.join('')}<div class="gnow" style="left:${x(now())}%"></div></div></div>
    ${ovenRows}${rows}
    <div class="legend"><span class="gbar mix">mix</span><span class="gbar chill">chill</span><span class="gbar prep">prep</span><span class="gbar bake">bake</span><span class="gbar cool">cool</span><span class="gbar pack">pack</span><span class="gbar changeover">oven temp change</span></div>
  </div>`;
}

function table(head, rows) {
  return `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ---------- Recipes
pages.recipes = () => {
  const list = App.state.recipes;
  return `<div class="btnrow">${btn('+ New recipe', 'go', { to: '#/recipe/new' }, 'primary')}
      <a class="btn" href="/api/recipes/export" download>Export recipes</a>
      <label class="btn">Import recipes<input type="file" id="import-file" accept="application/json" hidden></label></div>
    <div class="grid">${list.map((r) => `<div class="card" style="--c:${esc(r.color)}">
      <div class="btitle"><span class="swatch"></span><span class="bname">${esc(r.name)}</span></div>
      ${recipeChips(r)}
      <div class="meta">Mix ${r.mixMinutes}m · prep ${r.prepMinutesPerPan}m/pan · cool ${r.coolMinutes}m · pack ${r.packMinutes}m</div>
      <div class="btnrow">${btn('Edit', 'go', { to: `#/recipe/${r.id}` })}${btn('Queue 1 batch', 'quickAdd', { id: r.id }, '')}${btn('Delete', 'deleteRecipe', { id: r.id, name: r.name }, 'danger ghost')}</div>
    </div>`).join('') || empty('No recipes yet.')}</div>`;
};

const STEP_GROUPS = [
  ['mix', 'Mixing', [['mixMinutes', 'Mixing time (min)'], ['ingredients', 'Ingredients (one per line)', 'textarea']], 'mixSteps', 'Mixing steps', 'minutes = optional step timer'],
  ['chill', 'Chilling', [['chillMinutes', 'Chill time (min, 0 = no chill)'], ['chillNotes', 'Chill notes', 'text']], null],
  ['prep', 'Prep (panning)', [['pansPerBatch', 'Pans per batch'], ['prepMinutesPerPan', 'Prep minutes per pan']], 'prepSteps', 'Prep steps', 'minutes = optional step timer'],
  ['bake', 'Baking', [['ovenTempF', 'Oven temp (°F)'], ['bakeMinutes', 'Bake time per load (min)']], 'bakeSteps', 'Bake reminders', 'minutes = alert at this many minutes into the bake'],
  ['cool', 'Cooling & finishing', [['coolMinutes', 'Cooling time (min)']], 'finishSteps', 'Post-bake prep (glaze, icing…)', 'minutes = optional step timer'],
  ['pack', 'Packing', [['packMinutes', 'Finishing + packing time (min)'], ['yieldPerBatch', 'Cookies per batch']], 'packSteps', 'Packing steps', 'minutes = optional step timer'],
];

function stepRow(s = {}) {
  return `<div class="steprow"><input class="st-text" value="${esc(s.text || '')}" placeholder="Step"><input class="st-min" type="number" min="0" value="${s.minutes ?? ''}" placeholder="min" inputmode="numeric"><button class="btn tiny ghost" data-act="rmStep" type="button">✕</button></div>`;
}

pages.recipe = (id) => {
  App.locked = true; // don't wipe the form on live updates
  const r = id === 'new'
    ? { name: '', color: '#c8814a', yieldPerBatch: 48, pansPerBatch: 4, mixMinutes: 15, ingredients: [], mixSteps: [], chillMinutes: 0, chillNotes: '', prepMinutesPerPan: S().prepMinutesPerPan, prepSteps: [], ovenTempF: 350, bakeMinutes: 10, bakeSteps: [], coolMinutes: 15, finishSteps: [], packMinutes: 10, packSteps: [], notes: '' }
    : App.state.recipes.find((x) => x.id === id);
  if (!r) return empty('Recipe not found. <a href="#/recipes">Back</a>');
  const field = ([k, label, type]) => type === 'textarea'
    ? `<label class="field wide">${label}<textarea name="${k}" rows="5">${esc((r[k] || []).join('\n'))}</textarea></label>`
    : `<label class="field ${type === 'text' ? 'wide' : ''}">${label}<input name="${k}" type="${type || 'number'}" value="${esc(r[k] ?? '')}" ${type ? '' : 'min="0" inputmode="decimal"'}></label>`;
  return `<form id="recipe-form" class="recipe-form" data-id="${esc(id)}" onsubmit="return false">
    <div class="card"><div class="formgrid">
      <label class="field wide">Recipe name<input name="name" value="${esc(r.name)}" required></label>
      <label class="field">Color<input name="color" type="color" value="${esc(r.color)}"></label>
    </div></div>
    ${STEP_GROUPS.map(([key, h, fields, stepsKey, stepsLabel, stepsHint]) => `<div class="card"><h3>${h}</h3><div class="formgrid">${fields.map(field).join('')}</div>
      ${stepsKey ? `<h4>${stepsLabel} <span class="muted small">(${stepsHint})</span></h4><div class="steplist" data-steps="${stepsKey}">${(r[stepsKey] || []).map(stepRow).join('')}</div>${btn('+ Add step', 'addStep', {}, 'tiny')}` : ''}
    </div>`).join('')}
    <div class="card"><label class="field wide">Notes<textarea name="notes" rows="3">${esc(r.notes)}</textarea></label></div>
    <div class="btnrow sticky">${btn('Save recipe', 'saveRecipe', {}, 'primary big')}${btn('Cancel', 'go', { to: '#/recipes' }, 'big')}</div>
  </form>`;
};

// ---------- Settings
pages.settings = () => {
  App.locked = true;
  const s = S();
  const list = (k, label, v) => `<label class="field wide">${label}<textarea name="${k}" rows="${Math.max(2, v.length + 1)}">${esc(v.join('\n'))}</textarea></label>`;
  const numf = (k, label) => `<label class="field">${label}<input name="${k}" type="number" min="0" step="any" value="${esc(s[k])}"></label>`;
  return `<form id="settings-form" onsubmit="return false">
    <div class="card"><h3>Kitchen</h3><div class="formgrid">
      <label class="field wide">Kitchen name<input name="kitchenName" value="${esc(s.kitchenName)}"></label>
      ${list('mixStations', 'Mix stations (one per line)', s.mixStations)}
      ${list('chillLocations', 'Chill locations', s.chillLocations)}
      ${list('ovens', 'Ovens', s.ovens.map((o) => o.name))}
      ${list('coolingAreas', 'Cooling & packing areas', s.coolingAreas)}
    </div></div>
    <div class="card"><h3>Capacity & timing (used by the planner)</h3><div class="formgrid">
      ${numf('prepStations', 'People prepping at once')}
      ${numf('prepMinutesPerPan', 'Default prep min per pan')}
      ${numf('ovenPansPerLoad', 'Pans per oven load')}
      ${numf('preheatMinutes', 'Preheat from cold (min)')}
      ${numf('heatUpMinutesPer25F', 'Heat up: min per +25°F')}
      ${numf('coolDownMinutesPer25F', 'Cool down: min per −25°F')}
    </div></div>
    <div class="btnrow">${btn('Save settings', 'saveSettings', {}, 'primary big')}</div>
    <div class="card danger-zone"><h3>Danger zone</h3><div class="btnrow">${btn('Clear finished batches', 'clearDone')}${btn('Clear ALL batches', 'clearAll', {}, 'danger')}</div></div>
  </form>`;
};

// ------------------------------------------------------------------ actions
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    toast('Network error — is the server running?', 'error');
    throw new Error('network');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(json.error || res.statusText, 'error');
    throw new Error(json.error);
  }
  if (json.message) toast(json.message);
  return json;
}

function formData(form) {
  const o = {};
  for (const el of form.querySelectorAll('[name]')) o[el.name] = el.value;
  return o;
}

const ACTIONS = {
  batch: (d) => api('POST', `/api/batches/${d.id}/${d.action}`, d.body ? JSON.parse(d.body) : {}),
  unload: (d) => api('POST', `/api/ovens/${d.oven}/unload`),
  ovenTemp: (d) => api('POST', `/api/ovens/${d.oven}/temp`, { tempF: d.temp }),
  ovenTempInput: (d) => api('POST', `/api/ovens/${d.oven}/temp`, { tempF: $(`#mt-${d.oven}`).value }),
  ovenReady: (d) => api('POST', `/api/ovens/${d.oven}/ready`),
  addBatches: () => api('POST', '/api/batches', { recipeId: $('#add-recipe').value, count: $('#add-count').value, rush: $('#add-rush').checked }),
  quickAdd: (d) => api('POST', '/api/batches', { recipeId: d.id, count: 1 }),
  deleteBatch: (d) => confirm('Delete this batch?') && api('DELETE', `/api/batches/${d.id}`),
  clearDone: () => api('POST', '/api/batches/clear-done'),
  clearAll: () => confirm('Remove every batch, including ones in progress?') && api('POST', '/api/batches/clear-all'),
  deleteRecipe: (d) => confirm(`Delete recipe "${d.name}"? Batches already queued keep their copy.`) && api('DELETE', `/api/recipes/${d.id}`),
  go: (d) => { location.hash = d.to; },
  addStep: (d, el) => el.previousElementSibling.insertAdjacentHTML('beforeend', stepRow()),
  rmStep: (d, el) => el.closest('.steprow').remove(),
  async saveRecipe() {
    const form = $('#recipe-form');
    const body = formData(form);
    for (const list of form.querySelectorAll('[data-steps]')) {
      body[list.dataset.steps] = [...list.querySelectorAll('.steprow')].map((row) => ({ text: $('.st-text', row).value, minutes: $('.st-min', row).value }));
    }
    const id = form.dataset.id;
    await api(id === 'new' ? 'POST' : 'PUT', id === 'new' ? '/api/recipes' : `/api/recipes/${id}`, body);
    toast('Recipe saved');
    location.hash = '#/recipes';
  },
  async saveSettings() {
    await api('PUT', '/api/settings', formData($('#settings-form')));
    App.locked = false;
    render();
  },
};

document.addEventListener('click', async (e) => {
  unlockAudio();
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  e.preventDefault();
  if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  el.disabled = true;
  try { await fn(el.dataset, el); } catch { /* toast already shown */ } finally { el.disabled = false; }
});

document.addEventListener('change', async (e) => {
  if (e.target.matches('.stage-select')) {
    const b = B(e.target.dataset.id);
    if (confirm(`Move ${b.label} to "${STAGE_LABEL[e.target.value]}"? (manager override)`)) {
      await api('POST', `/api/batches/${b.id}/setStage`, { stage: e.target.value }).catch(() => {});
    } else e.target.value = b.stage;
  }
  if (e.target.id === 'import-file' && e.target.files[0]) {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      await api('POST', '/api/recipes/import', data);
    } catch (err) { if (err instanceof SyntaxError) toast('That file is not valid JSON', 'error'); }
    e.target.value = '';
  }
});

// ------------------------------------------------------------------ alerts & sound
function unlockAudio() {
  if (!App.audio) {
    try { App.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  }
  if (App.audio.state === 'suspended') App.audio.resume();
  $('#sound-banner').classList.add('hidden');
  requestWakeLock();
}
function beep(times = 3) {
  const ctx = App.audio;
  if (!ctx || ctx.state !== 'running') return;
  for (let i = 0; i < times; i++) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = 880;
    const t = ctx.currentTime + i * 0.35;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + 0.3);
  }
}
function alertNow(msg) {
  beep();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  toast(`🔔 ${msg}`, 'alert', 15000);
  document.body.classList.add('flash');
  setTimeout(() => document.body.classList.remove('flash'), 3000);
}
function toast(msg, kind = 'info', ms = 4000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  el.onclick = () => el.remove();
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => (wakeLock = null); } } catch { /* needs https or localhost */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && App.audio) requestWakeLock(); });

// ------------------------------------------------------------------ ticking
function tick() {
  const t = now();
  $('#clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  for (const el of document.querySelectorAll('.timer')) {
    if (el.dataset.start) { el.textContent = fmtDur(t - el.dataset.start); continue; }
    const rem = el.dataset.end - t;
    el.textContent = (rem < 0 ? '+' : '') + fmtDur(rem);
    el.classList.toggle('over', rem <= 0);
    const key = el.dataset.alert;
    if (key && rem <= 0 && !App.fired.has(key)) {
      App.fired.add(key);
      if (rem > -20000) alertNow(el.dataset.msg); // don't replay stale alerts after a reload
    }
  }
  for (const el of document.querySelectorAll('[data-pstart]')) {
    const a = +el.dataset.pstart, b = +el.dataset.pend;
    const pct = Math.min(100, Math.max(0, ((t - a) / (b - a)) * 100));
    el.style.width = pct + '%';
    el.classList.toggle('full', pct >= 100);
  }
  for (const el of document.querySelectorAll('.rel[data-at]')) el.textContent = rel(+el.dataset.at);
}
setInterval(tick, 1000);

// ------------------------------------------------------------------ routing & render
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return { page: parts[0] || 'home', arg: parts[1] };
}

function render() {
  if (!App.state) return;
  const { page, arg } = parseRoute();
  const key = location.hash;
  const fresh = key !== App.routeKey;
  App.routeKey = key;
  if (fresh) App.locked = false;
  $('#kitchen-name').textContent = S().kitchenName;
  const st = [...STATIONS, ...ADMIN].find((x) => x.key === page) || (page === 'recipe' ? { icon: '📖', name: 'Edit recipe' } : null);
  $('#station-title').innerHTML = st ? `${st.icon} ${esc(st.name)}` : '';
  $('#nav').innerHTML = [...STATIONS, ...ADMIN].map((x) => `<a href="#/${x.key}" class="${x.key === page ? 'on' : ''}" title="${esc(x.name)}">${x.icon}<span>${esc(x.name)}</span></a>`).join('');
  if (App.locked && !fresh) return;

  // Preserve values/focus of plain inputs across live re-renders.
  const keep = {};
  for (const el of document.querySelectorAll('#app input[id], #app select[id]')) keep[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  const focused = document.activeElement?.id;
  const openDetails = [...document.querySelectorAll('#app details[open]')].map((d) => d.querySelector('summary')?.textContent);
  const scroll = window.scrollY;

  const fn = pages[page] || pages.home;
  $('#app').innerHTML = `<div class="page page-${esc(page)}">${fn(arg)}</div>`;

  for (const [id, v] of Object.entries(keep)) {
    const el = document.getElementById(id);
    if (el) el.type === 'checkbox' ? (el.checked = v) : (el.value = v);
  }
  if (!fresh) {
    for (const d of document.querySelectorAll('#app details')) if (openDetails.includes(d.querySelector('summary')?.textContent)) d.open = true;
    window.scrollTo(0, scroll);
  } else window.scrollTo(0, 0);
  if (focused) document.getElementById(focused)?.focus();
  tick();
}
window.addEventListener('hashchange', render);

// ------------------------------------------------------------------ connection
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { App.connected = true; updateConn(); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type !== 'state') return;
    App.state = m.state;
    App.plan = m.plan;
    App.offset = m.serverTime - Date.now();
    render();
  };
  ws.onclose = () => { App.connected = false; updateConn(); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
}
function updateConn() {
  const el = $('#conn');
  el.classList.toggle('ok', App.connected);
  el.title = App.connected ? 'Live' : 'Reconnecting…';
}
connect();
