'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const { stage, startLoopback, stopPilot } = require('./provision.cjs');
const id = 'a'.repeat(32);
const p = { id, instance:17, port:19081, bind:'127.0.0.1', publicAlias:'pilot_pub_'+id,
    privateAlias:'pilot_key_'+id, publicPath:'/tmp/test/cert.pem', privatePath:'/tmp/test/key.pem',
    caPath:'/tmp/test/ca.pem', expectedIp:'192.168.0.2', caSha256:'b'.repeat(64),
    serverCertSha256:'c'.repeat(64), serviceUid:1000, serviceGid:1000, trustMode:'leaf' };
function fixture() {
    let obj=null, map={existing:'preserved'}, record=null, writes=[], failAt='', port=true, tls=true;
    const fail = k => { writes.push(k); if (failAt === k) throw Error('simulated_uncertainty'); };
    const d = {
        checkCertificateFiles: async () => {},
        getInstance: async () => structuredClone(obj),
        getCertMap: async () => structuredClone(map),
        portFree: async () => port,
        awaitStopped: async () => port,
        getListenerHashes: async () => ['d'.repeat(64)],
        pilotProcessCount: async () => 0,
        createDisabled: async () => { fail('create'); obj={common:{enabled:false,loglevel:'info',mode:'daemon',runAsCompactMode:false},native:{}}; },
        configureDisabled: async q => { fail('configure'); Object.assign(obj.native, {auth:true,secure:true,bind:q.bind,port:q.port,certPublic:q.publicAlias,certPrivate:q.privateAlias,certChained:'',pilotId:q.id}); },
        extendCertMap: async entries => { fail('aliases'); Object.assign(map, entries); },
        enable: async () => { fail('enable'); obj.common.enabled=true; },
        disable: async () => { fail('disable'); obj.common.enabled=false; },
        verifyRealTls: async () => { if (!tls) throw Error('no tls'); },
        verifyUnauthenticatedRedirect: async () => {},
    };
    const j = {
        read: async () => structuredClone(record),
        save: async r => { fail('journal:'+r.phase); record=structuredClone(r); },
    };
    return {d,j, get:()=>({obj,map,record,writes}), fail:k=>{failAt=k}, setMap:x=>{map=x}, setObj:x=>{obj=x}, setPort:x=>{port=x}, setTls:x=>{tls=x}};
}
test('the executable rejects LAN before reading config or making changes',()=>{
    const run=spawnSync(process.execPath,[path.join(__dirname,'pilot.cjs'),'lan','/no/such/config','--execute'],{encoding:'utf8',timeout:5000});
    assert.equal(run.status,1);
    assert.match(run.stderr,/Pilot gestoppt: usage/);
    assert.equal(run.stdout,'');
});
test('stage retains pre-existing certificates and keeps admin disabled', async () => {
    const f=fixture(); assert.equal(await stage(f.d,f.j,p),'prepared');
    assert.equal(f.get().record.phase,'prepared'); assert.equal(f.get().obj.common.enabled,false);
    assert.equal(f.get().map.existing,'preserved'); assert.equal(f.get().map[p.privateAlias],p.privatePath);
    assert.ok(f.get().writes.indexOf('journal:aliases_attempting') < f.get().writes.indexOf('aliases'));
});
test('reject existing instance without writing', async () => {
    const f=fixture(); f.setObj({common:{enabled:true}});
    await assert.rejects(stage(f.d,f.j,p), {code:'instance_exists'}); assert.deepEqual(f.get().writes,[]);
});
test('reject orphaned process for otherwise absent instance', async () => {
    const f=fixture(); f.d.pilotProcessCount=async()=>1;
    await assert.rejects(stage(f.d,f.j,p), {code:'pilot_process_already_present'});
    assert.deepEqual(f.get().writes,[]);
});
test('changing preflight listeners prevent any write', async()=>{
    const f=fixture(); let call=0; f.d.getListenerHashes=async()=>[String(++call).repeat(64)];
    await assert.rejects(stage(f.d,f.j,p),{code:'listeners_unstable'});
    assert.deepEqual(f.get().writes,[]);
});
test('reject alias collision without writing', async () => {
    const f=fixture(); f.setMap({[p.publicAlias]:'other'});
    await assert.rejects(stage(f.d,f.j,p), {code:'alias_exists'}); assert.deepEqual(f.get().writes,[]);
});
test('reject externally exposed bind', async () => {
    const f=fixture(); await assert.rejects(stage(f.d,f.j,{...p,bind:'0.0.0.0'}), {code:'bind_not_loopback'});
    assert.deepEqual(f.get().writes,[]);
});
test('do not touch instance if port already used', async () => {
    const f=fixture(); f.setPort(false); await assert.rejects(stage(f.d,f.j,p), {code:'port_not_free'});
    assert.deepEqual(f.get().writes,[]);
});
for (const [step,phase] of [['create','create_attempting'],['configure','configure_attempting'],['aliases','aliases_attempting']]) {
    test('uncertain '+step+' leaves durable intent and is not retried',async()=>{
        const f=fixture(); f.fail(step); await assert.rejects(stage(f.d,f.j,p));
        assert.equal(f.get().record.phase,phase);
        await assert.rejects(stage(f.d,f.j,p),{code:'journal_already_exists'});
        assert.equal(f.get().writes.filter(x=>x===step).length,1);
    });
}
for (const [phase,forbidden] of [
    ['create_attempting','create'], ['configure_attempting','configure'],
    ['aliases_attempting','aliases'], ['prepared','enable'],
]) {
    test('journal failure before '+phase+' does not execute following action',async()=>{
        const f=fixture(); f.fail('journal:'+phase); await assert.rejects(stage(f.d,f.j,p));
        assert.equal(f.get().writes.includes(forbidden),false);
        if(f.get().obj) assert.equal(f.get().obj.common.enabled,false);
    });
}
test('concurrent certificate change stops before adding aliases',async()=>{
    const f=fixture(), original=f.d.configureDisabled;
    f.d.configureDisabled=async q=>{await original(q); f.setMap({existing:'changed'});};
    await assert.rejects(stage(f.d,f.j,p),{code:'certificates_changed_before_write'});
    assert.equal(f.get().map[p.publicAlias],undefined); assert.equal(f.get().obj.common.enabled,false);
});
test('concurrent change during extend detected and remains blocked',async()=>{
    const f=fixture(), original=f.d.extendCertMap;
    f.d.extendCertMap=async e=>{await original(e); f.setMap({...f.get().map,existing:'changed'});};
    await assert.rejects(stage(f.d,f.j,p),{code:'other_certificates_changed'});
    assert.equal(f.get().record.phase,'aliases_attempting'); assert.equal(f.get().obj.common.enabled,false);
});
test('start succeeds only after TLS proof',async()=>{
    const f=fixture(); await stage(f.d,f.j,p);
    assert.equal(await startLoopback(f.d,f.j,p),'loopback_tls_verified_auth_unproven');
    assert.equal(f.get().obj.common.enabled,true);
});
test('journal failure after acknowledged start performs one guarded stop',async()=>{
    const f=fixture(); await stage(f.d,f.j,p); f.fail('journal:start_acknowledged');
    await assert.rejects(startLoopback(f.d,f.j,p),{code:'emergency_stop_observed'});
    assert.equal(f.get().record.phase,'stop_observed_entries_retained'); assert.equal(f.get().obj.native.bind,'127.0.0.1');
    await assert.rejects(stopPilot(f.d,f.j,p),{code:'stop_order_uncertain'});
    assert.equal(f.get().writes.filter(x=>x==='disable').length,1);
});
test('failed real TLS stops the owned instance and preserves aliases',async()=>{
    const f=fixture(); await stage(f.d,f.j,p); f.setTls(false);
    await assert.rejects(startLoopback(f.d,f.j,p),{code:'pilot_stop_observed_tls_or_http_unconfirmed'});
    assert.equal(f.get().obj.common.enabled,false); assert.equal(f.get().record.phase,'stop_observed_entries_retained');
    assert.equal(f.get().map[p.publicAlias],p.publicPath);
});
test('unconfirmed unauthenticated access protection stops pilot',async()=>{
    const f=fixture(); await stage(f.d,f.j,p);
    f.d.verifyUnauthenticatedRedirect=async()=>{ throw Error('no redirect'); };
    await assert.rejects(startLoopback(f.d,f.j,p),{code:'pilot_stop_observed_tls_or_http_unconfirmed'});
    assert.equal(f.get().obj.common.enabled,false); assert.equal(f.get().record.phase,'stop_observed_entries_retained');
});
test('changed configuration after start triggers one stop',async()=>{
    const f=fixture(); await stage(f.d,f.j,p);
    const enable=f.d.enable;
    f.d.enable=async()=>{await enable(); f.get().obj.native.auth=false;};
    await assert.rejects(startLoopback(f.d,f.j,p),{code:'pilot_stop_observed_tls_or_http_unconfirmed'});
    assert.equal(f.get().obj.common.enabled,false);
    assert.equal(f.get().writes.filter(x=>x==='disable').length,1);
});
test('ambiguous disable retains stop attempt instead of retrying',async()=>{
    const f=fixture(); await stage(f.d,f.j,p); f.setTls(false); f.fail('disable');
    await assert.rejects(startLoopback(f.d,f.j,p));
    assert.equal(f.get().record.phase,'stop_attempting'); assert.equal(f.get().writes.filter(x=>x==='disable').length,1);
});
test('a still-open listener after stop is not reported as successful',async()=>{
    const f=fixture(); await stage(f.d,f.j,p); f.setTls(false);
    f.d.awaitStopped=async()=>false;
    await assert.rejects(startLoopback(f.d,f.j,p),{code:'emergency_stop_unconfirmed'});
    assert.equal(f.get().record.phase,'stop_attempting');
});
test('stop rejects instance whose ownership marker has changed',async()=>{
    const f=fixture(); await stage(f.d,f.j,p); await startLoopback(f.d,f.j,p); f.get().obj.native.pilotId='wrong';
    await assert.rejects(stopPilot(f.d,f.j,p),{code:'ownership_unverified'});
    assert.equal(f.get().writes.includes('disable'),false);
});
test('stop does not claim a fresh stop of an already-disabled staged instance',async()=>{
    const f=fixture(); await stage(f.d,f.j,p);
    await assert.rejects(stopPilot(f.d,f.j,p),{code:'stop_order_uncertain'});
    assert.equal(f.get().writes.includes('disable'),false);
});
test('changed prepared certificate store prevents start',async()=>{
    const f=fixture(); await stage(f.d,f.j,p); f.setMap({...f.get().map,existing:'different'});
    await assert.rejects(startLoopback(f.d,f.j,p),{code:'other_certificates_changed'});
    assert.equal(f.get().writes.includes('enable'),false);
});
