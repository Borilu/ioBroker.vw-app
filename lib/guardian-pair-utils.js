'use strict';
const net = require('node:net');
const dgram = require('node:dgram');

function failure() { return new Error('Guardian pairing failed or outcome is uncertain. Check both sides before retrying.'); }
function privateIp(ip) {
    if (net.isIP(ip) !== 4) return false;
    const a = ip.split('.').map(Number);
    return a[0] === 10 || a[0] === 172 && a[1] >= 16 && a[1] <= 31 || a[0] === 192 && a[1] === 168;
}
function parsePackagePath(output) {
    const lines = String(output).trim().split(/\r?\n/);
    if (lines.length !== 1) throw failure();
    const m = /^package:(\/data\/app\/[A-Za-z0-9_.~+=\/-]+\/base\.apk)$/.exec(lines[0]);
    if (!m || m[1].includes('..')) throw failure();
    return m[1];
}
function parseHash(output) {
    const m = /^([a-f0-9]{64})\s+\/data\/app\/[A-Za-z0-9_.~+=\/-]+\/base\.apk\s*$/.exec(String(output));
    if (!m) throw failure();
    return m[1];
}
async function resolveVmIp(phoneIp, { createSocket = dgram.createSocket, timeoutMs = 2000 } = {}) {
    if (!privateIp(phoneIp) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw failure();
    return new Promise((resolve, reject) => {
        let socket, timer, done = false;
        const finish = ip => {
            if (done) return; done = true; clearTimeout(timer);
            try { socket?.close(); } catch (_) { /* Already closed. */ }
            if (!privateIp(ip)) reject(failure()); else resolve(ip);
        };
        try {
            socket = createSocket('udp4'); socket.on('error', () => finish(null));
            timer = setTimeout(() => finish(null), timeoutMs);
            // Route lookup: connecting this UDP socket does not send a packet.
            socket.connect(37457, phoneIp, () => { try { finish(socket.address().address); } catch (_) { finish(null); } });
        } catch (_) { finish(null); }
    });
}
module.exports = { privateIp, parsePackagePath, parseHash, resolveVmIp };
