'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../lib/store');
const { recoveryStatus } = require('../lib/recovery-status');
const secret = 'b'.repeat(64);
const digest = crypto.createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex');
const deviceId = 'serial:SYNTHETIC';
function fixture(records = {}) {
    const values = { 'guardian-permission-state': { status: 'confirmed' },
        'guardian-pair-state': { status: 'android_verified_host_not_enabled', keyDigest: digest }, ...records };
    const reads = [];
    return { reads, store: { async read(name, fallback) { reads.push(name); return values[name] ?? fallback; } } };
}
test('legacy and bound pair only identify candidate, even without a runtime marker', async () => {
    const f = fixture();
    assert.equal(await recoveryStatus({ store: f.store, deviceId, guardianSecret: secret }), 'recovery_legacy_candidate');
    assert.deepEqual(f.reads.sort(), ['adb-execution-fence', 'guardian-pair-state', 'guardian-permission-state', 'guardian-test-state']);
});
test('all uncertain, malformed or new journal states require manual review', async () => {
    for (const records of [
        { 'guardian-permission-state': { status: 'attempting' } },
        { 'guardian-permission-state': { status: 'confirmed', version: 2 } },
        { 'guardian-permission-state': { status: 'confirmed', extra: 'unexpected' } },
        { 'guardian-pair-state': { status: 'attempting', keyDigest: digest } },
        { 'guardian-pair-state': { status: 'host_prepared', keyDigest: digest } },
        { 'guardian-pair-state': { status: 'android_verified_host_not_enabled', keyDigest: 'a'.repeat(64) } },
        { 'guardian-pair-state': { status: 'android_verified_host_not_enabled', keyDigest: digest, future: true } },
        { 'guardian-test-state': { version: 1, status: 'attempting' } },
        { 'guardian-test-state': { version: 9, status: 'confirmed' } },
        { 'guardian-test-state': { version: 1, status: 'confirmed', future: true } },
        { 'adb-execution-fence': { version: 1 } },
    ]) {
        const f = fixture(records);
        assert.equal(await recoveryStatus({ store: f.store, deviceId, guardianSecret: secret }), 'recovery_manual_review');
    }
});
test('missing pinned device, missing secret and unreadable files fail closed', async () => {
    const f = fixture();
    assert.equal(await recoveryStatus({ store: f.store, deviceId: '', guardianSecret: secret }), 'recovery_manual_review');
    assert.equal(await recoveryStatus({ store: f.store, deviceId, guardianSecret: '' }), 'recovery_manual_review');
    assert.equal(await recoveryStatus({ store: { read: async () => { throw Error('SECRET TEST STRING'); } }, deviceId,
        guardianSecret: secret }), 'recovery_manual_review');
});
test('the local status reader cannot replace or clear the exclusive execution fence', async () => {
    const store = new StateStore(path.join(os.tmpdir(), 'synthetic-unused-vw-recovery-path'));
    await assert.rejects(store.write('adb-execution-fence', {version: 1, token: 'a'.repeat(32)}), {code: 'invalid_state'});
});
