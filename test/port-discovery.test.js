'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Phone } = require('../lib/phone');
const { BridgeError } = require('../lib/errors');

const OLD = '192.0.2.14:37123';
const NEW = '192.0.2.14:49876';
const ID = 'serial:TEST-DEVICE';
const service = (address = NEW, type = '_adb-tls-connect._tcp') => `adb-PRIVATE-SERIAL-ABC ${type} ${address}\n`;

function setup({ mdns = service(), serial = 'TEST-DEVICE', oldAvailable = false, candidateAvailable = true,
    deviceId = ID, endpoint = OLD, fallbackEndpoint = '', discoverPort = true, discoveryError, signal, unicastDiscovery = async () => null } = {}) {
    const calls = [], verified = [];
    const runtime = { async run(args, options) {
        calls.push({ args, options });
        if (args[0] === 'mdns') {
            if (discoveryError) throw discoveryError;
            return mdns;
        }
        if (args[0] === 'connect') return 'ok';
        if (args[2] === 'get-state') {
            return (args[1] === OLD ? oldAvailable : candidateAvailable) ? 'device\n' : 'offline\n';
        }
        if (args.slice(2).join(' ') === 'shell getprop ro.serialno') return serial + '\n';
        throw new Error('Unexpected command');
    } };
    const phone = new Phone({ runtime, endpoint, fallbackEndpoint, deviceId, discoverPort, signal, unicastDiscovery,
        onVerified: async (...args) => verified.push(args) });
    return { phone, calls, verified };
}
async function fails(promise, code) {
    await assert.rejects(promise, error => error instanceof BridgeError && error.code === code && !error.message.includes('PRIVATE'));
}
function noUi(calls) {
    assert.ok(!calls.some(call => call.args.includes('input') || call.args.includes('am')));
}

test('a reachable configured port is used without discovery', async () => {
    const f = setup({ oldAvailable: true });
    assert.deepEqual(await f.phone.connect(), { deviceId: ID });
    assert.deepEqual(f.verified, [[ID, OLD]]);
    assert.ok(!f.calls.some(call => call.args[0] === 'mdns'));
});

test('a new advertised port is accepted only after device identity is verified', async () => {
    const f = setup({});
    assert.deepEqual(await f.phone.connect(), { deviceId: ID });
    assert.equal(f.phone.endpoint, NEW);
    assert.deepEqual(f.verified, [[ID, NEW]]);
    assert.deepEqual(f.calls.map(call => call.args), [['connect', OLD], ['-s', OLD, 'get-state'], ['mdns', 'services'],
        ['connect', NEW], ['-s', NEW, 'get-state'], ['-s', NEW, 'shell', 'getprop', 'ro.serialno']]);
    assert.equal(f.calls[2].options.maxOutputBytes, 65536);
    noUi(f.calls);
});

test('directed discovery recovers an unlisted port but still requires the enrolled identity', async () => {
    let queries = 0;
    const unicastDiscovery = async (host, options) => {
        queries++; assert.equal(host, '192.0.2.14'); assert.ok(options.timeoutMs <= 800);
        options.check(); return 49876;
    };
    const f = setup({ mdns: '', unicastDiscovery });
    assert.deepEqual(await f.phone.connect(), { deviceId: ID });
    assert.equal(queries, 1); assert.deepEqual(f.verified, [[ID, NEW]]); noUi(f.calls);
    const wrong = setup({ mdns: '', unicastDiscovery, serial: 'OTHER-PHONE' });
    await fails(wrong.phone.connect(), 'wifi_wrong_device');
    assert.deepEqual(wrong.verified, []); noUi(wrong.calls);
});

test('an ambiguous ADB discovery result cannot be bypassed by directed discovery', async () => {
    let queries = 0;
    const f = setup({ mdns: service(NEW) + service('192.0.2.14:49877'),
        unicastDiscovery: async () => { queries++; return 49876; } });
    await fails(f.phone.connect(), 'wifi_unavailable');
    assert.equal(queries, 0); noUi(f.calls);
});

test('an unreachable cached port falls back to the configured port without mDNS', async () => {
    const f = setup({ endpoint: NEW, fallbackEndpoint: OLD, oldAvailable: true, candidateAvailable: false, mdns: '' });
    assert.deepEqual(await f.phone.connect(), { deviceId: ID });
    assert.equal(f.phone.endpoint, OLD);
    assert.deepEqual(f.verified, [[ID, OLD]]);
    assert.deepEqual(f.calls.map(call => call.args), [['connect', NEW], ['-s', NEW, 'get-state'],
        ['connect', OLD], ['-s', OLD, 'get-state'], ['-s', OLD, 'shell', 'getprop', 'ro.serialno']]);
    noUi(f.calls);
});

test('a wrong device on the configured fallback port cannot be bypassed with mDNS', async () => {
    const f = setup({ endpoint: NEW, fallbackEndpoint: OLD, oldAvailable: true, candidateAvailable: false, serial: 'OTHER-PHONE' });
    await fails(f.phone.connect(), 'wifi_wrong_device');
    assert.equal(f.phone.endpoint, NEW);
    assert.ok(!f.calls.some(call => call.args[0] === 'mdns'));
    assert.deepEqual(f.verified, []); noUi(f.calls);
});

test('a fallback cannot point at another IP', () => {
    assert.throws(() => setup({ fallbackEndpoint: '192.0.2.15:12345' }), error => error.code === 'invalid_wifi_endpoint');
});

test('handoff requested during connection stops before the next transport step', async () => {
    for (const stopAfter of ['connect', 'mdns']) {
        const f = setup({});
        const original = f.phone.runtime.run;
        let stop = false;
        f.phone.runtime.run = async (...args) => {
            const result = await original(...args);
            if (args[0][0] === stopAfter) stop = true;
            return result;
        };
        await fails(f.phone.connect({ checkpoint: () => { if (stop) throw new BridgeError('cancelled', 'Handoff'); } }), 'cancelled');
        if (stopAfter === 'connect') assert.deepEqual(f.calls.map(call => call.args), [['connect', OLD]]);
        else assert.deepEqual(f.calls.map(call => call.args), [['connect', OLD], ['-s', OLD, 'get-state'], ['mdns', 'services']]);
        assert.deepEqual(f.verified, []); noUi(f.calls);
        assert.equal(f.phone.connectionCheckpoint, null);
    }
});

test('a wrong device or missing identity cannot become verified or cause any app input', async () => {
    for (const [serial, code] of [['OTHER-PHONE', 'wifi_wrong_device'], ['unknown', 'wifi_identity_unavailable']]) {
        const f = setup({ serial });
        await fails(f.phone.connect(), code);
        assert.deepEqual(f.verified, []); assert.equal(f.phone.endpoint, OLD); noUi(f.calls);
    }
});

test('a wrong configured device is not bypassed by port discovery', async () => {
    const f = setup({ oldAvailable: true, serial: 'OTHER-PHONE' });
    await fails(f.phone.connect(), 'wifi_wrong_device');
    assert.ok(!f.calls.some(call => call.args[0] === 'mdns'));
    noUi(f.calls);
});

test('no unpinned or setup connection silently discovers another port', async () => {
    const unpinned = setup({ deviceId: '' });
    await fails(unpinned.phone.connect(), 'wifi_identity_required');
    assert.equal(unpinned.calls.length, 0);
    const probing = setup({ deviceId: '' });
    await fails(probing.phone.connect({ allowUnpinned: true }), 'wifi_unavailable');
    assert.ok(!probing.calls.some(call => call.args[0] === 'mdns'));
});

test('ambiguous, malformed, wrong host, pairing or unsupported mDNS reports do not connect', async () => {
    const reports = ['', service('192.0.2.15:49876'), service(NEW, '_adb-tls-pairing._tcp'),
        service('192.0.2.14:0'), service('192.0.2.14:049876'), service(NEW) + service('192.0.2.14:49877'),
        service(OLD), 'X'.repeat(65537), null];
    for (const mdns of reports) {
        const f = setup({ mdns });
        await fails(f.phone.connect(), 'wifi_unavailable');
        assert.equal(f.calls.filter(call => call.args[0] === 'connect').length, 1);
        assert.deepEqual(f.verified, []); noUi(f.calls);
    }
    const unsupported = setup({ discoveryError: new Error('PRIVATE') });
    await fails(unsupported.phone.connect(), 'wifi_unavailable');
    const ipv6 = setup({ endpoint: '[fd00::14]:1234' });
    ipv6.phone.endpoint = '[fd00::14]:1234';
    // Simulate the configured IPv6 endpoint being unavailable.
    ipv6.phone.connectEndpoint = async () => { throw new BridgeError('wifi_unavailable', 'Unavailable'); };
    await fails(ipv6.phone.connect(), 'wifi_unavailable');
    assert.equal(ipv6.calls.length, 0);
});

test('a non-ready discovered endpoint is not verified or retried', async () => {
    const f = setup({ candidateAvailable: false });
    await fails(f.phone.connect(), 'wifi_unavailable');
    assert.equal(f.calls.filter(call => call.args[0] === 'connect').length, 2);
    assert.deepEqual(f.verified, []); assert.equal(f.phone.endpoint, OLD); noUi(f.calls);
});

test('a failed command after connection is not reconnected or repeated', async () => {
    const f = setup({ oldAvailable: true });
    await f.phone.connect();
    const command = ['shell', 'input', 'tap', '10', '20'];
    await assert.rejects(f.phone.run(command), /Unexpected command/);
    assert.equal(f.calls.filter(call => call.args[0] === 'connect').length, 1);
    assert.equal(f.calls.filter(call => call.args.includes('tap')).length, 1);
    assert.ok(!f.calls.some(call => call.args[0] === 'mdns'));
});

test('cancellation and deadline are honored during discovery', async () => {
    const cancel = setup({ discoveryError: new BridgeError('cancelled', 'Cancelled') });
    await fails(cancel.phone.connect(), 'cancelled');
    const expired = setup({});
    expired.phone.deadline = Date.now() - 1;
    await fails(expired.phone.connect(), 'phone_timeout');
    assert.equal(expired.calls.length, 0);
});
