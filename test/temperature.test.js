'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../lib/store');

test('the accepted temperature preference survives a new store instance and clearing preserves the command journal', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-temperature-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new StateStore(directory);
    assert.deepEqual(await store.read('temperature-preference', { targetCelsius: null }), { targetCelsius: null });
    await store.write('command-journal', { lastAttempt: 1700000000000 });
    await store.write('temperature-preference', { targetCelsius: 22.5 });
    const restarted = new StateStore(directory);
    assert.deepEqual(await restarted.read('temperature-preference'), { targetCelsius: 22.5 });
    await restarted.write('temperature-preference', { targetCelsius: null });
    assert.deepEqual(await new StateStore(directory).read('temperature-preference'), { targetCelsius: null });
    assert.deepEqual(await restarted.read('command-journal'), { lastAttempt: 1700000000000 });
    assert.deepEqual((await fs.readdir(directory)).sort(), ['command-journal.json', 'temperature-preference.json']);
});
