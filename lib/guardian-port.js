'use strict';

// Optional, authenticated query to the configured phone. The response is a
// candidate only: ADB pairing and the saved phone identity still decide use.
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const net = require('node:net');
const { BridgeError } = require('./errors');

function mac(secret, text) {
    return crypto.createHmac('sha256', secret).update(text, 'ascii').digest();
}

async function discoverGuardianPort(host, { port, getSecret, timeoutMs = 17000, signal,
    check = () => {}, createSocket = dgram.createSocket, randomBytes = crypto.randomBytes } = {}) {
    if (net.isIP(host) !== 4 || !Number.isInteger(port) || port < 1 || port > 65535 ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 17000 || typeof getSecret !== 'function') return null;
    check();
    let value;
    try { value = getSecret(); } catch (_) { return null; }
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return null;
    const key = Buffer.from(value, 'hex');
    value = null;
    let nonce;
    try { nonce = randomBytes(16).toString('hex'); } catch (_) { key.fill(0); return null; }
    if (!/^[a-f0-9]{32}$/.test(nonce)) { key.fill(0); return null; }
    const request = Buffer.from(`VWAG2 Q ${nonce} ${mac(key, `vwapp.guardian.query.v2\n${nonce}`).toString('hex')}`, 'ascii');
    return new Promise((resolve, reject) => {
        let socket, timer, interval, done = false, packets = 0, guardianNonce = null;
        const finish = (result, error) => {
            if (done) return;
            done = true; clearTimeout(timer); clearInterval(interval);
            signal?.removeEventListener('abort', onAbort);
            try { socket?.close(); } catch (_) { /* Not bound or already closed. */ }
            key.fill(0); request.fill(0);
            if (error) reject(error); else resolve(result);
        };
        const checkNow = () => { try { check(); } catch (error) { finish(null, error); } };
        const onAbort = () => { try { check(); finish(null, new BridgeError('cancelled', 'The adapter is stopping.')); } catch (error) { finish(null, error); } };
        try {
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) return onAbort();
            socket = createSocket('udp4');
            socket.on('error', () => finish(null));
            socket.on('message', (data, remote) => {
                if (done || remote.address !== host || remote.port !== port) return;
                if (++packets > 32) return finish(null);
                if (!Buffer.isBuffer(data) || data.length > 192 || data.length < 1 || data.some(byte => byte > 127)) return;
                const text = data.toString('ascii');
                const challenge = /^VWAG2 C ([a-f0-9]{32}) ([a-f0-9]{32}) ([a-f0-9]{64})$/.exec(text);
                if (!guardianNonce && challenge && challenge[1] === nonce) {
                    const supplied = Buffer.from(challenge[3], 'hex');
                    const expected = mac(key, `vwapp.guardian.challenge.v2\n${nonce}\n${challenge[2]}`);
                    const valid = crypto.timingSafeEqual(supplied, expected);
                    supplied.fill(0); expected.fill(0);
                    if (!valid) return;
                    checkNow(); if (done) return;
                    guardianNonce = challenge[2];
                    const ack = Buffer.from(`VWAG2 A ${nonce} ${guardianNonce} ${mac(key, `vwapp.guardian.ack.v2\n${nonce}\n${guardianNonce}`).toString('hex')}`, 'ascii');
                    try { socket.send(ack, port, host, error => { ack.fill(0); if (error) finish(null); }); }
                    catch (_) { ack.fill(0); finish(null); }
                    return;
                }
                if (!guardianNonce) return;
                const match = /^VWAG2 R ([a-f0-9]{32}) ([a-f0-9]{32}) ([1-9][0-9]{0,4}) ([a-f0-9]{64})$/.exec(text);
                if (!match || match[1] !== nonce || match[2] !== guardianNonce) return;
                const found = Number(match[3]);
                if (!Number.isInteger(found) || found < 1 || found > 65535) return;
                const supplied = Buffer.from(match[4], 'hex');
                const expected = mac(key, `vwapp.guardian.reply.v2\n${nonce}\n${guardianNonce}\n${match[3]}`);
                const valid = crypto.timingSafeEqual(supplied, expected);
                supplied.fill(0); expected.fill(0);
                if (valid) { checkNow(); if (!done) finish(found); }
            });
            timer = setTimeout(() => { checkNow(); if (!done) finish(null); }, timeoutMs);
            interval = setInterval(checkNow, Math.min(50, timeoutMs));
            socket.send(request, port, host, error => { if (error) finish(null); });
        } catch (_) { finish(null); }
    });
}

module.exports = { discoverGuardianPort };
