'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const https=require('node:https');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {probeSocket}=require('./auth-socket-probe.cjs');
const {readStateWithNoAuth}=require('./control-socket.cjs');
const openssl=process.env.OPENSSL_BIN;
const wsPath=process.env.WS_FIXTURE_PATH;
test('WebSocket probe: liveness, denial, disclosure and disconnect', {skip:!openssl||!wsPath},async()=>{
    const {WebSocket,WebSocketServer}=require(wsPath);
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vw-socket-ci-'));
    let httpsServer,wss,behavior='safe';
    try {
        const run=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.pem',
            '-days','1','-subj','/CN=Synthetic socket test','-addext','basicConstraints=critical,CA:FALSE',
            '-addext','keyUsage=critical,digitalSignature,keyEncipherment','-addext','extendedKeyUsage=serverAuth',
            '-addext','subjectAltName=IP:127.0.0.1'],{cwd:dir,timeout:20000,encoding:'utf8'});
        assert.equal(run.status,0);
        const cert=fs.readFileSync(path.join(dir,'leaf.pem')),key=fs.readFileSync(path.join(dir,'leaf.key'));
        const pin=crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('hex');
        httpsServer=https.createServer({cert,key});
        wss=new WebSocketServer({server:httpsServer,perMessageDeflate:false});
        wss.on('connection',sock=>{
            if(behavior!=='control')sock.send(JSON.stringify([0,401,'reauthenticate']));
            sock.send(JSON.stringify([0,1,'___ready___']));
            sock.on('message',data=>{
                const m=JSON.parse(data.toString());
                if(behavior==='disconnect') {sock.terminate();return;}
                if(m[2]==='updateTokenExpiration') sock.send(JSON.stringify([3,m[1],m[2],['No access token found',false]]));
                if(m[2]==='getState' && behavior==='unsafe') sock.send(JSON.stringify([3,m[1],m[2],[null,{val:true}]]));
                if(m[2]==='getState' && behavior==='control') sock.send(JSON.stringify([3,m[1],m[2],[null,{val:true}]]));
                if(m[2]==='getState' && behavior==='denied') sock.send(JSON.stringify([3,m[1],m[2],['permissionError']]));
            });
        });
        await new Promise((resolve,reject)=>{httpsServer.once('error',reject);httpsServer.listen(0,'127.0.0.1',resolve);});
        const options={WebSocket,host:'127.0.0.1',port:httpsServer.address().port,ca:cert,expectedIp:'127.0.0.1',
            expectedCertSha256:pin,instance:17,observeMs:500,deadlineMs:4000};
        assert.equal(await probeSocket(options),'unauthenticated_state_not_observed');
        behavior='denied'; assert.equal(await probeSocket(options),'state_read_explicitly_denied');
        behavior='unsafe'; await assert.rejects(probeSocket(options),/unauthenticated_read_not_denied/);
        behavior='disconnect'; await assert.rejects(probeSocket(options),/socket_disconnected|socket_transport_failed/);
        behavior='safe'; await assert.rejects(probeSocket({...options,expectedCertSha256:'0'.repeat(64)}),/socket_transport_failed/);
        await assert.rejects(readStateWithNoAuth(options),/control_unexpected_auth/);
        behavior='control'; await readStateWithNoAuth(options);
    } finally {
        if(wss) await new Promise(resolve=>wss.close(resolve));
        if(httpsServer) await new Promise(resolve=>httpsServer.close(resolve));
        for(const name of ['leaf.key','leaf.pem']) {try{fs.unlinkSync(path.join(dir,name));}catch(e){if(e.code!=='ENOENT')throw e;}}
        fs.rmdirSync(dir);
    }
});
