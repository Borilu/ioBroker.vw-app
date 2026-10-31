'use strict';
const tls=require('node:tls');
const crypto=require('node:crypto');

// This probes a single synthetic loopback service. It does not guarantee a
// different browser connection negotiates the same ALPN.
function probeNoH2({host,port,ca,expectedIp,expectedCertSha256}) {
    return new Promise((resolve,reject)=>{
        let done=false;
        const finish=(error,value)=>{
            if(done)return;
            done=true;socket.destroy();
            error?reject(Object.assign(new Error(error),{code:error})):resolve(value);
        };
        const socket=tls.connect({host,port,ca,rejectUnauthorized:true,ALPNProtocols:['h2','http/1.1'],
            checkServerIdentity:(_host,cert)=>{
                const error=tls.checkServerIdentity(expectedIp,cert);
                if(error)return error;
                if(!cert.raw||crypto.createHash('sha256').update(cert.raw).digest('hex')!==expectedCertSha256)
                    return Error('pin mismatch');
            }},()=>{
                if(socket.alpnProtocol==='h2')return finish('h2_negotiated');
                if(socket.alpnProtocol!==false&&socket.alpnProtocol!=='http/1.1')return finish('unexpected_alpn');
                finish(null,socket.alpnProtocol||'implicit-http1');
            });
        socket.setTimeout(5000,()=>finish('timeout'));
        socket.once('error',()=>finish('tls_failed'));
    });
}
module.exports={probeNoH2};
