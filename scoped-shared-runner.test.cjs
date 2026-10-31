'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const {parseSharedScope}=require('./shared-scope-policy.cjs');
const {makeOwnedStop}=require('./scoped-shared-runner.cjs');
test('runner rejects implicit execution before filesystem or controller operations',()=>{
    const r=spawnSync(process.execPath,[path.join(__dirname,'scoped-shared-runner.cjs')],{encoding:'utf8'});
    assert.equal(r.status,1);assert.match(r.stderr,/explicit_invocation_required/);assert.equal(r.stdout,'');
});
test('scope requires exact hash, owner and distinct synthetic pilot identities and paths',()=>{
    const base='/tmp/vw-admin-https-ci-abc123',ownerBase='/tmp/vw-admin-https-ci-def456';
    const x={id:'a'.repeat(32),owner:'b'.repeat(32),instance:20,previousInstance:17,port:19082,
        expectedIp:'10.0.0.9',serverCertSha256:'f'.repeat(64),ownerUid:1001,serviceUid:1001,serviceGid:1001,
        base,dir:base,ownerBase,publicPath:ownerBase+'/synthetic.pem',privatePath:ownerBase+'/synthetic.key'};
    const enc=o=>Buffer.from(JSON.stringify(o)),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
    const bytes=enc(x),filename=base+'/pilot-scope.json';
    assert.deepEqual(parseSharedScope(bytes,hash(bytes),filename,1001),x);
    assert.throws(()=>parseSharedScope(bytes,'0'.repeat(64),filename,1001));
    assert.throws(()=>parseSharedScope(bytes,hash(bytes),filename,1002));
    for(const patch of [{id:x.owner},{instance:17},{port:80},{expectedIp:'8.8.8.8'},
        {base:ownerBase},{dir:'/tmp/other'},{publicPath:'/tmp/other'},{ownerBase:'/tmp/other'},
        {serviceUid:0},{extra:'value'}]){
        const changed=enc({...x,...patch});assert.throws(()=>parseSharedScope(changed,hash(changed),filename,1001));
    }
});
test('emergency stop ignores previous instance and rejects a foreign marker',async()=>{
    const scope={id:'a'.repeat(32),instance:20,port:19082};
    const p={publicAlias:'public-synthetic',privateAlias:'private-synthetic'};let marker=scope.id;const calls=[];
    const d={getInstance:async n=>{calls.push('get:'+n);if(n!==20)throw Error('foreign');
        return {common:{enabled:true},native:{pilotId:marker,bind:'127.0.0.1',port:scope.port,
            certPublic:p.publicAlias,certPrivate:p.privateAlias}};},disable:async n=>calls.push('stop:'+n)};
    const stop=makeOwnedStop(d,p,async()=>calls.push('lock'),scope,()=>true);
    await stop(20);assert.deepEqual(calls,['lock','get:20','stop:20']);
    calls.length=0;marker='b'.repeat(32);await assert.rejects(stop(20),{code:'identity_unverified'});
    assert.deepEqual(calls,['lock','get:20']);
});
