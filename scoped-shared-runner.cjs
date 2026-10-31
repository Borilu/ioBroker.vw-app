'use strict';
// Hash-scoped experimental prototype. Never run without independent
// review, isolated matching controller tests and an exclusive maintenance window.
// This runner never writes system.certificates or exposes a LAN listener.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {isDeepStrictEqual}=require('node:util');
const {createCliDriver}=require('./cli-driver.cjs');
const {stageSharedPilot,startSharedPilot}=require('./shared-pilot.cjs');
const {probeNoH2}=require('./ci/alpn-probe.cjs');
const {probeSocket}=require('./ci/auth-socket-probe.cjs');
const {parseSharedScope}=require('./shared-scope-policy.cjs');
let id,owner,pin,base,dir,scope,spec;
function fail(code){throw Object.assign(new Error(code),{code});}
function target(p){return p?.id===id&&p.certificateOwnerId===owner&&p.instance===scope.instance&&p.port===scope.port
    &&p.bind==='127.0.0.1'&&p.expectedIp===scope.expectedIp&&p.serverCertSha256===pin
    &&p.publicAlias==='pilot_pub_'+owner&&p.privateAlias==='pilot_key_'+owner
    &&p.publicPath===scope.publicPath&&p.privatePath===scope.privatePath&&p.caPath===p.publicPath
    &&p.serviceUid===spec.serviceUid&&p.serviceGid===spec.serviceGid&&p.trustMode==='leaf';}
function checkDir(name,mode){const s=fs.lstatSync(name);
    if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(name)!==name
        ||s.uid!==process.getuid()||(s.mode&0o777)!==mode)fail('unsafe_directory');}
function privateFile(name){const s=fs.lstatSync(name);
    if(!s.isFile()||s.isSymbolicLink()||fs.realpathSync(name)!==name||s.nlink!==1
        ||s.uid!==process.getuid()||(s.mode&0o777)!==0o600)fail('unsafe_private_file');}
function syncDir(name){const fd=fs.openSync(name,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function journal(){const file=dir+'/pilot-journal.json';return {
    read:async()=>{checkDir(dir,0o700);try{privateFile(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
        return JSON.parse(fs.readFileSync(file,'utf8'));},
    save:async value=>{checkDir(dir,0o700);const tmp=dir+'/.new-'+crypto.randomBytes(16).toString('hex');let fd;
        try{fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
            fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
            fs.renameSync(tmp,file);syncDir(dir);
        }catch{if(fd!==undefined)fs.closeSync(fd);fail('journal_write_uncertain');}}
};}
function cli(args){const r=spawnSync('iobroker',args,{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
    if(r.error||r.signal||r.status!==0)fail('cli_outcome_uncertain');return r.stdout;}
function globalSafe(){const o=JSON.parse(cli(['object','get','system.config']));
    if([o.common?.defaultLogLevel,o.common?.logLevel].some(x=>typeof x==='string'&&['debug','silly'].includes(x.toLowerCase())))
        fail('unsafe_global_loglevel');}
function sameTarget(candidate,p){return target(candidate)&&isDeepStrictEqual(candidate,p);}
function makeOwnedStop(driver,p,checkLock,checkedScope,validateTarget){return async n=>{
    if(n!==checkedScope.instance||!validateTarget(p))fail('wrong_pilot_scope');
    await checkLock();
    // A stop must not depend on the health, configuration or availability of
    // a different instance. Check only this pilot's identity and destination.
    const o=await driver.getInstance(checkedScope.instance);
    if(o?.native?.pilotId!==checkedScope.id||o.native?.bind!=='127.0.0.1'||o.native?.port!==checkedScope.port
        ||o.native?.certPublic!==p.publicAlias||o.native?.certPrivate!==p.privateAlias
        ||o.common?.enabled!==true)fail('identity_unverified');
    return driver.disable(checkedScope.instance);
};}
async function main(){
    const operation=process.argv[2];
    if(process.argv.length!==8||!['--stage','--start'].includes(operation)||process.argv[3]!=='--scope'
        ||!path.isAbsolute(process.argv[4])||process.argv[5]!=='--scope-hash'
        ||!/^[a-f0-9]{64}$/.test(process.argv[6])||process.argv[7]!=='--execute')
        fail('explicit_invocation_required');
    if(process.platform!=='linux'||typeof process.getuid!=='function')fail('wrong_execution_user');
    for(const k of ['NODE_OPTIONS','NODE_TLS_REJECT_UNAUTHORIZED','SSLKEYLOGFILE','NODE_EXTRA_CA_CERTS'])
        if(process.env[k])fail('unsafe_environment');
    if(fs.realpathSync('/tmp')!=='/tmp'||fs.lstatSync('/tmp').isSymbolicLink())fail('unsafe_tmp');
    const scopePath=process.argv[4];privateFile(scopePath);
    if(typeof fs.constants.O_NOFOLLOW!=='number')fail('unsafe_scope_file');
    const fd=fs.openSync(scopePath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;
    try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600
            ||s.nlink!==1||s.size>8192)fail('unsafe_scope_file');bytes=fs.readFileSync(fd);}
    finally{fs.closeSync(fd);}
    spec=parseSharedScope(bytes,process.argv[6],scopePath,process.getuid());
    id=spec.id;owner=spec.owner;pin=spec.serverCertSha256;base=spec.base;dir=spec.dir;
    scope=Object.freeze({id,certificateOwnerId:owner,instance:spec.instance,port:spec.port,expectedIp:spec.expectedIp,
        serverCertSha256:pin,publicPath:spec.publicPath,privatePath:spec.privatePath});
    checkDir(base,0o700);checkDir(dir,0o700);const config=dir+'/config.json';privateFile(config);
    const cfg=JSON.parse(fs.readFileSync(config,'utf8'));
    if(cfg.journalDir!==dir||!target(cfg.pilot))fail('wrong_pilot_scope');
    const p=cfg.pilot,certStat=fs.lstatSync(scope.publicPath);
    if(!certStat.isFile()||certStat.isSymbolicLink()||fs.realpathSync(scope.publicPath)!==scope.publicPath)
        fail('unsafe_public_certificate');
    const certPem=fs.readFileSync(scope.publicPath),cert=new crypto.X509Certificate(certPem);
    if(cert.ca||cert.subjectAltName!=='IP Address:'+scope.expectedIp||!cert.checkIP(scope.expectedIp)
        ||!Array.isArray(cert.keyUsage)||cert.keyUsage.length!==1||cert.keyUsage[0]!=='1.3.6.1.5.5.7.3.1'
        ||Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<=Date.now()+600000
        ||crypto.createHash('sha256').update(cert.raw).digest('hex')!==pin)fail('certificate_scope_invalid');
    const wsServer=require.resolve('@iobroker/ws-server/package.json',{paths:['/opt/iobroker/node_modules/iobroker.admin']});
    if(require(require.resolve('ws/package.json',{paths:[path.dirname(wsServer)]})).version!=='8.22.0')fail('version_mismatch');
    const WebSocket=require(require.resolve('ws',{paths:[path.dirname(wsServer)]}));
    const lock=dir+'/pilot.lock';fs.mkdirSync(lock,{mode:0o700});syncDir(dir);let finished=false;
    try{
        globalSafe();
        const version=name=>require(require.resolve(name+'/package.json',{paths:['/opt/iobroker/node_modules/iobroker.admin']})).version;
        const expected={'iobroker.js-controller':'7.2.5','iobroker.admin':'8.3.5',
            '@iobroker/socket-classes':'2.10.0','@iobroker/ws-server':'4.5.2','@iobroker/webserver':'3.4.0'};
        for(const [name,wanted] of Object.entries(expected))if(version(name)!==wanted)fail('version_mismatch');
        if(JSON.parse(cli(['object','get','system.adapter.admin'])).common?.installedVersion!=='8.3.5')fail('version_mismatch');
        const baseDriver=createCliDriver(),j=journal();
        const guard=async()=>{
            checkDir(dir,0o700);checkDir(lock,0o700);globalSafe();
            const old=await baseDriver.getInstance(spec.previousInstance);
            if(old?.native?.pilotId!==owner||old.common?.enabled!==false||await baseDriver.pilotProcessCount(spec.previousInstance)!==0)
                fail('previous_pilot_not_stopped');
            const alive=JSON.parse(cli(['state','get','system.adapter.admin.'+spec.previousInstance+'.alive']));
            if(alive?.val!==false||alive.ack!==true||(alive.q!==undefined&&alive.q!==0))fail('previous_pilot_not_stopped');
        };
        const identity=async enabled=>{
            await guard();const o=await baseDriver.getInstance(scope.instance);
            if(o?.native?.pilotId!==id||o.native?.bind!=='127.0.0.1'||o.native?.port!==scope.port
                ||o.native?.certPublic!==p.publicAlias||o.native?.certPrivate!==p.privateAlias
                ||o.common?.enabled!==enabled)fail('identity_unverified');
            return o;
        };
        const expectedListener=crypto.createHash('sha256').update(id+'|tcp|127.0.0.1:'+scope.port).digest('hex');
        const verifyListener=async()=>{
            const rec=await j.read();if(!Array.isArray(rec?.beforeListeners))fail('listener_baseline_unverified');
            const now=await baseDriver.getListenerHashes(id),before=new Set(rec.beforeListeners);
            const added=now.filter(x=>!before.has(x));
            if(before.has(expectedListener)||added.length!==1||added[0]!==expectedListener
                ||await baseDriver.pilotProcessCount(scope.instance)!==1)fail('listener_unverified');
        };
        const d={...baseDriver,
            createDisabled:async(n,port)=>{await guard();const rec=await j.read();
                if(n!==scope.instance||port!==scope.port||rec?.phase!=='create_attempting'||rec.p?.id!==id
                    ||await baseDriver.getInstance(scope.instance)!==null||await baseDriver.pilotProcessCount(scope.instance)!==0
                    ||!await baseDriver.portFree('127.0.0.1',scope.port))fail('create_unverified');
                return baseDriver.createDisabled(n,port);},
            configureSharedDisabled:async candidate=>{
                if(!sameTarget(candidate,p))fail('wrong_pilot_scope');await guard();
                const obj=await baseDriver.getInstance(scope.instance),rec=await j.read();
                if(rec?.phase!=='configure_attempting'||rec.p?.id!==id||obj?.common?.enabled!==false
                    ||(obj.native?.pilotId!==undefined&&obj.native?.pilotId!==id)
                    ||await baseDriver.pilotProcessCount(scope.instance)!==0||!await baseDriver.portFree('127.0.0.1',scope.port))
                    fail('configure_unverified');
                const patch={common:{enabled:false,loglevel:'info',mode:'daemon',runAsCompactMode:false},
                    native:{pilotId:id,bind:'127.0.0.1',port:scope.port,auth:true,secure:true,http2:false,
                        certPublic:p.publicAlias,certPrivate:p.privateAlias,certChained:''}};
                cli(['object','extend','system.adapter.admin.'+scope.instance,JSON.stringify(patch)]);
            },
            enable:async n=>{if(n!==scope.instance)fail('wrong_pilot_scope');const o=await identity(false);
                if(o.native?.auth!==true||o.native?.secure!==true||o.native?.http2!==false
                    ||o.common?.loglevel!=='info'||o.common?.mode!=='daemon'||o.common?.runAsCompactMode!==false)
                    fail('start_config_unverified');return baseDriver.enable(n);},
            disable:makeOwnedStop(baseDriver,p,async()=>{checkDir(dir,0o700);checkDir(lock,0o700);},scope,target),
            verifyNoH2WithPinnedTls:async candidate=>{if(!sameTarget(candidate,p))fail('wrong_pilot_scope');
                await identity(true);await verifyListener();return probeNoH2({host:'127.0.0.1',port:scope.port,ca:certPem,
                    expectedIp:scope.expectedIp,expectedCertSha256:pin});},
            verifyUnauthenticatedSocket:async candidate=>{if(!sameTarget(candidate,p))fail('wrong_pilot_scope');
                await identity(true);await verifyListener();return probeSocket({WebSocket,host:'127.0.0.1',port:scope.port,
                    ca:certPem,expectedIp:scope.expectedIp,expectedCertSha256:pin,instance:scope.instance});},
        };
        delete d.extendCertMap;
        await guard();
        const outcome=operation==='--stage'?await stageSharedPilot(d,j,p,scope):await startSharedPilot(d,j,p,scope);
        if(!['shared_pilot_prepared','shared_pilot_loopback_observed'].includes(outcome))fail('result_unconfirmed');
        finished=true;process.stdout.write(outcome+'\n');
    }finally{if(finished){fs.rmdirSync(lock);syncDir(dir);}}
}
if(require.main===module)main().catch(e=>{
    const code=typeof e?.code==='string'&&/^[a-z_]+$/.test(e.code)?e.code:'uncertain';
    process.stderr.write('PILOT_STOPPED: '+code+'\n');process.exitCode=1;
});
module.exports={target,makeOwnedStop};
