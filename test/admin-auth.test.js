'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authenticatedAdminMessage } = require('../lib/admin-auth');

function setup() {
    const from = 'system.adapter.admin.0', user = 'system.user.example';
    const objects = new Map([
        [from, {_id:from,type:'instance',ts:100,common:{enabled:true},native:{auth:true}}],
        [user, {_id:user,type:'user',common:{enabled:true}}],
        ['system.group.administrator', {_id:'system.group.administrator',type:'group',common:{members:[user]}}],
    ]);
    const states = new Map([[from + '.alive', {val:true,lc:200}]]);
    const adapter = { async getForeignObjectAsync(id) { return objects.get(id) || null; },
        async getForeignStateAsync(id) { return states.get(id) || null; } };
    return {adapter,objects,states,from,user};
}

test('only an enabled administrator group member through a restarted authenticated Admin instance is accepted', async () => {
    const f = setup();
    assert.equal(await authenticatedAdminMessage(f.adapter,{from:f.from,user:f.user}),true);
});

test('missing, non-admin and forged-looking message contexts fail closed', async () => {
    const f = setup();
    for (const obj of [null, {}, {from:f.from}, {from:f.from,user:'admin'},
        {from:'system.adapter.admin.0.extra',user:f.user}, {from:'system.adapter.javascript.0',user:f.user},
        {from:f.from,user:'system.user.unknown'}, {from:f.from,user:{toString:()=>f.user}}]) {
        assert.equal(await authenticatedAdminMessage(f.adapter,obj),false);
    }
});

test('disabled authentication, stale Admin process, missing users and nonmembers fail closed', async () => {
    for (const mutate of [
        f => { f.objects.get(f.from).native.auth=false; },
        f => { delete f.objects.get(f.from).native.auth; },
        f => { f.objects.get(f.from).common.enabled=false; },
        f => { f.states.get(f.from+'.alive').lc=99; },
        f => { f.states.get(f.from+'.alive').val=false; },
        f => { f.states.delete(f.from+'.alive'); },
        f => { f.objects.get(f.user).common.enabled=false; },
        f => { f.objects.delete(f.user); },
        f => { f.objects.get('system.group.administrator').common.members=[]; },
        f => { f.objects.get('system.group.administrator').common.enabled=false; },
        f => { f.objects.delete('system.group.administrator'); },
        f => { f.adapter.getForeignStateAsync = async () => { throw Error('synthetic unavailable'); }; },
    ]) {
        const f=setup(); mutate(f);
        assert.equal(await authenticatedAdminMessage(f.adapter,{from:f.from,user:f.user}),false);
    }
});
