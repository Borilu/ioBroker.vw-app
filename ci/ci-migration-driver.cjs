'use strict';
// CI ONLY. Never use on a real VM or with a persistent controller.
// The mkdir lock excludes cooperating pilot tools, not arbitrary DB writers.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {isDeepStrictEqual}=require('node:util');
const {isolatedCi}=require('./isolation-check.cjs');
const {createCliDriver}=require('../cli-driver.cjs');
const {migrateToHttp1}=require('../http1-migration.cjs');
const {probeNoH2}=require('./alpn-probe.cjs');
const {probeSocket}=require('./auth-socket-probe.cjs');

function assertCi(){
    if(!isolatedCi({githubActions:process.env.GITHUB_ACTIONS,mode:process.env.VW_HTTPS_PILOT_CI,
        docker:fs.existsSync('/.dockerenv'),runId:process.env.VW_HTTPS_RUN_ID,marker:process.env.VW_HTTPS_MARKER,
        hostname:os.hostname(),uid:typeof process.getuid==='function'?process.getuid():-1,
        platform:process.platform,interfaces:Object.values(os.networkInterfaces()).flat().filter(Boolean)}))
        throw new Error('not_disposable_ci_container');
}
function validateCiPilot(p,dir){
    return !!p&&p.instance===17&&p.bind==='127.0.0.1'&&p.expectedIp==='192.168.248.250'
        &&/^[a-f0-9]{32}$/.test(p.id)&&p.publicAlias==='pilot_pub_'+p.id&&p.privateAlias==='pilot_key_'+p.id
        &&/^\/tmp\/vw-admin-https-ci-[A-Za-z0-9]+$/.test(dir)&&p.publicPath===dir+'/synthetic.pem'
        &&p.privatePath===dir+'/synthetic.key'&&p.caPath===p.publicPath&&p.trustMode==='leaf';
}
function safeDir(dir){
    const s=fs.lstatSync(dir);
    if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(dir)!==dir||s.uid!==process.getuid()
        ||(s.mode&0o777)!==0o700)throw new Error('unsafe_ci_directory');
}
function syncDir(dir){const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function ciJournal(dir){
    const file=path.join(dir,'pilot-journal.json');
    return {
        read:async()=>{
            safeDir(dir);const s=fs.lstatSync(file);
            if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw Error('unsafe_ci_journal');
            return JSON.parse(fs.readFileSync(file,'utf8'));
        },
        save:async value=>{
            safeDir(dir);const tmp=path.join(dir,'.ci-journal-'+crypto.randomBytes(16).toString('hex'));
            let fd;
            try{
                fd=fs.openSync(tmp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);
                fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
                fs.renameSync(tmp,file);syncDir(dir);
            }catch{if(fd!==undefined)fs.closeSync(fd);throw Error('ci_journal_uncertain');}
        },
    };
}
function unchangedExceptHttp2(obj){
    const x=structuredClone(obj);delete x.native.http2;
    for(const key of ['_rev','ts','from','user'])delete x[key];
    return x;
}
function invokeObjectSet(){
    // Constant target and constant value. Output and full object are never logged.
    const r=spawnSync('iobroker',['object','set','system.adapter.admin.17','native.http2=false'],
        {encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
    if(r.error||r.signal||r.status!==0)throw Error('ci_http1_write_uncertain');
}
async function runCiMigration({p,dir,certPem,WebSocket}){
    assertCi();safeDir(dir);
    if(!validateCiPilot(p,dir))throw Error('invalid_ci_pilot');
    const cert=new crypto.X509Certificate(certPem);
    if(crypto.createHash('sha256').update(cert.raw).digest('hex')!==p.serverCertSha256
        ||!cert.checkIP(p.expectedIp))throw Error('ci_cert_mismatch');
    const lock=path.join(dir,'pilot.lock');
    fs.mkdirSync(lock,{mode:0o700});syncDir(dir);
    let finished=false;
    try{
        const base=createCliDriver(),journal=ciJournal(dir);
        const checkIdentity=async enabled=>{
            assertCi();safeDir(dir);
            const s=fs.lstatSync(lock);
            if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)
                throw Error('ci_lock_unverified');
            const obj=await base.getInstance(17);
            if(obj?.native?.pilotId!==p.id||obj.native?.bind!==p.bind||obj.native?.port!==p.port
                ||obj.native?.certPublic!==p.publicAlias||obj.native?.certPrivate!==p.privateAlias
                ||obj.native?.auth!==true||obj.native?.secure!==true||obj.common?.enabled!==enabled)
                throw Error('ci_identity_unverified');
            return obj;
        };
        const driver={...base,
            disable:async n=>{if(n!==17)throw Error('wrong_ci_instance');await checkIdentity(true);return base.disable(n);},
            enable:async n=>{if(n!==17)throw Error('wrong_ci_instance');await checkIdentity(false);return base.enable(n);},
            setHttp1OnlyForOwnedPilot:async candidate=>{
                if(!isDeepStrictEqual(candidate,p))throw Error('ci_pilot_mismatch');
                const before=await checkIdentity(false);
                if(before.native.http2!==true||await base.pilotProcessCount(17)!==0
                    ||!await base.portFree(p.bind,p.port))throw Error('ci_pilot_not_stopped');
                assertCi();invokeObjectSet();
                const after=await checkIdentity(false);
                if(after.native.http2!==false||!isDeepStrictEqual(unchangedExceptHttp2(before),unchangedExceptHttp2(after)))
                    throw Error('ci_pilot_write_mismatch');
            },
            verifyNoH2WithPinnedTls:async candidate=>{
                if(!isDeepStrictEqual(candidate,p))throw Error('ci_pilot_mismatch');
                await probeNoH2({host:p.bind,port:p.port,ca:certPem,expectedIp:p.expectedIp,
                    expectedCertSha256:p.serverCertSha256});
            },
            verifyUnauthenticatedSocket:async candidate=>{
                if(!isDeepStrictEqual(candidate,p))throw Error('ci_pilot_mismatch');
                return probeSocket({WebSocket,host:p.bind,port:p.port,ca:certPem,expectedIp:p.expectedIp,
                    expectedCertSha256:p.serverCertSha256,instance:p.instance});
            },
        };
        const result=await migrateToHttp1(driver,journal,p,{instance:p.instance,port:p.port,
            expectedIp:p.expectedIp,serverCertSha256:p.serverCertSha256});
        if(result!=='http1_loopback_observed')throw Error('ci_migration_unconfirmed');
        finished=true;return result;
    }finally{
        if(finished){fs.rmdirSync(lock);syncDir(dir);}
    }
}
module.exports={runCiMigration,validateCiPilot,unchangedExceptHttp2};
