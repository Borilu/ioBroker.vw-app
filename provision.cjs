'use strict';
// Experimental pilot: this module has no CLI entry point and makes no live changes by itself.
// A caller must explicitly supply a driver and a durable journal. Never log driver responses.
const crypto = require('node:crypto');
const tls = require('node:tls');

class Stop extends Error {
    constructor(code) { super(code); this.code = code; }
}
const assert = (ok, code) => { if (!ok) throw new Stop(code); };
const stable = x => JSON.stringify(Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))));
const digest = x => crypto.createHash('sha256').update(stable(x)).digest('hex');
const otherEntries = (map, p) => Object.fromEntries(Object.entries(map).filter(([key]) => key !== p.publicAlias && key !== p.privateAlias));

function validate(p) {
    assert(p && /^[a-f0-9]{32}$/.test(p.id), 'invalid_id');
    assert(Number.isInteger(p.instance) && p.instance >= 1 && p.instance <= 999, 'invalid_instance');
    assert(Number.isInteger(p.port) && p.port >= 1024 && p.port <= 65535, 'invalid_port');
    assert(p.bind === '127.0.0.1', 'bind_not_loopback');
    assert(p.publicAlias === 'pilot_pub_' + p.id && p.privateAlias === 'pilot_key_' + p.id, 'invalid_alias');
    for (const path of [p.publicPath, p.privatePath, p.caPath]) {
        assert(typeof path === 'string' && /^\/[a-zA-Z0-9_./-]+$/.test(path) && !path.includes('..'), 'invalid_path');
    }
    assert(typeof p.expectedIp === 'string' && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(p.expectedIp)
        && p.expectedIp.split('.').every(x => +x <= 255), 'invalid_san');
    const octets=p.expectedIp.split('.').map(Number);
    assert(octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168), 'address_not_private');
    assert(/^[a-f0-9]{64}$/.test(p.caSha256), 'invalid_ca_digest');
    assert(/^[a-f0-9]{64}$/.test(p.serverCertSha256), 'invalid_server_digest');
    assert(Number.isInteger(p.serviceUid) && p.serviceUid >= 1, 'invalid_service_uid');
    assert(Number.isInteger(p.serviceGid) && p.serviceGid >= 1, 'invalid_service_gid');
    assert(['leaf','ca'].includes(p.trustMode), 'invalid_trust_mode');
}

async function inspectPrepared(driver, p, expectedBaseline) {
    const obj = await driver.getInstance(p.instance);
    const map = await driver.getCertMap();
    assert(obj && obj.common?.enabled === false && obj.common?.loglevel === 'info', 'instance_not_disabled_or_loglevel');
    assert(obj.native?.auth === true && obj.native?.secure === true && obj.native?.bind === p.bind
        && obj.native?.port === p.port && obj.native?.certPublic === p.publicAlias
        && obj.native?.certPrivate === p.privateAlias && !obj.native?.certChained
        && obj.native?.pilotId === p.id, 'instance_config_mismatch');
    assert(map[p.publicAlias] === p.publicPath && map[p.privateAlias] === p.privatePath, 'aliases_mismatch');
    assert(digest(otherEntries(map, p)) === expectedBaseline, 'other_certificates_changed');
    assert(await driver.portFree(p.bind, p.port), 'port_not_free');
    await driver.checkCertificateFiles(p);
}

// The journal records intent BEFORE every mutating call. A failed/uncertain call is never
// retried automatically. It contains aliases/path metadata and digests, never PEM or config.
async function stage(driver, journal, p) {
    validate(p);
    assert(await journal.read() === null, 'journal_already_exists');
    await driver.checkCertificateFiles(p);
    assert(await driver.getInstance(p.instance) === null, 'instance_exists');
    assert(await driver.portFree(p.bind, p.port), 'port_not_free');
    const certs = await driver.getCertMap();
    assert(!Object.hasOwn(certs, p.publicAlias) && !Object.hasOwn(certs, p.privateAlias), 'alias_exists');
    const baseline = digest(certs);
    const rec = { version: 1, p, baseline, phase: 'create_attempting' };
    await journal.save(rec);
    await driver.createDisabled(p.instance, p.port);
    let instance = await driver.getInstance(p.instance);
    assert(instance && instance.common?.enabled === false, 'create_not_verified');
    await journal.save({ ...rec, phase: 'configure_attempting' });
    await driver.configureDisabled(p);
    instance = await driver.getInstance(p.instance);
    assert(instance && instance.common?.enabled === false && instance.native?.pilotId === p.id, 'configure_not_verified');
    let now = await driver.getCertMap();
    assert(digest(now) === baseline && !Object.hasOwn(now, p.publicAlias) && !Object.hasOwn(now, p.privateAlias), 'certificates_changed_before_write');
    await journal.save({ ...rec, phase: 'aliases_attempting' });
    await driver.extendCertMap({ [p.publicAlias]: p.publicPath, [p.privateAlias]: p.privatePath });
    await inspectPrepared(driver, p, baseline);
    await journal.save({ ...rec, phase: 'prepared' });
    return 'prepared';
}

// Loopback start is separate. A configuration flag is not a TLS proof.
async function startLoopback(driver, journal, p) {
    validate(p);
    const rec = await journal.read();
    assert(rec && rec.phase === 'prepared' && stable(rec.p) === stable(p), 'not_prepared');
    await inspectPrepared(driver, p, rec.baseline);
    await journal.save({ ...rec, phase: 'start_attempting' });
    await driver.enable(p.instance);
    try {
        const state = await driver.getInstance(p.instance);
        assert(state?.common?.enabled === true && state.common.loglevel === 'info'
            && state.native?.auth === true && state.native?.secure === true
            && state.native?.bind === p.bind && state.native?.port === p.port
            && state.native?.certPublic === p.publicAlias && state.native?.certPrivate === p.privateAlias
            && !state.native?.certChained && state.native?.pilotId === p.id, 'start_config_mismatch');
        const certs = await driver.getCertMap();
        assert(certs[p.publicAlias] === p.publicPath && certs[p.privateAlias] === p.privatePath
            && digest(otherEntries(certs,p)) === rec.baseline, 'certificates_changed');
        await driver.checkCertificateFiles(p);
        await driver.verifyRealTls(p); // Pin CA and leaf, verify SAN; negative probes are required.
        await driver.verifyUnauthenticatedRedirect(p); // No password or vehicle action.
    } catch {
        // enable() returned successfully; if TLS is absent, try once to stop this exact pilot.
        // If ownership or stop is unclear, retain the durable stop-attempt marker.
        await stopPilot(driver, journal, p);
        throw new Stop('tls_failed_pilot_stopped');
    }
    await journal.save({ ...rec, phase: 'loopback_tls_verified' });
    return 'loopback_tls_verified';
}

// A safe stop is allowed only on an instance carrying this exact pilot marker.
// Global certificate entries and files are deliberately retained for later reviewed cleanup.
async function stopPilot(driver, journal, p) {
    validate(p);
    const rec = await journal.read();
    assert(rec && stable(rec.p) === stable(p), 'journal_mismatch');
    const obj = await driver.getInstance(p.instance);
    assert(obj && obj.native?.pilotId === p.id, 'ownership_unverified');
    await journal.save({ ...rec, phase: 'stop_attempting' });
    await driver.disable(p.instance);
    const checked = await driver.getInstance(p.instance);
    assert(checked && checked.native?.pilotId === p.id && checked.common?.enabled === false, 'stop_unconfirmed');
    assert([p.bind,p.expectedIp].includes(checked.native?.bind) && checked.native?.port===p.port, 'stop_config_changed');
    assert(await driver.awaitPortFree(checked.native.bind,p.port), 'stop_listener_still_open');
    await journal.save({ ...rec, phase: 'stopped_entries_retained' });
    return 'stopped_entries_retained';
}

// Exposing the pilot to the private LAN is a distinct explicit operation AFTER loopback
// proof. A remote browser MUST NOT receive the password until the final TLS/auth proof.
// The listener is briefly reachable during startup before that proof; auth remains enabled
// and the operator must keep third-party clients away from this pilot port during that window.
async function startLan(driver, journal, p) {
    validate(p);
    let rec = await journal.read();
    assert(rec && rec.phase === 'loopback_tls_verified' && stable(rec.p) === stable(p), 'loopback_not_verified');
    assert(await driver.interfacePresent(p.expectedIp), 'pilot_address_not_local');
    let state = await driver.getInstance(p.instance);
    assert(state?.common?.enabled === true && state.common.loglevel === 'info'
        && state.native?.pilotId === p.id && state.native?.auth === true && state.native?.secure === true
        && state.native?.bind === p.bind && state.native?.port === p.port
        && state.native?.certPublic === p.publicAlias && state.native?.certPrivate === p.privateAlias
        && !state.native?.certChained, 'loopback_config_changed');
    let certs = await driver.getCertMap();
    assert(certs[p.publicAlias] === p.publicPath && certs[p.privateAlias] === p.privatePath
        && digest(otherEntries(certs,p)) === rec.baseline, 'certificates_changed');
    await driver.checkCertificateFiles(p);
    await driver.verifyRealTls(p);
    await driver.verifyUnauthenticatedRedirect(p);
    await journal.save({...rec,phase:'rebind_stop_attempting'});
    await driver.disable(p.instance);
    state=await driver.getInstance(p.instance);
    assert(state?.common?.enabled === false && state.native?.pilotId === p.id, 'rebind_stop_unconfirmed');
    assert(await driver.awaitPortFree(p.bind,p.port) && await driver.portFree(p.expectedIp,p.port), 'rebind_port_not_free');
    certs=await driver.getCertMap();
    assert(certs[p.publicAlias]===p.publicPath && certs[p.privateAlias]===p.privatePath
        && digest(otherEntries(certs,p))===rec.baseline,'certificates_changed');
    await driver.checkCertificateFiles(p);
    await journal.save({...rec,phase:'rebind_config_attempting'});
    await driver.bindDisabled(p.instance,p.expectedIp);
    state=await driver.getInstance(p.instance);
    assert(state?.common?.enabled === false && state.common.loglevel === 'info'
        && state.native?.pilotId === p.id && state.native?.auth === true && state.native?.secure === true
        && state.native?.bind === p.expectedIp && state.native?.port === p.port
        && state.native?.certPublic === p.publicAlias && state.native?.certPrivate === p.privateAlias && !state.native?.certChained,
    'rebind_config_unconfirmed');
    await journal.save({...rec,phase:'lan_start_attempting'});
    await driver.enable(p.instance);
    try {
        state=await driver.getInstance(p.instance);
        assert(state?.common?.enabled === true && state.common.loglevel === 'info'
            && state.native?.pilotId === p.id && state.native?.auth === true && state.native?.secure === true
            && state.native?.bind === p.expectedIp && state.native?.port === p.port
            && state.native?.certPublic === p.publicAlias && state.native?.certPrivate === p.privateAlias && !state.native?.certChained,
        'lan_config_unconfirmed');
        certs=await driver.getCertMap();
        assert(certs[p.publicAlias]===p.publicPath && certs[p.privateAlias]===p.privatePath
            && digest(otherEntries(certs,p))===rec.baseline,'certificates_changed');
        await driver.checkCertificateFiles(p);
        const lan={...p,bind:p.expectedIp};
        await driver.verifyRealTls(lan);
        await driver.verifyUnauthenticatedRedirect(lan);
    } catch {
        await stopPilot(driver,journal,p);
        throw new Stop('lan_test_failed_pilot_stopped');
    }
    await journal.save({...rec,phase:'lan_tls_verified'});
    return 'lan_tls_verified';
}

// Helper for real TLS drivers; a successful TCP connection alone is not proof of TLS.
async function tlsProbe({ host, port, ca, expectedIp, expectedCertSha256, check = tls.checkServerIdentity }) {
    return new Promise((resolve, reject) => {
        const s = tls.connect({ host, port, ca, rejectUnauthorized: true,
            checkServerIdentity: (_host, cert) => check(expectedIp, cert) }, () => {
            if (!s.authorized) { s.destroy(); reject(new Stop('tls_not_authorized')); return; }
            if (expectedCertSha256 && crypto.createHash('sha256').update(s.getPeerCertificate().raw).digest('hex') !== expectedCertSha256) {
                s.destroy(); reject(new Stop('tls_peer_mismatch')); return;
            }
            s.end(); resolve();
        });
        s.setTimeout(5000, () => s.destroy(new Stop('tls_timeout')));
        s.once('error', () => reject(new Stop('tls_failed')));
    });
}

module.exports = { Stop, digest, validate, stage, startLoopback, startLan, stopPilot, tlsProbe };
