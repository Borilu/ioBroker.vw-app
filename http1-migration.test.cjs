'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {digest}=require('./provision.cjs');
const {migrateToHttp1:core}=require('./http1-migration.cjs');
const PIN='f'.repeat(64);
const SCOPE={instance:1,port:19081,expectedIp:'10.0.0.9',serverCertSha256:PIN};
const migrateToHttp1=(driver,journal,p)=>core(driver,journal,p,SCOPE);
function fixture(){
    const id='a'.repeat(32),p={id,instance:1,port:19081,bind:'127.0.0.1',expectedIp:'10.0.0.9',
        publicAlias:'pilot_pub_'+id,privateAlias:'pilot_key_'+id,publicPath:'/tmp/synthetic/cert.pem',
        privatePath:'/tmp/synthetic/key.pem',caPath:'/tmp/synthetic/cert.pem',caSha256:'b'.repeat(64),
        serverCertSha256:PIN,serviceUid:1001,serviceGid:1001,trustMode:'leaf'};
    const obj={common:{enabled:true,loglevel:'info',mode:'daemon',runAsCompactMode:false},
        native:{pilotId:id,http2:true,auth:true,secure:true,bind:p.bind,port:p.port,
            certPublic:p.publicAlias,certPrivate:p.privateAlias,certChained:''}};
    const map={foreign:'unchanged',[p.publicAlias]:p.publicPath,[p.privateAlias]:p.privatePath};
    let rec={version:2,p,baseline:digest({foreign:'unchanged'}),beforeListeners:['c'.repeat(64)],
        phase:'loopback_tls_verified_auth_unproven'},fail='',processes=1;
    const calls=[];
    const journal={read:async()=>structuredClone(rec),save:async r=>{calls.push('journal:'+r.phase);
        if((fail==='journal_ack'&&r.phase==='start_acknowledged')
            ||(fail==='journal_verified'&&r.http1Verification==='verified')
            ||(fail==='journal_loopback'&&r.phase==='loopback_tls_verified_auth_unproven'&&calls.includes('enable:1'))
            ||(fail==='journal_permanent'&&obj.common.enabled&&r.phase==='start_acknowledged')
            ||(fail==='journal_permanent'&&r.phase==='stop_attempting'&&calls.includes('enable:1')))
            throw Error('synthetic journal failure');
        rec=structuredClone(r);}};
    const driver={getInstance:async()=>structuredClone(obj),getCertMap:async()=>structuredClone(map),
        checkCertificateFiles:async()=>{if(fail==='cert')throw Error('cert');},
        pilotProcessCount:async()=>processes,portFree:async()=>processes===0,
        disable:async n=>{calls.push('disable:'+n);obj.common.enabled=false;processes=0;},
        awaitStopped:async()=>fail!=='stop',
        setHttp1OnlyForOwnedPilot:async()=>{calls.push('set-http2:false');
            if(fail==='write')throw Error('uncertain');obj.native.http2=false;},
        enable:async n=>{calls.push('enable:'+n);
            if(fail==='enable_disabled')throw Error('synthetic start timeout');
            obj.common.enabled=true;processes=1;
            if(fail==='enable_foreign'){obj.native.pilotId='foreign';throw Error('synthetic start timeout');}
            if(fail==='enable_uncertain')throw Error('synthetic start timeout');},
        verifyRealTls:async()=>{calls.push('tls-positive-negative');if(fail==='tls')throw Error('tls');},
        verifyUnauthenticatedRedirect:async()=>{calls.push('http-auth');},
        verifyNoH2WithPinnedTls:async()=>{calls.push('alpn-h2-h1');if(fail==='h2')throw Error('h2');},
        verifyUnauthenticatedSocket:async()=>{calls.push('socket-auth');return fail==='socket'?'silence':'state_read_explicitly_denied';}};
    return {p,obj,map,journal,driver,calls,getRec:()=>rec,setFail:x=>{fail=x;},setProcesses:x=>{processes=x;}};
}
test('owned running pilot is stopped, reconfigured and verified in journal order',async()=>{
    const f=fixture();assert.equal(await migrateToHttp1(f.driver,f.journal,f.p),'http1_loopback_observed');
    assert.equal(f.getRec().phase,'loopback_tls_verified_auth_unproven');
    assert.equal(f.getRec().http1Verification,'verified');
    assert.equal(f.obj.native.http2,false);assert.equal(f.obj.common.enabled,true);
    assert.ok(f.calls.indexOf('journal:stop_attempting')<f.calls.indexOf('disable:1'));
    assert.ok(f.calls.indexOf('journal:http1_config_attempting')<f.calls.indexOf('set-http2:false'));
    assert.ok(f.calls.indexOf('journal:prepared')<f.calls.indexOf('enable:1'));
    for(const call of ['tls-positive-negative','http-auth','alpn-h2-h1','socket-auth'])assert.ok(f.calls.includes(call));
    assert.equal(f.map.foreign,'unchanged');
});
test('wrong pilot identity or scope causes no mutation',async()=>{
    for(const change of [f=>{f.obj.native.pilotId='foreign';},f=>{f.p.port=9999;},f=>{f.p.serverCertSha256='0'.repeat(64);},
        f=>{f.obj.native.auth=false;},f=>{f.setProcesses(2);}]){
        const f=fixture();change(f);await assert.rejects(migrateToHttp1(f.driver,f.journal,f.p));
        assert.deepEqual(f.calls,[]);
    }
});
test('uncertain stop does not attempt configuration or restart',async()=>{
    const f=fixture();f.setFail('stop');await assert.rejects(migrateToHttp1(f.driver,f.journal,f.p));
    assert.equal(f.getRec().phase,'stop_attempting');assert.ok(!f.calls.includes('set-http2:false'));
});
test('uncertain settings write remains journalled and is never retried',async()=>{
    const f=fixture();f.setFail('write');await assert.rejects(migrateToHttp1(f.driver,f.journal,f.p));
    assert.equal(f.getRec().phase,'http1_config_attempting');assert.ok(!f.calls.includes('enable:1'));
    await assert.rejects(migrateToHttp1(f.driver,f.journal,f.p));
    assert.equal(f.calls.filter(x=>x==='set-http2:false').length,1);
});
for(const fail of ['h2','socket'])test('failed '+fail+' verification stops owned pilot once',async()=>{
    const f=fixture();f.setFail(fail);await assert.rejects(migrateToHttp1(f.driver,f.journal,f.p));
    assert.equal(f.getRec().phase,'stop_observed_entries_retained');assert.equal(f.obj.common.enabled,false);
    assert.equal(f.calls.filter(x=>x==='disable:1').length,2);
    assert.equal(f.getRec().http1Verification,'pending');
});
for(const fail of ['enable_uncertain','journal_ack','journal_loopback','journal_verified','journal_permanent'])
    test('failure of '+fail+' after start makes one guarded emergency stop',async()=>{
        const f=fixture();f.setFail(fail);await assert.rejects(migrateToHttp1(f.driver,f.journal,f.p));
        assert.equal(f.obj.common.enabled,false);
        assert.equal(f.calls.filter(x=>x==='disable:1').length,2);
        assert.equal(f.calls.filter(x=>x==='enable:1').length,1);
        assert.notEqual(f.getRec().http1Verification,'verified');
        await assert.rejects(migrateToHttp1(f.driver,f.journal,f.p));
        assert.equal(f.calls.filter(x=>x==='disable:1').length,2);
    });
for(const fail of ['enable_disabled','enable_foreign'])
    test('uncertain start with '+fail+' does not claim stopped or touch a foreign instance',async()=>{
        const f=fixture();f.setFail(fail);await assert.rejects(migrateToHttp1(f.driver,f.journal,f.p));
        assert.equal(f.getRec().phase,'start_attempting');
        assert.equal(f.calls.filter(x=>x==='disable:1').length,1);
        assert.equal(f.calls.filter(x=>x==='enable:1').length,1);
    });
