'use strict';
// CI ONLY: verify that a deliberately unprotected, synthetic admin socket
// can read its own synthetic alive state. Never use this probe on live ioBroker.
const crypto=require('node:crypto');
const tls=require('node:tls');
function readStateWithNoAuth({WebSocket,host,port,ca,expectedIp,expectedCertSha256,instance,deadlineMs=8000}) {
    return new Promise((resolve,reject)=>{
        let ws,done=false;
        const timer=setTimeout(()=>finish('control_timeout'),deadlineMs);
        function finish(err) {
            if(done)return;done=true;clearTimeout(timer);
            if(ws){ws.removeAllListeners();ws.on('error',()=>{});ws.terminate();}
            if(err)reject(new Error(err)); else resolve();
        }
        ws=new WebSocket('wss://'+host+':'+port+'/?sid='+crypto.randomBytes(16).toString('hex'),{
            ca,rejectUnauthorized:true,handshakeTimeout:5000,perMessageDeflate:false,maxPayload:4096,
            checkServerIdentity:(_h,cert)=>{
                const err=tls.checkServerIdentity(expectedIp,cert);
                if(err)return err;
                if(!cert.raw||crypto.createHash('sha256').update(cert.raw).digest('hex')!==expectedCertSha256)
                    return new Error('certificate_pin_mismatch');
            },
        });
        ws.on('message',data=>{
            let m;try{m=JSON.parse(data.toString());}catch{finish('control_invalid');return;}
            if(!Array.isArray(m)){finish('control_invalid');return;}
            if(m[0]===0 && m[2]==='reauthenticate'){finish('control_unexpected_auth');return;}
            if(m[0]===0 && m[2]==='___ready___') {
                try {ws.send(JSON.stringify([3,201,'getState',['system.adapter.admin.'+instance+'.alive']]));}
                catch {finish('control_transport_failed');}
            }
            if(m[0]===3 && m[1]===201 && m[2]==='getState') {
                if(Array.isArray(m[3]) && m[3][0]===null && typeof m[3][1]?.val==='boolean')finish();
                else finish('control_read_not_verified');
            }
        });
        ws.on('close',()=>finish('control_disconnected'));
        ws.on('error',()=>finish('control_transport_failed'));
    });
}
module.exports={readStateWithNoAuth};
