'use strict';
// An accident-prevention check, not an attestation against a malicious Docker host.
function isolatedCi(s) {
    return s && s.githubActions==='true' && s.mode==='synthetic' && s.docker===true
        && /^\d{1,20}$/.test(s.runId||'') && s.hostname==='vwci-'+s.runId
        && /^[a-f0-9]{32}$/.test(s.marker||'') && Number.isInteger(s.uid) && s.uid>0
        && s.platform==='linux' && Array.isArray(s.interfaces) && s.interfaces.length>0
        && s.interfaces.every(x=>x && x.internal===true);
}
module.exports={isolatedCi};
