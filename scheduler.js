'use strict';
/*
 * Cookie Flow scheduler.
 *
 * Every time something changes, we simulate the rest of the day forward from
 * "now" and pick the mixing order that finishes everything soonest.
 *
 *   Mixing (N mix stations) -> Chilling (unlimited, timed) -> Prep (P people)
 *   -> Baking (ovens, loads of up to K pans, temperature changeovers cost time)
 *   -> Cooling (timed) -> Finishing & packing (timed)
 *
 * The only free decision for queued batches is the order they are mixed in;
 * prep and oven order follow greedily from that. We try a few sensible
 * orderings (longest chill first, grouped by oven temperature, FIFO, last
 * plan) and then improve the best one with a quick local search.
 */

const MIN = 60000;
const SEARCH_BUDGET_MS = 150;

function num(v, d) {
  if (v === '' || v === null || v === undefined) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function durations(recipe, settings) {
  const r = recipe || {};
  return {
    mix: num(r.mixMinutes, 15) * MIN,
    chill: Math.max(0, num(r.chillMinutes, 0)) * MIN,
    panChill: Math.max(0, num(r.panChillMinutes, 0)) * MIN, // after prep, before baking
    prepPerPan: num(r.prepMinutesPerPan, num(settings.prepMinutesPerPan, 4)) * MIN,
    bake: num(r.bakeMinutes, 10) * MIN,
    cool: num(r.coolMinutes, 15) * MIN,
    pack: num(r.packMinutes, 10) * MIN,
    temp: num(r.ovenTempF, 350),
  };
}

/** Time for an oven to go from one temperature to another (ms). */
function changeoverMs(fromTemp, toTemp, s) {
  if (toTemp === null || toTemp === undefined || fromTemp === toTemp) return 0;
  if (fromTemp === null || fromTemp === undefined) return num(s.preheatMinutes, 15) * MIN;
  const diff = toTemp - fromTemp;
  const per25 = diff > 0 ? num(s.heatUpMinutesPer25F, 3) : num(s.coolDownMinutesPer25F, 6);
  return (Math.abs(diff) / 25) * per25 * MIN;
}

/** Local calendar date (YYYY-MM-DD) in the server's time zone (TZ). */
function localDate(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Bakes on a later day and hasn't gone past chilling yet. */
const isLater = (b, today) => !!b.bakeDate && b.bakeDate > today && ['queued', 'mixing', 'chilling'].includes(b.stage);
/** Mixed today so it can chill overnight for a later bake day. */
const isMixAhead = (b, today) => isLater(b, today) && !!b.recipe?.mixDayBefore;

/** Pans an oven holds (its own capacity; older data used one setting for all). */
const ovenCapacity = (o, s) => Math.max(1, Math.floor(num(o?.capacity, num(s.ovenPansPerLoad, 2))));

const argmin = (arr) => arr.reduce((best, v, i) => (v < arr[best] ? i : best), 0);

// `release`: optional Map batchId → earliest time to start mixing it (used by
// the backward plan to mix dough just in time instead of as early as possible).
function simulate(ctx, order, release = null) {
  const { now, s, active } = ctx;
  const P = {};
  for (const b of active) P[b.id] = { loads: [] };

  // ---------- Mixing
  const stationNames = s.mixStations.length ? s.mixStations : ['Mix Station'];
  const stations = stationNames.map((name) => ({ name, free: now }));
  // Batches mixed today for tomorrow use the mix stations, but nothing after that.
  for (const b of ctx.ahead) P[b.id] = { loads: [], forLater: true };
  for (const b of [...active, ...ctx.ahead]) {
    if (b.stage !== 'mixing') continue;
    const end = Math.max(now, (b.t.mixStart || now) + b.d.mix);
    const st = stations.find((x) => x.name === b.location) || stations[argmin(stations.map((x) => x.free))];
    st.free = Math.max(st.free, end);
    Object.assign(P[b.id], { mixStart: b.t.mixStart, mixEnd: end, mixStation: b.location });
  }
  for (const b of [...order, ...ctx.aheadQueued]) {
    const st = stations[argmin(stations.map((x) => x.free))];
    const start = Math.max(st.free, release?.get(b.id) ?? now);
    st.free = start + b.d.mix;
    Object.assign(P[b.id], { mixStart: start, mixEnd: st.free, mixStation: st.name });
  }
  for (const b of ctx.ahead) {
    const p = P[b.id];
    if (b.stage === 'chilling') p.chillEnd = (b.t.chillStart || now) + b.d.chill;
    else p.chillEnd = p.mixEnd + b.d.chill;
  }

  // ---------- When is each batch's dough ready for prep?
  for (const b of active) {
    const p = P[b.id];
    if (b.stage === 'queued' || b.stage === 'mixing') {
      p.chillEnd = p.mixEnd + b.d.chill;
      p.prepReady = p.chillEnd;
    } else if (b.stage === 'chilling') {
      p.chillEnd = Math.max(now, (b.t.chillStart || now) + b.d.chill);
      p.prepReady = p.chillEnd;
    } else if (b.stage === 'ready_prep') {
      p.prepReady = now;
    }
  }

  // Priority sequence: batches already past mixing (by readiness), then mix order.
  const notQueued = active
    .filter((b) => b.stage !== 'queued')
    .sort((a, b) => (b.rush ? 1 : 0) - (a.rush ? 1 : 0) || (P[a.id].prepReady ?? 0) - (P[b.id].prepReady ?? 0) || a.createdAt - b.createdAt);
  const seq = new Map();
  [...notQueued, ...order].forEach((b, i) => seq.set(b.id, i));

  // ---------- Prep
  // The plan uses one batch at a time per prep station, whatever its capacity.
  // Capacity only lets staff start extra batches there by hand; batches already
  // prepping at a station keep it busy until the last of them is done.
  const stationsDef = Array.isArray(s.prepStations) && s.prepStations.length ? s.prepStations : [{ name: 'Cookie Prep', capacity: 1 }];
  const prepNames = stationsDef.map((st) => st.name ?? st);
  const prepSlots = prepNames.map(() => now);
  for (const b of active) {
    if (b.stage !== 'prepping') continue;
    const end = Math.max(now, (b.t.prepStart || now) + b.d.prepPerPan * b.pans);
    let k = prepNames.indexOf(b.location);
    if (k < 0) k = argmin(prepSlots); // station was renamed away
    prepSlots[k] = Math.max(prepSlots[k], end);
    Object.assign(P[b.id], { prepStart: b.t.prepStart, prepEnd: end, prepStation: b.location });
  }
  const waiting = active
    .filter((b) => ['queued', 'mixing', 'chilling', 'ready_prep'].includes(b.stage))
    .sort((a, b) => seq.get(a.id) - seq.get(b.id));
  while (waiting.length) {
    const k = argmin(prepSlots);
    let t = prepSlots[k];
    let pick = waiting.find((b) => P[b.id].prepReady <= t);
    if (!pick) {
      t = Math.min(...waiting.map((b) => P[b.id].prepReady));
      pick = waiting.find((b) => P[b.id].prepReady <= t);
    }
    waiting.splice(waiting.indexOf(pick), 1);
    const p = P[pick.id];
    p.prepStart = t;
    p.prepStation = prepNames[k];
    p.prepEnd = t + pick.d.prepPerPan * pick.pans;
    prepSlots[k] = p.prepEnd;
  }

  // ---------- Ovens
  // An oven holds up to `cap` pans. Pans from different batches share an oven
  // when they bake at the same temperature (each keeps its own bake time).
  // Policy: avoid temperature changes, go low → high (cooling an oven down is
  // slow and heavily penalized), and keep every oven busy.
  const ovens = s.ovens.map((o) => {
    const st = ctx.ovenState[o.id] || {};
    const items = st.items || [];
    let free = Math.max(now, st.readyAt || 0);
    let temp = st.targetTempF ?? null;
    let used = 0;
    for (const it of items) {
      const end = Math.max(now, it.startedAt + (it.bakeMinutes + (it.extraMinutes || 0)) * MIN);
      free = Math.max(free, end);
      used += it.pans;
      temp = it.tempF;
      const pb = P[it.batchId];
      if (pb) pb.loads.push({ ovenId: o.id, batchId: it.batchId, start: it.startedAt, end, temp: it.tempF, pans: it.pans, inOven: true });
    }
    const cap = ovenCapacity(o, s);
    return { id: o.id, cap, free, temp, schedule: [], busy: items.length > 0, room: items.length ? Math.max(0, cap - used) : 0 };
  });

  const pool = [];
  for (const b of active) {
    if (['cooling', 'packing', 'done'].includes(b.stage)) continue;
    let ready;
    if (b.stage === 'staged' || b.stage === 'baking') ready = now;
    else if (b.stage === 'pan_chilling') ready = Math.max(now, (b.t.panChillStart || now) + b.d.panChill);
    else ready = P[b.id].prepEnd + b.d.panChill;
    if (b.d.panChill && b.stage !== 'staged' && b.stage !== 'baking') P[b.id].panChillEnd = ready;
    const left = b.pans - (b.pansBaked || 0) - (b.pansInOven || 0);
    if (left > 0) pool.push({ b, ready, left, temp: b.d.temp, bake: b.d.bake, seq: seq.get(b.id) });
  }
  pool.sort((x, y) => x.seq - y.seq);

  // Fill `room` pans with other same-temperature dough that's ready by `start`.
  const fill = (start, temp, room, items) => {
    for (const L of pool) {
      if (room <= 0) break;
      if (L.left <= 0 || L.temp !== temp || L.ready > start) continue;
      const pans = Math.min(room, L.left);
      L.left -= pans;
      room -= pans;
      items.push({ L, pans });
    }
  };
  const addLoad = (o, start, co, items) => {
    const entry = {
      ovenId: o.id, start, temp: items[0].L.temp,
      end: Math.max(...items.map(({ L }) => start + L.bake)),
      changeoverAt: co ? start - co : null, changeoverFrom: co ? o.temp : null,
      items: items.map(({ L, pans }) => ({ batchId: L.b.id, pans, end: start + L.bake })),
    };
    for (const it of entry.items) {
      P[it.batchId].loads.push({ ovenId: o.id, batchId: it.batchId, start, end: it.end, temp: entry.temp, pans: it.pans, shared: entry.items.length > 1 });
    }
    o.schedule.push(entry);
    return entry;
  };

  // Ovens that already have pans in them but still have room: top them up now.
  for (const o of ovens) {
    if (!o.room) continue;
    const items = [];
    fill(now, o.temp, o.room, items);
    if (items.length) o.free = Math.max(o.free, addLoad(o, now, 0, items).end);
  }

  // Lowering an oven's temperature is slow and breaks "low → high", so it is
  // only worth it when the alternative is a long wait.
  const DOWN_PENALTY = 45 * MIN;
  let changeovers = 0, downs = 0, idle = 0, wait = 0;
  while (ovens.length && pool.some((L) => L.left > 0)) {
    let best = null;
    for (const o of ovens) {
      for (const L of pool) {
        if (L.left <= 0) continue;
        const co = changeoverMs(o.temp, L.temp, s);
        const start = Math.max(o.free + co, L.ready);
        const down = o.temp !== null && L.temp < o.temp;
        // earliest start, then: fewer/cheaper temp changes, never go down if
        // avoidable, lower temps first (≈1 s per °F), then planned order.
        const score = start + co * 0.5 + (down ? DOWN_PENALTY : 0) + L.temp * 1000 + L.seq * 1000;
        if (!best || score < best.score) best = { o, L, start, co, score };
      }
    }
    const { o, L, start, co } = best;
    const items = [{ L, pans: Math.min(o.cap, L.left) }];
    L.left -= items[0].pans;
    fill(start, L.temp, o.cap - items[0].pans, items); // top up with other ready dough at this temp
    if (o.busy) idle += Math.max(0, start - co - o.free);
    if (co && o.temp !== null) { changeovers++; if (L.temp < o.temp) downs++; }
    const entry = addLoad(o, start, co, items);
    for (const it of items) wait += Math.max(0, start - it.L.ready) * it.pans;
    o.free = entry.end;
    o.temp = L.temp;
    o.busy = true;
  }

  // ---------- Cooling, packing, totals
  let finish = now;
  let sumDone = 0;
  for (const b of active) {
    const p = P[b.id];
    if (b.stage === 'cooling') {
      // Batch is cool once the last pans out of the oven have cooled.
      const lastOut = Math.max(b.t.allOut || 0, ...(b.coolGroups || []).map((g) => g.outAt), b.t.coolStart || 0) || now;
      p.coolEnd = Math.max(now, lastOut + b.d.cool);
    } else if (b.stage === 'packing') {
      p.coolEnd = b.t.packStart;
    } else {
      p.bakeStart = p.loads.length ? Math.min(...p.loads.map((l) => l.start)) : undefined;
      p.bakeEnd = p.loads.length ? Math.max(...p.loads.map((l) => l.end)) : now;
      p.coolEnd = p.bakeEnd + b.d.cool;
    }
    p.doneAt = b.stage === 'packing' ? Math.max(now, (b.t.packStart || now) + b.d.pack) : p.coolEnd + b.d.pack;
    finish = Math.max(finish, p.doneAt);
    sumDone += p.doneAt - now;
  }
  const n = active.length || 1;
  // Finish early; then few temp changes (going down costs most); then keep ovens busy.
  const score = finish - now + (0.25 * sumDone) / n + changeovers * 2 * MIN + downs * 45 * MIN + idle * 0.5 + wait * 0.02;
  return { score, P, ovens, finish, changeovers, downs, idle, wait };
}

const rushFirst = (arr) => [...arr.filter((b) => b.rush), ...arr.filter((b) => !b.rush)];
const rushValid = (arr) => {
  let seenNormal = false;
  for (const b of arr) {
    if (!b.rush) seenNormal = true;
    else if (seenNormal) return false;
  }
  return true;
};

// Work backward from the ovens: bake lowest temperature first and, within a
// temperature, whichever dough can be ready soonest. Give each batch the next
// free oven slot, fit its prep onto a prep station (one batch at a time each)
// as late as still works, and start mixing just early enough (mix + chill) for
// that prep. Returns the mixing order and the earliest time to mix each batch.
function backwardPlan(queued, ctx) {
  const { s, now } = ctx;
  const caps = s.ovens.map((o) => ovenCapacity(o, s));
  if (!caps.length) caps.push(Math.max(1, Math.floor(num(s.ovenPansPerLoad, 2))));
  const prepTime = (b) => b.d.prepPerPan * b.pans;
  const lead = (b) => b.d.mix + b.d.chill + prepTime(b) + b.d.panChill;
  const ovenFree = s.ovens.map((o) => {
    const st = ctx.ovenState[o.id] || {};
    let free = st.targetTempF == null ? now + num(s.preheatMinutes, 15) * MIN : Math.max(now, st.readyAt || 0);
    for (const it of st.items || []) free = Math.max(free, it.startedAt + (it.bakeMinutes + (it.extraMinutes || 0)) * MIN);
    return free;
  });
  if (!ovenFree.length) ovenFree.push(now);
  const nPrep = Array.isArray(s.prepStations) && s.prepStations.length ? s.prepStations.length : 1;
  const prepFree = Array(nPrep).fill(now);
  // Work already past mixing takes oven and prep time first.
  for (const b of ctx.active) {
    if (['queued', 'cooling', 'packing', 'done'].includes(b.stage)) continue;
    if (['mixing', 'chilling', 'ready_prep', 'prepping'].includes(b.stage)) {
      const k = argmin(prepFree);
      prepFree[k] += prepTime(b);
    }
    const left = b.pans - (b.pansBaked || 0) - (b.pansInOven || 0);
    const k = argmin(ovenFree);
    ovenFree[k] += Math.ceil(Math.max(0, left) / caps[k]) * b.d.bake;
  }
  const ovenOrder = [...queued].sort((a, b) => (b.rush ? 1 : 0) - (a.rush ? 1 : 0) || a.d.temp - b.d.temp || lead(a) - lead(b) || a.createdAt - b.createdAt);
  const release = new Map();
  for (const b of ovenOrder) {
    const k = argmin(ovenFree);
    const p = argmin(prepFree);
    const earliestPrep = now + b.d.mix + b.d.chill;
    const wantPrep = ovenFree[k] - b.d.panChill - prepTime(b); // just in time for the oven
    const prepStart = Math.max(prepFree[p], earliestPrep, b.rush ? 0 : wantPrep);
    prepFree[p] = prepStart + prepTime(b);
    const slot = Math.max(ovenFree[k], prepFree[p] + b.d.panChill);
    ovenFree[k] = slot + Math.ceil(b.pans / caps[k]) * b.d.bake;
    release.set(b.id, b.rush ? now : Math.max(now, prepStart - b.d.chill - b.d.mix));
  }
  const order = [...queued].sort((a, b) => release.get(a.id) - release.get(b.id) || a.createdAt - b.createdAt);
  return { order, release };
}

function candidateOrders(queued, prevOrder) {
  const byCreated = (a, b) => a.createdAt - b.createdAt;
  const chillDesc = (a, b) => b.d.chill + b.d.panChill - (a.d.chill + a.d.panChill) || byCreated(a, b);
  const groupedByTemp = (dir) => {
    const groups = new Map();
    for (const b of queued) {
      if (!groups.has(b.d.temp)) groups.set(b.d.temp, []);
      groups.get(b.d.temp).push(b);
    }
    return [...groups.entries()]
      .map(([temp, list]) => ({ temp, list: list.sort(chillDesc), maxChill: Math.max(...list.map((b) => b.d.chill)) }))
      .sort((a, b) => b.maxChill - a.maxChill || (a.temp - b.temp) * dir)
      .flatMap((g) => g.list);
  };
  const prevIdx = new Map(prevOrder.map((id, i) => [id, i]));
  const prev = [...queued].sort((a, b) => (prevIdx.get(a.id) ?? 1e9) - (prevIdx.get(b.id) ?? 1e9) || chillDesc(a, b));
  const tempAsc = [...queued].sort((a, b) => a.d.temp - b.d.temp || chillDesc(a, b));
  return [
    prev,
    tempAsc,
    [...queued].sort(chillDesc),
    groupedByTemp(1),
    groupedByTemp(-1),
    [...queued].sort(byCreated),
  ].map(rushFirst);
}

function computePlan(state, now = Date.now(), prevOrder = []) {
  const s = state.settings;
  const today = localDate(now);
  const open = state.batches
    .filter((b) => b.stage !== 'done')
    .map((b) => ({ ...b, t: b.t || {}, d: durations(b.recipe, s) }));
  // Today's work; batches for a later day are left out, except that
  // "mix the day before" ones are mixed today (after today's queue).
  const active = open.filter((b) => !isLater(b, today));
  const ahead = open.filter((b) => isMixAhead(b, today));
  const aheadQueued = ahead.filter((b) => b.stage === 'queued').sort((a, b) => (a.bakeDate < b.bakeDate ? -1 : a.bakeDate > b.bakeDate ? 1 : 0) || a.createdAt - b.createdAt);
  const queued = active.filter((b) => b.stage === 'queued');
  const ctx = { now, s, active, ahead, aheadQueued, ovenState: state.ovens || {} };

  const back = backwardPlan(queued, ctx);
  // Each candidate: a mixing order, optionally with just-in-time release times.
  const cands = [
    ...candidateOrders(queued, prevOrder).map((order) => ({ order, release: null })),
    { order: rushFirst(back.order), release: back.release },
  ];
  // The previous plan gets a small stability bonus so "Up next" doesn't flicker
  // between near-identical options.
  let bestCand = cands[0];
  let best = simulate(ctx, bestCand.order, bestCand.release);
  best.score -= 2 * MIN;
  for (const c of cands.slice(1)) {
    const r = simulate(ctx, c.order, c.release);
    if (r.score < best.score) { best = r; bestCand = c; }
  }

  // Local search: move one batch to another position while it helps.
  let bestOrder = bestCand.order;
  const release = bestCand.release;
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  let improved = queued.length > 1;
  while (improved && Date.now() < deadline) {
    improved = false;
    outer: for (let i = 0; i < bestOrder.length; i++) {
      for (let j = 0; j < bestOrder.length; j++) {
        if (i === j) continue;
        const next = bestOrder.slice();
        const [moved] = next.splice(i, 1);
        next.splice(j, 0, moved);
        if (!rushValid(next)) continue;
        const r = simulate(ctx, next, release);
        if (r.score < best.score - 1000) {
          best = r; bestOrder = next; improved = true;
          break outer;
        }
        if (Date.now() > deadline) break outer;
      }
    }
  }

  const final = simulate(ctx, bestOrder, release); // clean (un-bonused) result
  const P = final.P;
  const prepQueue = active
    .filter((b) => ['queued', 'mixing', 'chilling', 'ready_prep', 'prepping'].includes(b.stage))
    .sort((a, b) => P[a.id].prepStart - P[b.id].prepStart)
    .map((b) => b.id);
  const ovens = {};
  for (const o of final.ovens) ovens[o.id] = { schedule: o.schedule };


  return {
    computedAt: now,
    // Listed in planned mixing-time order (ties keep the search order).
    mixQueue: bestOrder.map((b, i) => [b.id, P[b.id].mixStart, i]).sort((x, y) => x[1] - y[1] || x[2] - y[2]).map((x) => x[0]),
    // Mix today, chill overnight, bake on their bake day.
    mixAheadQueue: aheadQueued.map((b) => b.id),
    today,
    prepQueue,
    batches: P,
    ovens,
    finishAt: final.finish,
    changeovers: final.changeovers,
    tempDrops: final.downs,
  };
}

module.exports = { computePlan, changeoverMs, durations, localDate, ovenCapacity, MIN };
