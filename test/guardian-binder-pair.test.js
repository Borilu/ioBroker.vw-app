'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../lib/store');
const { prepareHost, transferAndVerify, approveRecovery, testTransport, pairingStatus } = require('../lib/guardian-binder-pair');

const secret = '42'.repeat(32); // synthetic only
const digest = crypto.createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex');
const journalFor = status => ({ status, keyDigest: digest });
const apkHash = 'a'.repeat(64);
const apk = '/data/app/~~ABC==/de.borilu.wirelessguardian-ABC==/base.apk';
function fixture(options = {}) {
    let journal = Object.hasOwn(options, 'journal') ? options.journal : options.empty ? null : journalFor('host_prepared');
    let testJournal = Object.hasOwn(options, 'testJournal') ? options.testJournal : null;
    let queries = 0;
    const calls = [], writes = [];
    const adapter = {
        namespace: 'vw-app.99', config: { guardianSecret: options.empty ? '' : secret },
        settings: { hostIp: '192.168.1.2', guardianPort: 37457, guardianPortDiscovery: !!options.enabled },
        abortController: new AbortController(),
        guardianProtectionReady: async () => !options.unprotected,
        encrypt: value => 'encrypted:' + value,
        extendForeignObjectAsync: async (...args) => { if (options.writeFailure) throw Error('private'); writes.push(args); },
        store: { read: async name => name === 'guardian-test-state' ? testJournal : journal,
            write: async (name, value) => { if (name === 'guardian-test-state') testJournal = value; else journal = value; } },
    };
    const phone = { connect: async () => { if (options.badPhone) throw Error('private'); },
        run: async args => { calls.push(args); const command = args.join(' ');
            if (command === 'shell pm path de.borilu.wirelessguardian') return 'package:' + apk;
            if (command === 'shell sha256sum ' + apk) return (options.badHash ? 'b'.repeat(64) : apkHash) + '  ' + apk;
            if (command.includes('--method port_status')) return 'Result: Bundle[{result=' + (options.active ? 'not_resettable' : 'inactive_closed') + '}]';
            if (command.includes('--method synthetic_status')) return 'Result: Bundle[{result=' + (options.badStatus ? 'unknown' : 'test_ok') + '}]';
            if (command.includes('--method pair_status')) {
                queries++;
                if (options.abortOnStatus) adapter.abortController.abort();
                return 'Result: Bundle[{result=' + (options.badStatus ? 'unknown' : queries <= (options.pendingCount || 0) ? 'pending' : 'prepared') + '}]';
            }
            if (command.includes('--method pair_commit')) { if (options.commitError) throw Error('private'); return 'Result: Bundle[{result=committed}]'; }
            throw Error('unexpected'); },
        runSensitive: async (args, input) => { calls.push(args); if (args.some(v => v.includes('/synthetic?'))) {
            assert.deepEqual(input, Buffer.alloc(32, 0x42)); return ''; }
            assert.equal(input.subarray(0,8).toString(), 'VWGPREP2');
            assert.equal(input.subarray(-32).toString('hex'), secret); if (options.transferError) throw Error('private'); return ''; } };
    return { adapter, calls, writes, getJournal: () => journal, getTestJournal: () => testJournal,
        args: { adapter, phone, vmIp: '192.168.100.33', approvedApkHash: apkHash,
            randomBytes: size => Buffer.alloc(size, 0x41),
            guardianQuery: async () => options.badQuery ? null : 43000,
            verifyEndpoint: async () => { if (options.badEndpoint) throw Error('private'); } } };
}
test('synthetic Binder test persists only its non-secret completion marker', async () => {
    const f = fixture({ empty: true });
    assert.deepEqual(await testTransport({ adapter: f.adapter, phone: f.args.phone, approvedApkHash: apkHash }), { result: 'guardian_binder_test_ok' });
    assert.equal(f.writes.length, 0); assert.equal(f.getJournal(), null);
    assert.deepEqual(f.getTestJournal(), { version: 1, status: 'confirmed' });
    assert.equal(f.calls.filter(a => a.includes('write')).length, 1);
    assert.equal(f.calls.some(a => a.includes('pair_commit')), false);
});
test('an unclear asynchronous synthetic test blocks repeat, preparation and transfer after restart', async () => {
    const f = fixture({empty: true, badStatus: true});
    await assert.rejects(testTransport({ adapter: f.adapter, phone: f.args.phone, approvedApkHash: apkHash }));
    assert.deepEqual(f.getTestJournal(), { version: 1, status: 'attempting' });
    const calls = f.calls.length;
    await assert.rejects(testTransport({ adapter: f.adapter, phone: f.args.phone, approvedApkHash: apkHash }));
    await assert.rejects(prepareHost({adapter: f.adapter}));
    await assert.rejects(transferAndVerify(f.args));
    assert.equal(await pairingStatus(f.adapter), 'guardian_status_uncertain');
    assert.equal(f.calls.length, calls);
    const successor = fixture({ empty: true, testJournal: f.getTestJournal() });
    await assert.rejects(testTransport({ adapter: successor.adapter, phone: successor.args.phone, approvedApkHash: apkHash }));
    assert.equal(successor.calls.length, 0);
});
test('synthetic fence persistence failure happens before Android receives the test', async () => {
    const f = fixture({empty: true});
    const write = f.adapter.store.write;
    f.adapter.store.write = async (name, value) => { if (name === 'guardian-test-state') throw Error('disk failure'); return write(name, value); };
    await assert.rejects(testTransport({ adapter: f.adapter, phone: f.args.phone, approvedApkHash: apkHash }));
    assert.equal(f.calls.some(a => a.includes('write')), false);
});
test('synthetic completion storage failure retains the pending marker and blocks subsequent access', async () => {
    const f = fixture({empty: true});
    const write = f.adapter.store.write;
    f.adapter.store.write = async (name, value) => {
        if (name === 'guardian-test-state' && value.status === 'confirmed') throw Error('disk failure');
        return write(name, value);
    };
    await assert.rejects(testTransport({ adapter: f.adapter, phone: f.args.phone, approvedApkHash: apkHash }));
    assert.deepEqual(f.getTestJournal(), {version: 1, status: 'attempting'});
    const calls = f.calls.length;
    await assert.rejects(testTransport({ adapter: f.adapter, phone: f.args.phone, approvedApkHash: apkHash }));
    await assert.rejects(prepareHost({adapter: f.adapter}));
    assert.equal(f.calls.length, calls);
});
test('pending real pairing prevents even a synthetic test', async () => {
    const f = fixture({journal: journalFor('attempting')});
    await assert.rejects(testTransport({ adapter: f.adapter, phone: f.args.phone, approvedApkHash: apkHash }));
    assert.equal(f.calls.length, 0);
});
test('synthetic pending marker survives a new StateStore instance', { skip: process.platform === 'win32' }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'guardian-synthetic-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const first = new StateStore(dir);
    await first.write('guardian-test-state', {version: 1, status: 'attempting'});
    const next = new StateStore(dir);
    assert.deepEqual(await next.read('guardian-test-state', null), {version: 1, status: 'attempting'});
    const f = fixture({empty: true});
    f.adapter.store = next;
    await assert.rejects(testTransport({ adapter: f.adapter, phone: f.args.phone, approvedApkHash: apkHash }));
    assert.equal(f.calls.length, 0);
});
test('host preparation saves only a protected encrypted key and waits for separate action', async () => {
    const f = fixture({ empty: true });
    await prepareHost({ adapter: f.adapter, randomBytes: () => Buffer.alloc(32, 0x42) });
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0], ['system.adapter.vw-app.99', { native: { guardianSecret: 'encrypted:' + secret } }]);
    assert.deepEqual(f.getJournal(), journalFor('host_prepared'));
});
test('unresolved and legacy recovery journals never release a delayed host client fence', async () => {
    for (const status of ['attempting', 'android_verified_host_not_enabled', 'recovery_approved']) {
        const f = fixture({journal: journalFor(status)});
        // Even an explicit confirmation and inactive phone do not prove the
        // earlier /prepare client has stopped. A fresh window could be taken.
        await assert.rejects(approveRecovery({ adapter: f.adapter, phone: f.args.phone, approvedApkHash: apkHash, userConfirmed: true }));
        await assert.rejects(transferAndVerify(f.args));
        assert.deepEqual(f.getJournal(), journalFor(status));
        assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
        if (status === 'recovery_approved') assert.equal(await pairingStatus(f.adapter), 'guardian_status_uncertain');
    }
});
test('existing config, active discovery, journal and absent protection block preparation', async () => {
    for (const opts of [{}, { empty: true, enabled: true }, { empty: true, journal: { status: 'attempting' } }, { empty: true, unprotected: true }]) {
        const f = fixture(opts); await assert.rejects(prepareHost({ adapter: f.adapter })); assert.equal(f.writes.length, 0);
    }
});
test('manual key without host preparation and nonstandard Guardian port fail before phone contact', async () => {
    const existing = fixture({journal: null});
    await assert.rejects(transferAndVerify(existing.args));
    assert.equal(existing.calls.length, 0);
    const wrongPort = fixture(); wrongPort.adapter.settings.guardianPort = 5555;
    await assert.rejects(transferAndVerify(wrongPort.args));
    assert.equal(wrongPort.calls.length, 0);
    const wrongPortHost = fixture({empty: true}); wrongPortHost.adapter.settings.guardianPort = 5555;
    await assert.rejects(prepareHost({adapter: wrongPortHost.adapter}));
    assert.equal(wrongPortHost.writes.length, 0);
});
test('a prepared journal is bound to the generated key, including after interrupted config save', async () => {
    const f = fixture({empty: true});
    f.adapter.extendForeignObjectAsync = async () => { throw Error('synthetic interrupted write'); };
    await assert.rejects(prepareHost({adapter: f.adapter, randomBytes: () => Buffer.alloc(32, 0x42)}));
    assert.deepEqual(f.getJournal(), journalFor('host_prepared'));
    // A different, externally supplied key cannot reuse the old marker.
    f.adapter.config.guardianSecret = '43'.repeat(32);
    await assert.rejects(transferAndVerify(f.args));
    assert.equal(f.calls.length, 0);
    assert.equal(f.writes.length, 0);
});
test('changed secret after an uncertain transaction cannot release its fence', async () => {
    const f = fixture({journal: journalFor('attempting')});
    f.adapter.config.guardianSecret = '43'.repeat(32);
    await assert.rejects(approveRecovery({ adapter: f.adapter, phone: f.args.phone, approvedApkHash: apkHash, userConfirmed: true }));
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.getJournal(), journalFor('attempting'));
});
test('existing enabled connection with legacy journal remains visible and is not automatically altered', async () => {
    const f = fixture({ enabled: true, journal: { status: 'android_verified_host_not_enabled' } });
    assert.equal(await pairingStatus(f.adapter), 'guardian_status_enabled_needs_check');
    assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
    await assert.rejects(transferAndVerify(f.args));
    assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});
test('old uncertain journal without key binding cannot silently permit a retry or recovery', async () => {
    const f = fixture({ journal: { status: 'attempting' } });
    await assert.rejects(transferAndVerify(f.args));
    await assert.rejects(approveRecovery({ adapter: f.adapter, phone: f.args.phone, approvedApkHash: apkHash, userConfirmed: true }));
    assert.deepEqual(f.getJournal(), { status: 'attempting' });
    assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});
test('transfer uses stdin, persists fence, authenticates UDP and identity before enabling', async () => {
    const f = fixture(); await transferAndVerify(f.args);
    assert.deepEqual(f.getJournal(), journalFor('android_verified_host_not_enabled'));
    assert.deepEqual(f.writes[0], ['system.adapter.vw-app.99', { native: { guardianPortDiscovery: true } }]);
    assert.equal(JSON.stringify(f.calls).includes(secret), false);
});
test('pending provider preparation is polled with same transaction, without retransmission or repeated commit', async () => {
    const f = fixture({ pendingCount: 2 });
    f.args.wait = async () => {};
    await transferAndVerify(f.args);
    const writes = f.calls.filter(a => a.includes('write'));
    const status = f.calls.filter(a => a.includes('pair_status'));
    const commits = f.calls.filter(a => a.includes('pair_commit'));
    assert.equal(writes.length, 1); assert.equal(status.length, 3); assert.equal(commits.length, 1);
    assert.equal(new Set([...status, ...commits].map(a => a.at(-1))).size, 1);
});
test('pending timeout and cancellation preserve durable fence and never commit', async () => {
    for (const options of [{ pendingCount: 999 }, { pendingCount: 999, abortOnStatus: true }]) {
        const f = fixture(options); let tick = 0;
        f.args.now = () => tick; f.args.wait = async () => { tick += 1000; };
        await assert.rejects(transferAndVerify(f.args));
        assert.deepEqual(f.getJournal(), journalFor('attempting'));
        assert.equal(f.calls.some(a => a.includes('pair_commit')), false);
        assert.equal(f.writes.length, 0);
    }
});
test('adapter restart during host config save leaves no phone contact and must not reprepare', async () => {
    const f = fixture({ empty: true });
    f.adapter.extendForeignObjectAsync = async (_, patch) => {
        f.adapter.config.guardianSecret = secret; // controller has persisted the encrypted value
        assert.deepEqual(Object.keys(patch.native), ['guardianSecret']);
        throw Error('adapter restarted before callback');
    };
    await assert.rejects(prepareHost({ adapter: f.adapter, randomBytes: () => Buffer.alloc(32, 0x42) }));
    await assert.rejects(prepareHost({ adapter: f.adapter }));
    assert.equal(f.calls.length, 0);
});
test('adapter restart during enabling preserves verified-but-not-confirmed journal and blocks repeat', async () => {
    const f = fixture();
    f.adapter.extendForeignObjectAsync = async () => { throw Error('adapter restarted before callback'); };
    await assert.rejects(transferAndVerify(f.args));
    assert.deepEqual(f.getJournal(), journalFor('android_verified_host_not_enabled'));
    const count = f.calls.length;
    await assert.rejects(transferAndVerify(f.args)); assert.equal(f.calls.length, count);
});
test('cancellation immediately before discovery change prevents configuration write', async () => {
    const f = fixture();
    f.args.verifyEndpoint = async () => f.adapter.abortController.abort();
    await assert.rejects(transferAndVerify(f.args));
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.getJournal(), journalFor('attempting'));
});
test('failure after fence is permanent and never enables or retries the transfer', async () => {
    for (const opts of [{ transferError: true }, { badStatus: true }, { commitError: true }, { badQuery: true }, { badEndpoint: true }]) {
        const f = fixture(opts); await assert.rejects(transferAndVerify(f.args));
        assert.deepEqual(f.getJournal(), journalFor('attempting')); assert.equal(f.writes.length, 0);
        const count = f.calls.length; await assert.rejects(transferAndVerify(f.args)); assert.equal(f.calls.length, count);
    }
});
test('invalid handset or APK never sends a key and never enables discovery', async () => {
    for (const opts of [{ badPhone: true }, { badHash: true }, { enabled: true }, { unprotected: true }]) {
        const f = fixture(opts); await assert.rejects(transferAndVerify(f.args));
        assert.equal(f.writes.length, 0); assert.deepEqual(f.getJournal(), journalFor('host_prepared'));
        assert.equal(f.calls.some(args => args.includes('write')), false);
    }
});
