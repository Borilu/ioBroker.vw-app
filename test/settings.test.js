'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SETTINGS_KEYS, DEFAULT_TARGET_SETTINGS, MODES, ZONES, isSettingValue, isObservedSettingValue,
    validateSetting, validateTargetSettings } = require('../lib/settings');
const { StateStore } = require('../lib/store');
const { BridgeError } = require('../lib/errors');

test('default wishes preserve all four existing app settings and validation returns an independent object', () => {
    assert.deepEqual(SETTINGS_KEYS, ['mode', 'climateOnUnlock', 'autoWindowHeating', 'zones']);
    assert.deepEqual(DEFAULT_TARGET_SETTINGS, { mode: null, climateOnUnlock: null, autoWindowHeating: null, zones: null });
    const first = validateTargetSettings();
    assert.deepEqual(first, DEFAULT_TARGET_SETTINGS);
    assert.notEqual(first, DEFAULT_TARGET_SETTINGS);
    first.mode = 'climate';
    assert.equal(DEFAULT_TARGET_SETTINGS.mode, null);
    assert.deepEqual(validateTargetSettings(), DEFAULT_TARGET_SETTINGS);
});

test('mode and zone values accept only the supported exact enums or null', () => {
    assert.deepEqual(MODES, ['climate', 'windowHeating']);
    assert.deepEqual(ZONES, ['frontLeft', 'frontRight', 'both']);
    for (const [key, values] of [['mode', [...MODES, null]], ['zones', [...ZONES, null]]]) {
        for (const value of values) {
            assert.equal(isSettingValue(key, value), true);
            assert.equal(validateSetting(key, value), value);
        }
    }
    for (const [key, value] of [['mode', 'Climate'], ['mode', 'windowHeating '], ['mode', true],
        ['zones', 'left'], ['zones', 'right'], ['zones', 'none'], ['zones', false]]) {
        assert.equal(isSettingValue(key, value), false);
        assert.throws(() => validateSetting(key, value), error => error instanceof BridgeError && error.code === 'invalid_settings');
    }
    assert.equal(isObservedSettingValue('zones', 'none'), true);
    assert.equal(isSettingValue('zones', 'none'), false);
    assert.equal(isObservedSettingValue('mode', 'none'), false);
});

test('boolean wishes preserve explicit false and reject coercion or unknown values', () => {
    for (const key of ['climateOnUnlock', 'autoWindowHeating']) {
        for (const value of [true, false, null]) assert.equal(validateSetting(key, value), value);
        for (const value of [0, 1, '', 'true', 'false', undefined, {}, []]) {
            assert.equal(isSettingValue(key, value), false);
            assert.throws(() => validateSetting(key, value), error => error.code === 'invalid_settings');
        }
    }
    assert.deepEqual(validateTargetSettings({ climateOnUnlock: false, autoWindowHeating: true }), {
        mode: null, climateOnUnlock: false, autoWindowHeating: true, zones: null,
    });
});

test('invalid settings objects and unknown keys produce fixed messages without echoing input', () => {
    const inputs = [null, true, 1, 'SECRET', [], { mode: undefined }, { mode: 'SECRET' },
        { arbitrary: 'SECRET' }, JSON.parse('{"__proto__":{"SECRET":true}}')];
    for (const value of inputs) {
        assert.throws(() => validateTargetSettings(value), error => error.code === 'invalid_settings' && !error.message.includes('SECRET'));
    }
    assert.equal(isSettingValue('unknown', null), false);
    assert.throws(() => validateSetting('unknown', false), error => error.code === 'invalid_settings');
});

test('the private settings file survives restart separately from temperature, enrollment and cooldown', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-app-settings-test-'));
    t.after(async () => {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('vw-app-settings-test-'));
        await fs.rm(resolved, { recursive: true, force: true });
    });
    const store = new StateStore(directory);
    const selected = { mode: 'climate', climateOnUnlock: false, autoWindowHeating: true, zones: 'both' };
    await store.write('temperature-preference', { targetCelsius: 22.5 });
    await store.write('enrollment', { deviceId: 'serial:SETTINGS-TEST' });
    await store.write('command-journal', { lastAttempt: 123 });
    await store.write('settings-preference', selected);
    const restarted = new StateStore(directory);
    assert.deepEqual(await restarted.read('settings-preference'), selected);
    assert.deepEqual(await restarted.read('temperature-preference'), { targetCelsius: 22.5 });
    assert.deepEqual(await restarted.read('enrollment'), { deviceId: 'serial:SETTINGS-TEST' });
    assert.deepEqual(await restarted.read('command-journal'), { lastAttempt: 123 });
});
