'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { discoverUnicast, parseRecords, resolveRecords, query } = require('../lib/mdns-unicast');
const { BridgeError } = require('../lib/errors');

const HOST = '192.0.2.14', ID = 0x1234, PORT = 49876;
function name(labels) { return Buffer.concat([...labels.map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]); }
function ptr(offset) { return Buffer.from([0xc0 | (offset >> 8), offset & 255]); }
function record(owner, type, data, ttl = 120) {
    const head = Buffer.alloc(10); head.writeUInt16BE(type, 0); head.writeUInt16BE(0x8001, 2);
    head.writeUInt32BE(ttl, 4); head.writeUInt16BE(data.length, 8);
    return Buffer.concat([owner, head, data]);
}
function response({ ttl = 120, ip = [192, 0, 2, 14], port = PORT, otherPort = 0, service = '_adb-tls-connect', id = ID } = {}) {
    const header = Buffer.alloc(12); header.writeUInt16BE(id, 0); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(otherPort ? 4 : 3, 6);
    const serviceName = name([service, '_tcp', 'local']);
    const instanceOffset = 12 + serviceName.length + 10;
    const instance = Buffer.concat([Buffer.from([8]), Buffer.from('adb-test'), ptr(12)]);
    const ptrRecord = record(serviceName, 12, instance, ttl);
    const hostName = name(['phone', 'local']);
    const srvHeader = Buffer.alloc(6); srvHeader.writeUInt16BE(port, 4);
    const targetOffset = 12 + ptrRecord.length + 2 + 10 + 6;
    const srvRecord = record(ptr(instanceOffset), 33, Buffer.concat([srvHeader, hostName]), ttl);
    const addressRecord = record(ptr(targetOffset), 1, Buffer.from(ip), ttl);
    const extraHeader = Buffer.alloc(6); extraHeader.writeUInt16BE(otherPort, 4);
    const extra = otherPort ? record(ptr(instanceOffset), 33, Buffer.concat([extraHeader, ptr(targetOffset)]), ttl) : Buffer.alloc(0);
    return Buffer.concat([header, ptrRecord, srvRecord, addressRecord, extra]);
}

test('query uses a single unicast-response PTR question', () => {
    const q = query(ID);
    assert.equal(q.readUInt16BE(0), ID);
    assert.equal(q.readUInt16BE(4), 1);
    assert.deepEqual([...q.subarray(-4)], [0, 12, 0x80, 1]);
});

test('compressed PTR, SRV and A records must describe the specified IPv4 and a unique port', () => {
    assert.equal(resolveRecords(parseRecords(response(), ID), HOST), PORT);
    assert.equal(resolveRecords(parseRecords(response({ ttl: 0 }), ID), HOST), null);
    assert.equal(resolveRecords(parseRecords(response({ ip: [192, 0, 2, 15] }), ID), HOST), null);
    assert.equal(resolveRecords(parseRecords(response({ service: '_adb-tls-pairing' }), ID), HOST), null);
    assert.equal(resolveRecords(parseRecords(response({ otherPort: 49877 }), ID), HOST), null);
    assert.throws(() => parseRecords(response({ id: ID + 1 }), ID));
});

test('malformed, truncated, looping, excessive and non-response packets are rejected', () => {
    const loop = response(); loop[12] = 0xc0; loop[13] = 12;
    const truncatedFlag = response(); truncatedFlag.writeUInt16BE(0x8600, 2);
    const requestFlag = response(); requestFlag.writeUInt16BE(0, 2);
    const excessive = response(); excessive.writeUInt16BE(129, 6);
    const short = response().subarray(0, -1);
    const trailing = Buffer.concat([response(), Buffer.from([0])]);
    for (const data of [loop, truncatedFlag, requestFlag, excessive, short, trailing, Buffer.alloc(12), Buffer.alloc(16385)]) {
        assert.throws(() => parseRecords(data, ID));
    }
});

function socketFor(packets, sent) {
    class FakeSocket extends EventEmitter {
        send(bytes, port, host, callback) {
            sent.push({ bytes, port, host });
            callback(null);
            for (const [packet, source] of packets) this.emit('message', packet, source);
        }
        close() { this.closed = true; }
    }
    return new FakeSocket();
}
const source = (address = HOST, port = 5353) => ({ address, port });

test('directed discovery sends only to the configured address and rejects foreign sources', async () => {
    for (const [packets, expected] of [
        [[[response(), source()]], PORT],
        [[[response(), source('192.0.2.15')]], null],
        [[[response(), source(HOST, 9999)]], null],
        [[[response(), source()], [response({ otherPort: 49877 }), source()]], null],
        [[[Buffer.from([1, 2, 3]), source()], [response(), source()]], PORT],
    ]) {
        const sent = [], socket = socketFor(packets, sent);
        const value = await discoverUnicast(HOST, { timeoutMs: 10, id: ID, createSocket: () => socket });
        assert.equal(value, expected); assert.equal(socket.closed, true); assert.equal(sent.length, 1);
        assert.equal(sent[0].host, HOST); assert.equal(sent[0].port, 5353);
        assert.deepEqual(sent[0].bytes, query(ID));
    }
});

test('an excessive number of packets from the expected source fails closed', async () => {
    for (const [count, expected] of [[32, PORT], [33, null]]) {
        const packets = Array.from({ length: count }, () => [response(), source()]);
        const socket = socketFor(packets, []);
        const result = await discoverUnicast(HOST, { timeoutMs: 10, id: ID, createSocket: () => socket });
        assert.equal(result, expected);
        assert.equal(socket.closed, true);
    }
});

test('abort and handoff during the bounded wait close the socket promptly', async () => {
    const abort = new AbortController(), socket = socketFor([], []);
    const active = discoverUnicast(HOST, { timeoutMs: 200, id: ID, signal: abort.signal, createSocket: () => socket });
    abort.abort();
    await assert.rejects(active, error => error.code === 'cancelled');
    assert.equal(socket.closed, true);
    let stopped = false;
    const socket2 = socketFor([], []);
    const handoff = discoverUnicast(HOST, { timeoutMs: 200, id: ID, createSocket: () => socket2,
        check: () => { if (stopped) throw new BridgeError('cancelled', 'Handoff'); } });
    stopped = true;
    await assert.rejects(handoff, error => error.code === 'cancelled');
    assert.equal(socket2.closed, true);
    const socket3 = socketFor([], []);
    let expired = false;
    const deadline = discoverUnicast(HOST, { timeoutMs: 200, id: ID, createSocket: () => socket3,
        check: () => { if (expired) throw new BridgeError('phone_timeout', 'Expired'); } });
    expired = true;
    await assert.rejects(deadline, error => error.code === 'phone_timeout');
    assert.equal(socket3.closed, true);
});
