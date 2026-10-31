'use strict';
// Experimental migration core ONLY. No CLI and no ioBroker writer is provided.
// A production transport requires independent review and an exclusive operator
// maintenance window; instance ownership checks are not an atomic database CAS.
const {isDeepStrictEqual}=require('node:util');
const {Stop,validate,digest,stopPilot,startLoopback,emergencyStopAfterJournalFailure}=require('./provision.cjs');
function requireThat(ok,code){if(!ok)throw new Stop(code);}
function target(p,scope){
    validate(p);
    requireThat(scope&&Number.isInteger(scope.instance)&&Number.isInteger(scope.port)
        &&typeof scope.expectedIp==='string'&&/^[a-f0-9]{64}$/.test(scope.serverCertSha256)
        &&p.instance===scope.instance&&p.port===scope.port&&p.bind==='127.0.0.1'
        &&p.expectedIp===scope.expectedIp&&p.serverCertSha256===scope.serverCertSha256&&p.trustMode==='leaf'
        &&p.caPath===p.publicPath,'wrong_pilot_scope');
}
function validInstance(obj,p,enabled,http2){
    return obj?.common?.enabled===enabled&&obj.common.loglevel==='info'
        &&obj.common.mode==='daemon'&&obj.common.runAsCompactMode===false
        &&obj.native?.pilotId===p.id&&obj.native.auth===true&&obj.native.secure===true
        &&obj.native.bind===p.bind&&obj.native.port===p.port
        &&obj.native.certPublic===p.publicAlias&&obj.native.certPrivate===p.privateAlias
        &&!obj.native.certChained&&obj.native.http2===http2;
}
async function checkStore(driver,p,baseline){
    const m=await driver.getCertMap();
    requireThat(m[p.publicAlias]===p.publicPath&&m[p.privateAlias]===p.privatePath,'alias_changed');
    const other=Object.fromEntries(Object.entries(m).filter(([k])=>k!==p.publicAlias&&k!==p.privateAlias));
    requireThat(digest(other)===baseline,'certificates_changed');
    await driver.checkCertificateFiles(p);
}
async function migrateToHttp1(driver,journal,p,scope){
    // Freeze private copies so the checked target cannot be changed mid-flight.
    p=Object.freeze(structuredClone(p));scope=Object.freeze(structuredClone(scope));
    target(p,scope);
    let rec=await journal.read();
    requireThat(rec?.phase==='loopback_tls_verified_auth_unproven'&&isDeepStrictEqual(rec.p,p)
        &&rec.http1Verification===undefined,'migration_order_uncertain');
    requireThat(validInstance(await driver.getInstance(p.instance),p,true,true),'ownership_or_config_changed');
    await checkStore(driver,p,rec.baseline);
    requireThat(await driver.pilotProcessCount(p.instance)===1,'unexpected_pilot_process_count');
    // Existing stop routine journals before it acts and checks process/listener exit.
    await stopPilot(driver,journal,p);
    rec=await journal.read();
    requireThat(rec?.phase==='stop_observed_entries_retained'&&isDeepStrictEqual(rec.p,p),'stop_unconfirmed');
    requireThat(validInstance(await driver.getInstance(p.instance),p,false,true),'ownership_or_config_changed');
    await checkStore(driver,p,rec.baseline);
    requireThat(await driver.pilotProcessCount(p.instance)===0&&await driver.portFree(p.bind,p.port),'stop_unconfirmed');
    await journal.save({...rec,phase:'http1_config_attempting',http1Verification:'pending'});
    // Transport MUST target only the exact instance, only native.http2; no full
    // instance overwrite or writes to certificates/other objects are permitted.
    await driver.setHttp1OnlyForOwnedPilot(p);
    requireThat(validInstance(await driver.getInstance(p.instance),p,false,false),'http1_config_unconfirmed');
    await checkStore(driver,p,rec.baseline);
    requireThat(await driver.pilotProcessCount(p.instance)===0&&await driver.portFree(p.bind,p.port),'stop_unconfirmed');
    await journal.save({...rec,phase:'prepared',http1Verification:'pending'});
    // startLoopback verifies pinned TLS, name/trust negative probes, partial
    // unauthenticated HTTP evidence, and stops on a known post-start failure.
    await startLoopback(driver,journal,p);
    try{
        requireThat(validInstance(await driver.getInstance(p.instance),p,true,false),'http1_running_config_unconfirmed');
        await driver.verifyNoH2WithPinnedTls(p); // offers h2 + HTTP/1.1
        await driver.verifyRealTls(p); // repeat positive and negative checks
        await driver.verifyUnauthenticatedRedirect(p);
        requireThat(await driver.verifyUnauthenticatedSocket(p)==='state_read_explicitly_denied',
            'socket_auth_unconfirmed');
        requireThat(validInstance(await driver.getInstance(p.instance),p,true,false),'http1_running_config_unconfirmed');
        await checkStore(driver,p,rec.baseline);
    }catch(e){
        // A journal failure must not prevent one guarded emergency stop.
        // No retry and no fallback to insecure transport.
        try { await emergencyStopAfterJournalFailure(driver,journal,p,{...rec,http1Verification:'pending'}); }
        catch(stopError) { if(stopError instanceof Stop&&stopError.code==='emergency_stop_observed')
            throw new Stop('http1_verification_failed_stop_observed'); throw stopError; }
    }
    try{
        const final=await journal.read();
        requireThat(final?.phase==='loopback_tls_verified_auth_unproven'&&final.http1Verification==='pending'
            &&isDeepStrictEqual(final.p,p),'migration_order_uncertain');
        await journal.save({...final,http1Verification:'verified'});
    }catch{
        // rec was captured while this exact pilot was stopped and still carries
        // its listener baseline; do not depend on a possibly unreadable journal.
        await emergencyStopAfterJournalFailure(driver,journal,p,{...rec,http1Verification:'pending'});
    }
    return 'http1_loopback_observed';
}
module.exports={migrateToHttp1};
