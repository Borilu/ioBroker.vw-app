'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Screen } = require('../lib/ui');
const { ACCESS_POSITIONS, ACCESS_COMPONENTS, validateVehicleAccess } = require('../lib/vehicle-access');
const { vehicleAccessScreen, partiallyScrolledAccessScreen, COMPONENTS, node } = require('./support/access-fixtures.cjs');

const rejects = code => error => error.code === code;
function read(options) { return new Screen(vehicleAccessScreen(options)).vehicleAccess(); }
function allOpenings(value) { return [...Object.values(value.doors), ...Object.values(value.windows), value.trunkOpen]; }
function edit(xml, marker, changes) {
    return xml.replace(/<node [^>]*>/gu, tag => {
        if (!tag.includes(marker)) return tag;
        for (const [key, value] of Object.entries(changes)) {
            const pattern = new RegExp(' ' + key + '="[^"]*"', 'u');
            tag = pattern.test(tag) ? tag.replace(pattern, ` ${key}="${value}"`) : tag.replace(/>$/u, ` ${key}="${value}">`);
        }
        return tag;
    });
}

test('complete Home reads all nine open components independently from unlocked state', () => {
    const result = read({ locked: false, open: COMPONENTS });
    assert.deepEqual(allOpenings(result), Array(9).fill(true));
    assert.equal(result.locked, false);
    assert.equal(result.synchronizationText, 'Gerade synchronisiert');
    assert.match(result.warningText, /^Fahrzeug ist entriegelt\./u);
});

test('every component has its own observed true value without changing any other component', () => {
    for (const label of COMPONENTS) {
        const result = read({ locked: false, open: [label] });
        const [group, key] = ACCESS_COMPONENTS[label];
        assert.equal(key ? result[group][key] : result[group], true, label);
        assert.equal(allOpenings(result).filter(Boolean).length, 1, label);
        assert.equal(result.locked, false);
    }
});

test('closing driver door, its window and trunk removes only the corresponding open values', () => {
    let remaining = [...COMPONENTS];
    const before = read({ locked: false, open: remaining });
    for (const label of ['Tür vorne links', 'Fenster vorne links', 'Kofferraum']) {
        remaining = remaining.filter(item => item !== label);
        const after = read({ locked: false, open: remaining });
        const expected = structuredClone(before);
        for (const closed of COMPONENTS.filter(item => !remaining.includes(item))) {
            const [group, key] = ACCESS_COMPONENTS[closed];
            if (key) expected[group][key] = false; else expected[group] = false;
        }
        assert.deepEqual(after.doors, expected.doors);
        assert.deepEqual(after.windows, expected.windows);
        assert.equal(after.trunkOpen, expected.trunkOpen);
        assert.equal(after.locked, false);
    }
});

test('complete blank car-status slot proves app-reported closed values for either lock state', () => {
    for (const locked of [false, true]) {
        const result = read({ locked });
        assert.deepEqual(allOpenings(result), Array(9).fill(false));
        assert.equal(result.locked, locked);
        assert.equal(result.warningText, '');
    }
});

test('synchronization wording is retained without inventing a vehicle timestamp', () => {
    for (const synchronizationText of ['Gerade synchronisiert', 'Synchronisiert vor 10 Minuten', 'Synchronisiert vor Eine Minute']) {
        const result = read({ synchronizationText });
        assert.equal(result.synchronizationText, synchronizationText);
        assert.equal(Object.hasOwn(result, 'observedAt'), false);
    }
});

test('unknown warning terms preserve exact known open values while omitted components remain unknown', () => {
    const result = read({ locked: false, open: ['Tür vorne links', 'Standlicht', 'Fenster hinten rechts'] });
    assert.equal(result.doors.frontLeft, true);
    assert.equal(result.windows.rearRight, true);
    assert.deepEqual(allOpenings(result).filter(value => value === null), Array(7).fill(null));
    assert.equal(result.locked, false);
    assert.match(result.warningText, /Standlicht/u);
});

test('an unsupported lights-only warning cannot turn all openings into closed observations', () => {
    assert.deepEqual(allOpenings(read({ locked: false, open: ['Unbekannte Meldung'] })), Array(9).fill(null));
});

test('malformed, duplicated and truncated warning lists never prove closed values', () => {
    const warnings = [
        'Fahrzeug ist entriegelt. Etwas ist noch offen oder eingeschaltet:. Tür vorne links',
        'Fahrzeug ist entriegelt. Etwas ist noch offen oder eingeschaltet:. Tür vorne links. Tür vorne links. ',
        'Fahrzeug ist entriegelt. Etwas ist noch offen oder eingeschaltet:. ',
        'Fahrzeug ist entriegelt. Neue Darstellung: Tür vorne links. ',
        'Andere Fahrzeuganzeige',
    ];
    for (const warning of warnings) {
        const result = read({ locked: false, warning });
        assert.deepEqual(allOpenings(result), Array(9).fill(null), warning);
        assert.equal(result.locked, false);
    }
});

test('contradictory warning and tile lock states fail instead of publishing a mixed snapshot', () => {
    assert.throws(() => read({ locked: true,
        warning: 'Fahrzeug ist entriegelt. Etwas ist noch offen oder eingeschaltet:. Kofferraum. ' }), rejects('unknown_state'));
});

test('missing or unsupported vehicle lock tile cannot prove a valid Home access snapshot', () => {
    for (const value of ['Fahrzeug. Unbekannt. Details öffnen', 'Fahrzeug. Entriegelt.', 'Anderes Fahrzeug']) {
        const xml = vehicleAccessScreen().replace('Fahrzeug. Verriegelt. Details öffnen', value);
        assert.throws(() => new Screen(xml).vehicleAccess(), rejects('unknown_state'));
    }
});

test('visible or hidden duplicate lock tiles are ambiguous even if they agree', () => {
    for (const hidden of [false, true]) {
        const extra = node('', { 'content-desc': 'Fahrzeug. Verriegelt. Details öffnen',
            'visible-to-user': String(!hidden), bounds: '[50,900][950,1050]' });
        assert.throws(() => new Screen(vehicleAccessScreen().replace('</hierarchy>', extra + '</hierarchy>')).vehicleAccess(), rejects('unknown_state'));
    }
});

test('lock status text must be readable and agree with the row description', () => {
    const xml = vehicleAccessScreen();
    for (const changed of [xml.replace('text="Verriegelt"', 'text="Entriegelt"'),
        xml.replace('text="Verriegelt"', 'text="Unbekannt"'),
        edit(xml, 'text="Verriegelt"', { 'visible-to-user': 'false' })]) {
        assert.throws(() => new Screen(changed).vehicleAccess(), rejects('unknown_state'));
    }
});

test('Home without the car graphic or complete status placeholder does not imply all closed', () => {
    const xml = vehicleAccessScreen();
    for (const changed of [xml.replace('androidx.compose.ui.viewinterop.ViewFactoryHolder', 'android.view.View'),
        edit(xml, 'bounds="[0,500][1000,580]"', { 'visible-to-user': 'false' }),
        edit(xml, 'bounds="[0,500][1000,580]"', { bounds: '[0,500][1000,500]' }),
        edit(xml, 'bounds="[0,500][1000,580]"', { bounds: '[0,480][1000,580]' }),
        xml.replace('resource-id="rangeTile"', 'resource-id="unrelatedTile"')]) {
        assert.throws(() => new Screen(changed).vehicleAccess(), rejects('unknown_state'));
    }
});

test('clipped, disabled or offscreen overview tiles are rejected instead of producing closed values', () => {
    const xml = vehicleAccessScreen();
    for (const changes of [{ bounds: '[50,40][450,140]' }, { bounds: '[50,515][450,515]' },
        { bounds: '[50,515][1450,850]' }, { enabled: 'false' }, { 'visible-to-user': 'false' }]) {
        assert.throws(() => new Screen(edit(xml, 'resource-id="rangeTile"', changes)).vehicleAccess(), rejects('unknown_state'));
    }
});

test('a full-size tile outside its clipping ancestor is not accepted', () => {
    const xml = edit(vehicleAccessScreen(), 'class="android.widget.ScrollView"', { bounds: '[0,600][1000,1440]' });
    assert.throws(() => new Screen(xml).vehicleAccess(), rejects('unknown_state'));
});

test('a partly scrolled car graphic needs native normalization even while both tiles remain below the sticky header', () => {
    for (const options of [{}, { locked: false, open: ['Kofferraum'] }]) {
        const partial = new Screen(partiallyScrolledAccessScreen(options));
        assert.equal(partial.overviewNeedsTop(), true);
        assert.throws(() => partial.vehicleAccess(), rejects('unknown_state'));
        assert.deepEqual(partial.overviewNativeScrollContext(), { header: 'Ihr Fahrzeug: Testwagen. Gerade synchronisiert',
            target: { class: 'android.widget.ScrollView', bounds: [0, 40, 1000, 1440] } });
    }
    assert.equal(new Screen(vehicleAccessScreen()).overviewNeedsTop(), false);
});

test('a signed off-window graphic is normalization evidence but cannot produce a closed access snapshot or tap target', () => {
    const xml = edit(partiallyScrolledAccessScreen(), 'class="androidx.compose.ui.viewinterop.ViewFactoryHolder"', {
        bounds: '[0,-150][1000,350]', 'visible-to-user': 'false',
    });
    const partial = new Screen(xml);
    assert.equal(partial.overviewNeedsTop(), true);
    assert.throws(() => partial.vehicleAccess(), rejects('unknown_state'));
    assert.deepEqual(partial.overviewNativeScrollContext().target.bounds, [0, 40, 1000, 1440]);
});

test('native Home scroll context refuses non-scrollable, hidden, disabled or ambiguous Home scopes', () => {
    const xml = partiallyScrolledAccessScreen();
    for (const changes of [{ scrollable: 'false' }, { enabled: 'false' }, { 'visible-to-user': 'false' }]) {
        assert.throws(() => new Screen(edit(xml, 'class="android.widget.ScrollView"', changes)).overviewNativeScrollContext());
    }
    const duplicate = xml.replace('</node></node></hierarchy>', node('', {
        'content-desc': 'Ihr Fahrzeug: Zweites Fahrzeug. Gerade synchronisiert', bounds: '[100,80][900,140]',
    }) + '</node></node></hierarchy>');
    assert.throws(() => new Screen(duplicate).overviewNativeScrollContext());
});

test('missing, duplicated, hidden or malformed header prevents a closed inference', () => {
    const xml = vehicleAccessScreen();
    for (const changed of [
        xml.replace('Ihr Fahrzeug: Testwagen. Gerade synchronisiert', 'Andere Überschrift'),
        xml.replace('Ihr Fahrzeug: Testwagen. Gerade synchronisiert', 'Ihr Fahrzeug: Testwagen. Aktualisierung unbekannt'),
        edit(xml, 'content-desc="Ihr Fahrzeug:', { 'visible-to-user': 'false' }),
        xml.replace('</hierarchy>', node('', { 'content-desc': 'Ihr Fahrzeug: Testwagen. Gerade synchronisiert' }) + '</hierarchy>'),
    ]) assert.throws(() => new Screen(changed).vehicleAccess(), rejects('unknown_state'));
});

test('a stale warning outside the status slot, including hidden text, blocks an all-closed inference', () => {
    for (const hidden of [false, true]) {
        const stale = node('', { 'content-desc': 'Fahrzeug ist entriegelt. Etwas ist noch offen oder eingeschaltet:. Kofferraum. ',
            'visible-to-user': String(!hidden), bounds: '[0,500][1000,580]' });
        assert.throws(() => new Screen(vehicleAccessScreen().replace('</hierarchy>', stale + '</hierarchy>')).vehicleAccess(), rejects('unknown_state'));
    }
});

test('dialogs, foreign apps and non-Home screens never publish closed access values', () => {
    const xml = vehicleAccessScreen();
    for (const extra of [node('alert_dialog', { class: 'android.app.Dialog' }), node('', { package: 'another.app' })]) {
        assert.throws(() => new Screen(xml.replace('</hierarchy>', extra + '</hierarchy>')).vehicleAccess(), rejects('blocked_ui'));
    }
    assert.throws(() => new Screen('<hierarchy/>').vehicleAccess(), rejects('unknown_state'));
});

test('model validator copies nullable booleans and text instead of retaining caller mutations', () => {
    const model = read({ locked: false });
    model.doors.frontLeft = null;
    model.windows.rearRight = null;
    model.locked = null;
    const result = validateVehicleAccess(model);
    assert.deepEqual(result, model);
    model.doors.frontLeft = true;
    assert.equal(result.doors.frontLeft, null);
    assert.equal(ACCESS_POSITIONS.length, 4);
});

test('model validation rejects absent, extra, non-boolean or excessive values', () => {
    const fresh = () => read({ locked: false });
    const candidates = [null, [], new Date(), { ...fresh(), extra: true },
        { ...fresh(), locked: 'false' }, { ...fresh(), trunkOpen: 0 },
        { ...fresh(), synchronizationText: '' }, { ...fresh(), synchronizationText: 'x'.repeat(513) },
        { ...fresh(), warningText: 'x'.repeat(4097) }, { ...fresh(), warningText: 'untrusted\ntext' },
        { ...fresh(), doors: { frontLeft: false } },
        { ...fresh(), windows: { ...fresh().windows, other: true } },
    ];
    for (const candidate of candidates) assert.throws(() => validateVehicleAccess(candidate), rejects('invalid_vehicle_access'));
});

test('model validation never executes getters or includes their private error text', () => {
    let executed = false;
    const model = read();
    Object.defineProperty(model, 'locked', { enumerable: true, get() { executed = true; throw Error('private content'); } });
    assert.throws(() => validateVehicleAccess(model), error => error.code === 'invalid_vehicle_access' && !error.message.includes('private content'));
    assert.equal(executed, false);
    assert.throws(() => validateVehicleAccess(new Proxy({}, { ownKeys() { throw Error('private content'); } })),
        error => error.code === 'invalid_vehicle_access' && !error.message.includes('private content'));
});
