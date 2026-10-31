'use strict';
// Experimental only. A caller must supply an exclusive journal and tightly
// scoped driver. Never mutates the global certificate map.
const {isDeepStrictEqual}=require('node:util');
const {Stop,validate,digest,startLoopback,emergencyStopAfterJournalFailure}=require('./provision.cjs');
function check(ok,code){if(!ok)throw new Stop(code);}
function target(p,s){
    validate(p);
    check(s&&p.id===s.id&&p.certificateOwnerId===s.certificateOwnerId
        &&p.certificateOwnerId!==p.id&&p.instance===s.instance&&p.port===s.port
        &&p.expectedIp===s.expectedIp&&p.serverCertSha256===s.serverCertSha256
        &&p.publicPath===s.publicPath&&p.privatePath===s.privatePath&&p.caPath===p.publicPath
        &&p.trustMode==='leaf','shared_scope_mismatch');
}
function validInstance(o,p,enabled){return o?.common?.enabled===enabled&&o.common.loglevel==='info'
    &&o.common.mode==='daemon'&&o.common.runAsCompactMode===false&&o.native?.pilotId===p.id
    &&o.native?.bind==='127.0.0.1'&&o.native?.port===p.port&&o.native?.auth===true
    &&o.native?.secure===true&&o.native?.http2===false&&o.native?.certPublic===p.publicAlias
    &&o.native?.certPrivate===p.privateAlias&&!o.native?.certChained;}
function otherEntries(map,p){return Object.fromEntries(Object.entries(map).filter(([k])=>k!==p.publicAlias&&k!==p.privateAlias));}
async function unchangedCerts(driver,p,expected){
    const map=await driver.getCertMap();
    check(map[p.publicAlias]===p.publicPath&&map[p.privateAlias]===p.privatePath&&digest(map)===expected,'shared_certificates_changed');
    await driver.checkCertificateFiles(p);
}
async function stableNoNewListeners(driver,p,before){
    const now=await driver.getListenerHashes(p.id),baseline=new Set(before);
    return Array.isArray(now)&&now.every(x=>baseline.has(x))
        &&await driver.pilotProcessCount(p.instance)===0&&await driver.portFree(p.bind,p.port);
}
async function stageSharedPilot(driver,journal,p,scope){
    p=Object.freeze(structuredClone(p));scope=Object.freeze(structuredClone(scope));target(p,scope);
    check(await journal.read()===null,'journal_already_exists');
    await driver.checkCertificateFiles(p);
    check(await driver.getInstance(p.instance)===null,'instance_exists');
    check(await driver.pilotProcessCount(p.instance)===0&&await driver.portFree(p.bind,p.port),'pilot_not_free');
    const certs=await driver.getCertMap();
    check(certs[p.publicAlias]===p.publicPath&&certs[p.privateAlias]===p.privatePath,'shared_alias_mismatch');
    const fullCertDigest=digest(certs),baseline=digest(otherEntries(certs,p));
    const beforeListeners=await driver.getListenerHashes(p.id),again=await driver.getListenerHashes(p.id);
    check(Array.isArray(beforeListeners)&&beforeListeners.length>0&&isDeepStrictEqual(beforeListeners,again),'listeners_unstable');
    const rec={version:2,p,baseline,beforeListeners,sharedCertDigest:fullCertDigest,phase:'create_attempting'};
    await journal.save(rec);
    await driver.createDisabled(p.instance,p.port);
    const created=await driver.getInstance(p.instance);
    check(created&&created.common?.enabled===false&&await stableNoNewListeners(driver,p,beforeListeners),'create_unconfirmed');
    await unchangedCerts(driver,p,fullCertDigest);
    await journal.save({...rec,phase:'configure_attempting'});
    await driver.configureSharedDisabled(p);
    check(validInstance(await driver.getInstance(p.instance),p,false)
        &&await stableNoNewListeners(driver,p,beforeListeners),'configure_unconfirmed');
    await unchangedCerts(driver,p,fullCertDigest);
    await journal.save({...rec,phase:'prepared',sharedCertVerification:'pending'});
    return 'shared_pilot_prepared';
}
async function startSharedPilot(driver,journal,p,scope){
    p=Object.freeze(structuredClone(p));scope=Object.freeze(structuredClone(scope));target(p,scope);
    const rec=await journal.read();
    check(rec?.phase==='prepared'&&rec.sharedCertVerification==='pending'&&isDeepStrictEqual(rec.p,p),'shared_not_prepared');
    check(validInstance(await driver.getInstance(p.instance),p,false)
        &&await stableNoNewListeners(driver,p,rec.beforeListeners),'shared_not_stopped');
    await unchangedCerts(driver,p,rec.sharedCertDigest);
    await startLoopback(driver,journal,p);
    try{
        check(validInstance(await driver.getInstance(p.instance),p,true),'shared_start_unconfirmed');
        await driver.verifyNoH2WithPinnedTls(p);await driver.verifyRealTls(p);
        await driver.verifyUnauthenticatedRedirect(p);
        check(await driver.verifyUnauthenticatedSocket(p)==='state_read_explicitly_denied','socket_auth_unconfirmed');
        check(validInstance(await driver.getInstance(p.instance),p,true),'shared_start_unconfirmed');
        await unchangedCerts(driver,p,rec.sharedCertDigest);
        const j=await journal.read();
        check(j?.phase==='loopback_tls_verified_auth_unproven'&&isDeepStrictEqual(j.p,p)
            &&j.sharedCertVerification==='pending','journal_unconfirmed');
        await journal.save({...j,sharedCertVerification:'verified'});
    }catch{
        await emergencyStopAfterJournalFailure(driver,journal,p,rec);
    }
    return 'shared_pilot_loopback_observed';
}
module.exports={stageSharedPilot,startSharedPilot};
