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

const argmin = (arr) => arr.reduce((best, v, i) => (v < arr[best] ? i : best), 0);

function simulate(ctx, order) {
  const { now, s, active } = ctx;
  const cap = Math.max(1, Math.floor(num(s.ovenPansPerLoad, 2)));
  const P = {};
  for (const b of active) P[b.id] = { loads: [] };

  // ---------- Mixing
  const stationNames = s.mixStations.length ? s.mixStations : ['Mix Station'];
  const stations = stationNames.map((name) => ({ name, free: now }));
  for (const b of active) {
    if (b.stage !== 'mixing') continue;
    const end = Math.max(now, (b.t.mixStart || now) + b.d.mix);
    const st = stations.find((x) => x.name === b.location) || stations[argmin(stations.map((x) => x.free))];
    st.free = Math.max(st.free, end);
    Object.assign(P[b.id], { mixStart: b.t.mixStart, mixEnd: end, mixStation: b.location });
  }
  for (const b of order) {
    const st = stations[argmin(stations.map((x) => x.free))];
    const start = st.free;
    st.free = start + b.d.mix;
    Object.assign(P[b.id], { mixStart: start, mixEnd: st.free, mixStation: st.name });
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
  const ovens = s.ovens.map((o) => {
    const st = ctx.ovenState[o.id] || {};
    let free = Math.max(now, st.readyAt || 0);
    const temp = st.targetTempF ?? null;
    if (st.current) {
      const end = Math.max(now, st.current.startedAt + (st.current.bakeMinutes + (st.current.extraMinutes || 0)) * MIN);
      free = Math.max(free, end);
      const pb = P[st.current.batchId];
      if (pb) pb.loads.push({ ovenId: o.id, batchId: st.current.batchId, start: st.current.startedAt, end, temp: st.current.tempF, pans: st.current.pans, inOven: true });
    }
    return { id: o.id, free, temp, schedule: [] };
  });

  const loads = [];
  for (const b of active) {
    if (['cooling', 'packing', 'done'].includes(b.stage)) continue;
    let ready;
    if (b.stage === 'staged' || b.stage === 'baking') ready = now;
    else if (b.stage === 'pan_chilling') ready = Math.max(now, (b.t.panChillStart || now) + b.d.panChill);
    else ready = P[b.id].prepEnd + b.d.panChill;
    if (b.d.panChill && b.stage !== 'staged' && b.stage !== 'baking') P[b.id].panChillEnd = ready;
    let left = b.pans - (b.pansBaked || 0) - (b.pansInOven || 0);
    while (left > 0) {
      const pans = Math.min(cap, left);
      left -= pans;
      loads.push({ b, ready, pans, temp: b.d.temp, bake: b.d.bake, seq: seq.get(b.id) });
    }
  }

  let changeovers = 0;
  while (loads.length && ovens.length) {
    let best = null;
    for (const o of ovens) {
      const seen = new Set();
      for (const L of loads) {
        if (seen.has(L.b.id)) continue; // a batch's loads are interchangeable
        seen.add(L.b.id);
        const co = changeoverMs(o.temp, L.temp, s);
        const start = Math.max(o.free + co, L.ready);
        // Discourage temperature flip-flopping beyond its raw time cost.
        const score = start + co * 0.5 + L.seq * 1000;
        if (!best || score < best.score) best = { o, L, start, co, score };
      }
    }
    const { o, L, start, co } = best;
    loads.splice(loads.indexOf(L), 1);
    const entry = {
      ovenId: o.id, batchId: L.b.id, start, end: start + L.bake, temp: L.temp, pans: L.pans,
      changeoverAt: co ? start - co : null, changeoverFrom: co ? o.temp : null,
    };
    if (co && o.temp !== null) changeovers++;
    o.schedule.push(entry);
    P[L.b.id].loads.push(entry);
    o.free = entry.end;
    o.temp = L.temp;
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
  const score = finish - now + (0.25 * sumDone) / n + changeovers * 2 * MIN;
  return { score, P, ovens, finish, changeovers };
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
  return [
    prev,
    [...queued].sort(chillDesc),
    groupedByTemp(1),
    groupedByTemp(-1),
    [...queued].sort(byCreated),
  ].map(rushFirst);
}

function computePlan(state, now = Date.now(), prevOrder = []) {
  const s = state.settings;
  const active = state.batches
    .filter((b) => b.stage !== 'done')
    .map((b) => ({ ...b, t: b.t || {}, d: durations(b.recipe, s) }));
  const queued = active.filter((b) => b.stage === 'queued');
  const ctx = { now, s, active, ovenState: state.ovens || {} };

  // Pick best starting order; the previous plan gets a small stability bonus
  // so the "Up next" card doesn't flicker between near-identical options.
  const cands = candidateOrders(queued, prevOrder);
  let bestOrder = cands[0];
  let best = simulate(ctx, bestOrder);
  best.score -= 2 * MIN;
  for (const order of cands.slice(1)) {
    const r = simulate(ctx, order);
    if (r.score < best.score) { best = r; bestOrder = order; }
  }

  // Local search: move one batch to another position while it helps.
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
        const r = simulate(ctx, next);
        if (r.score < best.score - 1000) {
          best = r; bestOrder = next; improved = true;
          break outer;
        }
        if (Date.now() > deadline) break outer;
      }
    }
  }

  const final = simulate(ctx, bestOrder); // clean (un-bonused) result
  const P = final.P;
  const prepQueue = active
    .filter((b) => ['queued', 'mixing', 'chilling', 'ready_prep', 'prepping'].includes(b.stage))
    .sort((a, b) => P[a.id].prepStart - P[b.id].prepStart)
    .map((b) => b.id);
  const ovens = {};
  for (const o of final.ovens) ovens[o.id] = { schedule: o.schedule };

  return {
    computedAt: now,
    mixQueue: bestOrder.map((b) => b.id),
    prepQueue,
    batches: P,
    ovens,
    finishAt: final.finish,
    changeovers: final.changeovers,
  };
}

module.exports = { computePlan, changeoverMs, durations, MIN };
