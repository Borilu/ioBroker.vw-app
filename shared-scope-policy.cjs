'use strict';
const crypto=require('node:crypto'),net=require('node:net');
function parseSharedScope(bytes,hash,scopePath,uid){
    const fail=()=>{throw Object.assign(new Error('scope_invalid'),{code:'scope_invalid'});};
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>8192||!/^[a-f0-9]{64}$/.test(hash)
        ||crypto.createHash('sha256').update(bytes).digest('hex')!==hash)fail();
    let x;try{x=JSON.parse(bytes.toString('utf8'));}catch{fail();}
    const fields=['id','owner','instance','previousInstance','port','expectedIp','serverCertSha256',
        'ownerUid','serviceUid','serviceGid','base','dir','ownerBase','publicPath','privatePath'];
    if(!x||Array.isArray(x)||typeof x!=='object'||Object.keys(x).length!==fields.length
        ||fields.some(k=>!Object.hasOwn(x,k))||!/^[a-f0-9]{32}$/.test(x.id)||!/^[a-f0-9]{32}$/.test(x.owner)
        ||x.id===x.owner||!Number.isInteger(x.instance)||x.instance<1||x.instance>999
        ||!Number.isInteger(x.previousInstance)||x.previousInstance<1||x.previousInstance>999
        ||x.instance===x.previousInstance||!Number.isInteger(x.port)||x.port<1024||x.port>65535
        ||net.isIP(x.expectedIp)!==4||!/^[a-f0-9]{64}$/.test(x.serverCertSha256)
        ||!Number.isInteger(x.ownerUid)||x.ownerUid!==uid||!Number.isInteger(x.serviceUid)||x.serviceUid<1
        ||!Number.isInteger(x.serviceGid)||x.serviceGid<1)fail();
    const oct=x.expectedIp.split('.').map(Number);
    if(!(oct[0]===10||(oct[0]===172&&oct[1]>=16&&oct[1]<=31)||(oct[0]===192&&oct[1]===168)))fail();
    const ci=/^\/tmp\/vw-admin-https-ci-[A-Za-z0-9]+$/.test(x.base)
        &&/^\/tmp\/vw-admin-https-ci-[A-Za-z0-9]+$/.test(x.ownerBase);
    const pilot=x.base==='/tmp/vw-admin-https-pilot-'+x.id&&x.ownerBase==='/tmp/vw-admin-https-pilot-'+x.owner;
    if(!(ci||pilot)||x.base===x.ownerBase||x.dir!==(ci?x.base:x.base+'/journal')
        ||scopePath!==x.dir+'/pilot-scope.json'
        ||x.publicPath!==(ci?x.ownerBase+'/synthetic.pem':x.ownerBase+'/server.pem')
        ||x.privatePath!==(ci?x.ownerBase+'/synthetic.key':x.ownerBase+'/server.key'))fail();
    return Object.freeze(x);
}
module.exports={parseSharedScope};
