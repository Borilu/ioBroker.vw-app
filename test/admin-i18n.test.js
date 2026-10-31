'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const admin = require('../admin/jsonConfig.json');
const ioPackage = require('../io-package.json');

const languages = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
const translations = Object.fromEntries(languages.map(language => [language,
    JSON.parse(fs.readFileSync(path.join(__dirname, '../admin/i18n', language + '.json'), 'utf8')),
]));
const textAttributes = new Set(['label', 'text', 'textAlive', 'textNotAlive', 'title',
    'tooltip', 'help', 'placeholder', 'validatorErrorText']);

test('Admin enables file translations with complete, nonempty resources in all supported languages', () => {
    assert.equal(admin.i18n, true);
    const expectedKeys = Object.keys(translations.en).sort();
    assert.ok(expectedKeys.length > 0);
    for (const language of languages) {
        assert.deepEqual(Object.keys(translations[language]).sort(), expectedKeys, language);
        for (const [key, value] of Object.entries(translations[language])) {
            assert.equal(typeof value, 'string', language + ': ' + key);
            assert.ok(value.trim(), language + ': ' + key);
        }
    }
    // English sentence keys remain readable if Admin has to fall back.
    for (const [key, value] of Object.entries(translations.en)) assert.equal(key, value);
});

test('all visible Admin text and sendTo results resolve through the translation resources', () => {
    const references = new Set();
    const checkReference = (value, location) => {
        assert.equal(typeof value, 'string', location);
        for (const language of languages) {
            assert.ok(Object.hasOwn(translations[language], value), language + ': ' + location);
        }
        references.add(value);
    };
    const visit = (node, location) => {
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
            if (textAttributes.has(key)) checkReference(value, location + '.' + key);
            else if (key === 'result' || key === 'error') {
                for (const [code, message] of Object.entries(value)) {
                    checkReference(message, location + '.' + key + '.' + code);
                }
            } else if (value && typeof value === 'object') visit(value, location + '.' + key);
        }
    };
    visit(admin.items, 'items');
    assert.deepEqual([...references].sort(), Object.keys(translations.en).sort(),
        'Every resource must be reachable from an Admin control.');
});

test('transient pairing remains masked and unsaved while both password fields are defensively protected', () => {
    assert.equal(admin.items._pairCode.type, 'password');
    assert.equal(admin.items._pairCode.visible, false);
    assert.equal(admin.items._pairCode.doNotSave, true);
    assert.equal(Object.hasOwn(ioPackage.native, '_pairCode'), false);
    for (const attribute of ['encryptedNative', 'protectedNative']) {
        assert.ok(ioPackage[attribute].includes('_pairCode'), attribute);
        assert.ok(ioPackage[attribute].includes('sPin'), attribute);
    }
    assert.equal(admin.items.sPin.type, 'password');
    assert.equal(admin.items.sPin.visible, false);
    assert.notEqual(admin.items.sPin.doNotSave, true);
    assert.equal(ioPackage.native.sPin, '');
});

test('Guardian password stays unavailable until a current instance protection check succeeds', () => {
    const check = admin.items._guardianProtectionCheck;
    const marker = admin.items._guardianProtectionVerified;
    const password = admin.items.guardianSecret;
    assert.equal(check.type, 'sendTo');
    assert.equal(check.command, 'guardianProtectionCheck');
    assert.deepEqual(check.data, {}); // No native configuration or S-PIN sent.
    assert.equal(check.useNative, true);
    assert.equal(check.onLoaded, true);
    assert.equal(check.disabled, true); // It cannot be manually rerun on a stale form.
    // Admin schedules defaults asynchronously at mount. A false default here
    // could overwrite an earlier positive backend response 100 ms later.
    assert.equal(Object.hasOwn(marker, 'default'), false);
    assert.equal(marker.hidden, true);
    assert.equal(marker.doNotSave, true);
    const disabled = new Function('data', 'return (' + password.disabled + ');');
    for (const value of [undefined, false, 'true', 1, null]) {
        assert.equal(disabled({ _guardianProtectionVerified: value }), true);
    }
    assert.equal(disabled({ _guardianProtectionVerified: true }), false);
    assert.equal(password.type, 'password');
    assert.equal(password.visible, false);
});

test('Guardian recovery requires the explicit temporary confirmation and sends only a fixed confirmation flag', () => {
    const checkbox = admin.items._guardianBinderRecoverConfirmed;
    const button = admin.items._guardianBinderRecover;
    assert.equal(checkbox.type, 'checkbox');
    assert.equal(checkbox.doNotSave, true);
    assert.equal(checkbox.default, false);
    assert.deepEqual(button.data, { confirm: true });
    assert.equal(button.useNative, true); // response carries an empty native object
    const disabled = new Function('data', 'return (' + button.disabled + ');');
    assert.equal(disabled({ _guardianProtectionVerified: true }), true);
    assert.equal(disabled({ _guardianProtectionVerified: false, _guardianBinderRecoverConfirmed: true }), true);
    assert.equal(disabled({ _guardianProtectionVerified: true, _guardianBinderRecoverConfirmed: true }), false);
});

test('Guardian system permission requires a separate unsaved explicit confirmation', () => {
    const checkbox = admin.items._guardianPermissionConfirmed;
    const button = admin.items._guardianPermissionGrant;
    assert.equal(checkbox.type, 'checkbox');
    assert.equal(checkbox.default, false);
    assert.equal(checkbox.doNotSave, true);
    assert.deepEqual(button.data, { confirm: true });
    const disabled = new Function('data', 'return (' + button.disabled + ');');
    assert.equal(disabled({}), true);
    assert.equal(disabled({ _guardianPermissionConfirmed: 'true' }), true);
    assert.equal(disabled({ _guardianPermissionConfirmed: true }), false);
});
