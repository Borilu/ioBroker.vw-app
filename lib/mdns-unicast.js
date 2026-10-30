'use strict';

// A single directed DNS-SD query. This never scans or sends multicast traffic.
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const net = require('node:net');
const { BridgeError } = require('./errors');

const SERVICE_LABELS = ['_adb-tls-connect', '_tcp', 'local'];
const SERVICE_KEY = SERVICE_LABELS.map(label => Buffer.from(label).toString('hex')).join('.');
const MAX_PACKET = 16384;
const MAX_RECORDS = 128;

function query(id) {
    const labels = SERVICE_LABELS.flatMap(label => [Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)]);
    const header = Buffer.alloc(12); header.writeUInt16BE(id, 0); header.writeUInt16BE(1, 4);
    // PTR with the unicast-response bit; the request is sent to the phone's address only.
    return Buffer.concat([header, ...labels, Buffer.from([0, 0, 12, 0x80, 1])]);
}

function nameAt(data, start) {
    let position = start, next = null, wireLength = 1;
    const labels = [], seen = new Set();
    while (true) {
        if (position >= data.length || seen.has(position) || seen.size > 127) throw new Error('bad name');
        seen.add(position);
        const length = data[position];
        if ((length & 0xc0) === 0xc0) {
            if (position + 1 >= data.length) throw new Error('bad pointer');
            if (next === null) next = position + 2;
            const target = ((length & 0x3f) << 8) | data[position + 1];
            if (target >= position) throw new Error('forward pointer');
            position = target;
            continue;
        }
        if ((length & 0xc0) !== 0 || length > 63) throw new Error('bad label');
        position++;
        if (!length) return { key: labels.join('.'), next: next === null ? position : next };
        if (position + length > data.length || (wireLength += length + 1) > 255) throw new Error('bad length');
        // DNS labels compare case-insensitively. Represent each label separately,
        // avoiding collisions from literal dots or arbitrary bytes in a label.
        const value = Buffer.from(data.subarray(position, position + length));
        for (let i = 0; i < value.length; i++) if (value[i] >= 65 && value[i] <= 90) value[i] += 32;
        labels.push(value.toString('hex')); position += length;
    }
}

function parseRecords(data, id) {
    if (!Buffer.isBuffer(data) || data.length < 12 || data.length > MAX_PACKET || data.readUInt16BE(0) !== id) throw new Error('invalid packet');
    const flags = data.readUInt16BE(2);
    if (!(flags & 0x8000) || flags & 0x7a0f) throw new Error('invalid response'); // opcode, truncation, rcode
    const questions = data.readUInt16BE(4);
    const count = data.readUInt16BE(6) + data.readUInt16BE(8) + data.readUInt16BE(10);
    if (questions > 8 || count > MAX_RECORDS) throw new Error('too many records');
    let offset = 12;
    for (let i = 0; i < questions; i++) {
        offset = nameAt(data, offset).next;
        if (offset + 4 > data.length) throw new Error('short question');
        offset += 4;
    }
    const records = [];
    for (let i = 0; i < count; i++) {
        const owner = nameAt(data, offset); offset = owner.next;
        if (offset + 10 > data.length) throw new Error('short record');
        const type = data.readUInt16BE(offset), klass = data.readUInt16BE(offset + 2) & 0x7fff;
        const ttl = data.readUInt32BE(offset + 4), length = data.readUInt16BE(offset + 8);
        offset += 10;
        const end = offset + length;
        if (end > data.length) throw new Error('short data');
        if (klass === 1 && type === 12) {
            const target = nameAt(data, offset);
            if (target.next !== end) throw new Error('invalid ptr');
            records.push({ type, owner: owner.key, target: target.key, ttl });
        } else if (klass === 1 && type === 33) {
            if (length < 7) throw new Error('invalid srv');
            const port = data.readUInt16BE(offset + 4), target = nameAt(data, offset + 6);
            if (target.next !== end || !port) throw new Error('invalid srv');
            records.push({ type, owner: owner.key, target: target.key, port, ttl });
        } else if (klass === 1 && type === 1) {
            if (length !== 4) throw new Error('invalid address');
            records.push({ type, owner: owner.key, address: [...data.subarray(offset, end)].join('.'), ttl });
        }
        offset = end;
    }
    if (offset !== data.length) throw new Error('trailing bytes');
    return records;
}

function resolveRecords(records, host) {
    // TTL zero withdraws the matching record rather than becoming fresh data.
    const key = r => JSON.stringify([r.type, r.owner, r.target || '', r.port || 0, r.address || '']);
    const withdrawn = new Set(records.filter(r => !r.ttl).map(key));
    const usable = records.filter(r => r.ttl && !withdrawn.has(key(r)));
    const instances = new Set(usable.filter(r => r.type === 12 && r.owner === SERVICE_KEY).map(r => r.target));
    const addresses = new Set(usable.filter(r => r.type === 1 && r.address === host).map(r => r.owner));
    const ports = new Set(usable.filter(r => r.type === 33 && instances.has(r.owner) && addresses.has(r.target)).map(r => r.port));
    return ports.size === 1 ? [...ports][0] : null;
}

async function discoverUnicast(host, { timeoutMs = 800, signal, check = () => {}, createSocket = dgram.createSocket, id = crypto.randomInt(65536) } = {}) {
    if (net.isIP(host) !== 4 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return null;
    check();
    return new Promise((resolve, reject) => {
        let socket, timer, interval, done = false, packets = 0, records = [];
        const finish = (result, error) => {
            if (done) return;
            done = true; clearTimeout(timer); clearInterval(interval);
            signal?.removeEventListener('abort', onAbort);
            try { socket?.close(); } catch (_) { /* Socket may not have bound. */ }
            if (error) reject(error); else resolve(result);
        };
        const checkNow = () => { try { check(); } catch (error) { finish(null, error); } };
        const onAbort = () => { try { check(); finish(null, new BridgeError('cancelled', 'The adapter is stopping.')); } catch (error) { finish(null, error); } };
        try {
            socket = createSocket('udp4');
            socket.on('error', () => finish(null));
            socket.on('message', (data, remote) => {
                if (done || remote.address !== host || remote.port !== 5353) return;
                if (++packets > 32) return finish(null);
                try {
                    const parsed = parseRecords(data, id);
                    if (records.length + parsed.length > MAX_RECORDS) return finish(null);
                    records = records.concat(parsed);
                } catch (_) { /* Ignore malformed and unrelated packets. */ }
            });
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) return onAbort();
            timer = setTimeout(() => { checkNow(); if (!done) finish(resolveRecords(records, host)); }, timeoutMs);
            interval = setInterval(checkNow, Math.min(50, timeoutMs));
            socket.send(query(id), 5353, host, error => { if (error) finish(null); });
        } catch (_) { finish(null); }
    });
}

module.exports = { discoverUnicast, parseRecords, resolveRecords, query };
