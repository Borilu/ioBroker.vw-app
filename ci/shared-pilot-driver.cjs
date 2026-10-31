'use strict';
// Disposable, network-isolated CI instance ONLY. Not a production driver.
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {isDeepStrictEqual}=require('node:util');
const {assertCi,ciJournal,safeDir,syncDir}=require('./ci-migration-driver.cjs');
const {createCliDriver}=require('../cli-driver.cjs');
const {stageSharedPilot,startSharedPilot}=require('../shared-pilot.cjs');
const {stopPilot,digest}=require('../provision.cjs');
const {probeNoH2}=require('./alpn-probe.cjs');
const {probeSocket}=require('./auth-socket-probe.cjs');
function cli(args){const r=spawnSync('iobroker',args,{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
    if(r.error||r.signal||r.status!==0)throw Error('ci_shared_cli_uncertain');return r.stdout;}
async function runCiShared({p,scope,dir,certPem,WebSocket}){
    assertCi();safeDir(dir);
    if(p.instance!==19||p.bind!=='127.0.0.1'||p.expectedIp!=='192.168.248.250'
        ||!/^[a-f0-9]{32}$/.test(p.id)||!/^[a-f0-9]{32}$/.test(p.certificateOwnerId)
        ||!/^\/tmp\/vw-admin-https-ci-[A-Za-z0-9]+$/.test(dir)
        ||!/^\/tmp\/vw-admin-https-ci-[A-Za-z0-9]+\/synthetic\.pem$/.test(p.publicPath)
        ||p.privatePath!==p.publicPath.replace(/synthetic\.pem$/,'synthetic.key')
        ||p.caPath!==p.publicPath)throw Error('invalid_ci_shared_scope');
    const lock=path.join(dir,'pilot.lock');fs.mkdirSync(lock,{mode:0o700});syncDir(dir);let done=false;
    try{
        const base=createCliDriver(),journal=ciJournal(dir);
        const ownerCheck=async enabled=>{
            assertCi();safeDir(dir);const lockstat=fs.lstatSync(lock);
            if(!lockstat.isDirectory()||lockstat.isSymbolicLink()||lockstat.uid!==process.getuid()
                ||(lockstat.mode&0o777)!==0o700)throw Error('ci_shared_lock_invalid');
            const o=await base.getInstance(19);
            if(o?.native?.pilotId!==p.id||o.native?.bind!==p.bind||o.native?.port!==p.port
                ||o.native?.certPublic!==p.publicAlias||o.native?.certPrivate!==p.privateAlias
                ||o.native?.auth!==true||o.native?.secure!==true||o.native?.http2!==false
                ||o.common?.enabled!==enabled)throw Error('ci_shared_identity_unverified');
        };
        const d={...base,
            createDisabled:async(n,port)=>{assertCi();if(n!==19||port!==p.port)throw Error('invalid_ci_shared_scope');
                return base.createDisabled(n,port);},
            configureSharedDisabled:async candidate=>{
                assertCi();if(!isDeepStrictEqual(candidate,p))throw Error('invalid_ci_shared_scope');
                const obj=await base.getInstance(19),rec=await journal.read();
                if(rec?.phase!=='configure_attempting'||rec.p?.id!==p.id||obj?.common?.enabled!==false
                    ||(obj.native?.pilotId!==undefined&&obj.native?.pilotId!==p.id)
                    ||await base.pilotProcessCount(19)!==0||!await base.portFree(p.bind,p.port))
                    throw Error('ci_shared_unconfigured_identity');
                const patch={common:{enabled:false,loglevel:'info',mode:'daemon',runAsCompactMode:false},
                    native:{pilotId:p.id,bind:p.bind,port:p.port,auth:true,secure:true,http2:false,
                        certPublic:p.publicAlias,certPrivate:p.privateAlias,certChained:''}};
                cli(['object','extend','system.adapter.admin.19',JSON.stringify(patch)]);
            },
            enable:async n=>{if(n!==19)throw Error('invalid_ci_shared_scope');await ownerCheck(false);return base.enable(n);},
            disable:async n=>{if(n!==19)throw Error('invalid_ci_shared_scope');await ownerCheck(true);return base.disable(n);},
            verifyNoH2WithPinnedTls:async candidate=>{if(!isDeepStrictEqual(candidate,p))throw Error('invalid_ci_shared_scope');
                return probeNoH2({host:p.bind,port:p.port,ca:certPem,expectedIp:p.expectedIp,expectedCertSha256:p.serverCertSha256});},
            verifyUnauthenticatedSocket:async candidate=>{if(!isDeepStrictEqual(candidate,p))throw Error('invalid_ci_shared_scope');
                return probeSocket({WebSocket,host:p.bind,port:p.port,ca:certPem,expectedIp:p.expectedIp,
                    expectedCertSha256:p.serverCertSha256,instance:19});},
        };
        const originalCertDigest=digest(await base.getCertMap());
        if(await stageSharedPilot(d,journal,p,scope)!=='shared_pilot_prepared')throw Error('ci_shared_stage_unconfirmed');
        if(await startSharedPilot(d,journal,p,scope)!=='shared_pilot_loopback_observed')throw Error('ci_shared_start_unconfirmed');
        if((await journal.read()).sharedCertVerification!=='verified')throw Error('ci_shared_journal_unconfirmed');
        await stopPilot(d,journal,p);
        if(digest(await base.getCertMap())!==originalCertDigest)throw Error('ci_shared_certificates_changed');
        done=true;return 'ci_shared_pilot_observed';
    }finally{if(done){fs.rmdirSync(lock);syncDir(dir);}}
}
module.exports={runCiShared};
