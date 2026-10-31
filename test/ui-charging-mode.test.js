'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Screen } = require('../lib/ui');
const { extendedViewToXml } = require('../lib/accessibility-view');
const { rangeModeScreen, chargingModeScreen, nativeObservationFromXml, MODE_LABELS, MODE_POINTS } = require('./support/charging-mode-fixtures.cjs');
const { rangeScreen, overviewChargingScreen, node } = require('./support/charging-fixtures.cjs');

const rejectedTarget = error => error.code === 'target_unavailable';
function editNode(xml, marker, key, value) {
    return xml.replace(/<node [^>]*>/g, tag => {
        if (!tag.includes(marker)) return tag;
        const attribute = new RegExp(' ' + key + '="[^"]*"');
        return attribute.test(tag) ? tag.replace(attribute, ` ${key}="${value}"`) : tag.replace(/>$/, ` ${key}="${value}">`);
    });
}

test('charging mode is read from the exact range summary independently of battery', () => {
    for (const mode of Object.keys(MODE_LABELS)) {
        const screen = new Screen(rangeModeScreen({ mode }));
        assert.equal(screen.kind(), 'range');
        assert.equal(screen.chargingModeValue(), mode);
        assert.deepEqual(screen.batteryValues(), { soc: 52, rangeKm: 205 });
        assert.deepEqual(screen.chargingModeNavigationTarget(), MODE_POINTS.open);
    }
});

test('an absent or unrecognized mode does not invent a value or break battery observations', () => {
    for (const xml of [rangeScreen(), rangeModeScreen({ description: 'Ladeverfahren. Unbekannt. Ladeverfahren ändern' }),
        rangeModeScreen({ description: 'Ladeverfahren. Sofortladen. Ladeverfahren ändern Extra' }),
        rangeModeScreen({ description: 'Sofortladen' })]) {
        const screen = new Screen(xml);
        assert.equal(screen.chargingModeValue(), null);
        assert.deepEqual(screen.batteryValues(), { soc: 52, rangeKm: 205 });
        assert.throws(() => screen.chargingModeNavigationTarget(), rejectedTarget);
    }
    assert.equal(new Screen(overviewChargingScreen()).chargingModeValue(), null);
});

test('mode summary is scoped to range and rejects ambiguous labels even if they agree', () => {
    const extra = node('', { 'content-desc': 'Ladeverfahren. Laden & Klima zur Abfahrt. Ladeverfahren ändern', bounds: '[60,1130][940,1210]' });
    for (const extraMode of [extra, extra.replace('Laden &amp; Klima zur Abfahrt', 'Sofortladen')]) {
        const screen = new Screen(rangeModeScreen({ extraMode }));
        assert.equal(screen.chargingModeValue(), null);
        assert.deepEqual(screen.batteryValues(), { soc: 52, rangeKm: 205 });
        assert.throws(() => screen.chargingModeNavigationTarget(), rejectedTarget);
    }
    const outside = node('', { 'content-desc': 'Ladeverfahren. Sofortladen. Ladeverfahren ändern', bounds: '[0,0][50,50]' });
    assert.equal(new Screen(rangeModeScreen().replace('</hierarchy>', outside + '</hierarchy>')).chargingModeValue(), 'departureClimate');
});

test('mode navigation uses the fresh enabled clickable summary parent, never the charging start CTA', () => {
    const xml = rangeModeScreen();
    for (const changed of [editNode(xml, 'bounds="[50,1120][950,1220]"', 'clickable', 'false'),
        editNode(xml, 'content-desc="Ladeverfahren.', 'visible-to-user', 'false'),
        editNode(xml, 'content-desc="Ladeverfahren.', 'package', 'foreign.app'),
        editNode(xml, 'content-desc="Ladeverfahren.', 'class', 'android.widget.TextView')]) {
        const screen = new Screen(changed);
        assert.equal(screen.chargingModeValue(), null);
        assert.throws(() => screen.chargingModeNavigationTarget(), error => ['target_unavailable', 'blocked_ui'].includes(error.code));
    }
    assert.throws(() => new Screen(xml).chargingNavigationTarget('start'), rejectedTarget);
});

test('disabled mode descriptions remain readable but never provide a navigation target', () => {
    for (const mode of Object.keys(MODE_LABELS)) {
        const xml = rangeModeScreen({ mode, enabled: false });
        for (const view of [xml, extendedViewToXml(JSON.stringify(nativeObservationFromXml(xml)))]) {
            const screen = new Screen(view);
            assert.equal(screen.chargingModeValue(), mode);
            assert.deepEqual(screen.batteryValues(), { soc: 52, rangeKm: 205 });
            assert.throws(() => screen.chargingModeNavigationTarget(), rejectedTarget);
        }
    }
    const disabledLabel = editNode(rangeModeScreen(), 'content-desc="Ladeverfahren.', 'enabled', 'false');
    const screen = new Screen(disabledLabel);
    assert.equal(screen.chargingModeValue(), 'departureClimate');
    assert.throws(() => screen.chargingModeNavigationTarget(), rejectedTarget);
});

test('missing or malformed enabled metadata never becomes a known mode', () => {
    for (const enabled of ['', 'unknown', 'True']) {
        const xml = editNode(rangeModeScreen(), 'content-desc="Ladeverfahren.', 'enabled', enabled);
        const screen = new Screen(xml);
        assert.equal(screen.chargingModeValue(), null);
        assert.throws(() => screen.chargingModeNavigationTarget(), rejectedTarget);
    }
    const missing = rangeModeScreen().replace(/<node [^>]*>/g, tag => tag.includes('content-desc="Ladeverfahren.')
        ? tag.replace(' enabled="true"', '') : tag);
    const screen = new Screen(missing);
    assert.equal(screen.chargingModeValue(), null);
    assert.throws(() => screen.chargingModeNavigationTarget(), rejectedTarget);
});

test('mode navigation refuses a foreign overlay', () => {
    const overlay = node('', { package: 'foreign.app', bounds: '[0,0][1000,1400]' });
    const screen = new Screen(rangeModeScreen().replace('</hierarchy>', overlay + '</hierarchy>'));
    assert.throws(() => screen.chargingModeNavigationTarget(), error => error.code === 'blocked_ui');
});

test('the mode picker identifies every choice by its complete heading and its selected state', () => {
    for (const mode of Object.keys(MODE_LABELS)) {
        const screen = new Screen(chargingModeScreen({ mode }));
        assert.equal(screen.kind(), 'chargingMode');
        assert.deepEqual(screen.chargingModeSelection(), { mode });
        assert.deepEqual(screen.chargingModeBackTarget(), MODE_POINTS.back);
        assert.deepEqual(screen.chargingModeBackContext(), { header: 'Ladeverfahren', target: {
            id: 'chargeModeSelectionBack', class: 'android.view.View', bounds: [20, 0, 120, 100],
        } });
        for (const choice of Object.keys(MODE_LABELS)) {
            if (choice === mode) assert.throws(() => screen.chargingModeTarget(choice), rejectedTarget);
            else assert.deepEqual(screen.chargingModeTarget(choice), MODE_POINTS[choice]);
        }
        assert.equal(screen.batteryValues(), null);
    }
});

test('the observed empty Compose focus wrapper preserves the complete charging choice context', () => {
    for (const wrapperCount of [0, 1, 2, 4]) {
        for (const actions of ['[]', '[64]']) {
            const xml = editNode(chargingModeScreen({ wrapperCount }), 'a11y-actions="[64]"', 'a11y-actions', actions);
            const screen = new Screen(xml);
            assert.equal(screen.kind(), 'chargingMode');
            assert.deepEqual(screen.chargingModeSelection(), { mode: 'departure' });
            assert.deepEqual(screen.chargingModeTarget('departureClimate'), MODE_POINTS.departureClimate);
            assert.equal(screen.chargingModeBackContext().target.id, 'chargeModeSelectionBack');
        }
    }
});

test('Compose wrappers may not add interaction, labels, siblings, clipping or unbounded depth', () => {
    const marker = 'a11y-actions="[64]"';
    const xml = chargingModeScreen();
    const variants = [
        ...['clickable', 'long-clickable', 'checkable', 'checked', 'selected', 'scrollable'].map(key => editNode(xml, marker, key, 'true')),
        ...['resource-id', 'text', 'content-desc', 'state-description'].map(key => editNode(xml, marker, key, 'unknown')),
        ...['[16]', '[32]', '[4096]', '[2097152]', '[16908349]', '[64,16]', '[64,64]', 'not json']
            .map(actions => editNode(xml, marker, 'a11y-actions', actions)),
        editNode(xml, marker, 'class', 'android.widget.FrameLayout'),
        editNode(xml, marker, 'enabled', 'false'),
        editNode(xml, marker, 'visible-to-user', 'false'),
        editNode(xml, marker, 'bounds', '[0,0][1000,1300]'),
        xml.replace(/<node [^>]*a11y-actions="\[64\]"[^>]*>/, '$&' + node('', { clickable: 'true' })),
        chargingModeScreen({ wrapperCount: 5 }),
    ];
    for (const changed of variants) {
        const screen = new Screen(changed);
        assert.throws(() => screen.chargingModeTarget('immediate'), error => error.code === 'unknown_state');
        assert.throws(() => screen.chargingModeBackContext(), error => error.code === 'unknown_state');
    }
});

test('mode choices follow current labels and geometry rather than fixed indexes or stored points', () => {
    const screen = new Screen(chargingModeScreen({ mode: 'immediate', order: ['departureClimate', 'immediate', 'departure'] }));
    assert.deepEqual(screen.chargingModeSelection(), { mode: 'immediate' });
    assert.deepEqual(screen.chargingModeTarget('departureClimate'), MODE_POINTS.immediate);
    assert.deepEqual(screen.chargingModeTarget('departure'), MODE_POINTS.departureClimate);
});

test('the mode explanation may include a synthetic changing temperature without changing its identity', () => {
    for (const temperature of ['19', '21.5', '22,5']) {
        const description = `Laden &amp; Klima zur Abfahrt. Ihr Fahrzeug wird zu Ihren Abfahrtszeiten geladen und auf die gewählte Temperatur von ${temperature} Grad Celsius klimatisiert.. Dieses Ladeverfahren wählen`;
        const xml = chargingModeScreen().replace('Laden &amp; Klima zur Abfahrt. Erklärung des Ladeverfahrens. Dieses Ladeverfahren wählen', description);
        const screen = new Screen(xml);
        assert.deepEqual(screen.chargingModeSelection(), { mode: 'departure' });
        assert.deepEqual(screen.chargingModeTarget('departureClimate'), MODE_POINTS.departureClimate);
    }
});

test('unknown, missing and duplicate mode labels never authorize a pointer exception', () => {
    const xml = chargingModeScreen();
    const duplicate = xml.replace('Sofortladen. Erklärung', 'Laden zur Abfahrtszeit. Erklärung');
    for (const changed of [duplicate, xml.replace('Sofortladen. Erklärung', 'Sofortladen Extra. Erklärung'),
        xml.replace('Laden &amp; Klima zur Abfahrt. Erklärung', 'Unbekannte Funktion. Erklärung'),
        xml.replace('Dieses Ladeverfahren wählen', 'Jetzt starten'),
        editNode(xml, 'content-desc="Sofortladen.', 'content-desc', ''),
        editNode(xml, 'content-desc="Sofortladen.', 'class', 'android.view.View')]) {
        const screen = new Screen(changed);
        assert.throws(() => screen.chargingModeSelection(), error => error.code === 'unknown_state');
        assert.throws(() => screen.chargingModeTarget('immediate'), error => error.code === 'unknown_state');
        assert.throws(() => screen.chargingModeBackTarget(), error => error.code === 'unknown_state');
        assert.throws(() => screen.chargingModeBackContext(), error => error.code === 'unknown_state');
    }
});

test('selection requires exactly one consistent checked card and the observed selected description', () => {
    const xml = chargingModeScreen();
    for (const changed of [editNode(xml, 'content-desc="Laden zur Abfahrtszeit.', 'checked', 'false'),
        editNode(xml, 'content-desc="Sofortladen.', 'checked', 'true'),
        editNode(xml, 'content-desc="Laden zur Abfahrtszeit.', 'checkable', 'false'),
        editNode(xml, 'content-desc="Laden zur Abfahrtszeit.', 'state-description', ''),
        editNode(xml, 'content-desc="Sofortladen.', 'state-description', 'Ausgewählt'),
        editNode(xml, 'content-desc="Laden zur Abfahrtszeit.', 'selected', 'true'),
        xml.replace('Erklärung des Ladeverfahrens. Ausgewählt', 'Erklärung des Ladeverfahrens. Dieses Ladeverfahren wählen')]) {
        assert.throws(() => new Screen(changed).chargingModeSelection(), error => error.code === 'unknown_state');
    }
});

test('the pointer exception rejects disabled, hidden, foreign, overlapping and changed groups', () => {
    const xml = chargingModeScreen();
    for (const changed of [editNode(xml, 'content-desc="Sofortladen.', 'enabled', 'false'),
        editNode(xml, 'content-desc="Sofortladen.', 'visible-to-user', 'false'),
        editNode(xml, 'content-desc="Sofortladen.', 'package', 'foreign.app'),
        editNode(xml, 'content-desc="Sofortladen.', 'bounds', '[50,600][950,800]'),
        editNode(xml, 'content-desc="Sofortladen.', 'bounds', '[20,0][120,100]'),
        editNode(xml, 'class="androidx.compose.ui.platform.ComposeView"', 'enabled', 'false'),
        editNode(xml, 'bounds="[0,100][1000,1400]"', 'class', 'android.widget.ScrollView'),
        editNode(xml, 'bounds="[0,100][1000,1400]"', 'bounds', '[0,100][1000,300]'),
        xml.replace('<node package="com.volkswagen.weconnect" class="android.view.View" enabled="true" clickable="false" bounds="[50,100][950,230]"></node>', '')]) {
        const screen = new Screen(changed);
        assert.throws(() => screen.chargingModeTarget('immediate'), error => ['unknown_state', 'blocked_ui'].includes(error.code));
    }
});

test('a clickable same-package overlay outside the picker prevents card selection', () => {
    const overlay = node('', { clickable: 'true' });
    const screen = new Screen(chargingModeScreen().replace('</hierarchy>', overlay + '</hierarchy>'));
    assert.throws(() => screen.chargingModeTarget('immediate'), error => error.code === 'unknown_state');
    const insideScope = new Screen(chargingModeScreen().replace(/<\/node><\/hierarchy>$/, overlay + '</node></hierarchy>'));
    assert.throws(() => insideScope.chargingModeTarget('immediate'), error => error.code === 'unknown_state');
    const headerOverlay = node('', { clickable: 'true', bounds: '[0,0][150,100]' });
    const blockedHeader = new Screen(chargingModeScreen().replace('</hierarchy>', headerOverlay + '</hierarchy>'));
    assert.throws(() => blockedHeader.chargingModeBackTarget(), error => error.code === 'unknown_state');
});

test('picker header identity, ownership and enabled return control are required', () => {
    const xml = chargingModeScreen();
    for (const changed of [xml.replace('content-desc="Ladeverfahren"', 'content-desc="Andere Ansicht"'),
        editNode(xml, 'resource-id="chargeModeSelectionBack"', 'enabled', 'false'),
        editNode(xml, 'resource-id="chargeModeSelectionBack"', 'package', 'foreign.app'),
        editNode(xml, 'resource-id="chargeModeSelectionBack"', 'bounds', '[20,0][20,100]')]) {
        assert.throws(() => new Screen(changed).chargingModeTarget('immediate'), error => ['unknown_state', 'blocked_ui'].includes(error.code));
    }
    const screen = new Screen(xml);
    for (const invalid of [null, undefined, ['immediate'], {}, 'constructor', 'toString', 'start', 'Immediate']) {
        assert.throws(() => screen.chargingModeTarget(invalid), error => error.code === 'invalid_charging_mode');
    }
    for (const actions of ['', '[]', '[64]', 'not json']) {
        const changed = new Screen(editNode(xml, 'resource-id="chargeModeSelectionBack"', 'a11y-actions', actions));
        assert.throws(() => changed.chargingModeBackContext(), rejectedTarget);
    }
});
