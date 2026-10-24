'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig } = require('../lib/config');
const nativeDefaults = require('../io-package.json').native;
const admin = require('../admin/jsonConfig.json').items;
const invalid = error => error.code === 'invalid_config';

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
