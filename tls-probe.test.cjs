'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
const {tlsProbe} = require('./provision.cjs');
const exe = process.env.OPENSSL_BIN;
test('actual TLS: pin, matching SAN, wrong identity, untrusted CA and HTTP fallback', {skip:!exe}, async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vw-pilot-tls-'));
    const names=['ca.key','ca.pem','ca.srl','leaf.key','leaf.csr','leaf.ext','leaf.pem'];
    let server, plaintext;
    const run=args=>{
        const r=spawnSync(exe,args,{cwd:dir,encoding:'utf8',timeout:20000});
        assert.equal(r.status,0,'synthetic openssl failure');
    };
    try {
        run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=Synthetic CA',
            '-addext','basicConstraints=critical,CA:TRUE,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign']);
        run(['req','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.csr','-subj','/CN=Synthetic Server']);
        fs.writeFileSync(path.join(dir,'leaf.ext'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
        run(['x509','-req','-in','leaf.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','leaf.pem','-days','1','-extfile','leaf.ext']);
        const ca=fs.readFileSync(path.join(dir,'ca.pem')), cert=fs.readFileSync(path.join(dir,'leaf.pem')), key=fs.readFileSync(path.join(dir,'leaf.key'));
        const fingerprint=crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('hex');
        server=https.createServer({cert,key},(_q,r)=>r.end('test'));
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
        const base={host:'127.0.0.1',port:server.address().port,ca,expectedIp:'127.0.0.1',expectedCertSha256:fingerprint};
        await tlsProbe(base);
        await assert.rejects(tlsProbe({...base,expectedIp:'192.0.2.2'}));
        await assert.rejects(tlsProbe({...base,expectedCertSha256:'0'.repeat(64)}));
        await assert.rejects(tlsProbe({...base,ca:[]}));
        plaintext=http.createServer((_q,r)=>r.end('not tls'));
        await new Promise((resolve,reject)=>{plaintext.once('error',reject);plaintext.listen(0,'127.0.0.1',resolve);});
        await assert.rejects(tlsProbe({...base,port:plaintext.address().port}));
    } finally {
        if (server) await new Promise(resolve=>server.close(resolve));
        if (plaintext) await new Promise(resolve=>plaintext.close(resolve));
        for (const name of names) { try { fs.unlinkSync(path.join(dir,name)); } catch (e) { if(e.code!=='ENOENT') throw e; } }
        fs.rmdirSync(dir);
    }
});
test('explicitly pinned self-signed server certificate works without a CA', {skip:!exe}, async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vw-pilot-leaf-'));
    let server;
    try {
        const r=spawnSync(exe,['req','-x509','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.pem',
            '-days','1','-subj','/CN=Synthetic leaf','-addext','basicConstraints=critical,CA:FALSE',
            '-addext','keyUsage=critical,digitalSignature,keyEncipherment','-addext','extendedKeyUsage=serverAuth',
            '-addext','subjectAltName=IP:127.0.0.1'],{cwd:dir,encoding:'utf8',timeout:20000});
        assert.equal(r.status,0);
        const cert=fs.readFileSync(path.join(dir,'leaf.pem')),key=fs.readFileSync(path.join(dir,'leaf.key'));
        const fingerprint=crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('hex');
        server=https.createServer({cert,key},(_q,res)=>res.end('test'));
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
        const base={host:'127.0.0.1',port:server.address().port,ca:cert,expectedIp:'127.0.0.1',expectedCertSha256:fingerprint};
        await tlsProbe(base);
        await assert.rejects(tlsProbe({...base,ca:[]}));
        await assert.rejects(tlsProbe({...base,expectedIp:'192.0.2.2'}));
        await assert.rejects(tlsProbe({...base,expectedCertSha256:'0'.repeat(64)}));
    } finally {
        if(server) await new Promise(resolve=>server.close(resolve));
        for(const name of ['leaf.key','leaf.pem']) {try{fs.unlinkSync(path.join(dir,name));}catch(e){if(e.code!=='ENOENT')throw e;}}
        fs.rmdirSync(dir);
    }
});
