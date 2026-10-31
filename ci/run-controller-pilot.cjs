'use strict';
// ONLY for a disposable GitHub-hosted Docker container with an empty ioBroker.
// Never run this against a production controller.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const net=require('node:net');
const assert=require('node:assert/strict');
const {spawnSync,execFileSync}=require('node:child_process');
const {tlsProbe}=require('../provision.cjs');
const {probeSocket}=require('./auth-socket-probe.cjs');
const {readStateWithNoAuth}=require('./control-socket.cjs');
const {createCliDriver}=require('../cli-driver.cjs');
const {isolatedCi}=require('./isolation-check.cjs');
const {probeNoH2}=require('./alpn-probe.cjs');
const {runCiMigration}=require('./ci-migration-driver.cjs');
const expectedController='7.2.5',expectedAdmin='8.3.5';
const expectedTransitive={'@iobroker/socket-classes':'2.10.0','@iobroker/ws-server':'4.5.2','@iobroker/webserver':'3.4.0'};
function fixedCommand(exe,args,opts={}) {
    const r=spawnSync(exe,args,{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,...opts});
    if(r.error || r.status!==0) {
        const code=(r.stderr||'').match(/Pilot gestoppt: ([a-z_]+)/)?.[1]||'command_failed';
        throw new Error(code);
    }
    return r.stdout;
}
async function freePort() {
    return new Promise((resolve,reject)=>{
        const s=net.createServer();s.once('error',reject);
        s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});
    });
}
async function waitTls(p,ca) {
    for(let i=0;i<50;i++) {
        try { await tlsProbe({host:p.bind,port:p.port,ca,expectedIp:p.expectedIp,expectedCertSha256:p.serverCertSha256});return; }
        catch {await new Promise(r=>setTimeout(r,300));}
    }
    throw new Error('control_tls_unavailable');
}
async function main() {
    function requireIsolated() {
        const okay=isolatedCi({githubActions:process.env.GITHUB_ACTIONS,mode:process.env.VW_HTTPS_PILOT_CI,
            docker:fs.existsSync('/.dockerenv'),runId:process.env.VW_HTTPS_RUN_ID,marker:process.env.VW_HTTPS_MARKER,
            hostname:os.hostname(),uid:typeof process.getuid==='function'?process.getuid():-1,
            platform:process.platform,interfaces:Object.values(os.networkInterfaces()).flat().filter(Boolean)});
        if(!okay)throw new Error('not_disposable_ci_container');
    }
    requireIsolated();
    const actualController=require('/opt/iobroker/node_modules/iobroker.js-controller/package.json').version;
    const actualAdmin=require('/opt/iobroker/node_modules/iobroker.admin/package.json').version;
    if(actualController!==expectedController || actualAdmin!==expectedAdmin || Number(process.versions.node.split('.')[0])!==24)
        throw new Error('unexpected_iobroker_versions');
    const registeredAdmin=JSON.parse(fixedCommand('iobroker',['object','get','system.adapter.admin']));
    if(registeredAdmin.common?.installedVersion!==expectedAdmin) throw new Error('registered_admin_version_mismatch');
    const systemConfig=JSON.parse(fixedCommand('iobroker',['object','get','system.config']));
    if([systemConfig.common?.defaultLogLevel,systemConfig.common?.logLevel]
        .some(x=>typeof x==='string' && ['debug','silly'].includes(x.toLowerCase()))) throw new Error('unsafe_global_loglevel');
    for(const [name,expected] of Object.entries(expectedTransitive)) {
        const pkgPath=require.resolve(name+'/package.json',{paths:['/opt/iobroker/node_modules/iobroker.admin']});
        if(require(pkgPath).version!==expected) throw new Error('transitive_version_mismatch');
    }
    const serverPackage=require.resolve('@iobroker/ws-server/package.json',{paths:['/opt/iobroker/node_modules/iobroker.admin']});
    const wsPackage=require.resolve('ws/package.json',{paths:[path.dirname(serverPackage)]});
    if(require(wsPackage).version!=='8.22.0') throw new Error('websocket_version_mismatch');
    const uid=Number(fixedCommand('/usr/bin/id',['-u','iobroker']).trim());
    const gid=Number(fixedCommand('/usr/bin/id',['-g','iobroker']).trim());
    if(process.getuid()!==uid || process.getgid()!==gid) throw new Error('unexpected_service_identity');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vw-admin-https-ci-'));
    fs.chmodSync(dir,0o700);
    const key=path.join(dir,'synthetic.key'),cert=path.join(dir,'synthetic.pem'),config=path.join(dir,'config.json');
    fixedCommand('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1',
        '-subj','/CN=Synthetic ioBroker CI','-addext','basicConstraints=critical,CA:FALSE',
        '-addext','keyUsage=critical,digitalSignature,keyEncipherment','-addext','extendedKeyUsage=serverAuth',
        '-addext','subjectAltName=IP:192.168.248.250'],{stdio:'ignore'});
    fs.chmodSync(key,0o600);fs.chmodSync(cert,0o600);
    const certPem=fs.readFileSync(cert),id=crypto.randomBytes(16).toString('hex'),port=await freePort();
    const p={id,instance:17,port,bind:'127.0.0.1',expectedIp:'192.168.248.250',
        publicAlias:'pilot_pub_'+id,privateAlias:'pilot_key_'+id,publicPath:cert,privatePath:key,caPath:cert,
        caSha256:crypto.createHash('sha256').update(certPem).digest('hex'),
        serverCertSha256:crypto.createHash('sha256').update(new crypto.X509Certificate(certPem).raw).digest('hex'),
        serviceUid:uid,serviceGid:gid,trustMode:'leaf'};
    fs.writeFileSync(config,JSON.stringify({journalDir:dir,pilot:p}),{mode:0o600});
    const pilot=path.join(__dirname,'..','pilot.cjs');
    function command(name) {
        const output=fixedCommand(process.execPath,[pilot,name,config,'--execute']);
        const allowed=['prepared','loopback_tls_verified_auth_unproven','stop_observed_entries_retained'];
        if(!allowed.includes(output.trim())) throw new Error('unexpected_pilot_result');
        console.log(name+': '+output.trim());
    }
    command('stage');command('start');
    const prior=JSON.parse(fixedCommand('iobroker',['object','get','system.adapter.admin.17']));
    if(prior.native?.pilotId!==id||prior.native?.http2!==true||prior.common?.enabled!==true)
        throw new Error('initial_h2_control_unverified');
    const tlsOptions={host:'127.0.0.1',port,ca:certPem,expectedIp:p.expectedIp,
        expectedCertSha256:p.serverCertSha256};
    await assert.rejects(probeNoH2(tlsOptions),{code:'h2_negotiated'});
    const wsPath=require.resolve('ws',{paths:[path.dirname(serverPackage)]});
    const WebSocket=require(wsPath);
    assert.equal(await runCiMigration({p,dir,certPem,WebSocket}),'http1_loopback_observed');
    const afterJournal=JSON.parse(fs.readFileSync(path.join(dir,'pilot-journal.json'),'utf8'));
    if(afterJournal.phase!=='loopback_tls_verified_auth_unproven'||afterJournal.http1Verification!=='verified'
        ||afterJournal.p?.id!==id)throw new Error('ci_migration_journal_unverified');
    console.log('journaled real-controller HTTP/1.1 migration verified');
    const running=JSON.parse(fixedCommand('iobroker',['object','get','system.adapter.admin.17']));
    if(running.native?.pilotId!==id || running.native?.http2!==false || running.common?.enabled!==true)
        throw new Error('http1_running_configuration_unverified');
    const alpn=await probeNoH2({host:'127.0.0.1',port,ca:certPem,expectedIp:p.expectedIp,
        expectedCertSha256:p.serverCertSha256});
    console.log('HTTP/2 not negotiated with h2 and http/1.1 offered: '+alpn);
    const options={WebSocket,host:'127.0.0.1',port,ca:certPem,expectedIp:p.expectedIp,
        expectedCertSha256:p.serverCertSha256,instance:p.instance};
    const observed=await probeSocket(options);
    assert(['state_read_explicitly_denied','unauthenticated_state_not_observed'].includes(observed));
    console.log('auth-on WebSocket: '+observed+' (bounded observation)');
    await createCliDriver().verifyRealTls(p);
    command('stop');
    // Negative control in this isolated disposable container only: deliberately turn
    // authentication off and prove the exact same state is then readable on WebSocket.
    requireIsolated();
    const finalJournal=JSON.parse(fs.readFileSync(path.join(dir,'pilot-journal.json'),'utf8'));
    const testObject=JSON.parse(fixedCommand('iobroker',['object','get','system.adapter.admin.17']));
    if(finalJournal.phase!=='stop_observed_entries_retained' || finalJournal.p?.id!==id
        || testObject.native?.pilotId!==id || testObject.native?.auth!==true || testObject.native?.secure!==true
        || testObject.native?.http2!==false
        || testObject.native?.bind!=='127.0.0.1' || testObject.native?.port!==port
        || testObject.common?.enabled!==false) throw new Error('negative_control_ownership_unverified');
    fixedCommand('iobroker',['object','set','system.adapter.admin.17','native.auth=false']);
    fixedCommand('iobroker',['start','admin.17']);
    await waitTls(p,certPem);
    await readStateWithNoAuth(options);
    let rejected=false;
    try { await probeSocket(options); } catch { rejected=true; }
    assert.equal(rejected,true,'auth-off must not pass unauthenticated-access check');
    fixedCommand('iobroker',['stop','admin.17']);
    console.log('negative control: auth-off state was readable; probe rejected it');
}
main().catch(e=>{console.error('Synthetic controller integration stopped: '+(e.message||'unknown'));process.exitCode=1;});
