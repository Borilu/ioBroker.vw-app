'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateCiPilot,unchangedExceptHttp2,runCiMigration}=require('./ci-migration-driver.cjs');
test('CI driver only accepts the synthetic instance, paths and marker',()=>{
    const id='a'.repeat(32),dir='/tmp/vw-admin-https-ci-abcdef';
    const p={id,instance:17,bind:'127.0.0.1',expectedIp:'192.168.248.250',
        publicAlias:'pilot_pub_'+id,privateAlias:'pilot_key_'+id,publicPath:dir+'/synthetic.pem',
        privatePath:dir+'/synthetic.key',caPath:dir+'/synthetic.pem',trustMode:'leaf'};
    assert.equal(validateCiPilot(p,dir),true);
    for(const patch of [{instance:1},{bind:'0.0.0.0'},{expectedIp:'10.0.0.1'},
        {id:'wrong'},{publicAlias:'foreign'},{privatePath:'/tmp/other'},
        {caPath:'/tmp/other'},{trustMode:'ca'}])
        assert.equal(validateCiPilot({...p,...patch},dir),false);
    assert.equal(validateCiPilot(p,'/tmp/unrelated'),false);
});
test('object comparison ignores only HTTP/2 and expected metadata',()=>{
    const before={_rev:'1',ts:1,from:'x',user:'x',native:{http2:true,auth:true},common:{enabled:false}};
    const after={_rev:'2',ts:2,from:'y',user:'y',native:{http2:false,auth:true},common:{enabled:false}};
    assert.deepEqual(unchangedExceptHttp2(before),unchangedExceptHttp2(after));
    after.native.auth=false;
    assert.notDeepEqual(unchangedExceptHttp2(before),unchangedExceptHttp2(after));
    assert.equal(before.native.http2,true);
});
test('driver rejects a non-isolated environment before any file or controller access',async()=>{
    const old=process.env.VW_HTTPS_PILOT_CI;delete process.env.VW_HTTPS_PILOT_CI;
    try{await assert.rejects(runCiMigration({}),{message:'not_disposable_ci_container'});}
    finally{if(old!==undefined)process.env.VW_HTTPS_PILOT_CI=old;}
});
