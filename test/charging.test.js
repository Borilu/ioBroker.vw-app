'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
    CHARGING_KEYS, DEFAULT_TARGET_CHARGING, MIN_TARGET_SOC, MAX_TARGET_SOC, TARGET_SOC_STEP,
    isChargingValue, validateChargingSetting, validateTargetCharging,
    isObservedChargingValue, isBatterySoc, isRangeKm,
    CHARGING_MODES, isChargingMode, validateTargetChargingMode,
} = require('../lib/charging');
const { StateStore } = require('../lib/store');
const { BridgeError } = require('../lib/errors');

const SECRET = 'DO-NOT-LEAK-CHARGING-PRIVATE';
const BOOLEAN_KEYS = ['reducedAcCurrent', 'autoUnlockAc', 'optimizedBatteryUse'];

test('charging mode wishes use three exact values and keep null separate from a supported observed mode', () => {
    assert.deepEqual(CHARGING_MODES, ['immediate', 'departure', 'departureClimate']);
    assert.equal(Object.isFrozen(CHARGING_MODES), true);
    for (const value of CHARGING_MODES) {
        assert.equal(isChargingMode(value), true);
        assert.equal(validateTargetChargingMode(value), value);
    }
    assert.equal(isChargingMode(null), false);
    assert.equal(validateTargetChargingMode(null), null);
    const dangerous = { toString() { throw new Error(SECRET); }, valueOf() { throw new Error(SECRET); } };
    for (const value of [undefined, true, false, 0, '', 'null', 'Sofortladen', 'Departure', 'immediate ',
        [], {}, new String('immediate'), dangerous, SECRET]) {
        assert.equal(isChargingMode(value), false);
        assert.throws(() => validateTargetChargingMode(value), error => error.code === 'invalid_charging_mode'
            && !JSON.stringify(error.toJSON()).includes(SECRET));
    }
    invalid(() => validateTargetCharging({ mode: 'immediate' }));
});

test('the mode preference persists separately without changing the four existing charging wishes', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-app-mode-test-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('vw-app-mode-test-'));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const store = new StateStore(directory);
    const wishes = validateTargetCharging({ socLimit: 80, autoUnlockAc: false });
    await store.write('charging-preference', wishes);
    await store.write('charging-mode-preference', { mode: 'departureClimate' });
    const restarted = new StateStore(directory);
    assert.deepEqual(await restarted.read('charging-mode-preference'), { mode: 'departureClimate' });
    assert.deepEqual(await restarted.read('charging-preference'), wishes);
    await restarted.write('charging-mode-preference', { mode: null });
    assert.deepEqual(await store.read('charging-mode-preference'), { mode: null });
    assert.deepEqual(await store.read('charging-preference'), wishes);
});

function invalid(operation) {
    assert.throws(operation, error => error instanceof BridgeError
        && error.code === 'invalid_charging_settings'
        && !error.message.includes(SECRET)
        && !JSON.stringify(error.toJSON()).includes(SECRET));
}

test('default charging wishes preserve all four app settings and return independent mutable selections', () => {
    assert.deepEqual(CHARGING_KEYS, ['socLimit', 'reducedAcCurrent', 'autoUnlockAc', 'optimizedBatteryUse']);
    assert.deepEqual(DEFAULT_TARGET_CHARGING, {
        socLimit: null, reducedAcCurrent: null, autoUnlockAc: null, optimizedBatteryUse: null,
    });
    assert.equal(Object.isFrozen(CHARGING_KEYS), true);
    assert.equal(Object.isFrozen(DEFAULT_TARGET_CHARGING), true);
    const first = validateTargetCharging();
    const second = validateTargetCharging({});
    assert.deepEqual(first, DEFAULT_TARGET_CHARGING);
    assert.deepEqual(second, DEFAULT_TARGET_CHARGING);
    assert.notEqual(first, DEFAULT_TARGET_CHARGING);
    assert.notEqual(first, second);
    first.socLimit = MIN_TARGET_SOC;
    first.autoUnlockAc = false;
    assert.deepEqual(second, DEFAULT_TARGET_CHARGING);
    assert.deepEqual(validateTargetCharging(), DEFAULT_TARGET_CHARGING);
});

test('target SOC accepts only the six verified numeric slider values within 50 to 100, or null', () => {
    assert.equal(MIN_TARGET_SOC, 50);
    assert.equal(MAX_TARGET_SOC, 100);
    assert.equal(TARGET_SOC_STEP, 10);
    assert.deepEqual(Array.from({ length: 6 }, (_, index) => MIN_TARGET_SOC + index * TARGET_SOC_STEP), [50, 60, 70, 80, 90, 100]);
    for (let value = MIN_TARGET_SOC; value <= MAX_TARGET_SOC; value++) {
        const supported = Number.isInteger((value - MIN_TARGET_SOC) / TARGET_SOC_STEP);
        assert.equal(isChargingValue('socLimit', value), supported, 'SOC ' + value);
        if (supported) assert.equal(validateChargingSetting('socLimit', value), value);
        else invalid(() => validateChargingSetting('socLimit', value));
    }
    assert.equal(isChargingValue('socLimit', null), true);
    assert.equal(validateChargingSetting('socLimit', null), null);
    for (const value of [MIN_TARGET_SOC - 1, MAX_TARGET_SOC + 1, MIN_TARGET_SOC + 0.5,
        MAX_TARGET_SOC - 0.5, 0, -0.5, NaN, Infinity, -Infinity, undefined,
        String(MIN_TARGET_SOC), '80', '', true, false, [], {}, new Number(80), 80n]) {
        assert.equal(isChargingValue('socLimit', value), false);
        invalid(() => validateChargingSetting('socLimit', value));
    }
});

test('charging options preserve explicit false and accept only Boolean or null without coercion', () => {
    const noCoercion = {
        toString() { throw new Error(SECRET); },
        valueOf() { throw new Error(SECRET); },
    };
    for (const key of BOOLEAN_KEYS) {
        for (const value of [true, false, null]) {
            assert.equal(isChargingValue(key, value), true);
            assert.equal(validateChargingSetting(key, value), value);
        }
        for (const value of [0, 1, 'true', 'false', 'null', '', undefined, [], {},
            new Boolean(false), noCoercion, SECRET]) {
            assert.equal(isChargingValue(key, value), false);
            invalid(() => validateChargingSetting(key, value));
        }
    }
    const input = { reducedAcCurrent: false, autoUnlockAc: true, optimizedBatteryUse: false };
    const before = structuredClone(input);
    const selected = validateTargetCharging(input);
    assert.deepEqual(selected, { socLimit: null, ...input });
    assert.notEqual(selected, input);
    assert.deepEqual(input, before);
});

test('malformed charging objects and unknown keys produce redacted fixed errors', () => {
    for (const value of [null, true, false, 0, 1, SECRET, [], [SECRET],
        { socLimit: undefined }, { socLimit: SECRET }, { socLimit: {} },
        { reducedAcCurrent: SECRET }, { autoUnlockAc: [] }, { optimizedBatteryUse: 1 },
        { unknown: SECRET }, { [SECRET]: true },
        JSON.parse('{"__proto__":{"private":"' + SECRET + '"}}'),
        { constructor: SECRET }, { toString: SECRET }]) {
        invalid(() => validateTargetCharging(value));
    }
    for (const key of ['soclimit', 'unknown', '__proto__', 'constructor', 'toString', SECRET, null, undefined]) {
        assert.equal(isChargingValue(key, null), false);
        assert.equal(isObservedChargingValue(key, false), false);
        invalid(() => validateChargingSetting(key, false));
    }
    assert.equal(Object.prototype.private, undefined);
});

test('observed battery SOC covers the full finite numeric 0 to 100 range independently of target limits', () => {
    for (const value of [0, 0.5, 12.25, MIN_TARGET_SOC - 1, MIN_TARGET_SOC, 99.5, 100]) {
        assert.equal(isBatterySoc(value), true);
        assert.equal(isObservedChargingValue('socLimit', value), true);
    }
    assert.equal(isChargingValue('socLimit', MIN_TARGET_SOC - 1), false);
    for (const value of [-0.01, 100.01, NaN, Infinity, -Infinity, '80', '', true, false,
        null, undefined, [], {}, new Number(80), 80n]) {
        assert.equal(isBatterySoc(value), false);
        assert.equal(isObservedChargingValue('socLimit', value), false);
    }
    for (const key of BOOLEAN_KEYS) {
        for (const value of [true, false, null]) assert.equal(isObservedChargingValue(key, value), true);
        for (const value of [0, 1, 'true', undefined, {}, []]) assert.equal(isObservedChargingValue(key, value), false);
    }
});

test('observed remaining range accepts finite nonnegative numeric kilometres without coercion', () => {
    for (const value of [0, 0.25, 1, 123.45, 1000, Number.MAX_VALUE]) assert.equal(isRangeKm(value), true);
    for (const value of [-0.01, -1, NaN, Infinity, -Infinity, '123', '', true, false,
        null, undefined, [], {}, new Number(123), 123n]) assert.equal(isRangeKm(value), false);
});

test('the private charging preference survives restart independently of climate, temperature, enrollment and cooldown', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-app-charging-test-'));
    t.after(async () => {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('vw-app-charging-test-'));
        await fs.rm(resolved, { recursive: true, force: true });
    });
    const store = new StateStore(directory);
    const independent = {
        'enrollment': { deviceId: 'serial:CHARGING-TEST' },
        'command-journal': { lastAttempt: 123 },
        'temperature-preference': { targetCelsius: 22.5 },
        'settings-preference': { mode: 'climate', climateOnUnlock: false, autoWindowHeating: true, zones: 'both' },
    };
    for (const [name, value] of Object.entries(independent)) await store.write(name, value);
    const selected = validateTargetCharging({ socLimit: MIN_TARGET_SOC, reducedAcCurrent: true,
        autoUnlockAc: false, optimizedBatteryUse: true });
    await store.write('charging-preference', selected);
    const restarted = new StateStore(directory);
    assert.equal(path.basename(restarted.file('charging-preference')), 'charging-preference.json');
    assert.deepEqual(await restarted.read('charging-preference'), selected);
    for (const [name, value] of Object.entries(independent)) assert.deepEqual(await restarted.read(name), value);

    await restarted.write('charging-preference', validateTargetCharging());
    assert.deepEqual(await store.read('charging-preference'), DEFAULT_TARGET_CHARGING);
    for (const [name, value] of Object.entries(independent)) assert.deepEqual(await store.read(name), value);
    const stat = await fs.lstat(store.file('charging-preference'));
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
    assert.deepEqual((await fs.readdir(directory)).sort(), [
        'charging-preference.json', 'command-journal.json', 'enrollment.json',
        'settings-preference.json', 'temperature-preference.json',
    ]);
});
