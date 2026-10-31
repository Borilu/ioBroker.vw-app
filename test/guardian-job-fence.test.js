'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../lib/store');
const { assertGuardianJobsClear } = require('../lib/guardian-job-fence');

test('a durable journal remains a barrier with a newly constructed store after restart', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-guardian-job-fence-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('vw-guardian-job-fence-'));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const first = new StateStore(directory);
    await assertGuardianJobsClear(first);
    // An existing, real journal on disk is intentionally used here; other
    // tests exercise write ordering and crash durability on supported systems.
    await fs.writeFile(path.join(directory, 'guardian-permission-state.json'),
        JSON.stringify({ status: 'attempting', version: 2 }), { mode: 0o600 });
    await assert.rejects(assertGuardianJobsClear(first), { code: 'guardian_phone_fenced' });
    const afterRestart = new StateStore(directory);
    await assert.rejects(assertGuardianJobsClear(afterRestart), { code: 'guardian_phone_fenced' });
});
