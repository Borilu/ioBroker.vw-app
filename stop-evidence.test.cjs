'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {isStoppedObservation}=require('./stop-evidence.cjs');
const base={state:{val:false,ack:true,q:0,ts:2000},processCount:0,listeners:['a','b'],
    beforeListeners:['a','b'],stopRequestedAt:1999,portFree:true};
test('accept only a fresh acknowledged off state with no process or new listeners',()=>{
    assert.equal(isStoppedObservation(base),true);
    for(const patch of [
        {state:{val:false,ack:true,ts:1998}},{state:{val:false,ack:false,ts:2000}},
        {state:{val:false,ack:true,q:0x82,ts:2000}},{state:{val:true,ack:true,ts:2000}},
        {processCount:1},{portFree:false},{listeners:['a','b','fallback-port']},
        {beforeListeners:[]},{listeners:null},
    ]) assert.equal(isStoppedObservation({...base,...patch}),false);
});
test('unrelated old listener can disappear; newly appearing listener blocks',()=>{
    assert.equal(isStoppedObservation({...base,listeners:['a']}),true);
    assert.equal(isStoppedObservation({...base,listeners:['a','fallback-port']}),false);
});
