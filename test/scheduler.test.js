'use strict';
// Unit tests for the oven plan: shared loads, low → high temperatures, busy ovens.
const assert = require('assert');
const { computePlan } = require('../scheduler');
const { seedState } = require('../seed');

const MIN = 60000;
const now = Date.UTC(2026, 0, 1, 14, 0);
const recipe = (id, temp, bake, extra = {}) => ({ id, name: id, ovenTempF: temp, bakeMinutes: bake, mixMinutes: 15, chillMinutes: 0, prepMinutesPerPan: 4, coolMinutes: 15, packMinutes: 10, ...extra });
let n = 0;
const batch = (r, stage, pans, extra = {}) => ({
  id: `${r.id}-${++n}`, recipeId: r.id, recipe: r, label: `${r.id} #${n}`, stage, pans, pansBaked: 0, pansInOven: 0,
  createdAt: n, t: {}, coolGroups: [], location: '', rush: false, ...extra,
});
function kitchen(batches, settings = {}) {
  const s = seedState();
  s.settings = { ...s.settings, ...settings };
  s.batches = batches;
  for (const o of s.settings.ovens) s.ovens[o.id] = { targetTempF: null, readyAt: 0, items: [] };
  return s;
}
const temps = (plan, ovenId) => plan.ovens[ovenId].schedule.map((l) => l.temp);
const ascending = (list) => list.every((t, i) => i === 0 || t >= list[i - 1]);

// 1) One oven, 4 pans: lowest temp first, same-temp batches share a load, no temp drops.
{
  const A = recipe('a350', 350, 10), B2 = recipe('b350', 350, 12), C = recipe('c400', 400, 9), D = recipe('d325', 325, 11);
  const s = kitchen([batch(A, 'staged', 3), batch(C, 'staged', 2), batch(B2, 'staged', 3), batch(D, 'staged', 2)],
    { ovens: [{ id: 'oven1', name: 'Oven', capacity: 4 }] });
  const plan = computePlan(s, now);
  const sched = plan.ovens.oven1.schedule;
  assert.deepStrictEqual(sched.map((l) => l.temp), [325, 350, 350, 400], 'low → high');
  const shared = sched.find((l) => l.items.length > 1);
  assert.ok(shared, 'a 350°F load is shared by both 350°F batches');
  assert.deepStrictEqual(shared.items.map((it) => it.pans).sort(), [1, 3], '3 pans + 1 pan fill the 4-pan oven');
  assert.strictEqual(shared.end - shared.start, 12 * MIN, 'shared load lasts as long as the longest bake');
  assert.strictEqual(plan.tempDrops, 0);
  console.log('✓ one oven: 325 → 350 (shared 3+1) → 350 → 400');
}

// 2) Pans already in an oven with spare room: plan tops it up now with ready dough at that temp.
{
  const A = recipe('a350', 350, 10), B2 = recipe('b350', 350, 10), C = recipe('c375', 375, 10);
  const inOven = batch(A, 'baking', 2, { pansInOven: 2 });
  const s = kitchen([inOven, batch(B2, 'staged', 2), batch(C, 'staged', 2)], { ovens: [{ id: 'oven1', name: 'Oven', capacity: 4 }] });
  s.ovens.oven1 = { targetTempF: 350, readyAt: 0, items: [{ id: 'x', batchId: inOven.id, label: inOven.label, pans: 2, startedAt: now - 3 * MIN, bakeMinutes: 10, tempF: 350, extraMinutes: 0 }] };
  const plan = computePlan(s, now);
  const first = plan.ovens.oven1.schedule[0];
  assert.strictEqual(first.start, now, 'fills the spare room right away');
  assert.strictEqual(first.temp, 350);
  assert.strictEqual(first.items[0].batchId.startsWith('b350'), true, 'with the other 350°F batch, not the 375°F one');
  console.log('✓ partly full oven is topped up with same-temp dough now');
}

// 3) The seed recipes queued in "bad" order: every oven goes low → high and stays busy
//    once started (chill and prep are planned so dough is ready in time).
{
  const s = seedState();
  for (const o of s.settings.ovens) s.ovens[o.id] = { targetTempF: null, readyAt: 0, items: [] };
  const R = Object.fromEntries(s.recipes.map((r) => [r.id, r]));
  s.batches = [
    ...[1, 2].map(() => batch(R['r-snickerdoodle'], 'queued', 3)), // 400°F
    ...[1, 2].map(() => batch(R['r-choc-chip'], 'queued', 4)), // 350°F, 60 min chill
    batch(R['r-sugar'], 'queued', 3), // 375°F, 90 min chill
    batch(R['r-oatmeal'], 'queued', 4), // 350°F, 20 min pan chill
  ];
  const plan = computePlan(s, now);
  for (const id of Object.keys(plan.ovens)) {
    const list = temps(plan, id);
    console.log(`  ${id}: ${list.join(' ')}`);
    assert.ok(ascending(list), `${id} should go low → high: ${list}`);
  }
  assert.strictEqual(plan.tempDrops, 0);
  const firstOven = Math.min(...Object.values(plan.ovens).flatMap((o) => o.schedule.map((l) => l.start)));
  const sugar = s.batches.find((b) => b.recipeId === 'r-sugar');
  const sugarLoad = plan.batches[sugar.id].loads[0].start;
  const order = plan.mixQueue.map((id) => s.batches.find((b) => b.id === id).recipeId);
  console.log(`  mix order: ${order.join(', ')}`);
  assert.ok(sugarLoad > firstOven, 'higher-temp sugar bakes after the 350°F batches');
  assert.ok(order.indexOf('r-sugar') < order.indexOf('r-snickerdoodle'), 'long-chill sugar is mixed before no-chill snickerdoodles');
  console.log(`✓ seed recipes: no temperature drops, ${plan.changeovers} changes, finish in ${Math.round((plan.finishAt - now) / MIN)} min`);
}
// 4) Mix the day before: tomorrow's long-chill batch is mixed today (after today's
//    work) and kept out of today's prep and ovens; tomorrow it's ready for prep.
{
  const { localDate } = require('../scheduler');
  const today = localDate(now);
  const d = new Date(now); const tomorrow = localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12).getTime());
  const T = recipe('t350', 350, 10), O = recipe('overnight', 350, 12, { chillMinutes: 720, mixDayBefore: true }), N = recipe('notyet', 400, 9);
  const todays = batch(T, 'queued', 2, { bakeDate: today });
  const ahead = batch(O, 'queued', 2, { bakeDate: tomorrow });
  const later = batch(N, 'queued', 2, { bakeDate: tomorrow }); // normal recipe for tomorrow: nothing today
  const s = kitchen([todays, ahead, later]);
  let plan = computePlan(s, now);
  assert.deepStrictEqual(plan.mixQueue, [todays.id], "today's queue is only today's batch");
  assert.deepStrictEqual(plan.mixAheadQueue, [ahead.id], 'overnight dough is mixed today');
  assert.ok(plan.batches[ahead.id].mixStart >= now && plan.batches[ahead.id].forLater);
  assert.ok(!plan.prepQueue.includes(ahead.id) && !plan.prepQueue.includes(later.id));
  assert.ok(Object.values(plan.ovens).every((o) => o.schedule.every((l) => l.items.every((it) => it.batchId === todays.id))), "only today's batch is in the ovens");
  assert.strictEqual(plan.batches[later.id], undefined, 'not planned at all today');
  // Next morning: the dough chilled overnight and joins the plan ready for prep.
  ahead.stage = 'chilling'; ahead.t = { mixStart: now, chillStart: now + 15 * MIN };
  const nextMorning = now + 18 * 60 * MIN;
  plan = computePlan(s, nextMorning);
  assert.strictEqual(plan.today, tomorrow);
  assert.ok(plan.prepQueue.includes(ahead.id), 'in tomorrow\'s prep queue');
  assert.strictEqual(plan.batches[ahead.id].prepReady, nextMorning, 'chill already done: ready for prep right away');
  assert.ok(plan.mixQueue.includes(later.id), "tomorrow's normal batch is in tomorrow's mixing queue");
  console.log('✓ mix the day before: mixed today, out of today\'s ovens, ready for prep tomorrow');
}
// 5) Ovens with different capacities: the bigger oven takes bigger loads.
{
  const A = recipe('a350', 350, 10);
  const s = kitchen([batch(A, 'staged', 6)], { ovens: [{ id: 'big', name: 'Big', capacity: 4 }, { id: 'small', name: 'Small', capacity: 2 }] });
  const plan = computePlan(s, now);
  const pansIn = (id) => plan.ovens[id].schedule.map((l) => l.items.reduce((n, it) => n + it.pans, 0));
  assert.deepStrictEqual(pansIn('big'), [4]);
  assert.deepStrictEqual(pansIn('small'), [2]);
  console.log('✓ per-oven capacity: 6 pans → 4 in the big oven, 2 in the small one');
}
console.log('✓ all scheduler tests passed');
