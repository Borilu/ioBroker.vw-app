'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tls=require('node:tls'),https=require('node:https');
const {spawnSync}=require('node:child_process');
const {probeNoH2}=require('./alpn-probe.cjs');
test('ALPN probe accepts HTTPS with HTTP/1.1 and rejects h2, wrong pin and wrong identity',
    {skip:!process.env.OPENSSL_BIN},async()=>{
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vw-alpn-synthetic-'));
        let http1,h2;
        try{
            const command=spawnSync(process.env.OPENSSL_BIN,['req','-x509','-newkey','rsa:2048','-nodes',
                '-keyout','key.pem','-out','cert.pem','-days','1','-subj','/CN=Synthetic ALPN',
                '-addext','basicConstraints=critical,CA:FALSE','-addext','subjectAltName=IP:127.0.0.1'],
                {cwd:dir,encoding:'utf8',timeout:20000});
            assert.equal(command.status,0);
            const cert=fs.readFileSync(path.join(dir,'cert.pem')),key=fs.readFileSync(path.join(dir,'key.pem'));
            const pin=crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('hex');
            const listen=server=>new Promise((resolve,reject)=>{
                server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
            });
            http1=https.createServer({key,cert},(_req,res)=>res.end('synthetic'));
            await listen(http1);
            const opts={host:'127.0.0.1',port:http1.address().port,ca:cert,
                expectedIp:'127.0.0.1',expectedCertSha256:pin};
            assert.ok(['http/1.1','implicit-http1'].includes(await probeNoH2(opts)));
            await assert.rejects(probeNoH2({...opts,expectedIp:'192.0.2.1'}),{code:'tls_failed'});
            await assert.rejects(probeNoH2({...opts,expectedCertSha256:'0'.repeat(64)}),{code:'tls_failed'});
            h2=tls.createServer({key,cert,ALPNProtocols:['h2','http/1.1']},socket=>socket.end());
            await listen(h2);
            await assert.rejects(probeNoH2({...opts,port:h2.address().port}),{code:'h2_negotiated'});
        }finally{
            if(http1)await new Promise(resolve=>http1.close(resolve));
            if(h2)await new Promise(resolve=>h2.close(resolve));
            for(const name of ['cert.pem','key.pem'])try{fs.unlinkSync(path.join(dir,name));}catch(e){if(e.code!=='ENOENT')throw e;}
            fs.rmdirSync(dir);
        }
    });
