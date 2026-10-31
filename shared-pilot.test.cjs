'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {stageSharedPilot,startSharedPilot}=require('./shared-pilot.cjs');
function fixture(){
    const id='a'.repeat(32),owner='b'.repeat(32);
    const p={id,certificateOwnerId:owner,instance:19,port:19090,bind:'127.0.0.1',expectedIp:'10.0.0.9',
        publicAlias:'pilot_pub_'+owner,privateAlias:'pilot_key_'+owner,publicPath:'/tmp/synthetic/cert',
        privatePath:'/tmp/synthetic/key',caPath:'/tmp/synthetic/cert',caSha256:'c'.repeat(64),
        serverCertSha256:'d'.repeat(64),serviceUid:1001,serviceGid:1001,trustMode:'leaf'};
    const scope={id,certificateOwnerId:owner,instance:p.instance,port:p.port,expectedIp:p.expectedIp,
        serverCertSha256:p.serverCertSha256,publicPath:p.publicPath,privatePath:p.privatePath};
    const map={[p.publicAlias]:p.publicPath,[p.privateAlias]:p.privatePath,foreign:'untouched'};
    let rec=null,obj=null,processes=0,fail='';const calls=[];
    const journal={read:async()=>structuredClone(rec),save:async x=>{calls.push('journal:'+x.phase);rec=structuredClone(x);}};
    const driver={getInstance:async()=>structuredClone(obj),getCertMap:async()=>structuredClone(map),
        checkCertificateFiles:async()=>{},pilotProcessCount:async()=>processes,portFree:async()=>processes===0,
        getListenerHashes:async()=>['e'.repeat(64)],
        createDisabled:async n=>{calls.push('create:'+n);obj={common:{enabled:false},native:{}};},
        configureSharedDisabled:async()=>{calls.push('configure');obj={common:{enabled:false,loglevel:'info',mode:'daemon',runAsCompactMode:false},
            native:{pilotId:id,bind:p.bind,port:p.port,auth:true,secure:true,http2:false,
                certPublic:p.publicAlias,certPrivate:p.privateAlias,certChained:''}};},
        enable:async n=>{calls.push('enable:'+n);obj.common.enabled=true;processes=1;},
        disable:async n=>{calls.push('disable:'+n);obj.common.enabled=false;processes=0;},awaitStopped:async()=>true,
        verifyRealTls:async()=>{if(fail==='tls')throw Error('tls');},verifyUnauthenticatedRedirect:async()=>{},
        verifyNoH2WithPinnedTls:async()=>{if(fail==='alpn')throw Error('alpn');},
        verifyUnauthenticatedSocket:async()=>fail==='socket'?'silence':'state_read_explicitly_denied'};
    return {p,scope,map,journal,driver,calls,getRec:()=>rec,getObj:()=>obj,setFail:x=>{fail=x;},
        occupy:()=>{obj={common:{enabled:true}};}};
}
test('shared certificate pilot creates only its instance and never writes the certificate map',async()=>{
    const f=fixture(),before=structuredClone(f.map);
    assert.equal(await stageSharedPilot(f.driver,f.journal,f.p,f.scope),'shared_pilot_prepared');
    assert.equal(await startSharedPilot(f.driver,f.journal,f.p,f.scope),'shared_pilot_loopback_observed');
    assert.deepEqual(f.map,before);assert.equal(f.getObj().native.http2,false);
    assert.equal(f.getRec().sharedCertVerification,'verified');
    assert.ok(f.calls.indexOf('journal:create_attempting')<f.calls.indexOf('create:19'));
    assert.ok(f.calls.indexOf('journal:configure_attempting')<f.calls.indexOf('configure'));
});
test('existing foreign instance and mismatched scope are rejected before any write',async()=>{
    let f=fixture();f.occupy();await assert.rejects(stageSharedPilot(f.driver,f.journal,f.p,f.scope));assert.deepEqual(f.calls,[]);
    f=fixture();await assert.rejects(stageSharedPilot(f.driver,f.journal,f.p,{...f.scope,id:'f'.repeat(32)}));assert.deepEqual(f.calls,[]);
});
test('changed shared certificate map prevents start',async()=>{
    const f=fixture();await stageSharedPilot(f.driver,f.journal,f.p,f.scope);f.map.foreign='changed';
    await assert.rejects(startSharedPilot(f.driver,f.journal,f.p,f.scope),{code:'shared_certificates_changed'});
    assert.ok(!f.calls.includes('enable:19'));
});
for(const failure of ['alpn','socket'])test('failed '+failure+' check stops only the new pilot once',async()=>{
    const f=fixture();await stageSharedPilot(f.driver,f.journal,f.p,f.scope);f.setFail(failure);
    await assert.rejects(startSharedPilot(f.driver,f.journal,f.p,f.scope));
    assert.equal(f.getObj().common.enabled,false);assert.equal(f.calls.filter(x=>x==='disable:19').length,1);
    assert.equal(f.map.foreign,'untouched');
});
