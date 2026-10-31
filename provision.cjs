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
    assert(obj && obj.common?.enabled === false && obj.common?.loglevel === 'info'
        && obj.common?.mode === 'daemon' && obj.common?.runAsCompactMode === false, 'instance_not_disabled_or_loglevel');
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
    assert(await driver.pilotProcessCount(p.instance) === 0, 'pilot_process_already_present');
    assert(await driver.portFree(p.bind, p.port), 'port_not_free');
    const certs = await driver.getCertMap();
    assert(!Object.hasOwn(certs, p.publicAlias) && !Object.hasOwn(certs, p.privateAlias), 'alias_exists');
    const baseline = digest(certs);
    const beforeListeners=await driver.getListenerHashes(p.id);
    const secondListeners=await driver.getListenerHashes(p.id);
    assert(Array.isArray(beforeListeners) && beforeListeners.length>0
        && JSON.stringify(beforeListeners)===JSON.stringify(secondListeners), 'listeners_unstable');
    assert(await driver.pilotProcessCount(p.instance) === 0, 'pilot_process_already_present');
    const rec = { version: 2, p, baseline, beforeListeners, phase: 'create_attempting' };
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
    try { await driver.enable(p.instance); }
    catch {
        // The controller might have applied the request before losing its reply.
        // A fresh enabled object permits one identity-guarded emergency stop;
        // disabled/unreadable is still ambiguous (a delayed start is possible).
        let observed;
        try { observed=await driver.getInstance(p.instance); }
        catch { throw new Stop('start_outcome_uncertain'); }
        if(observed?.common?.enabled===true)
            await emergencyStopAfterJournalFailure(driver,journal,p,rec);
        throw new Stop('start_outcome_uncertain');
    }
    try { await journal.save({ ...rec, phase: 'start_acknowledged' }); }
    catch { await emergencyStopAfterJournalFailure(driver,journal,p,rec); }
    try {
        const state = await driver.getInstance(p.instance);
        assert(state?.common?.enabled === true && state.common.loglevel === 'info'
            && state.common.mode === 'daemon' && state.common.runAsCompactMode === false
            && state.native?.auth === true && state.native?.secure === true
            && state.native?.bind === p.bind && state.native?.port === p.port
            && state.native?.certPublic === p.publicAlias && state.native?.certPrivate === p.privateAlias
            && !state.native?.certChained && state.native?.pilotId === p.id, 'start_config_mismatch');
        const certs = await driver.getCertMap();
        assert(certs[p.publicAlias] === p.publicPath && certs[p.privateAlias] === p.privatePath
            && digest(otherEntries(certs,p)) === rec.baseline, 'certificates_changed');
        await driver.checkCertificateFiles(p);
        await driver.verifyRealTls(p); // Pin CA and leaf, verify SAN; negative probes are required.
        await driver.verifyUnauthenticatedRedirect(p); // Partial HTTP evidence only.
    } catch {
        // A failed journal can make stopPilot refuse even before its single stop.
        // Emergency stop still checks exact ownership and never repeats a stop.
        try { await emergencyStopAfterJournalFailure(driver,journal,p,rec); }
        catch(e) { if(e instanceof Stop&&e.code==='emergency_stop_observed')
            throw new Stop('pilot_stop_observed_tls_or_http_unconfirmed'); throw e; }
    }
    try { await journal.save({ ...rec, phase: 'loopback_tls_verified_auth_unproven' }); }
    catch { await emergencyStopAfterJournalFailure(driver,journal,p,rec); }
    return 'loopback_tls_verified_auth_unproven';
}

// The start intent is durable before enable(). If a later journal write fails,
// make exactly one guarded attempt to stop the owned instance even if storage
// cannot record a fresh stop intent. Never claim clean rollback without the
// process/listener evidence AND a durable stop record. No automatic retry.
async function emergencyStopAfterJournalFailure(driver,journal,p,rec){
    validate(p);
    if(!rec||!isSamePilot(rec.p,p)||!Array.isArray(rec.beforeListeners)||!rec.beforeListeners.length)
        throw new Stop('emergency_stop_ownership_uncertain');
    const obj=await driver.getInstance(p.instance);
    if(!obj||obj.native?.pilotId!==p.id||obj.native?.bind!==p.bind||obj.native?.port!==p.port
        ||obj.native?.certPublic!==p.publicAlias||obj.native?.certPrivate!==p.privateAlias
        ||obj.common?.enabled!==true)throw new Stop('emergency_stop_ownership_uncertain');
    const stopRequestedAt=Date.now();let recorded=true;
    try { await journal.save({...rec,phase:'stop_attempting',stopRequestedAt}); }
    catch { recorded=false; }
    await driver.disable(p.instance);
    const checked=await driver.getInstance(p.instance);
    if(!checked||checked.native?.pilotId!==p.id||checked.native?.bind!==p.bind
        ||checked.native?.port!==p.port||checked.common?.enabled!==false
        ||!await driver.awaitStopped(p,rec.beforeListeners,stopRequestedAt))
        throw new Stop('emergency_stop_unconfirmed');
    if(recorded){
        try{await journal.save({...rec,phase:'stop_observed_entries_retained'});}
        catch{recorded=false;}
    }
    throw new Stop(recorded?'emergency_stop_observed':'emergency_stop_journal_uncertain');
}
function isSamePilot(a,b){return !!a&&!!b&&stable(a)===stable(b);}

// A safe stop is allowed only on an instance carrying this exact pilot marker.
// Global certificate entries and files are deliberately retained for later reviewed cleanup.
async function stopPilot(driver, journal, p) {
    validate(p);
    const rec = await journal.read();
    assert(rec && stable(rec.p) === stable(p), 'journal_mismatch');
    assert(['start_acknowledged','loopback_tls_verified_auth_unproven'].includes(rec.phase), 'stop_order_uncertain');
    assert(Array.isArray(rec.beforeListeners) && rec.beforeListeners.length>0
        && rec.beforeListeners.every(x=>/^[a-f0-9]{64}$/.test(x)), 'listener_baseline_missing');
    const obj = await driver.getInstance(p.instance);
    assert(obj && obj.native?.pilotId === p.id, 'ownership_unverified');
    const stopRequestedAt=Date.now();
    await journal.save({ ...rec, phase: 'stop_attempting', stopRequestedAt });
    await driver.disable(p.instance);
    const checked = await driver.getInstance(p.instance);
    assert(checked && checked.native?.pilotId === p.id && checked.common?.enabled === false, 'stop_unconfirmed');
    assert([p.bind,p.expectedIp].includes(checked.native?.bind) && checked.native?.port===p.port, 'stop_config_changed');
    assert(await driver.awaitStopped(p,rec.beforeListeners,stopRequestedAt), 'stop_process_or_listener_unconfirmed');
    await journal.save({ ...rec, phase: 'stop_observed_entries_retained' });
    return 'stop_observed_entries_retained';
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
        s.once('error', err => {
            const nameErrors = ['ERR_TLS_CERT_ALTNAME_INVALID'];
            const trustErrors = ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
                'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED'];
            const code = nameErrors.includes(err?.code) ? 'tls_name_mismatch'
                : trustErrors.includes(err?.code) ? 'tls_untrusted' : 'tls_io_uncertain';
            reject(new Stop(code));
        });
    });
}

module.exports = { Stop, digest, validate, stage, startLoopback, stopPilot, tlsProbe, emergencyStopAfterJournalFailure };
