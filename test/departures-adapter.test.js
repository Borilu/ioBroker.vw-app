'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateLocationTargets, validatePreferredTargets, localKey, DEFAULT_TARGET_LOCATION, isDepartureButton } = require('../lib/departures-adapter');
const { StateStore } = require('../lib/store');

test('metadata migration recognizes only actual departure controls, including historical charging-location keys', () => {
    const key = 'loc_' + 'a'.repeat(24);
    const valid = ['commands.refreshDepartureClimate', 'commands.refreshDepartureLocations',
        ...['1', '2'].flatMap(id => ['apply', 'clear'].map(command => 'departures.climate.timer' + id + '.commands.' + command)),
        'chargingLocations.' + key + '.commands.refresh',
        ...['1', '2', '3'].flatMap(id => ['apply', 'clear'].map(command => 'chargingLocations.' + key + '.timer' + id + '.commands.' + command)),
        ...['settings', 'preferredTimes'].flatMap(group => ['apply', 'clear'].map(command => 'chargingLocations.' + key + '.' + group + '.commands.' + command))];
    for (const id of valid) assert.equal(isDepartureButton(id), true, id);
    for (const id of ['commands.apply', 'departures.climate.timer3.commands.apply',
        'chargingLocations.' + key + '.timer4.commands.apply', 'chargingLocations.' + key + '.preferredTimes.window1.commands.apply',
        'chargingLocations.' + key + '.timer1.targetEnabled', 'chargingLocations.named.commands.refresh',
        'vw-app.1.' + valid[0], valid[0] + '.extra', 'chargingLocations.' + key.toUpperCase() + '.commands.refresh']) {
        assert.equal(isDepartureButton(id), false, id);
    }
});

test('location wishes preserve null and exact Unicode names without permitting SOC writes or Boolean coercion', () => {
    assert.deepEqual(validateLocationTargets(), DEFAULT_TARGET_LOCATION);
    assert.deepEqual(validateLocationTargets({ name: 'Synthetischer Ort Ä', autoUnlockAc: false }),
        { name: 'Synthetischer Ort Ä', reducedAcCurrent: null, autoUnlockAc: false });
    for (const value of [null, [], { directSoc: 50 }, { socLimit: 80 }, { reducedAcCurrent: 'false' },
        { autoUnlockAc: 0 }, { name: '' }, { name: ' Ort' }, { name: 'Ort ' }, { name: '\u0000PRIVATE' },
        { name: '\ud800' }, { name: 'x'.repeat(129) }, JSON.parse('{"__proto__":{"PRIVATE":true}}')]) {
        assert.throws(() => validateLocationTargets(value), error => error.code === 'invalid_departures_request' && !error.message.includes('PRIVATE'));
    }
});

test('preferred wishes cover each of the four fixed windows once and never contain writable start or end times', () => {
    const input = [{ id: '4', enabled: false }, { id: '1', enabled: null }, { id: '3', enabled: true }, { id: '2', enabled: null }];
    const normalized = validatePreferredTargets(input);
    assert.deepEqual(normalized, [{ id: '1', enabled: null }, { id: '2', enabled: null }, { id: '3', enabled: true }, { id: '4', enabled: false }]);
    normalized[3].enabled = true;
    assert.equal(input[0].enabled, false);
    for (const value of [null, [], input.slice(1), [...input, { id: '5', enabled: null }],
        input.map((item, index) => index === 0 ? { id: '1', enabled: false } : item),
        input.map((item, index) => index === 0 ? { ...item, start: '00:00' } : item),
        input.map((item, index) => index === 0 ? { ...item, enabled: 'false' } : item)]) {
        assert.throws(() => validatePreferredTargets(value), error => error.code === 'invalid_departures_request');
    }
});

test('local charging keys depend on vehicle and native identity while excluding mutable names and raw identifiers', () => {
    const first = localKey('SYNTHETIC VEHICLE A', '700');
    assert.match(first, /^loc_[a-f0-9]{24}$/);
    assert.equal(first, localKey('SYNTHETIC VEHICLE A', '700'));
    assert.notEqual(first, localKey('SYNTHETIC VEHICLE B', '700'));
    assert.notEqual(first, localKey('SYNTHETIC VEHICLE A', '701'));
    assert.equal(first.includes('SYNTHETIC'), false);
});

test('private departure preferences and bindings persist independently of existing climate and charge data', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-app-departure-test-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('vw-app-departure-test-'));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const store = new StateStore(directory);
    const preferences = { version: 1, groups: { synthetic: { enabled: { value: false, token: null } } } };
    const bindings = { version: 1, locations: {} };
    await store.write('charging-preference', { socLimit: 80 });
    await store.write('departure-preference', preferences);
    await store.write('departure-location-bindings', bindings);
    const restarted = new StateStore(directory);
    assert.deepEqual(await restarted.read('departure-preference'), preferences);
    assert.deepEqual(await restarted.read('departure-location-bindings'), bindings);
    assert.deepEqual(await restarted.read('charging-preference'), { socLimit: 80 });
});
