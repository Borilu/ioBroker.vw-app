'use strict';
// Experimental, read-only probe of ONE unauthenticated WebSocket operation.
// It is not a general proof that every admin/API/socket route is protected.
const crypto=require('node:crypto');
const tls=require('node:tls');

function probeSocket({WebSocket,host,port,ca,expectedIp,expectedCertSha256,instance,observeMs=1500,deadlineMs=8000}) {
    if(typeof WebSocket!=='function' || !Number.isInteger(port) || port<1 || port>65535
        || !Number.isInteger(instance) || instance<0 || !/^[a-f0-9]{64}$/.test(expectedCertSha256)
        || !Buffer.isBuffer(ca) || observeMs<500 || deadlineMs<observeMs+1000) {
        return Promise.reject(new Error('probe_configuration_invalid'));
    }
    return new Promise((resolve,reject)=>{
        const sid=crypto.randomBytes(16).toString('hex');
        let ws, ready=false,reauth=false,firstLive=false,secondLive=false,readReply=false,done=false,obsTimer;
        const finish=(err)=>{
            if(done)return; done=true; clearTimeout(deadline);clearTimeout(obsTimer);
            if(ws) {ws.removeAllListeners();ws.on('error',()=>{});ws.terminate();}
            if(err)reject(new Error(err));
            else resolve(readReply?'state_read_explicitly_denied':'unauthenticated_state_not_observed');
        };
        const deadline=setTimeout(()=>finish('socket_probe_uncertain'),deadlineMs);
        try {
            ws=new WebSocket('wss://'+host+':'+port+'/?sid='+sid,{
                ca,rejectUnauthorized:true,handshakeTimeout:5000,perMessageDeflate:false,maxPayload:4096,
                checkServerIdentity:(_host,cert)=>{
                    const error=tls.checkServerIdentity(expectedIp,cert);
                    if(error)return error;
                    if(!cert.raw || crypto.createHash('sha256').update(cert.raw).digest('hex')!==expectedCertSha256)
                        return new Error('certificate_pin_mismatch');
                },
            });
        } catch {finish('socket_connect_failed');return;}
        const send=(id,name,args)=>{
            try { ws.send(JSON.stringify([3,id,name,args])); }
            catch { finish('socket_transport_failed'); }
        };
        const begin=()=>{
            if(!ready || !reauth || firstLive || done)return;
            // Sent only after both explicit ready and reauthenticate; no token or personal data.
            firstLive='pending';
            send(101,'updateTokenExpiration',['']);
            send(102,'getState',['system.adapter.admin.'+instance+'.alive']);
        };
        ws.on('message',data=>{
            if(done)return;
            let m;try{m=JSON.parse(data.toString());}catch{finish('socket_response_invalid');return;}
            if(!Array.isArray(m)) {finish('socket_response_invalid');return;}
            if(m[0]===0 && m[2]==='reauthenticate') {reauth=true;begin();return;}
            if(m[0]===0 && m[2]==='___ready___') {ready=true;begin();return;}
            if(m[0]===0 && ['stateChange','objectChange'].includes(m[2])) {finish('unexpected_state_event');return;}
            if(m[0]!==3 || !Array.isArray(m[3]))return;
            if(m[1]===102 && m[2]==='getState') {
                readReply=true;
                if(m[3][0]!=='permissionError' || m[3].length!==1) {finish('unauthenticated_read_not_denied');return;}
            }
            if((m[1]===101 || m[1]===103) && m[2]==='updateTokenExpiration') {
                if(m[3][0]!=='No access token found' || m[3][1]!==false) {finish('socket_liveness_invalid');return;}
                if(m[1]===101) {
                    if(firstLive!=='pending'){finish('duplicate_socket_reply');return;}
                    firstLive=true;
                    obsTimer=setTimeout(()=>{if(!done)send(103,'updateTokenExpiration',['']);},observeMs);
                } else {
                    if(firstLive!==true || secondLive){finish('unexpected_socket_reply');return;}
                    secondLive=true;
                    // Explicit permissionError is strongest; silence is only bounded observation.
                    finish();
                }
            }
        });
        ws.on('close',()=>finish('socket_disconnected'));
        ws.on('error',()=>finish('socket_transport_failed'));
    });
}
module.exports={probeSocket};
