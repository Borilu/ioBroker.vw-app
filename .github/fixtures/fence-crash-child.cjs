'use strict';
// Synthetic CI fixture only: never starts adb or accesses a phone.
const {ExecutionFence}=require('../../lib/execution-fence');
const {AdbRuntime}=require('../../lib/runtime');
const [mode,dir]=process.argv.slice(2);
(async()=>{
    if(mode==='owner'){
        await new ExecutionFence(dir).acquire();
        if(typeof process.send!=='function')throw Error('IPC required');
        process.send('synthetic_fence_persisted');
        setInterval(()=>{},1000);
    }else if(mode==='successor'){
        let spawned=false;
        const runtime=new AdbRuntime({dataDir:dir,spawnImpl:()=>{spawned=true;throw Error('unexpected spawn');}});
        try{await runtime.start();throw Error('missing fence');}
        catch(e){if(e.code!=='adb_execution_fenced'||spawned)throw e;}
        process.stdout.write('synthetic_restart_fenced\n');
    }else throw Error('unknown fixture mode');
})().catch(()=>{process.stderr.write('synthetic_fixture_failed\n');process.exitCode=1;});
