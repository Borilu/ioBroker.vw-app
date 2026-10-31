'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {isolatedCi}=require('./isolation-check.cjs');
const okay={githubActions:'true',mode:'synthetic',docker:true,runId:'123',hostname:'vwci-123',
    marker:'a'.repeat(32),uid:1000,platform:'linux',interfaces:[{internal:true}]};
test('block invalid runtime and any remaining external network interface',()=>{
    assert.equal(isolatedCi(okay),true);
    for(const patch of [{githubActions:'false'},{mode:'real'},{docker:false},{hostname:'wrong'},
        {marker:'bad'},{uid:0},{platform:'win32'},{interfaces:[]},{interfaces:[{internal:false}]},
    ])assert.equal(isolatedCi({...okay,...patch}),false);
});
