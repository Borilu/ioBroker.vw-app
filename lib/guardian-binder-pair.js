'use strict';

// Experimental only: no automatic retry, no credentials in command arguments.
const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { BridgeError } = require('./errors');
const { privateIp, parsePackagePath, parseHash } = require('./guardian-pair-utils');

const PACKAGE = 'de.borilu.wirelessguardian';
const URI = 'content://de.borilu.wirelessguardian.pairtest';
const JOURNAL = 'guardian-pair-state';

// Prototype release anchor, updated only after the signed Android build and
// independent review. Never accept a digest from Admin or the phone.
const APPROVED_APK_SHA256 = '7af7fcf134919c54db0004fbe31d6646fa90822649e9656509a3019ee1886b30';

function failed(code = 'guardian_pair_uncertain') {
    return new BridgeError(code, 'Guardian pairing did not complete or its outcome is uncertain. No automatic retry was made.');
}

// Only a one-way digest of a uniformly random 256-bit key is persisted in the
// private journal, to bind each retry fence to the exact host configuration.
// It never contains the secret itself or any Volkswagen credentials.
function keyDigest(secret) {
    if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) return null;
    const key = Buffer.from(secret, 'hex');
    try { return crypto.createHash('sha256').update(key).digest('hex'); }
    finally { key.fill(0); }
}
function bound(journal, secret) {
    const digest = keyDigest(secret);
    return digest !== null && /^[a-f0-9]{64}$/.test(journal?.keyDigest || '') && journal.keyDigest === digest;
}

async function prepareHost({ adapter, randomBytes = crypto.randomBytes }) {
    const journal = await adapter.store.read(JOURNAL, null);
    if (!(await adapter.guardianProtectionReady()) || adapter.settings.guardianPortDiscovery || adapter.settings.guardianPort !== 37457 ||
        (adapter.config.guardianSecret !== undefined && adapter.config.guardianSecret !== '') ||
        (journal !== null && journal?.status !== 'host_prepared')) throw failed('guardian_pair_not_empty');
    let key;
    try {
        key = randomBytes(32);
        if (!Buffer.isBuffer(key) || key.length !== 32) throw failed();
        const plaintext = key.toString('hex');
        const encrypted = adapter.encrypt(plaintext);
        if (typeof encrypted !== 'string' || !encrypted || encrypted === plaintext) throw failed();
        if (adapter.stopping || adapter.abortController?.signal.aborted || adapter.settings.guardianPortDiscovery ||
            (adapter.config.guardianSecret !== undefined && adapter.config.guardianSecret !== '')) throw failed();
        // This marker makes it impossible to mistake a manually configured
        // pre-existing secret for an explicitly started first pairing.
        await adapter.store.write(JOURNAL, { status: 'host_prepared', keyDigest: keyDigest(plaintext) });
        if (!(await adapter.guardianProtectionReady()) || adapter.stopping || adapter.abortController?.signal.aborted ||
            adapter.settings.guardianPortDiscovery || adapter.settings.guardianPort !== 37457 ||
            (adapter.config.guardianSecret !== undefined && adapter.config.guardianSecret !== '')) throw failed();
        // Only the protected field is changed; the controller may restart this
        // adapter immediately, so no subsequent action depends on this return.
        await adapter.extendForeignObjectAsync('system.adapter.' + adapter.namespace,
            { native: { guardianSecret: encrypted } });
        return { result: 'guardian_host_prepared_reload' };
    } catch (_) { throw failed(); }
    finally { key?.fill(0); }
}

async function verifyGuardian(phone, apkHash) {
    if (!phone || !/^[a-f0-9]{64}$/.test(apkHash || '')) throw failed();
    await phone.connect(); // independently verifies the already enrolled device
    const apk = parsePackagePath(await phone.run(['shell', 'pm', 'path', PACKAGE]));
    if (parseHash(await phone.run(['shell', 'sha256sum', apk])) !== apkHash) throw failed();
}

async function testTransport({ adapter, phone, approvedApkHash, randomBytes = crypto.randomBytes,
    now = Date.now, wait = sleep }) {
    const check = () => { if (adapter.stopping || adapter.abortController.signal.aborted) throw failed(); };
    let synthetic;
    try {
        check(); await verifyGuardian(phone, approvedApkHash); check();
        const bytes = randomBytes(16);
        if (!Buffer.isBuffer(bytes) || bytes.length !== 16) throw failed();
        const token = bytes.toString('hex'); bytes.fill(0);
        synthetic = Buffer.alloc(32, 0x42); // fixed test value; never a real key
        const out = await phone.runSensitive(['shell', '-T', 'content', 'write', '--uri',
            URI + '/synthetic?token=' + token], synthetic, 10000);
        if (String(out).trim() !== '') throw failed();
        check();
        const until = now() + 5000;
        for (;;) {
            const status = String(await phone.run(['shell', 'content', 'call', '--uri', URI,
                '--method', 'synthetic_status', '--arg', token])).trim();
            check();
            if (status === 'Result: Bundle[{result=test_ok}]') return { result: 'guardian_binder_test_ok' };
            if (status !== 'Result: Bundle[{result=pending}]' || now() >= until) throw failed();
            await wait(Math.min(150, Math.max(1, until - now())), undefined, { signal: adapter.abortController.signal });
        }
    } catch (_) { throw new BridgeError('guardian_binder_test_failed', 'The synthetic Guardian test did not complete. No key or port setting was saved.'); }
    finally { synthetic?.fill(0); }
}

async function approveRecovery({ adapter, phone, approvedApkHash, userConfirmed }) {
    const status = await adapter.store.read(JOURNAL, null);
    if (userConfirmed !== true || !['attempting', 'android_verified_host_not_enabled'].includes(status?.status) ||
        adapter.settings.guardianPortDiscovery || !/^[a-f0-9]{64}$/.test(adapter.config.guardianSecret || '') ||
        !bound(status, adapter.config.guardianSecret) || !(await adapter.guardianProtectionReady())) throw failed('guardian_recovery_not_ready');
    try {
        if (adapter.stopping || adapter.abortController.signal.aborted) throw failed();
        await verifyGuardian(phone, approvedApkHash);
        if (adapter.stopping || adapter.abortController.signal.aborted) throw failed();
        const out = await phone.run(['shell', 'content', 'call', '--uri', URI, '--method', 'port_status']);
        if (String(out).trim() !== 'Result: Bundle[{result=inactive_closed}]' || adapter.stopping ||
            adapter.abortController.signal.aborted || adapter.settings.guardianPortDiscovery ||
            !bound(status, adapter.config.guardianSecret)) throw failed();
        // Explicitly allow one new attempt only after the user turned off
        // Android's port service and the app reports no pending transaction.
        await adapter.store.write(JOURNAL, { status: 'recovery_approved', keyDigest: status.keyDigest });
        return { result: 'guardian_recovery_approved' };
    } catch (_) { throw failed(); }
}

async function transferAndVerify({ adapter, phone, vmIp, approvedApkHash, guardianQuery,
    verifyEndpoint, randomBytes = crypto.randomBytes, now = Date.now, wait = sleep }) {
    const existing = await adapter.store.read(JOURNAL, null);
    if (!(await adapter.guardianProtectionReady()) || adapter.settings.guardianPortDiscovery || adapter.settings.guardianPort !== 37457 ||
        !privateIp(vmIp) || !privateIp(adapter.settings.hostIp) ||
        !/^[a-f0-9]{64}$/.test(adapter.config.guardianSecret || '') ||
        typeof guardianQuery !== 'function' || typeof verifyEndpoint !== 'function' ||
        !['host_prepared', 'recovery_approved'].includes(existing?.status) ||
        !bound(existing, adapter.config.guardianSecret)) throw failed('guardian_pair_not_ready');

    let key, frame;
    const expectedKey = adapter.config.guardianSecret;
    const expectedHost = adapter.settings.hostIp;
    const expectedPort = adapter.settings.guardianPort;
    const check = () => {
        if (adapter.stopping || adapter.abortController.signal.aborted || adapter.settings.guardianPortDiscovery ||
            adapter.config.guardianSecret !== expectedKey || adapter.settings.hostIp !== expectedHost ||
            adapter.settings.guardianPort !== expectedPort) throw failed();
    };
    try {
        check();
        await verifyGuardian(phone, approvedApkHash);
        check();
        const tokenBytes = randomBytes(16);
        if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length !== 16) throw failed();
        const token = tokenBytes.toString('hex');
        tokenBytes.fill(0);
        key = Buffer.from(adapter.config.guardianSecret, 'hex');
        const address = Buffer.from(vmIp, 'ascii');
        frame = Buffer.concat([Buffer.from('VWGPREP2', 'ascii'), Buffer.from([address.length]), address, key]);
        // This durable fence is saved before Android receives any key. It is
        // never cleared on error, restart or timeout. A retry needs review.
        await adapter.store.write(JOURNAL, { status: 'attempting', keyDigest: existing.keyDigest });
        check();
        const out = await phone.runSensitive(['shell', '-T', 'content', 'write', '--uri',
            URI + '/prepare?token=' + token], frame, 10000);
        if (String(out).trim() !== '') throw failed();
        check();
        // Provider reads asynchronously. Repeated queries are read-only and
        // use the same transaction; neither transfer nor commit is retried.
        const until = now() + 5000;
        for (;;) {
            check();
            const status = String(await phone.run(['shell', 'content', 'call', '--uri', URI,
                '--method', 'pair_status', '--arg', token])).trim();
            check();
            if (status === 'Result: Bundle[{result=prepared}]') break;
            if (status !== 'Result: Bundle[{result=pending}]' || now() >= until) throw failed();
            await wait(Math.min(150, Math.max(1, until - now())), undefined, { signal: adapter.abortController.signal });
        }
        check();
        const commit = await phone.run(['shell', 'content', 'call', '--uri', URI,
            '--method', 'pair_commit', '--arg', token]);
        if (String(commit).trim() !== 'Result: Bundle[{result=committed}]') throw failed();
        check();
        const port = await guardianQuery(adapter.settings.hostIp, {
            port: adapter.settings.guardianPort, getSecret: () => adapter.config.guardianSecret,
            timeoutMs: 17000, signal: adapter.abortController.signal,
        });
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw failed();
        check();
        await verifyEndpoint(port); // no mDNS or other fallback
        check();
        await adapter.store.write(JOURNAL, { status: 'android_verified_host_not_enabled', keyDigest: existing.keyDigest });
        check();
        if (!(await adapter.guardianProtectionReady())) throw failed();
        check();
        // No other settings are copied, including the Volkswagen S-PIN. If
        // this causes a restart the verified journal remains available.
        await adapter.extendForeignObjectAsync('system.adapter.' + adapter.namespace,
            { native: { guardianPortDiscovery: true } });
        return { result: 'guardian_pair_config_updated_reload' };
    } catch (_) { throw failed(); }
    finally { key?.fill(0); frame?.fill(0); }
}

async function pairingStatus(adapter) {
    const journal = await adapter.store.read(JOURNAL, null);
    if (journal?.status === 'attempting') return 'guardian_status_uncertain';
    if (journal?.status === 'host_prepared' && adapter.settings.guardianPortDiscovery) return 'guardian_status_existing';
    if (journal?.status === 'host_prepared') return bound(journal, adapter.config.guardianSecret)
        ? 'guardian_status_host_ready' : adapter.config.guardianSecret ? 'guardian_status_uncertain' : 'guardian_status_prepare_incomplete';
    if (journal?.status === 'recovery_approved') return bound(journal, adapter.config.guardianSecret)
        ? 'guardian_status_recovery_ready' : 'guardian_status_uncertain';
    if (journal?.status === 'android_verified_host_not_enabled') return adapter.settings.guardianPortDiscovery
        ? 'guardian_status_enabled_needs_check' : 'guardian_status_phone_verified';
    if (journal !== null) return 'guardian_status_uncertain';
    if (adapter.settings.guardianPortDiscovery) return 'guardian_status_existing';
    return adapter.config.guardianSecret ? 'guardian_status_existing' : 'guardian_status_unpaired';
}

module.exports = { prepareHost, transferAndVerify, verifyGuardian, approveRecovery, pairingStatus, testTransport, APPROVED_APK_SHA256 };
