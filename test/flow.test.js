'use strict';
// End-to-end smoke test: boots the server on a temp data dir and walks
// batches through every station via the HTTP API.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 18080 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookieflow-'));

async function call(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error}`);
  return j;
}
const get = async () => (await call('GET', '/api/state'));
const act = (id, a, body = {}) => call('POST', `/api/batches/${id}/${a}`, body);

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dataDir }, stdio: 'inherit' });
  try {
    for (let i = 0; i < 50; i++) { try { await get(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

    let { state, plan } = await get();
    assert.strictEqual(state.recipes.length, 4, 'seed recipes');

    // Queue a mix of recipes in "bad" FIFO order
    await call('POST', '/api/batches', { recipeId: 'r-snickerdoodle', count: 2 });
    await call('POST', '/api/batches', { recipeId: 'r-choc-chip', count: 2 });
    await call('POST', '/api/batches', { recipeId: 'r-sugar', count: 1 });
    await call('POST', '/api/batches', { recipeId: 'r-oatmeal', count: 1 });
    ({ state, plan } = await get());
    const order = plan.mixQueue.map((id) => state.batches.find((b) => b.id === id).label);
    console.log('Planned mix order:', order.join(' | '));
    console.log('Projected finish in', Math.round((plan.finishAt - Date.now()) / 60000), 'min; oven temp changes:', plan.changeovers);
    assert.ok(order[0].startsWith('Iced Sugar'), 'longest chill (sugar, 90m) should be mixed first');
    assert.ok(order.indexOf('Snickerdoodles #1') > order.indexOf('Chocolate Chip #1'), 'no-chill snickerdoodles should not block chilled doughs');
    for (const id of Object.keys(state.ovens)) {
      const temps = plan.ovens[id].schedule.map((l) => l.temp);
      console.log(`  ${id} temps:`, temps.join(' '));
    }

    // Walk the first planned batch through every station
    const id = plan.mixQueue[0];
    await act(id, 'startMix', { station: 'Mix Station #3' });
    await act(id, 'toggleCheck', { stage: 'mix', index: 0 });
    await act(id, 'stepTimer', { stage: 'mix', index: 0 });
    let r = await act(id, 'finishMix', { to: 'Outdoor Chiller' });
    assert.match(r.message, /Outdoor Chiller/);
    await act(id, 'finishChill');
    await act(id, 'startPrep');
    let b = state.batches.find((x) => x.id === id);
    assert.strictEqual(b.pans, 3, 'queued batch uses the estimate');
    assert.strictEqual(b.pansEstimated, true);
    await assert.rejects(act(id, 'finishPrep'), /how many pans/);
    await assert.rejects(act(id, 'finishPrep', { pans: 0 }), /how many pans/);
    await assert.rejects(act(id, 'finishPrep', { pans: 2.5 }), /how many pans/);
    r = await act(id, 'finishPrep', { pans: 5 }); // prep actually filled 5
    assert.match(r.message, /5 pans/);
    ({ state } = await get());
    b = state.batches.find((x) => x.id === id);
    assert.strictEqual(b.stage, 'staged');
    assert.strictEqual(b.pans, 5);
    assert.strictEqual(b.pansEstimated, false);
    assert.deepStrictEqual(state.panHistory['r-sugar'], [3, 5]);

    await call('POST', '/api/ovens/oven1/temp', { tempF: 375 });
    await call('POST', '/api/ovens/oven1/ready');
    await act(id, 'loadOven', { ovenId: 'oven1' });
    await assert.rejects(act(id, 'loadOven', { ovenId: 'oven1' }), /already has/);

    // Adding bake time while baking
    await call('POST', '/api/ovens/oven1/extend', { minutes: 1 });
    r = await call('POST', '/api/ovens/oven1/extend', { minutes: 2.5 });
    assert.match(r.message, /Added 2.5 min/);
    await assert.rejects(call('POST', '/api/ovens/oven1/extend', { minutes: 0 }), /between/);
    await assert.rejects(call('POST', '/api/ovens/oven2/extend', { minutes: 5 }), /Nothing is baking/);
    ({ state, plan } = await get());
    assert.strictEqual(state.ovens.oven1.current.extraMinutes, 3.5);
    const inOven = plan.batches[id].loads.find((l) => l.inOven);
    assert.strictEqual(inOven.end - inOven.start, (8 + 3.5) * 60000, 'planner includes added time');

    // Editing the recipe updates the batch in progress (and the load in the oven)
    const sugar = state.recipes.find((x) => x.id === 'r-sugar');
    await act(id, 'toggleCheck', { stage: 'pack', index: 0 });
    r = await call('PUT', '/api/recipes/r-sugar', { ...sugar, name: 'Sugar Cutouts', bakeMinutes: 9, packSteps: [{ text: 'New packing step' }] });
    assert.match(r.message, /Updated 1 active batch$/);
    ({ state } = await get());
    b = state.batches.find((x) => x.id === id);
    assert.strictEqual(b.recipe.bakeMinutes, 9);
    assert.strictEqual(b.label, 'Sugar Cutouts #1');
    assert.strictEqual(state.ovens.oven1.current.bakeMinutes, 9);
    assert.strictEqual(state.ovens.oven1.current.extraMinutes, 3.5, 'added time is kept');
    assert.strictEqual(state.ovens.oven1.current.label, 'Sugar Cutouts #1');
    assert.strictEqual(b.checks.pack, undefined, 'changed steps -> ticks cleared');
    assert.deepStrictEqual(b.checks.mix, [true], 'unchanged steps -> ticks kept (ticked during mixing)');

    await act(id, 'loadOven', { ovenId: 'oven2' }); // 5 pans, 2 per load: 2 + 2 + 1
    await call('POST', '/api/ovens/oven1/unload');
    ({ state } = await get());
    b = state.batches.find((x) => x.id === id);
    assert.strictEqual(b.coolGroups.length, 1, 'pans start cooling as soon as they come out');
    assert.deepStrictEqual([b.coolGroups[0].pans, b.coolGroups[0].ovenId], [2, 'oven1']);
    assert.strictEqual(b.stage, 'baking', 'rest of the batch is still baking');
    await new Promise((res) => setTimeout(res, 20));
    await call('POST', '/api/ovens/oven2/unload');
    ({ state } = await get());
    b = state.batches.find((x) => x.id === id);
    assert.strictEqual(b.stage, 'baking');
    assert.strictEqual(b.pansBaked, 4);
    assert.strictEqual(b.coolGroups.length, 2);
    assert.ok(b.coolGroups[1].outAt > b.coolGroups[0].outAt, 'groups keep their own out-of-oven time');
    await act(id, 'loadOven', { ovenId: 'oven1' });
    ({ state } = await get());
    assert.strictEqual(state.ovens.oven1.current.pans, 1, 'last load has the leftover pan');
    r = await call('POST', '/api/ovens/oven1/unload');
    ({ state, plan } = await get());
    b = state.batches.find((x) => x.id === id);
    assert.strictEqual(b.stage, 'cooling', 'all pans out -> cooling');
    assert.ok(b.coolingArea);
    assert.deepStrictEqual(b.coolGroups.map((g) => g.pans), [2, 2, 1]);
    await act(id, 'toggleCheck', { stage: 'finish-1', index: 0 });
    ({ state } = await get());
    assert.deepStrictEqual(state.batches.find((x) => x.id === id).checks['finish-1'], [true], 'post-bake checks are per group');
    await act(id, 'finishCooling');
    // Packing: the actual count is required (the estimate is only a hint)
    ({ state } = await get());
    assert.strictEqual(state.settings.shares, 10);
    assert.strictEqual(state.recipes.find((x) => x.id === 'r-sugar').perContainer, 4);
    await assert.rejects(act(id, 'finishPacking'), /how many containers/);
    await assert.rejects(act(id, 'finishPacking', { containers: 8 }), /cookies are in each container/);
    await assert.rejects(act(id, 'finishPacking', { containers: -1, perContainer: 4 }), /how many containers/);
    r = await act(id, 'finishPacking', { containers: 8, perContainer: 4 });
    assert.match(r.message, /8 containers × 4 = 32 cookies packed/);
    ({ state } = await get());
    b = state.batches.find((x) => x.id === id);
    assert.strictEqual(b.stage, 'done');
    assert.deepStrictEqual(b.packed, { containers: 8, perContainer: 4, cookies: 32 });
    assert.deepStrictEqual(state.packLog.map((e) => [e.recipeId, e.containers, e.cookies]), [['r-sugar', 8, 32]]);
    // Manager moves it back out of done -> its count is removed; packing again re-adds it
    await act(id, 'setStage', { stage: 'packing' });
    ({ state } = await get());
    assert.strictEqual(state.packLog.length, 0);
    await act(id, 'finishPacking', { containers: 9, perContainer: 4 });
    ({ state } = await get());
    assert.deepStrictEqual(state.packLog.map((e) => e.containers), [9]);

    // Multiple prep stations
    await assert.rejects(call('PUT', '/api/settings', { prepStations: '' }), /at least one prep station/);
    await call('PUT', '/api/settings', { prepStations: 'Prep Table A\nPrep Table B' });
    ({ state } = await get());
    assert.deepStrictEqual(state.settings.prepStations, [{ name: 'Prep Table A', capacity: 1 }, { name: 'Prep Table B', capacity: 1 }], 'plain names -> capacity 1');
    const sn = state.batches.filter((x) => x.recipeId === 'r-snickerdoodle' && x.stage === 'queued').map((x) => x.id);
    assert.strictEqual(sn.length, 2);
    for (const sid of sn) { await act(sid, 'startMix'); await act(sid, 'finishMix'); }
    ({ plan } = await get());
    assert.deepStrictEqual(sn.map((sid) => plan.batches[sid].prepStation).sort(), ['Prep Table A', 'Prep Table B'], 'planner preps both at once');
    assert.strictEqual(plan.batches[sn[0]].prepStart, plan.batches[sn[1]].prepStart);
    await act(sn[0], 'startPrep', { station: 'Prep Table B' });
    await assert.rejects(act(sn[1], 'startPrep', { station: 'Prep Table B' }), /Prep Table B is full/);
    await assert.rejects(act(sn[1], 'startPrep', { station: 'Nope' }), /Unknown prep station/);
    await act(sn[1], 'startPrep'); // takes the free one
    ({ state, plan } = await get());
    assert.deepStrictEqual(sn.map((sid) => state.batches.find((x) => x.id === sid).location), ['Prep Table B', 'Prep Table A']);
    assert.strictEqual(plan.batches[sn[0]].prepStation, 'Prep Table B');
    for (const sid of sn) await act(sid, 'finishPrep', { pans: 3 });

    // Several batches at one prep station
    await call('PUT', '/api/settings', { prepStations: [{ name: 'Big Table', capacity: 2 }, { name: 'Big Table', capacity: 5 }, { name: ' ', capacity: 1 }] });
    ({ state } = await get());
    assert.deepStrictEqual(state.settings.prepStations, [{ name: 'Big Table', capacity: 2 }], 'duplicates and blanks dropped');
    await call('POST', '/api/batches', { recipeId: 'r-snickerdoodle', count: 3 });
    ({ state } = await get());
    const trio = state.batches.filter((x) => x.recipeId === 'r-snickerdoodle' && x.stage === 'queued').map((x) => x.id);
    for (const tid of trio) { await act(tid, 'startMix'); await act(tid, 'finishMix'); }
    ({ plan } = await get());
    const starts = trio.map((tid) => plan.batches[tid].prepStart).sort((a, b) => a - b);
    assert.strictEqual(starts[0], starts[1], 'two batches prep side by side at one station');
    assert.ok(starts[2] > starts[1], 'third waits for a free spot');
    await act(trio[0], 'startPrep', { station: 'Big Table' });
    await act(trio[1], 'startPrep');
    await assert.rejects(act(trio[2], 'startPrep'), /All prep stations are full/);
    await assert.rejects(act(trio[2], 'startPrep', { station: 'Big Table' }), /Big Table is full \(2 batches at once\)/);
    ({ state } = await get());
    assert.deepStrictEqual(trio.slice(0, 2).map((tid) => state.batches.find((x) => x.id === tid).location), ['Big Table', 'Big Table']);
    for (const tid of trio.slice(0, 2)) await act(tid, 'finishPrep', { pans: 2 });
    for (const tid of trio) await call('DELETE', `/api/batches/${tid}`);
    await call('PUT', '/api/settings', { prepStations: 'Prep Table A\nPrep Table B' });

    // Chilling panned dough after prep (seed: Oatmeal Raisin chills pans 20 min)
    await call('POST', '/api/batches', { recipeId: 'r-oatmeal', count: 2 });
    ({ state } = await get());
    const [oat1, oat2] = state.batches.filter((x) => x.recipeId === 'r-oatmeal').map((x) => x.id);
    for (const oid of [oat1, oat2]) {
      await act(oid, 'startMix');
      await act(oid, 'finishMix'); // no dough chill -> straight to prep
      await act(oid, 'startPrep');
    }
    r = await act(oat1, 'finishPrep', { pans: 4, to: 'Outdoor Chiller' });
    assert.match(r.message, /Outdoor Chiller — chill 20 min before baking/);
    ({ state, plan } = await get());
    let oat = state.batches.find((x) => x.id === oat1);
    assert.strictEqual(oat.stage, 'pan_chilling');
    assert.strictEqual(oat.location, 'Outdoor Chiller');
    const chillEnd = oat.t.panChillStart + 20 * 60000;
    assert.ok(plan.batches[oat1].loads.every((l) => l.start >= chillEnd), 'planner waits for the pan chill');
    assert.strictEqual(plan.batches[oat1].panChillEnd, chillEnd);
    r = await act(oat1, 'finishPanChill');
    assert.match(r.message, /Oven Staging Rack/);
    ({ state } = await get());
    assert.strictEqual(state.batches.find((x) => x.id === oat1).stage, 'staged');
    // Default chill location, and the baker can load straight from the chiller
    await act(oat2, 'finishPrep', { pans: 2 });
    ({ state } = await get());
    oat = state.batches.find((x) => x.id === oat2);
    assert.deepStrictEqual([oat.stage, oat.location], ['pan_chilling', 'Fridge']);
    await act(oat2, 'loadOven', { ovenId: 'oven1' });
    ({ state } = await get());
    oat = state.batches.find((x) => x.id === oat2);
    assert.strictEqual(oat.stage, 'baking');
    assert.ok(oat.t.panChillEnd);
    await call('POST', '/api/ovens/oven1/unload');
    // Recipe without pan chill still goes straight to the rack
    const noChill = state.recipes.find((x) => x.id === 'r-snickerdoodle');
    assert.ok(!noChill.panChillMinutes);

    // Alarm dismissals are shared by all tablets
    await call('POST', '/api/alarms/dismiss', { keys: ['bake-oven1-1-2', 'cool-x-0-5'] });
    await call('POST', '/api/alarms/dismiss', { keys: ['bake-oven1-1-2'] });
    ({ state } = await get());
    assert.deepStrictEqual(state.dismissedAlarms, ['bake-oven1-1-2', 'cool-x-0-5'], 'no duplicates');
    await assert.rejects(call('POST', '/api/alarms/dismiss', { keys: [] }), /No alarm keys/);

    // Oven "it's at temp" confirmation
    await call('POST', '/api/ovens/oven2/temp', { tempF: 350 });
    ({ state } = await get());
    assert.strictEqual(state.ovens.oven2.readyConfirmed, false);
    await call('POST', '/api/ovens/oven2/ready');
    ({ state } = await get());
    assert.strictEqual(state.ovens.oven2.readyConfirmed, true);

    // Next sugar batch is estimated from what prep reported (avg of 3 and 5)
    await call('POST', '/api/batches', { recipeId: 'r-sugar', count: 1 });
    ({ state, plan } = await get());
    assert.strictEqual(state.batches.at(-1).pans, 4);
    assert.deepStrictEqual(state.batches.at(-1).coolGroups, []);

    // Guard rails
    await assert.rejects(act(plan.mixQueue[0], 'finishPrep'), /not prepping/);

    // Recipe CRUD + settings
    const { recipe } = await call('POST', '/api/recipes', { name: 'Test', ovenTempF: 325, chillMinutes: 0, mixSteps: [{ text: 'Stir', minutes: '2' }, { text: '' }] });
    assert.deepStrictEqual(recipe.mixSteps, [{ text: 'Stir', minutes: 2 }]);
    assert.strictEqual(recipe.pansPerBatch, undefined, 'pans are no longer a recipe field');
    await call('POST', '/api/batches', { recipeId: recipe.id, count: 1 });
    ({ state } = await get());
    assert.strictEqual(state.batches.at(-1).pans, 4, 'new recipe falls back to defaultPansPerBatch');
    // Old export with pansPerBatch seeds the estimate
    await call('POST', '/api/recipes/import', [{ id: 'r-old', name: 'Old', pansPerBatch: 6 }]);
    ({ state } = await get());
    assert.strictEqual(state.recipes.find((x) => x.id === 'r-old').pansPerBatch, undefined);
    assert.deepStrictEqual(state.panHistory['r-old'], [6]);
    await call('PUT', '/api/settings', { ovens: 'A\nB\nC', ovenPansPerLoad: 3 });
    ({ state, plan } = await get());
    assert.strictEqual(state.settings.ovens.length, 3);
    assert.ok(plan.ovens.oven3, 'planner uses the new oven');

    await call('PUT', '/api/settings', { shares: 12 });
    ({ state } = await get());
    assert.strictEqual(state.settings.shares, 12, 'shares editable in settings');
    await call('POST', '/api/batches/clear-done');
    ({ state } = await get());
    assert.strictEqual(state.packLog.length, 1, 'clearing finished batches keeps packed counts');
    await call('POST', '/api/pack/reset');
    ({ state } = await get());
    assert.strictEqual(state.packLog.length, 0, 'new day resets packed counts');
    // Persistence
    await new Promise((res) => setTimeout(res, 500));
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert.strictEqual(saved.batches.length, 9);
    console.log('✓ all flow tests passed');
  } finally {
    srv.kill('SIGTERM');
  }
})().catch((e) => { console.error('✗', e); process.exitCode = 1; });
