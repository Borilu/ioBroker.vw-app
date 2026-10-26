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
