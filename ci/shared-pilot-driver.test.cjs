'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {runCiShared}=require('./shared-pilot-driver.cjs');
test('shared CI driver rejects a non-isolated environment before touching files or a controller',async()=>{
    const old=process.env.VW_HTTPS_PILOT_CI;delete process.env.VW_HTTPS_PILOT_CI;
    try{await assert.rejects(runCiShared({}),{message:'not_disposable_ci_container'});}
    finally{if(old!==undefined)process.env.VW_HTTPS_PILOT_CI=old;}
});
