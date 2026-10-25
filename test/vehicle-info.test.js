'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isVin, validateVehicleInfo } = require('../lib/vehicle-info');
const { Screen } = require('../lib/ui');
const { vehicleInfoEntryTarget, vehicleInfoPage, vehicleInfoBackTarget, readVehicleInfo } = require('../lib/vehicle-info-ui');

const FIRST = 'TESTCAR0000000001';
const SECOND = 'TESTCAR0000000002';

test('VIN accepts the full international character format without a regional check digit', () => {
    for (const value of [FIRST, SECOND]) {
        assert.equal(isVin(value), true);
        assert.deepEqual(validateVehicleInfo({ vin: value }), { vin: value });
    }
    const record = Object.create(null);
    record.vin = FIRST;
    assert.deepEqual(validateVehicleInfo(record), { vin: FIRST });
});

test('VIN rejects missing, clipped, padded, lowercase and forbidden-character values', () => {
    for (const value of [null, undefined, 17, {}, '', FIRST.slice(1), FIRST + '0',
        ' ' + FIRST, FIRST + '\n', FIRST.toLowerCase(),
        FIRST.replace('T', 'I'), FIRST.replace('T', 'O'), FIRST.replace('T', 'Q')]) {
        assert.equal(isVin(value), false);
        assert.throws(() => validateVehicleInfo({ vin: value }), error => error.code === 'invalid_state');
    }
});

test('VIN records never execute accessors or accept unrelated fields and prototypes', () => {
    let invoked = 0;
    const getter = Object.defineProperty({}, 'vin', { get() { invoked++; return FIRST; } });
    const symbol = { vin: FIRST, [Symbol('private')]: true };
    for (const value of [null, [], {}, { vin: FIRST, other: SECOND }, getter, symbol,
        Object.create({ vin: FIRST }), new String(FIRST)]) {
        assert.throws(() => validateVehicleInfo(value), error => error.code === 'invalid_state');
    }
    assert.equal(invoked, 0);
});

test('VIN validation errors retain no source value or exception text', () => {
    const source = new Proxy({}, { getPrototypeOf() { throw new Error(SECOND); } });
    assert.throws(() => validateVehicleInfo(source), error => error.code === 'invalid_state'
        && !error.message.includes(SECOND));
});

const MODEL = 'Demo Elektro Kombi';
const marker = { contentDescPrefix: 'Ihr Fahrzeug: ' + MODEL + '. ' };
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
function node(attrs = {}, children = '') {
    const attributes = { package: 'com.volkswagen.weconnect', class: 'android.view.View',
        enabled: 'true', clickable: 'false', 'visible-to-user': 'true', bounds: '[0,0][1080,2100]', ...attrs };
    return '<node ' + Object.entries(attributes).map(([key, value]) => key + '="' + escape(value) + '"').join(' ') + '>'
        + children + '</node>';
}
const text = (value, bounds, attrs = {}) => node({ class: 'android.widget.TextView', text: value, bounds, ...attrs });
function card({ name = MODEL, vin = FIRST, active = true, y = 205, vinAttrs = {}, cardAttrs = {}, extra = '' } = {}) {
    return node({ clickable: 'true', bounds: `[0,${y}][1080,${y + 353}]`, ...cardAttrs },
        text(name, `[53,${y + 21}][850,${y + 100}]`)
        + text(vin, `[53,${y + 121}][1027,${y + 177}]`, vinAttrs)
        + text('Hauptnutzer', `[53,${y + 198}][1027,${y + 254}]`)
        + text('', `[53,${y + 275}][1027,${y + 332}]`)
        + (active ? node({ 'resource-id': 'activeBadge', bounds: `[903,${y + 34}][1027,${y + 87}]` },
            text('Aktiv', `[924,${y + 39}][1006,${y + 82}]`)) : '') + extra);
}
function garage(cards = card(), extra = '', backAttrs = {}) {
    return new Screen('<hierarchy rotation="0">' + node({ class: 'android.widget.FrameLayout' },
        node({ 'resource-id': 'garageBack', class: 'android.widget.Button', clickable: 'true',
            bounds: '[22,79][148,205]', ...backAttrs })
        + node({ 'content-desc': 'Meine Fahrzeuge', bounds: '[137,111][943,172]' })
        + cards + extra) + '</hierarchy>');
}

test('garage reads only the active enrolled vehicle, with a foreign VIN first in the list', () => {
    const screen = garage(card({ name: 'Anderes Fahrzeug', vin: SECOND, active: false }) + card({ y: 700 }));
    assert.equal(screen.kind(), 'vehicleInfo');
    assert.equal(vehicleInfoPage(screen), true);
    assert.deepEqual(readVehicleInfo(screen, marker), { vin: FIRST });
    assert.deepEqual(vehicleInfoBackTarget(screen), { x: 85, y: 142 });
});

test('garage rejects wrong vehicles, duplicated names and ambiguous active cards', () => {
    const cases = [
        [garage(card({ name: 'Anderes Fahrzeug' })), 'wrong_vehicle'],
        [garage(card({ active: false }) + card({ y: 700 })), 'ambiguous_ui'],
        [garage(card() + card({ name: 'Anderes Fahrzeug', vin: SECOND, y: 700 })), 'ambiguous_ui'],
        [garage(card({ active: false })), 'ambiguous_ui'],
    ];
    for (const [screen, code] of cases) assert.throws(() => readVehicleInfo(screen, marker), error => error.code === code);
});

test('garage requires one full visible VIN within the active vehicle card', () => {
    const screens = [
        garage(card({ vinAttrs: { 'visible-to-user': 'false' } })),
        garage(card({ vinAttrs: { bounds: '[53,326][1027,900]' } })),
        garage(card({ vin: FIRST.slice(1) })),
        garage(card({ vin: FIRST.replace('T', 'I') })),
        garage(card({ extra: text(SECOND, '[53,470][1027,520]') })),
    ];
    for (const screen of screens) {
        assert.equal(vehicleInfoPage(screen), true, 'A malformed VIN still allows the safe header return.');
        assert.throws(() => readVehicleInfo(screen, marker), error => ['invalid_vehicle_info', 'vehicle_info_unavailable'].includes(error.code));
    }
});

test('garage marker must contain the exact complete enrolled vehicle name', () => {
    const screen = garage();
    for (const value of [null, {}, { text: MODEL }, { contentDescPrefix: MODEL },
        { contentDescPrefix: 'Ihr Fahrzeug: ' + MODEL + '. ', other: true }]) {
        assert.throws(() => readVehicleInfo(screen, value), error => error.code === 'wrong_vehicle');
    }
});

test('a clickable list wrapper cannot lend a foreign VIN to the active vehicle', () => {
    const selected = card({ cardAttrs: { clickable: 'false' }, vinAttrs: { 'visible-to-user': 'false' } });
    const foreign = card({ name: 'Anderes Fahrzeug', vin: SECOND, active: false, y: 700,
        cardAttrs: { clickable: 'false' } });
    const list = node({ clickable: 'true', bounds: '[0,205][1080,1200]' }, selected + foreign);
    assert.throws(() => readVehicleInfo(garage(list), marker), error => error.code === 'vehicle_info_unavailable');
});

test('separate nested branches cannot synthesize a vehicle card from unrelated fields', () => {
    const wrapper = node({ clickable: 'true', bounds: '[0,205][1080,1200]' },
        node({}, text(MODEL, '[53,226][850,305]'))
        + node({}, text(FIRST, '[53,326][1027,382]'))
        + node({}, text('Aktiv', '[924,244][1006,287]')));
    assert.throws(() => readVehicleInfo(garage(wrapper), marker));
});

test('a flattened multi-car wrapper cannot masquerade as the known five-child card', () => {
    const flattened = node({ clickable: 'true', bounds: '[0,205][1080,1400]' },
        text(MODEL, '[53,226][850,305]')
        + text(FIRST, '[53,326][1027,382]', { 'visible-to-user': 'false' })
        + text('Hauptnutzer', '[53,403][1027,459]') + text('', '[53,480][1027,537]')
        + node({ 'resource-id': 'activeBadge', bounds: '[903,239][1027,292]' }, text('Aktiv', '[924,244][1006,287]'))
        + text('Anderes Fahrzeug', '[53,700][850,779]') + text(SECOND, '[53,800][1027,856]'));
    assert.throws(() => readVehicleInfo(garage(flattened), marker));
});

test('garage never offers a return gesture from an edit form or disabled header', () => {
    const editor = garage(card(), node({ class: 'android.widget.EditText', text: 'Entwurf' }));
    assert.throws(() => vehicleInfoPage(editor));
    assert.throws(() => vehicleInfoBackTarget(editor));
    assert.throws(() => vehicleInfoBackTarget(garage(card(), '', { enabled: 'false' })));
});

test('home entry is exactly the inspected manage-vehicles control', () => {
    const home = (attrs = {}, label = 'Fahrzeuge verwalten') => new Screen('<hierarchy rotation="0">'
        + node({ class: 'android.widget.FrameLayout' }, node({ 'resource-id': 'climateTile' })
            + node({ 'resource-id': 'vehicleCarPlus', clickable: 'true', bounds: '[933,79][1059,205]', ...attrs },
                node({ 'content-desc': label, bounds: '[965,111][1028,174]' }))) + '</hierarchy>');
    assert.deepEqual(vehicleInfoEntryTarget(home()), { x: 996, y: 142 });
    assert.throws(() => vehicleInfoEntryTarget(home({ enabled: 'false' })));
    assert.throws(() => vehicleInfoEntryTarget(home({}, 'Fahrzeug verbinden')));
    assert.throws(() => vehicleInfoEntryTarget(garage()));
});
