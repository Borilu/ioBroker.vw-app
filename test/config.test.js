'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig, validateSecurityPin } = require('../lib/config');
const { BridgeError, publicError } = require('../lib/errors');
const ioPackage = require('../io-package.json');
const nativeDefaults = ioPackage.native;
const admin = require('../admin/jsonConfig.json').items;
const invalid = error => error.code === 'invalid_config';
// Synthetic format probes only. No account credential or recorded PIN is used.
const syntheticPin = (...digits) => digits.map(value => String.fromCharCode(48 + value)).join('');

test('missing and explicit disabled legacy polling remain disabled while new instances opt in at 15 seconds', () => {
    assert.equal(normalizeConfig().pollIntervalSeconds, 0);
    assert.equal(normalizeConfig({}).pollIntervalSeconds, 0);
    assert.equal(normalizeConfig({ pollIntervalSeconds: 0 }).pollIntervalSeconds, 0);
    assert.equal(normalizeConfig({ pollIntervalSeconds: 300 }).pollIntervalSeconds, 300);
    assert.equal(nativeDefaults.pollIntervalSeconds, 15);
    assert.equal(normalizeConfig(nativeDefaults).pollIntervalSeconds, 15);
    assert.equal(normalizeConfig().allowWrites, false);
    assert.equal(nativeDefaults.allowWrites, false);
});

test('polling accepts only disabled or bounded whole-second completion intervals', () => {
    for (const value of [0, 15, 16, 299, 300, 86400, '0', '15', '86400']) {
        assert.equal(normalizeConfig({ pollIntervalSeconds: value }).pollIntervalSeconds, Number(value));
    }
    for (const value of [1, 14, -1, 86401, 15.5, NaN, Infinity, true, false, {}, [], '',
        '15\n', '15.0', ' 15', '15 ', '1e2', '-1', '0x10']) {
        assert.throws(() => normalizeConfig({ pollIntervalSeconds: value }), invalid, String(value));
    }
});

test('read-age limit defaults to automatic and accepts only automatic or 30 through 86400 whole seconds', () => {
    assert.equal(normalizeConfig().refreshMaxAgeSeconds, 0);
    assert.equal(nativeDefaults.refreshMaxAgeSeconds, 0);
    for (const value of [0, 30, 90, 86400, '0', '30', '86400']) {
        assert.equal(normalizeConfig({ refreshMaxAgeSeconds: value }).refreshMaxAgeSeconds, Number(value));
    }
    for (const value of [1, 29, -1, 86401, 30.5, NaN, Infinity, true, false, {}, [], '',
        '30\n', '30.0', ' 30', '30 ', '3e1', '-1', '0x20']) {
        assert.throws(() => normalizeConfig({ refreshMaxAgeSeconds: value }), invalid, String(value));
    }
});

test('read-age and polling settings remain independent and do not mutate existing configuration', () => {
    const native = { pollIntervalSeconds: 0, refreshMaxAgeSeconds: 30, allowWrites: false };
    const copy = structuredClone(native);
    const config = normalizeConfig(native);
    assert.equal(config.pollIntervalSeconds, 0);
    assert.equal(config.refreshMaxAgeSeconds, 30);
    assert.equal(config.allowWrites, false);
    assert.deepEqual(native, copy);
    assert.equal(normalizeConfig({ pollIntervalSeconds: 15, refreshMaxAgeSeconds: 30 }).refreshMaxAgeSeconds, 30);
    assert.equal(normalizeConfig({ pollIntervalSeconds: 86400, refreshMaxAgeSeconds: 0 }).refreshMaxAgeSeconds, 0);
});

test('admin defaults and numeric validators agree with the backend boundaries', () => {
    assert.equal(admin.pollIntervalSeconds.default, 15);
    assert.equal(admin.refreshMaxAgeSeconds.default, 0);
    for (const [name, min] of [['pollIntervalSeconds', 15], ['refreshMaxAgeSeconds', 30]]) {
        assert.equal(admin[name].min, 0);
        assert.equal(admin[name].max, 86400);
        assert.equal(admin[name].step, 1);
        assert.equal(admin[name].validatorNoSaveOnError, true);
        const validate = new Function('data', 'return (' + admin[name].validator + ');');
        for (const value of [0, min, min + 1, 86400]) assert.equal(validate({ [name]: value }), true);
        for (const value of [1, min - 1, -1, min + 0.5, 86401, NaN, Infinity, true, false, '']) {
            assert.equal(validate({ [name]: value }), false, name + ': ' + String(value));
        }
    }
});

test('vehicle locking is independently disabled by default and only accepts explicit boolean permission', () => {
    assert.equal(nativeDefaults.allowVehicleLocking, false);
    assert.equal(normalizeConfig().allowVehicleLocking, false);
    for (const allowWrites of [false, true]) for (const allowVehicleLocking of [false, true]) {
        const config = normalizeConfig({ allowWrites, allowVehicleLocking });
        assert.equal(config.allowWrites, allowWrites);
        assert.equal(config.allowVehicleLocking, allowVehicleLocking);
    }
    for (const value of ['true', 'false', 1, 0, null, {}, []]) {
        assert.throws(() => normalizeConfig({ allowVehicleLocking: value }), invalid);
    }
});

test('S-PIN format validation preserves four digit strings including leading zeros without coercion', () => {
    for (const value of [syntheticPin(0, 7, 2, 9), syntheticPin(8, 3, 6, 1), syntheticPin(0, 0, 0, 0)]) {
        assert.equal(validateSecurityPin(value), value);
        assert.equal(validateSecurityPin(value).length, 4);
    }
});

test('only a missing S-PIN produces the fixed required error', () => {
    for (const value of [undefined, null, '']) {
        assert.throws(() => validateSecurityPin(value), error => error instanceof BridgeError
            && error.code === 'security_pin_required'
            && error.message === 'Die Volkswagen S-PIN zuerst in den Adaptereinstellungen hinterlegen.');
    }
});

test('invalid S-PIN formats and object coercion cannot leak supplied values through errors', () => {
    const canary = 'synthetic-security-input-do-not-echo';
    const valid = syntheticPin(0, 7, 2, 9);
    const hostile = { toString() { throw new Error(canary); } };
    for (const value of [valid.slice(1), valid + '0', valid + '\n', ' ' + valid, valid + ' ',
        '１２３４', '١٢٣٤', Number(valid), true, false, {}, [], [valid], new String(valid), hostile, canary]) {
        assert.throws(() => validateSecurityPin(value), error => {
            assert.ok(error instanceof BridgeError);
            assert.equal(error.code, 'security_pin_invalid');
            assert.equal(error.message, 'Die Volkswagen S-PIN muss aus genau vier Ziffern bestehen.');
            assert.equal(JSON.stringify(publicError(error)).includes(canary), false);
            assert.equal(JSON.stringify(publicError(error)).includes(valid), false);
            return true;
        });
    }
});

test('normalized settings never read or carry the secret native setting', () => {
    const native = { allowVehicleLocking: true, allowWrites: false };
    Object.defineProperty(native, 'sPin', { enumerable: true, get() { throw new Error('The secret accessor must not be read.'); } });
    const config = normalizeConfig(native);
    assert.equal(config.allowVehicleLocking, true);
    assert.equal(Object.hasOwn(config, 'sPin'), false);
    assert.equal(JSON.stringify(config).includes('sPin'), false);
});

test('missing or invalid stored PIN values do not disable unrelated configuration and remain private', () => {
    for (const sPin of ['', undefined, null, { encrypted: 'synthetic-invalid-config' }, syntheticPin(0, 7, 2, 9)]) {
        const config = normalizeConfig({ sPin, allowWrites: true, pollIntervalSeconds: 15 });
        assert.equal(config.allowWrites, true);
        assert.equal(config.pollIntervalSeconds, 15);
        assert.equal(config.allowVehicleLocking, false);
        assert.equal(Object.hasOwn(config, 'sPin'), false);
        assert.equal(JSON.stringify(config).includes('synthetic-invalid-config'), false);
    }
});

test('the persistent masked S-PIN is encrypted and protected by native metadata', () => {
    assert.deepEqual(ioPackage.encryptedNative, ['sPin']);
    assert.deepEqual(ioPackage.protectedNative, ['sPin']);
    assert.equal(nativeDefaults.sPin, '');
    assert.equal(admin.sPin.type, 'password');
    assert.equal(admin.sPin.visible, false);
    assert.equal(admin.sPin.maxLength, 4);
    assert.notEqual(admin.sPin.doNotSave, true);
    assert.equal(admin.sPin.validatorNoSaveOnError, true);
    assert.equal(admin.allowVehicleLocking.type, 'checkbox');
    assert.equal(admin.allowVehicleLocking.default, false);
    // The password must not be interpolated into any setup message or response.
    for (const item of Object.values(admin)) {
        for (const key of ['jsonData', 'data', 'result']) {
            assert.equal(JSON.stringify(item[key] ?? null).includes('sPin'), false);
        }
    }
});

test('Admin PIN validation accepts empty configuration and agrees with exact four-digit backend validation', () => {
    const validate = new Function('data', 'return (' + admin.sPin.validator + ');');
    assert.equal(validate({}), true);
    assert.equal(validate({ sPin: '' }), true);
    for (const value of [syntheticPin(0, 7, 2, 9), syntheticPin(8, 3, 6, 1)]) {
        assert.equal(validate({ sPin: value }), true);
        assert.equal(validateSecurityPin(value), value);
    }
    for (const value of [null, 1234, true, false, [], {}, '123', '12345', '1234\n', ' 1234', '１２３４']) {
        assert.equal(validate({ sPin: value }), false);
    }
});
