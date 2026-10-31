'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { discoverUnicast, discoverMulticast, parseRecords, resolveRecords, query } = require('../lib/mdns-unicast');
const { BridgeError } = require('../lib/errors');

const HOST = '192.0.2.14', ID = 0x1234, PORT = 49876;
function name(labels) { return Buffer.concat([...labels.map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]); }
function ptr(offset) { return Buffer.from([0xc0 | (offset >> 8), offset & 255]); }
function record(owner, type, data, ttl = 120) {
    const head = Buffer.alloc(10); head.writeUInt16BE(type, 0); head.writeUInt16BE(0x8001, 2);
    head.writeUInt32BE(ttl, 4); head.writeUInt16BE(data.length, 8);
    return Buffer.concat([owner, head, data]);
}
function response({ ttl = 120, ip = [192, 0, 2, 14], port = PORT, otherPort = 0, service = '_adb-tls-connect',
    instanceLabel = 'adb-test', hostname = 'phone', id = ID } = {}) {
    const header = Buffer.alloc(12); header.writeUInt16BE(id, 0); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(otherPort ? 4 : 3, 6);
    const serviceName = name([service, '_tcp', 'local']);
    const instanceOffset = 12 + serviceName.length + 10;
    const instance = Buffer.concat([Buffer.from([Buffer.byteLength(instanceLabel)]), Buffer.from(instanceLabel), ptr(12)]);
    const ptrRecord = record(serviceName, 12, instance, ttl);
    const hostName = name([hostname, 'local']);
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

test('identical records are accepted, but distinct chains with the same port are ambiguous', () => {
    const first = parseRecords(response(), ID);
    assert.equal(resolveRecords(first.concat(first), HOST), PORT);
    assert.equal(resolveRecords(first.concat(parseRecords(response({ instanceLabel: 'adb-other' }), ID)), HOST), null);
    assert.equal(resolveRecords(first.concat(parseRecords(response({ hostname: 'other' }), ID)), HOST), null);
    assert.equal(resolveRecords(first.concat(parseRecords(response({ ttl: 0 }), ID)), HOST), null);
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
        [[[response(), source()], [response({ otherPort: 49877 }), source()]], undefined],
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
    for (const [count, expected] of [[32, PORT], [33, undefined]]) {
        const packets = Array.from({ length: count }, () => [response(), source()]);
        const socket = socketFor(packets, []);
        const result = await discoverUnicast(HOST, { timeoutMs: 10, id: ID, createSocket: () => socket });
        assert.equal(result, expected);
        assert.equal(socket.closed, true);
    }
});

test('an excessive number of records in directed discovery is an unsafe ambiguous result', async () => {
    const four = response({ otherPort: 49877 });
    const header = Buffer.from(four.subarray(0, 12)); header.writeUInt16BE(12, 6);
    const many = Buffer.concat([header, four.subarray(12), four.subarray(12), four.subarray(12)]);
    assert.equal(parseRecords(many, ID).length, 12);
    const socket = socketFor(Array.from({ length: 11 }, () => [many, source()]), []);
    assert.equal(await discoverUnicast(HOST, { timeoutMs: 25, id: ID, createSocket: () => socket }), undefined);
    assert.equal(socket.closed, true);
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

function multicastSockets(packets = [], { holdRoute = false, failJoin = false } = {}) {
    const steps = [], sent = [];
    class Route extends EventEmitter {
        connect(port, host, callback) { steps.push(['route', host, port]); if (!holdRoute) queueMicrotask(callback); }
        address() { return { address: '192.0.2.1' }; }
        close() { this.closed = true; }
    }
    class Multicast extends EventEmitter {
        bind(port, host, callback) { steps.push(['bind', host, port]); queueMicrotask(callback); }
        addMembership(group, local) { if (failJoin) throw new Error('join failed'); steps.push(['join', group, local]); }
        setMulticastInterface(local) { steps.push(['interface', local]); }
        setMulticastTTL(ttl) { steps.push(['ttl', ttl]); }
        send(bytes, port, host, callback) {
            sent.push({ bytes: Buffer.from(bytes), port, host, sentAt: performance.now() }); callback(null);
            for (const [packet, source] of packets) this.emit('message', packet, source);
        }
        close() { this.closed = true; }
    }
    const route = new Route(), socket = new Multicast();
    return { route, socket, steps, sent, createSocket: options => options === 'udp4' ? route : socket };
}

test('multicast uses the configured phone route and filters responses by source, type and unique chain', async () => {
    const valid = response({ id: 0 });
    const samples = [
        [[[valid, source()]], PORT],
        [[[valid, source('192.0.2.15')]], null],
        [[[valid, source(HOST, 9999)]], null],
        [[[response(), source()]], null],
        [[[response({ id: 0, service: '_adb-tls-pairing' }), source()]], null],
        [[[response({ id: 0, ip: [192, 0, 2, 15] }), source()]], null],
        [[[valid, source()], [response({ id: 0, otherPort: 49877 }), source()]], null],
        [[[valid, source()], [response({ id: 0, instanceLabel: 'adb-other' }), source()]], null],
        [[[valid, source()], [response({ id: 0, ttl: 0 }), source()]], null],
        [[[Buffer.from([1, 2, 3]), source()], [valid, source()]], PORT],
    ];
    for (const [packets, expected] of samples) {
        const f = multicastSockets(packets);
        assert.equal(await discoverMulticast(HOST, { timeoutMs: 25, createSocket: f.createSocket }), expected);
        assert.equal(f.route.closed, true); assert.equal(f.socket.closed, true);
        assert.deepEqual(f.steps, [['route', HOST, 5353], ['bind', '0.0.0.0', 5353],
            ['join', '224.0.0.251', '192.0.2.1'], ['interface', '192.0.2.1'], ['ttl', 1]]);
        assert.equal(f.sent.length, 1); assert.equal(f.sent[0].host, '224.0.0.251'); assert.equal(f.sent[0].port, 5353);
        assert.deepEqual([...f.sent[0].bytes.subarray(-4)], [0, 12, 0, 1]);
    }
});

test('multicast expires short-lived records and allows only one bounded retry', async () => {
    let time = 0;
    const expired = multicastSockets([[response({ id: 0, ttl: 1 }), source()]]);
    assert.equal(await discoverMulticast(HOST, { timeoutMs: 25, createSocket: expired.createSocket,
        now: () => { time += 2000; return time; } }), null);
    const f = multicastSockets();
    assert.equal(await discoverMulticast(HOST, { timeoutMs: 1100, createSocket: f.createSocket }), null);
    assert.equal(f.sent.length, 2);
    assert.ok(f.sent[1].sentAt - f.sent[0].sentAt >= 990);
    assert.deepEqual([...f.sent[0].bytes.subarray(-4)], [0, 12, 0, 1]);
    assert.deepEqual([...f.sent[1].bytes.subarray(-4)], [0, 12, 0, 1]);
    assert.equal(f.socket.closed, true);
});

test('a complete multicast answer does not trigger a repeated question, but observation continues', async () => {
    const f = multicastSockets([[response({ id: 0 }), source()]]);
    assert.equal(await discoverMulticast(HOST, { timeoutMs: 1100, createSocket: f.createSocket }), PORT);
    assert.equal(f.sent.length, 1); assert.equal(f.socket.closed, true);
    const conflict = multicastSockets([[response({ id: 0 }), source()]]);
    const delayed = setTimeout(() => conflict.socket.emit('message', response({ id: 0, otherPort: 49877 }), source()), 1050);
    try {
        assert.equal(await discoverMulticast(HOST, { timeoutMs: 1200, createSocket: conflict.createSocket }), null);
        assert.equal(conflict.sent.length, 1);
    } finally { clearTimeout(delayed); }
});

test('multicast fails closed on excess responses, join errors, abort and handoff', async () => {
    const flood = multicastSockets(Array.from({ length: 33 }, () => [response({ id: 0 }), source()]));
    assert.equal(await discoverMulticast(HOST, { timeoutMs: 25, createSocket: flood.createSocket }), null);
    assert.equal(flood.socket.closed, true);
    const failed = multicastSockets([], { failJoin: true });
    assert.equal(await discoverMulticast(HOST, { timeoutMs: 25, createSocket: failed.createSocket }), null);
    assert.equal(failed.route.closed, true); assert.equal(failed.socket.closed, true); assert.equal(failed.sent.length, 0);
    const aborted = multicastSockets([], { holdRoute: true }), abort = new AbortController();
    const pending = discoverMulticast(HOST, { timeoutMs: 200, signal: abort.signal, createSocket: aborted.createSocket });
    abort.abort(); await assert.rejects(pending, error => error.code === 'cancelled');
    assert.equal(aborted.route.closed, true); assert.equal(aborted.sent.length, 0);
    let stopped = false;
    const handoff = multicastSockets([], { holdRoute: true });
    const waiting = discoverMulticast(HOST, { timeoutMs: 200, createSocket: handoff.createSocket,
        check: () => { if (stopped) throw new BridgeError('cancelled', 'Handoff'); } });
    stopped = true; await assert.rejects(waiting, error => error.code === 'cancelled');
    assert.equal(handoff.route.closed, true); assert.equal(handoff.sent.length, 0);
});
