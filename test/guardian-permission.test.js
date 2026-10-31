'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../lib/store');
const { grantGuardianPermission, permissionState, userId } = require('../lib/guardian-permission');
const { APPROVED_APK_SHA256 } = require('../lib/guardian-binder-pair');
const PACKAGE = 'de.borilu.wirelessguardian';
const PERMISSION = 'android.permission.WRITE_SECURE_SETTINGS';
const APK = '/data/app/~~SYNTHETIC==/de.borilu.wirelessguardian-FAKE==/base.apk';

function fixture(options = {}) {
    const calls = [], records = [];
    let journalState = options.previous ?? null, granted = !!options.initiallyGranted, hashes = 0, sdkReads = 0, connects = 0, permissionReads = 0;
    const signal = new AbortController();
    const phone = {
        deviceId: options.unpinned ? '' : 'serial:SYNTHETIC-DEVICE',
        async connect() {
            calls.push('connect'); connects++;
            if (options.revokeOnSecondConnection && connects === 2) granted = false;
            if (options.badDevice || options.wrongDeviceAfterGrant && granted) throw Error('PRIVATE DEVICE');
        },
        async run(args) {
            calls.push(args);
            if (args.join(' ') === 'shell getprop ro.build.version.sdk') {
                sdkReads++;
                return options.badSdk || options.sdkChangesAfterGrant && granted || options.sdkChangesBeforeGrant && sdkReads > 1 ? '35' : '36';
            }
            if (args.join(' ') === 'shell am get-current-user') return options.badUser ? 'unknown' : '12\n';
            if (args.join(' ') === `shell pm path --user 12 ${PACKAGE}`) return 'package:' + APK;
            if (args.join(' ') === 'shell sha256sum ' + APK) {
                hashes++;
                const bad = options.badHash || (options.changeApkAfterGrant && granted);
                return (bad ? 'a'.repeat(64) : APPROVED_APK_SHA256) + '  ' + (options.hashPathMismatch ? APK.replace('FAKE','OTHER') : APK);
            }
            if (args.join(' ') === `shell dumpsys package check-permission ${PERMISSION} ${PACKAGE} 12`) {
                permissionReads++;
                if (options.revokeOnFinalCheck && permissionReads === 3) granted = false;
                return options.badStatus ? 'PRIVATE UNKNOWN' : granted ? '0' : '-1';
            }
            if (args.join(' ') === `shell pm grant --user 12 ${PACKAGE} ${PERMISSION}`) {
                if (options.abortOnGrant) signal.abort();
                if (!options.grantWithoutEffect) granted = true;
                if (options.grantThrows) throw Error('PRIVATE ERROR');
                return options.grantOutput || '';
            }
            throw Error('unexpected command');
        },
    };
    const journal = { async read() { return journalState; }, async write(value) {
        records.push(value);
        if (options.journalFailure) throw Error('PRIVATE JOURNAL');
        journalState = value;
    } };
    return { phone, journal, records, calls, signal, getJournal: () => journalState, setGranted: value => { granted = value; },
        args: { phone, journal, signal: signal.signal, userConfirmed: true }, getHashes: () => hashes };
}
const grantCalls = f => f.calls.filter(c => Array.isArray(c) && c[0] === 'shell' && c[1] === 'pm' && c[2] === 'grant');
test('explicit consent, pinned phone, exact approved APK and active user are required', async () => {
    for (const opts of [{badDevice:true}, {badUser:true}, {badHash:true}, {badStatus:true}, {hashPathMismatch:true}, {badSdk:true}]) {
        const f = fixture(opts);
        await assert.rejects(grantGuardianPermission(f.args), e => e.code === 'guardian_permission_unconfirmed' && !e.message.includes('PRIVATE'));
        assert.equal(grantCalls(f).length, 0); assert.equal(f.records.length, 0);
    }
    const f = fixture(); f.args.userConfirmed = false;
    await assert.rejects(grantGuardianPermission(f.args), e => e.code === 'guardian_permission_consent_required');
    assert.deepEqual(f.calls, []);
    const unpinned = fixture({unpinned:true});
    await assert.rejects(grantGuardianPermission(unpinned.args)); assert.deepEqual(unpinned.calls, []);
});
test('an observed permission never clears a previously uncertain grant', async () => {
    const f = fixture({initiallyGranted:true, previous: {status:'attempting'}});
    await assert.rejects(grantGuardianPermission(f.args), e => e.code === 'guardian_permission_unconfirmed');
    assert.equal(grantCalls(f).length, 0); assert.deepEqual(f.records, []); assert.equal(f.getHashes(), 2);
    assert.deepEqual(f.getJournal(), {status:'attempting'});
});
test('an existing permission and invalid or failed recovery journal do not issue a grant or false success', async () => {
    for (const options of [{initiallyGranted:true, previous:{status:'damaged'}},
        {initiallyGranted:true, previous:{status:'attempting'}, journalFailure:true}]) {
        const f = fixture(options);
        await assert.rejects(grantGuardianPermission(f.args)); assert.equal(grantCalls(f).length, 0);
    }
});
test('revocation between initial and final check cannot confirm an old uncertain grant', async () => {
    const f = fixture({initiallyGranted:true, previous:{status:'attempting'}, revokeOnSecondConnection:true});
    await assert.rejects(grantGuardianPermission(f.args));
    assert.deepEqual(f.getJournal(), {status:'attempting'}); assert.equal(f.records.length, 0); assert.equal(grantCalls(f).length, 0);
});
test('only the fixed user and permission are granted once after the durable fence and independently checked', async () => {
    const f = fixture();
    assert.deepEqual(await grantGuardianPermission(f.args), {result:'guardian_permission_granted'});
    assert.deepEqual(f.records, [{status:'attempting',version:2}, {status:'confirmed',version:2}]);
    assert.deepEqual(grantCalls(f), [['shell','pm','grant','--user','12',PACKAGE,PERMISSION]]);
    assert.ok(f.getHashes() >= 3);
});
test('an uncertain grant does not retry when the permission remains denied', async () => {
    for (const opts of [{grantWithoutEffect:true}, {grantOutput:'PRIVATE UNKNOWN'}, {abortOnGrant:true}]) {
        const f = fixture(opts); await assert.rejects(grantGuardianPermission(f.args));
        assert.deepEqual(f.getJournal(), {status:'attempting',version:2}); assert.equal(grantCalls(f).length, 1);
        if (opts.grantWithoutEffect) {
            await assert.rejects(grantGuardianPermission(f.args));
            assert.equal(grantCalls(f).length, 1);
        }
    }
});
test('a delayed grant or independently granted permission cannot clear an uncertain fence', async () => {
    const f = fixture({grantWithoutEffect:true, grantThrows:true});
    await assert.rejects(grantGuardianPermission(f.args));
    assert.deepEqual(f.getJournal(),{status:'attempting',version:2}); assert.equal(grantCalls(f).length,1);
    // An independent action can temporarily produce a granted status while
    // the original timed-out ADB process may still be alive.
    f.setGranted(true);
    await assert.rejects(grantGuardianPermission(f.args),e=>e.code==='guardian_permission_unconfirmed');
    assert.deepEqual(f.getJournal(),{status:'attempting',version:2}); assert.equal(grantCalls(f).length,1);
    f.setGranted(false);
    await assert.rejects(grantGuardianPermission(f.args));
    f.setGranted(true); // Original delayed command arrives after revocation.
    await assert.rejects(grantGuardianPermission(f.args));
    assert.deepEqual(f.getJournal(),{status:'attempting',version:2}); assert.equal(grantCalls(f).length,1);
});
test('a previously confirmed grant remains read-only when permission is already present', async () => {
    const f=fixture({initiallyGranted:true,previous:{status:'confirmed',version:2}});
    assert.deepEqual(await grantGuardianPermission(f.args),{result:'guardian_permission_already_granted'});
    assert.deepEqual(f.getJournal(),{status:'confirmed',version:2}); assert.equal(grantCalls(f).length,0);
});
test('a permission grant followed by an app update remains uncertain and never retries', async () => {
    for (const options of [{changeApkAfterGrant:true}, {wrongDeviceAfterGrant:true}, {sdkChangesAfterGrant:true}, {revokeOnFinalCheck:true}]) {
        const f = fixture(options);
        await assert.rejects(grantGuardianPermission(f.args), e => e.code === 'guardian_permission_unconfirmed');
        assert.deepEqual(f.getJournal(), {status:'attempting',version:2}); assert.equal(grantCalls(f).length, 1);
        await assert.rejects(grantGuardianPermission(f.args)); assert.equal(grantCalls(f).length, 1);
    }
});
test('failure to persist fence prevents any Android grant', async () => {
    const f = fixture({journalFailure:true});
    await assert.rejects(grantGuardianPermission(f.args));
    assert.equal(grantCalls(f).length, 0);
});
test('an SDK change after the first check blocks before the grant', async () => {
    const f = fixture({sdkChangesBeforeGrant:true});
    await assert.rejects(grantGuardianPermission(f.args));
    assert.equal(grantCalls(f).length, 0); assert.deepEqual(f.getJournal(), {status:'attempting',version:2});
});
test('a previously confirmed grant that was later revoked needs a new explicit action', async () => {
    const f = fixture({ previous: {status:'confirmed',version:2} });
    assert.deepEqual(await grantGuardianPermission(f.args), {result:'guardian_permission_granted'});
    assert.equal(grantCalls(f).length, 1);
});
test('a legacy confirmed record is observable when granted but never authorizes another grant when denied', async () => {
    const granted = fixture({initiallyGranted:true,previous:{status:'confirmed'}});
    assert.deepEqual(await grantGuardianPermission(granted.args),{result:'guardian_permission_legacy_granted_limited'});
    assert.deepEqual(granted.getJournal(),{status:'confirmed'}); assert.equal(grantCalls(granted).length,0);
    const denied = fixture({previous:{status:'confirmed'}});
    await assert.rejects(grantGuardianPermission(denied.args),e=>e.code==='guardian_permission_unconfirmed');
    assert.deepEqual(denied.getJournal(),{status:'confirmed'}); assert.equal(grantCalls(denied).length,0);
});
test('unknown journal versions fail closed and cannot authorize a grant', async () => {
    for (const initiallyGranted of [false,true]) {
        const f=fixture({initiallyGranted,previous:{status:'confirmed',version:999}});
        await assert.rejects(grantGuardianPermission(f.args),e=>e.code==='guardian_permission_unconfirmed');
        assert.equal(grantCalls(f).length,0); assert.equal(f.records.length,0);
    }
});
test('status and user parsers fail closed for extra output and unexpected data', () => {
    assert.equal(permissionState('0\n'), true); assert.equal(permissionState('-1'), false);
    for (const value of ['0\n1', '', 'true', '-2']) assert.throws(() => permissionState(value));
    assert.equal(userId('12\n'), '12');
    for (const value of ['', '-1', '01', '12\n13', '1000000']) assert.throws(() => userId(value));
});
test('permission journal has its own allowlisted private state file', () => {
    const store = new StateStore(os.tmpdir());
    assert.equal(store.file('guardian-permission-state'), path.join(os.tmpdir(), 'guardian-permission-state.json'));
    assert.throws(() => store.file('../guardian-permission-state'));
});
test('permission journal survives a new StateStore instance', { skip: process.platform === 'win32' }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guardian-permission-test-'));
    const store = new StateStore(directory);
    try {
        await store.write('guardian-permission-state', {status:'attempting'});
        assert.deepEqual(await new StateStore(directory).read('guardian-permission-state'), {status:'attempting'});
    } finally {
        await fs.unlink(path.join(directory, 'guardian-permission-state.json')).catch(() => {});
        await fs.rmdir(directory);
    }
});
