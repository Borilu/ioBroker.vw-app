'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { discoverGuardianPort } = require('../lib/guardian-port');

// Deliberately synthetic fixtures, never real pairing material.
const SECRET = 'ab'.repeat(32);
const NONCE = '12'.repeat(16);
const SERVER_NONCE = '34'.repeat(16);
function sign(text, secret = SECRET) {
    return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(text, 'ascii').digest('hex');
}
function challenge(nonce = NONCE, serverNonce = SERVER_NONCE, secret = SECRET) {
    return `VWAG2 C ${nonce} ${serverNonce} ${sign(`vwapp.guardian.challenge.v2\n${nonce}\n${serverNonce}`, secret)}`;
}
function ack(nonce = NONCE, serverNonce = SERVER_NONCE) {
    return `VWAG2 A ${nonce} ${serverNonce} ${sign(`vwapp.guardian.ack.v2\n${nonce}\n${serverNonce}`)}`;
}
function reply(nonce, serverNonce, port, secret = SECRET) {
    return `VWAG2 R ${nonce} ${serverNonce} ${port} ${sign(`vwapp.guardian.reply.v2\n${nonce}\n${serverNonce}\n${port}`, secret)}`;
}
async function server(t, onMessage) {
    const socket = dgram.createSocket('udp4');
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
    t.after(() => { try { socket.close(); } catch (_) { /* Already closed. */ } });
    socket.on('message', (data, remote) => onMessage(socket, data, remote));
    return socket;
}
const opts = port => ({ port, getSecret: () => SECRET, timeoutMs: 250, randomBytes: () => Buffer.from(NONCE, 'hex') });

test('synthetic cross-platform VWAG2 HMAC vectors use literal line feeds and no trailing newline', () => {
    assert.equal(sign(`vwapp.guardian.query.v2\n${NONCE}`), '2a8e73c769529d27b3ad38e8cfa51c1808d58b20a91a1f614b28e76bffaa965c');
    assert.equal(sign(`vwapp.guardian.challenge.v2\n${NONCE}\n${SERVER_NONCE}`), '1f1a808d2491f25cd03b391d5e30eb9f65c43729277fe749b360253b8d1e8f65');
    assert.equal(sign(`vwapp.guardian.ack.v2\n${NONCE}\n${SERVER_NONCE}`), '302ad6c7ab17720aedfccc02ae022fe1b34c0dbc6964c948e5e5288da0c54af3');
    assert.equal(sign(`vwapp.guardian.reply.v2\n${NONCE}\n${SERVER_NONCE}\n49122`), '25c76d5514c747a9a1f1de5c5bc671f3068a7a6560d17f2e5b84f6ffb23290b6');
});

test('the guardian request is authenticated and only the matching signed fresh port is accepted', async t => {
    let queries = 0, acknowledgements = 0;
    const socket = await server(t, (s, data, remote) => {
        if (data.toString().startsWith('VWAG2 Q ')) {
            queries++;
            assert.equal(data.toString(), `VWAG2 Q ${NONCE} ${sign(`vwapp.guardian.query.v2\n${NONCE}`)}`);
            s.send(Buffer.from(reply(NONCE, SERVER_NONCE, 49122)), remote.port, remote.address); // No challenge yet.
            s.send(Buffer.from(challenge(NONCE, SERVER_NONCE, 'cd'.repeat(32))), remote.port, remote.address);
            s.send(Buffer.from(challenge()), remote.port, remote.address);
        } else {
            acknowledgements++;
            assert.equal(data.toString(), ack());
            s.send(Buffer.from(reply('56'.repeat(16), SERVER_NONCE, 49122)), remote.port, remote.address);
            s.send(Buffer.from(reply(NONCE, '56'.repeat(16), 49122)), remote.port, remote.address);
            s.send(Buffer.from(reply(NONCE, SERVER_NONCE, 49122, 'cd'.repeat(32))), remote.port, remote.address);
            s.send(Buffer.from(reply(NONCE, SERVER_NONCE, 49122)), remote.port, remote.address);
        }
    });
    assert.equal(await discoverGuardianPort('127.0.0.1', opts(socket.address().port)), 49122);
    assert.equal(queries, 1); assert.equal(acknowledgements, 1);
});

test('only the configured source port can answer, even when another sender has a valid synthetic MAC', async t => {
    const attacker = await server(t, () => {});
    const socket = await server(t, (_s, _data, remote) => {
        attacker.send(Buffer.from(challenge()), remote.port, remote.address);
    });
    assert.equal(await discoverGuardianPort('127.0.0.1', opts(socket.address().port)), null);
});

test('a valid response claiming a different source IP is never accepted', async () => {
    const fakeSocket = new EventEmitter();
    fakeSocket.close = () => {};
    fakeSocket.send = (_request, port, _host, callback) => {
        callback();
        setImmediate(() => fakeSocket.emit('message', Buffer.from(challenge()), { address: '127.0.0.2', port }));
    };
    assert.equal(await discoverGuardianPort('127.0.0.1', { ...opts(37457), timeoutMs: 100,
        createSocket: () => fakeSocket }), null);
});

test('invalid, stale, malformed, out-of-range, non-ASCII and oversized responses do not select a port', async t => {
    const socket = await server(t, (s, data, remote) => {
        if (data.toString().startsWith('VWAG2 Q ')) {
            const messages = [challenge('56'.repeat(16)), challenge(NONCE, SERVER_NONCE, 'cd'.repeat(32)),
                challenge().replace('VWAG2', 'VWAG1'), 'X'.repeat(193),
                Buffer.from([0xd6, ...Buffer.from(challenge().slice(1))]), challenge()];
            for (const message of messages) s.send(Buffer.from(message), remote.port, remote.address);
        } else {
            for (const message of [reply('56'.repeat(16), SERVER_NONCE, 49122), reply(NONCE, SERVER_NONCE, 65536),
                reply(NONCE, SERVER_NONCE, '0491'), reply(NONCE, SERVER_NONCE, 49122, 'cd'.repeat(32))]) {
                s.send(Buffer.from(message), remote.port, remote.address);
            }
        }
    });
    assert.equal(await discoverGuardianPort('127.0.0.1', opts(socket.address().port)), null);
});

test('missing or invalid secrets and invalid endpoints do not start network activity', async () => {
    let sends = 0;
    const options = { ...opts(37457), createSocket: () => { sends++; throw new Error(); } };
    for (const secret of ['', 'A'.repeat(64), 'f'.repeat(63), null, 42]) {
        assert.equal(await discoverGuardianPort('127.0.0.1', { ...options, getSecret: () => secret }), null);
    }
    assert.equal(await discoverGuardianPort('example.org', options), null);
    assert.equal(await discoverGuardianPort('127.0.0.1', { ...options, port: 0 }), null);
    assert.equal(sends, 0);
});

test('abort and handoff stop a pending request without any selected port', async t => {
    const socket = await server(t, () => {});
    const abort = new AbortController();
    const pending = discoverGuardianPort('127.0.0.1', { ...opts(socket.address().port), signal: abort.signal });
    abort.abort();
    await assert.rejects(pending, error => error.code === 'cancelled');
    let stopped = false;
    const handoff = discoverGuardianPort('127.0.0.1', { ...opts(socket.address().port), check() {
        if (stopped) { const error = new Error('Handoff'); error.code = 'cancelled'; throw error; }
    } });
    stopped = true;
    await assert.rejects(handoff, error => error.code === 'cancelled');
});
