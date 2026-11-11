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
    r = await act(id, 'finishPrep');
    ({ state } = await get());
    let b = state.batches.find((x) => x.id === id);
    assert.strictEqual(b.stage, 'staged');

    await call('POST', '/api/ovens/oven1/temp', { tempF: 375 });
    await call('POST', '/api/ovens/oven1/ready');
    await act(id, 'loadOven', { ovenId: 'oven1' });
    await assert.rejects(act(id, 'loadOven', { ovenId: 'oven1' }), /already has/);
    await act(id, 'loadOven', { ovenId: 'oven2' }); // 3 pans, 2 per load -> second load (1 pan)
    await call('POST', '/api/ovens/oven1/unload');
    ({ state } = await get());
    b = state.batches.find((x) => x.id === id);
    assert.strictEqual(b.stage, 'baking');
    assert.strictEqual(b.pansBaked, 2);
    r = await call('POST', '/api/ovens/oven2/unload');
    ({ state, plan } = await get());
    b = state.batches.find((x) => x.id === id);
    assert.strictEqual(b.stage, 'cooling', 'all pans out -> cooling');
    assert.ok(b.coolingArea);
    await act(id, 'finishCooling');
    await act(id, 'finishPacking');
    ({ state } = await get());
    assert.strictEqual(state.batches.find((x) => x.id === id).stage, 'done');

    // Guard rails
    await assert.rejects(act(plan.mixQueue[0], 'finishPrep'), /not prepping/);

    // Recipe CRUD + settings
    const { recipe } = await call('POST', '/api/recipes', { name: 'Test', ovenTempF: 325, chillMinutes: 0, mixSteps: [{ text: 'Stir', minutes: '2' }, { text: '' }] });
    assert.deepStrictEqual(recipe.mixSteps, [{ text: 'Stir', minutes: 2 }]);
    await call('PUT', '/api/settings', { ovens: 'A\nB\nC', ovenPansPerLoad: 3 });
    ({ state, plan } = await get());
    assert.strictEqual(state.settings.ovens.length, 3);
    assert.ok(plan.ovens.oven3, 'planner uses the new oven');

    await call('POST', '/api/batches/clear-done');
    // Persistence
    await new Promise((res) => setTimeout(res, 500));
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert.strictEqual(saved.batches.length, 5);
    console.log('✓ all flow tests passed');
  } finally {
    srv.kill('SIGTERM');
  }
})().catch((e) => { console.error('✗', e); process.exitCode = 1; });
