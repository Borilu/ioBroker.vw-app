'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AdbRuntime, isConfirmedShellFailure, makeConfirmedRecoveryPermit } = require('../lib/runtime');

function memoryFence() {
    let marker = null;
    return {
        async assertClear() { if (marker) throw Object.assign(new Error('fenced'), {code:'adb_execution_fenced'}); },
        async acquire() { if (marker) throw Object.assign(new Error('fenced'), {code:'adb_execution_fenced'}); marker = 'a'.repeat(32); return marker; },
        async release(token) { if (!marker || marker !== token) throw Error('bad owner'); marker = null; },
        get held() { return marker !== null; },
    };
}
function child({ closeOnKill = true, delay = 0 } = {}) {
    const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.exitCode = null; c.signalCode = null; c.signals = [];
    c.kill = signal => {
        c.signals.push(signal);
        if (closeOnKill && !c.closing) { c.closing = true; setTimeout(() => { c.signalCode = signal; c.emit('close', null, signal); }, delay); }
        return true;
    };
    return c;
}
function fixture(plan = {}) {
    const fence = memoryFence(); const calls = [];
    const runtime = new AdbRuntime({ dataDir: require('node:path').resolve('.'), executionFence:fence,
        spawnImpl: (_file, args) => { const c=child(plan); c.args=args; calls.push(c); return c; } });
    runtime._ready=true; runtime._server=child(); runtime._binary='fake'; runtime._port=12345; runtime._env={};
    return { runtime, fence, calls };
}
const delay = ms => new Promise(r=>setTimeout(r,ms));

test('uncertain Android command waits for host termination and retains durable job fence', async () => {
    const f=fixture({delay:90}); await f.runtime.beginJob();
    let settled=false;
    const pending=f.runtime.run(['-s','192.0.2.1:1234','shell','input','tap','1','1'],{timeoutMs:10})
        .then(()=>{settled=true;}, e=>{settled=true; return e;});
    await delay(45); assert.equal(settled,false); assert.equal(f.fence.held,true);
    const e=await pending; assert.equal(e.code,'adb_timeout'); assert.equal(f.fence.held,true);
    await assert.rejects(f.runtime.endJob(),{code:'adb_execution_fenced'});
    await assert.rejects(f.runtime.run(['devices']),{code:'adb_execution_fenced'});
    assert.equal(f.calls.length,1);
});

test('host-only timeout may clear job fence only after confirmed host termination', async () => {
    const f=fixture({delay:80}); await f.runtime.beginJob();
    let settled=false;
    const pending=f.runtime.run(['devices'],{timeoutMs:10}).catch(e=>{settled=true;return e;});
    await delay(40); assert.equal(settled,false); assert.equal(f.fence.held,true);
    assert.equal((await pending).code,'adb_timeout');
    await f.runtime.endJob(); assert.equal(f.fence.held,false);
});

test('missing close after kill retains fence even for host-only command and late close does not clear it', async () => {
    const f=fixture({closeOnKill:false}); await f.runtime.beginJob();
    await assert.rejects(f.runtime.run(['devices'],{timeoutMs:10}),{code:'adb_timeout'});
    assert.deepEqual(f.calls[0].signals,['SIGTERM','SIGKILL']); assert.equal(f.fence.held,true);
    f.calls[0].signalCode='SIGKILL'; f.calls[0].emit('close',null,'SIGKILL');
    await assert.rejects(f.runtime.endJob(),{code:'adb_execution_fenced'});
    await assert.rejects(f.runtime.beginJob(),{code:'adb_execution_fenced'});
});

test('a fresh runtime rejects a surviving persistent job fence before spawning', async () => {
    const f=fixture(); await f.runtime.beginJob();
    const successor=new AdbRuntime({dataDir:require('node:path').resolve('.'), executionFence:f.fence,
        spawnImpl:()=>{throw Error('must not spawn');}});
    await assert.rejects(successor.start(),{code:'adb_execution_fenced'}); assert.equal(f.calls.length,0);
});

test('output overflow during Android command keeps fence after local child ends', async () => {
    const f=fixture(); await f.runtime.beginJob();
    const pending=f.runtime.run(['shell','input','tap','1','1'],{timeoutMs:1000,maxOutputBytes:2});
    f.calls[0].stdout.write('xxxx');
    await assert.rejects(pending,{code:'adb_output_limit'}); assert.equal(f.fence.held,true);
    await assert.rejects(f.runtime.endJob(),{code:'adb_execution_fenced'});
});

test('successful regular commands share one job fence and release only when job finishes', async () => {
    const f=fixture({closeOnKill:false}); await f.runtime.beginJob();
    for(let i=0;i<4;i++) {
        const p=f.runtime.run(['devices']);
        f.calls[i].exitCode=0; f.calls[i].stdout.write('ok'); f.calls[i].emit('close',0);
        assert.equal(await p,'ok'); assert.equal(f.fence.held,true);
    }
    await f.runtime.endJob(); assert.equal(f.fence.held,false);
});

test('stop waits for local client termination but leaves uncertain Android operation fenced', async () => {
    const f=fixture({delay:90}); await f.runtime.beginJob();
    let settled=false;
    const pending=f.runtime.run(['shell','input','tap','1','1'],{timeoutMs:5000})
        .catch(e=>{settled=true; return e;});
    const stopping=f.runtime.stop();
    await delay(45); assert.equal(settled,false); assert.equal(f.fence.held,true);
    await stopping; assert.equal((await pending).code,'runtime_stopped');
    await assert.rejects(f.runtime.endJob(),{code:'adb_execution_fenced'});
    assert.deepEqual(f.calls[0].signals,['SIGTERM']); assert.equal(f.fence.held,true);
});

test('separate calls cannot overlap within a single phone job', async () => {
    const f=fixture(); await f.runtime.beginJob();
    const pending=f.runtime.run(['devices']);
    await assert.rejects(f.runtime.run(['devices']),{code:'runtime_busy'});
    assert.equal(f.calls.length,1);
    f.calls[0].exitCode=0; f.calls[0].emit('close',0); await pending;
    await f.runtime.endJob();
});

test('no command can start while job fence removal is in progress', async () => {
    const f=fixture(); await f.runtime.beginJob();
    let resume; const original=f.fence.release;
    f.fence.release=async token=>{await new Promise(r=>{resume=r;}); await original(token);};
    const ending=f.runtime.endJob();
    await assert.rejects(f.runtime.run(['devices']),{code:'adb_execution_fenced'});
    assert.equal(f.calls.length,0); resume(); await ending;
});

test('failed remote command fences synchronously before another call can start', async () => {
    const f=fixture(); await f.runtime.beginJob();
    const pending=f.runtime.run(['shell','input','tap','1','1']);
    f.calls[0].exitCode=1; f.calls[0].emit('close',1);
    await assert.rejects(f.runtime.run(['devices']),{code:'adb_execution_fenced'});
    await assert.rejects(pending,{code:'adb_command_failed'});
    assert.equal(f.fence.held,true); assert.equal(f.calls.length,1);
});

test('stopping while acquiring a job waits and performs no device operation', async () => {
    const f=fixture(); let resume;
    const original=f.fence.acquire;
    f.fence.acquire=async ()=>{await new Promise(r=>{resume=r;}); return original();};
    const beginning=f.runtime.beginJob();
    const stopped=f.runtime.stop();
    await delay(25); assert.equal(f.calls.length,0);
    resume(); await assert.rejects(beginning,{code:'runtime_stopped'}); await stopped;
    assert.equal(f.calls.length,0); assert.equal(f.fence.held,false);
});
test('a permanently hung fence acquire does not prevent bounded stop or allow later phone work', async () => {
    const f=fixture();
    f.fence.acquire=async ()=>new Promise(()=>{});
    void f.runtime.beginJob();
    const start=Date.now();
    await f.runtime.stop();
    assert.ok(Date.now()-start < 1700);
    await assert.rejects(f.runtime.start(),{code:'runtime_busy'});
    assert.equal(f.calls.length,0);
});

test('failure to persist the fence refuses all device work', async () => {
    const f=fixture();
    f.fence.acquire=async ()=>{throw Object.assign(new Error('failed'),{code:'adb_execution_fenced'});};
    await assert.rejects(f.runtime.beginJob(),{code:'adb_execution_fenced'});
    await assert.rejects(f.runtime.run(['shell','input','tap','1','1']),{code:'adb_execution_fenced'});
    assert.equal(f.calls.length,0);
});

test('a successful Android command completes the existing job normally', async () => {
    const f=fixture(); await f.runtime.beginJob();
    const pending=f.runtime.run(['shell','input','tap','1','1']);
    const marker=f.calls[0].args.at(-1).match(/__VW_ANDROID_DONE_[a-f0-9]{32}__:/)[0];
    f.calls[0].stdout.write('\n'+marker+'0\n');
    f.calls[0].exitCode=0; f.calls[0].emit('close',0);
    await pending; await f.runtime.endJob(); assert.equal(f.fence.held,false);
});
test('shell exit zero without a complete per-command Android marker is uncertain', async () => {
    const f=fixture(); await f.runtime.beginJob();
    const pending=f.runtime.run(['-s','192.0.2.1:1234','shell','input','tap','1','1']);
    f.calls[0].stdout.write('partial output');
    f.calls[0].exitCode=0; f.calls[0].emit('close',0);
    await assert.rejects(pending,{code:'adb_execution_unconfirmed'});
    await assert.rejects(f.runtime.endJob(),{code:'adb_execution_fenced'});
    assert.equal(f.fence.held,true);
});
test('remote normal nonzero exit with verified marker fails the command but does not fence the job', async () => {
    const f=fixture(); await f.runtime.beginJob();
    const pending=f.runtime.run(['-s','192.0.2.1:1234','shell','test','-f','/not-present']);
    const marker=f.calls[0].args.at(-1).match(/__VW_ANDROID_DONE_[a-f0-9]{32}__:/)[0];
    f.calls[0].stdout.write('\n'+marker+'1\n');
    f.calls[0].exitCode=0; f.calls[0].emit('close',0);
    const completed = await pending.catch(error => error);
    assert.equal(completed.code, 'adb_command_failed');
    assert.equal(isConfirmedShellFailure(f.runtime, completed), true);
    assert.equal(isConfirmedShellFailure(f.runtime, Object.assign(new Error('foreign'), {code:'adb_command_failed'})), false);
    assert.equal(isConfirmedShellFailure(f.runtime, new Error('wrapped', {cause: completed})), false);
    assert.equal(isConfirmedShellFailure(fixture().runtime, completed), false);
    await f.runtime.endJob(); assert.equal(f.fence.held,false);
    assert.equal(isConfirmedShellFailure(f.runtime, completed), false);
});
test('confirmed shell failure proof expires when a later command starts or the runtime stops', async () => {
    for (const step of ['later-command', 'stop']) {
        const f=fixture(); await f.runtime.beginJob();
        const pending=f.runtime.run(['-s','192.0.2.1:1234','shell','test','-f','/not-present']);
        const marker=f.calls[0].args.at(-1).match(/__VW_ANDROID_DONE_[a-f0-9]{32}__:/)[0];
        f.calls[0].stdout.write('\n'+marker+'1\n');
        f.calls[0].exitCode=0; f.calls[0].emit('close',0);
        const completed=await pending.catch(error=>error);
        assert.equal(isConfirmedShellFailure(f.runtime, completed),true);
        if (step === 'stop') {
            await f.runtime.stop();
            assert.equal(isConfirmedShellFailure(f.runtime, completed),false);
        } else {
            const second=f.runtime.run(['devices']);
            assert.equal(isConfirmedShellFailure(f.runtime, completed),false);
            f.calls[1].exitCode=0; f.calls[1].emit('close',0); await second;
            assert.equal(isConfirmedShellFailure(f.runtime, completed),false);
            await f.runtime.endJob();
        }
    }
});
test('recovery permit consumes only authentic proof and survives successful reads in the same job', async () => {
    const f=fixture(); await f.runtime.beginJob();
    const pending=f.runtime.run(['-s','192.0.2.1:1234','shell','test','-f','/not-present']);
    const marker=f.calls[0].args.at(-1).match(/__VW_ANDROID_DONE_[a-f0-9]{32}__:/)[0];
    f.calls[0].stdout.write('\n'+marker+'1\n'); f.calls[0].exitCode=0; f.calls[0].emit('close',0);
    const completed=await pending.catch(error=>error);
    const foreign=Object.assign(new Error('synthetic'),{code:'adb_command_failed'});
    assert.equal(makeConfirmedRecoveryPermit(f.runtime, foreign),null);
    assert.equal(makeConfirmedRecoveryPermit(f.runtime, new Error('wrapped',{cause:completed})),null);
    const permit=makeConfirmedRecoveryPermit(f.runtime,completed);
    assert.equal(typeof permit,'function'); assert.equal(permit(),true);
    assert.equal(makeConfirmedRecoveryPermit(f.runtime,completed),null);
    assert.equal(isConfirmedShellFailure(f.runtime,completed),false);
    const read=f.runtime.run(['devices']); f.calls[1].exitCode=0; f.calls[1].emit('close',0); await read;
    assert.equal(permit(),true);
    await f.runtime.endJob(); assert.equal(permit(),false);
});
test('any later failure or active client permanently invalidates a recovery permit', async () => {
    for (const mode of ['confirmed-error', 'uncertain-timeout', 'invalid-command', 'active-client', 'stop',
        'invalid-pair', 'install-denied', 'begin-busy', 'assert-busy', 'start-failed']) {
        const f=fixture(); await f.runtime.beginJob();
        const initial=f.runtime.run(['-s','192.0.2.1:1234','shell','test','-f','/not-present']);
        const marker=f.calls[0].args.at(-1).match(/__VW_ANDROID_DONE_[a-f0-9]{32}__:/)[0];
        f.calls[0].stdout.write('\n'+marker+'1\n'); f.calls[0].exitCode=0; f.calls[0].emit('close',0);
        const proof=await initial.catch(error=>error);
        const permit=makeConfirmedRecoveryPermit(f.runtime,proof); assert.equal(permit(),true);
        if (mode === 'invalid-command') await assert.rejects(f.runtime.run(['exec-out','sh']));
        else if (mode === 'stop') await f.runtime.stop();
        else if (mode === 'invalid-pair') await assert.rejects(f.runtime.pair('not-an-endpoint','123456'));
        else if (mode === 'install-denied') await assert.rejects(f.runtime.install());
        else if (mode === 'begin-busy') await assert.rejects(f.runtime.beginJob());
        else if (mode === 'assert-busy') await assert.rejects(f.runtime.assertJobClear());
        else if (mode === 'start-failed') {
            f.runtime._ready=false; f.runtime._platform='win32';
            await assert.rejects(f.runtime.start());
        }
        else if (mode === 'active-client') {
            const second=f.runtime.run(['devices']); assert.equal(permit(),false);
            f.calls[1].exitCode=0; f.calls[1].emit('close',0); await second;
        } else {
            const second=f.runtime.run(['-s','192.0.2.1:1234','shell','test','-f','/other'], {timeoutMs:mode === 'uncertain-timeout' ? 10 : 1000});
            if (mode === 'confirmed-error') {
                const another=f.calls[1].args.at(-1).match(/__VW_ANDROID_DONE_[a-f0-9]{32}__:/)[0];
                f.calls[1].stdout.write('\n'+another+'1\n'); f.calls[1].exitCode=0; f.calls[1].emit('close',0);
            }
            await assert.rejects(second);
        }
        assert.equal(permit(),false,mode);
    }
});
test('exec-out and exec-in cannot bypass remote completion framing', async () => {
    const f=fixture(); await f.runtime.beginJob();
    await assert.rejects(f.runtime.run(['-s','192.0.2.1:1234','exec-out','uiautomator']),{code:'invalid_adb_command'});
    await assert.rejects(f.runtime.run(['-s','192.0.2.1:1234','exec-in','sh']),{code:'invalid_adb_command'});
    assert.equal(f.calls.length,0); await f.runtime.endJob();
});
