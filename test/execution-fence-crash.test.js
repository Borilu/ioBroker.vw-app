'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {fork,spawnSync}=require('node:child_process');

test('Linux crash leaves a durable fence that blocks a fresh runtime before spawn',
    {skip:process.platform!=='linux',timeout:15000},async t=>{
        const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vw-fence-crash-'));
        const fixture=path.join(__dirname,'..','.github','fixtures','fence-crash-child.cjs');
        let child;
        t.after(async()=>{
            if(child&&child.exitCode===null&&child.signalCode===null){
                await new Promise((resolve,reject)=>{
                    const timer=setTimeout(()=>reject(Error('fixture cleanup uncertain')),2000);
                    child.once('exit',()=>{clearTimeout(timer);resolve();});
                    child.kill('SIGKILL');
                });
            }
            assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
            assert.ok(path.basename(dir).startsWith('vw-fence-crash-'));
            await fs.rm(dir,{recursive:true,force:true});
        });
        child=fork(fixture,['owner',dir],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});
        await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('fixture readiness timed out')),5000);
            child.once('message',message=>{
                clearTimeout(timer);
                if(message==='synthetic_fence_persisted')resolve();
                else reject(Error('unexpected fixture message'));
            });
            child.once('error',error=>{clearTimeout(timer);reject(error);});
            child.once('exit',()=>{clearTimeout(timer);reject(Error('fixture exited before readiness'));});
        });
        const marker=path.join(dir,'adb-execution-fence.json'),stat=await fs.lstat(marker);
        assert.equal(stat.isFile(),true);assert.equal(stat.mode&0o777,0o600);
        const stopped=new Promise((resolve,reject)=>{
            child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
        });
        assert.equal(child.kill('SIGKILL'),true);
        assert.deepEqual(await stopped,{code:null,signal:'SIGKILL'});
        assert.equal((await fs.lstat(marker)).isFile(),true);
        const successor=spawnSync(process.execPath,[fixture,'successor',dir],{encoding:'utf8',timeout:5000});
        assert.equal(successor.status,0,successor.stderr);
        assert.equal(successor.stdout,'synthetic_restart_fenced\n');
        assert.equal((await fs.lstat(marker)).isFile(),true);
    });
