'use strict';
// Real ioBroker CLI transport. All CLI output remains in memory and is never logged.
// Do not enable this pilot on a live host without a separately reviewed durable journal
// and an exclusive operator-maintenance window for system.certificates.
const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const https = require('node:https');
const tls = require('node:tls');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Stop, tlsProbe } = require('./provision.cjs');

function cli(args, absentAllowed = false) {
    const result = spawnSync('iobroker', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    if (result.error || result.signal) throw new Stop('cli_outcome_uncertain');
    if (result.status === 3 && absentAllowed) return null;
    if (result.status !== 0) throw new Stop('cli_failed');
    return result.stdout;
}
function getObject(id, absentAllowed = false) {
    const value = cli(['object', 'get', id], absentAllowed);
    if (value === null) return null;
    try { return JSON.parse(value); } catch { throw new Stop('object_parse_failed'); }
}
function extend(id, value) { cli(['object', 'extend', id, JSON.stringify(value)]); }
function portFree(host, port) {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
    });
}
function regular(path) {
    const st = fs.lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) throw new Stop('certificate_file_not_regular');
    return st;
}
function serviceIds(p) {
    const uid=spawnSync('/usr/bin/id',['-u','iobroker'],{encoding:'utf8',timeout:5000});
    const groups=spawnSync('/usr/bin/id',['-G','iobroker'],{encoding:'utf8',timeout:5000});
    if(uid.status!==0 || groups.status!==0 || Number(uid.stdout.trim())!==p.serviceUid) throw new Stop('service_identity');
    const groupIds=groups.stdout.trim().split(/\s+/).map(Number);
    if(!groupIds.includes(p.serviceGid)) throw new Stop('service_group');
    return groupIds;
}
function accessible(st,uid,groups,ownerBit,groupBit,otherBit) {
    return !!(st.mode & (st.uid===uid ? ownerBit : groups.includes(st.gid) ? groupBit : otherBit));
}
function serviceCanRead(file,p,groups) {
    if(fs.realpathSync(file)!==file) return false;
    const st=regular(file);
    if(!accessible(st,p.serviceUid,groups,0o400,0o040,0o004)) return false;
    let dir=path.dirname(file);
    while(true) {
        const ds=fs.statSync(dir);
        if(!ds.isDirectory() || !accessible(ds,p.serviceUid,groups,0o100,0o010,0o001)) return false;
        const parent=path.dirname(dir);
        if(parent===dir) break;
        dir=parent;
    }
    return true;
}
function checkCertificateFiles(p) {
    try {
        const groups=serviceIds(p);
        if(!serviceCanRead(p.publicPath,p,groups) || !serviceCanRead(p.privatePath,p,groups)) throw new Stop('service_cannot_read_files');
        regular(p.caPath);
        const st = regular(p.privatePath);
        const mode=st.mode & 0o777;
        const ownerOnly=st.uid===p.serviceUid && mode===0o600;
        const groupRead=st.uid===process.getuid() && st.gid===p.serviceGid && mode===0o640;
        if(!ownerOnly && !groupRead) throw new Stop('key_permissions');
        const pem = fs.readFileSync(p.publicPath);
        const key = fs.readFileSync(p.privatePath);
        const caPem = fs.readFileSync(p.caPath);
        if (crypto.createHash('sha256').update(caPem).digest('hex') !== p.caSha256) throw new Stop('ca_digest');
        const cert = new crypto.X509Certificate(pem), ca = new crypto.X509Certificate(caPem);
        const anchorValid = p.trustMode === 'leaf'
            ? !ca.ca && cert.raw.equals(ca.raw) && cert.verify(cert.publicKey)
            : ca.ca && cert.verify(ca.publicKey);
        if (cert.ca || !anchorValid || !cert.checkIP(p.expectedIp)
            || Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw new Stop('certificate_invalid');
        if (crypto.createHash('sha256').update(cert.raw).digest('hex') !== p.serverCertSha256) throw new Stop('server_cert_digest');
        const wanted = cert.publicKey.export({type:'spki',format:'der'});
        const actual = crypto.createPublicKey(key).export({type:'spki',format:'der'});
        if (!crypto.timingSafeEqual(wanted, actual)) throw new Stop('key_mismatch');
    } catch (e) { if (e instanceof Stop) throw e; throw new Stop('certificate_check_failed'); }
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function awaitPortFree(host,port) {
    for(let i=0;i<40;i++) { if(await portFree(host,port)) return true; await wait(250); }
    return false;
}
async function verifyRealTls(p) {
    const ca = fs.readFileSync(p.caPath);
    if (crypto.createHash('sha256').update(ca).digest('hex') !== p.caSha256) throw new Stop('ca_digest');
    let good = false;
    for (let i = 0; i < 40; i++) {
        try { await tlsProbe({host:p.bind, port:p.port, ca, expectedIp:p.expectedIp, expectedCertSha256:p.serverCertSha256}); good = true; break; }
        catch { await wait(250); }
    }
    if (!good) throw new Stop('tls_not_ready');
    let wrongNameRejected = false, untrustedRejected = false;
    try { await tlsProbe({host:p.bind, port:p.port, ca, expectedIp:'wrong.invalid'}); } catch { wrongNameRejected = true; }
    try { await tlsProbe({host:p.bind, port:p.port, ca:[], expectedIp:p.expectedIp}); } catch { untrustedRejected = true; }
    if (!wrongNameRejected || !untrustedRejected) throw new Stop('tls_negative_probe_failed');
}
function verifyUnauthenticatedRedirect(p) {
    const ca = fs.readFileSync(p.caPath);
    if (crypto.createHash('sha256').update(ca).digest('hex') !== p.caSha256) throw new Stop('ca_digest');
    return new Promise((resolve,reject) => {
        const req=https.get({host:p.bind,port:p.port,path:'/pilot-auth-probe-no-such-resource',ca,rejectUnauthorized:true,
            checkServerIdentity:(_host,cert)=>{
                const nameError=tls.checkServerIdentity(p.expectedIp,cert);
                if(nameError) return nameError;
                if(crypto.createHash('sha256').update(cert.raw).digest('hex')!==p.serverCertSha256) return Error('cert');
            }},res=>{
                res.resume();
                if(res.statusCode===302 && typeof res.headers.location==='string' && res.headers.location.includes('index.html?login')) resolve();
                else reject(new Stop('auth_redirect_unconfirmed'));
            });
        req.setTimeout(5000,()=>req.destroy());
        req.once('error',()=>reject(new Stop('auth_probe_failed')));
    });
}
function createCliDriver() {
    return {
        getInstance: async n => getObject('system.adapter.admin.' + n, true),
        getCertMap: async () => {
            const o = getObject('system.certificates');
            if (!o?.native?.certificates || typeof o.native.certificates !== 'object') throw new Stop('certificate_store_missing');
            return o.native.certificates;
        },
        portFree, awaitPortFree, checkCertificateFiles, verifyRealTls, verifyUnauthenticatedRedirect,
        interfacePresent: async ip => Object.values(os.networkInterfaces()).flat().some(x => x && x.address===ip && !x.internal),
        createDisabled: async (n, port) => { cli(['add', 'admin', String(n), '--enabled=false', '--port', String(port)]); },
        configureDisabled: async p => extend('system.adapter.admin.' + p.instance, {
            common: {enabled:false, loglevel:'info'},
            native: {auth:true, secure:true, bind:p.bind, port:p.port, certPublic:p.publicAlias,
                certPrivate:p.privateAlias, certChained:'', pilotId:p.id},
        }),
        extendCertMap: async entries => extend('system.certificates', {native:{certificates:entries}}),
        bindDisabled: async (n, ip) => extend('system.adapter.admin.'+n, {native:{bind:ip}}),
        enable: async n => { cli(['start', 'admin.' + n]); },
        disable: async n => { cli(['stop', 'admin.' + n]); },
    };
}
module.exports = { createCliDriver };
