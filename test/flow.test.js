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
    await act(id, 'finishPacking');
    ({ state } = await get());
    assert.strictEqual(state.batches.find((x) => x.id === id).stage, 'done');

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

    await call('POST', '/api/batches/clear-done');
    // Persistence
    await new Promise((res) => setTimeout(res, 500));
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert.strictEqual(saved.batches.length, 7);
    console.log('✓ all flow tests passed');
  } finally {
    srv.kill('SIGTERM');
  }
})().catch((e) => { console.error('✗', e); process.exitCode = 1; });
