'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Screen } = require('../lib/ui');
const { overviewChargingScreen, rangeScreen, chargingSettingsScreen, chargingFooterScreen, POINTS, node, hierarchy } = require('./support/charging-fixtures.cjs');
const { completeDemoClimate } = require('./support/settings-fixtures.cjs');

function rejects(code) { return error => error.code === code; }
function editNode(xml, marker, changes) {
    return xml.replace(/<node [^>]*>/g, tag => {
        if (!tag.includes(marker)) return tag;
        for (const [key, value] of Object.entries(changes)) {
            const attribute = new RegExp(' ' + key + '="[^"]*"');
            tag = attribute.test(tag) ? tag.replace(attribute, ' ' + key + '="' + value + '"') : tag.replace(/>$/, ' ' + key + '="' + value + '">');
        }
        return tag;
    });
}

test('battery overview reads range only and never invents SOC', () => {
    const screen = new Screen(overviewChargingScreen());
    assert.equal(screen.kind(), 'overview');
    assert.deepEqual(screen.batteryValues(), { soc: null, rangeKm: 205 });
    assert.deepEqual(screen.chargingNavigationTarget('range'), POINTS.range);
    assert.equal(new Screen(hierarchy()).batteryValues(), null);
    const openedDetail = overviewChargingScreen().replace('</hierarchy>', completeDemoClimate().replace('<hierarchy>', '').replace('</hierarchy>', '') + '</hierarchy>');
    assert.equal(new Screen(openedDetail).batteryValues(), null);
});

test('range details read matching SOC and range, with a separate close target', () => {
    const screen = new Screen(rangeScreen());
    assert.equal(screen.kind(), 'range');
    assert.deepEqual(screen.batteryValues(), { soc: 52, rangeKm: 205 });
    assert.deepEqual(screen.chargingNavigationTarget('back'), POINTS.back);
    assert.throws(() => screen.chargingNavigationTarget('start'), rejects('target_unavailable'));
    assert.throws(() => screen.target('cta_start'), rejects('target_unavailable'));
});

test('zero and full SOC are observations rather than missing values', () => {
    assert.deepEqual(new Screen(rangeScreen({ soc: 0, rangeKm: 0 })).batteryValues(), { soc: 0, rangeKm: 0 });
    assert.equal(new Screen(rangeScreen({ soc: 100 })).batteryValues().soc, 100);
    assert.throws(() => new Screen(rangeScreen({ soc: 101 })).batteryValues(), rejects('unknown_state'));
});

test('SOC text and accessibility description must agree', () => {
    assert.throws(() => new Screen(rangeScreen().replace('Batterie 52 %', 'Batterie 53 %')).batteryValues(), rejects('unknown_state'));
    assert.equal(new Screen(rangeScreen().replace('Ladestatus. Batterieladung:', 'Unbekannter Ladestatus:')).batteryValues().soc, null);
});

test('range values are scoped, unit-specific whole values', () => {
    const unrelated = node('', { 'content-desc': 'Übersicht Reichweite. Batteriereichweite: 999 Kilometer', bounds: '[0,0][50,50]' });
    assert.equal(new Screen(rangeScreen().replace('</hierarchy>', unrelated + '</hierarchy>')).batteryValues().rangeKm, 205);
    assert.equal(new Screen(rangeScreen().replace('205 Kilometer', '205 Meilen')).batteryValues().rangeKm, null);
    assert.equal(new Screen(rangeScreen().replace('205 Kilometer', '205.5 Kilometer')).batteryValues().rangeKm, null);
    assert.equal(new Screen(overviewChargingScreen().replace('205 Kilometer', '205 Kilometer Extra')).batteryValues().rangeKm, null);
});

test('duplicated range descriptions and SOC controls fail closed', () => {
    const duplicatedLabel = rangeScreen().replace('resource-id="rangeArcRangeAndUnit"',
        'content-desc="Übersicht Reichweite. Batteriereichweite: 205 Kilometer" resource-id="rangeArcRangeAndUnit"');
    assert.throws(() => new Screen(duplicatedLabel).batteryValues(), rejects('unknown_state'));
    const duplicateSoc = node('rangeArcBatterySoc', { class: 'android.widget.TextView', bounds: '[0,0][50,50]' });
    assert.throws(() => new Screen(rangeScreen().replace('</hierarchy>', duplicateSoc + '</hierarchy>')).kind(), rejects('unknown_state'));
});

test('range anchors from different containers or invalid views are rejected', () => {
    assert.throws(() => new Screen(editNode(rangeScreen(), 'resource-id="rangeArcRangeAndUnit"', { package: 'foreign.app' })).kind(), rejects('unknown_state'));
    assert.throws(() => new Screen(rangeScreen().replace('resource-id="rangeArcBatterySoc"', 'visible-to-user="false" resource-id="rangeArcBatterySoc"')).kind(), rejects('unknown_state'));
    assert.throws(() => new Screen(rangeScreen().replace('bounds="[150,1120][850,1200]"', 'bounds="[150,1120][150,1200]"')).batteryValues(), rejects('unknown_state'));
    assert.throws(() => new Screen(rangeScreen().replace('resource-id="rangeArcBatterySoc"', 'resource-id="notSoc"')).kind(), rejects('unknown_state'));
});

test('overview gestures are computed within the one observed scroll area', () => {
    const screen = new Screen(overviewChargingScreen());
    assert.deepEqual(screen.overviewScrollTarget('down'), { x1: 500, y1: 1000, x2: 500, y2: 400, durationMs: 400 });
    assert.deepEqual(screen.overviewScrollTarget('up'), { x1: 500, y1: 400, x2: 500, y2: 1000, durationMs: 400 });
    assert.throws(() => screen.overviewScrollTarget('left'), rejects('invalid_action'));
    assert.throws(() => new Screen(rangeScreen()).overviewScrollTarget('down'), rejects('target_unavailable'));
});

test('overview gestures reject disabled, hidden, foreign or duplicate scroll scopes', () => {
    const xml = overviewChargingScreen();
    assert.throws(() => new Screen(editNode(xml, 'scrollable="true"', { 'visible-to-user': 'false' })).overviewScrollTarget('down'), rejects('unknown_state'));
    assert.throws(() => new Screen(editNode(xml, 'scrollable="true"', { enabled: 'false' })).overviewScrollTarget('down'), rejects('target_unavailable'));
    assert.throws(() => new Screen(editNode(xml, 'scrollable="true"', { package: 'foreign.app' })).overviewScrollTarget('down'), rejects('unknown_state'));
    assert.throws(() => new Screen(xml.replace('scrollable="true"', 'scrollable="false"')).overviewScrollTarget('down'), rejects('target_unavailable'));
    const extra = node('', { class: 'android.widget.ScrollView', bounds: '[20,100][980,1300]' });
    assert.throws(() => new Screen(xml.replace(/(?=<node [^>]*class="android.widget.ScrollView")/, extra)).overviewScrollTarget('down'), rejects('unknown_state'));
});

test('vehicle settings navigation requires the exact visible label in the overview scroll', () => {
    const screen = new Screen(overviewChargingScreen({ lower: true }));
    assert.deepEqual(screen.chargingNavigationTarget('vehicleSettings'), POINTS.vehicleSettings);
    assert.deepEqual(screen.batteryValues(), { soc: null, rangeKm: 205 });
    screen.requireVehicle({ contentDescPrefix: 'Ihr Fahrzeug: Testwagen. ' });
    assert.throws(() => new Screen(overviewChargingScreen()).chargingNavigationTarget('vehicleSettings'), rejects('target_unavailable'));
    assert.throws(() => new Screen(overviewChargingScreen({ lower: true }).replace('Einstellungen. Details öffnen', 'Einstellungen')).chargingNavigationTarget('vehicleSettings'), rejects('target_unavailable'));
});

test('navigation refuses duplicate labels or disabled controls, and ignores labels outside scope', () => {
    const xml = overviewChargingScreen({ lower: true });
    const extra = node('', { 'content-desc': 'Einstellungen. Details öffnen', bounds: '[20,20][200,80]' });
    assert.deepEqual(new Screen(xml.replace('</hierarchy>', extra + '</hierarchy>')).chargingNavigationTarget('vehicleSettings'), POINTS.vehicleSettings);
    const duplicated = xml.replace(/<node [^>]*content-desc="Einstellungen\. Details öffnen"[^>]*><\/node>/, '$&$&');
    assert.throws(() => new Screen(duplicated).chargingNavigationTarget('vehicleSettings'), rejects('unknown_state'));
    assert.throws(() => new Screen(editNode(xml, 'bounds="[50,800][950,1000]"', { enabled: 'false' })).chargingNavigationTarget('vehicleSettings'), rejects('unknown_state'));
    assert.throws(() => new Screen(editNode(overviewChargingScreen(), 'resource-id="rangeTile"', { enabled: 'false' })).chargingNavigationTarget('range'), rejects('target_unavailable'));
});

test('native vehicle settings expose all four observed charging values and a separate internal name', () => {
    const screen = new Screen(chargingSettingsScreen());
    assert.equal(screen.kind(), 'vehicleSettings');
    assert.deepEqual(screen.chargingValues(), { socLimit: 100, reducedAcCurrent: true, autoUnlockAc: false, optimizedBatteryUse: true });
    assert.equal(screen.chargingVehicleName(), 'Testwagen');
    assert.deepEqual(screen.chargingNavigationTarget('back'), POINTS.vehicleSettingsBack);
    assert.equal(screen.batteryValues(), null);
    assert.equal(new Screen(overviewChargingScreen()).chargingValues(), null);
    assert.equal(new Screen(overviewChargingScreen()).chargingVehicleName(), null);
});

test('charging limit parsing uses the observed row, percent unit and numeric bounds', () => {
    assert.equal(new Screen(chargingSettingsScreen({ socLimit: 50 })).chargingValues().socLimit, 50);
    for (const value of [49, 101, '80.5', '080', '80 %', 'NaN']) {
        assert.throws(() => new Screen(chargingSettingsScreen({ socLimit: value })).chargingValues(), rejects('unknown_state'));
    }
    const xml = chargingSettingsScreen();
    assert.throws(() => new Screen(xml.replace('Laden bis (50-100 %)', 'Anderes Ladeziel')).chargingValues(), rejects('unknown_state'));
    assert.throws(() => new Screen(editNode(xml, 'resource-id="value"', { package: 'other.app' })).chargingValues(), rejects('unknown_state'));
    const unrelatedValue = node('value', { class: 'android.widget.TextView', text: '80%', bounds: '[0,0][20,20]' });
    assert.equal(new Screen(xml.replace('</hierarchy>', unrelatedValue + '</hierarchy>')).chargingValues().socLimit, 100);
});

test('charging toggle states validate the whole row and both narrow virtual switch layers', () => {
    assert.deepEqual(new Screen(chargingSettingsScreen({ reducedAcCurrent: false, autoUnlockAc: true, optimizedBatteryUse: false })).chargingValues(),
        { socLimit: 100, reducedAcCurrent: false, autoUnlockAc: true, optimizedBatteryUse: false });
    const xml = chargingSettingsScreen();
    const conflicting = xml.replace('checkable="true" checked="true"', 'checkable="true" checked="false"');
    assert.throws(() => new Screen(conflicting).chargingValues(), rejects('unknown_state'));
    assert.throws(() => new Screen(xml.replace('Reduzierter AC-Ladestrom', 'Unbekannter AC-Ladestrom')).chargingValues(), rejects('unknown_state'));
    const duplicate = xml.replace(/<node [^>]*text="Reduzierter AC-Ladestrom"[^>]*><\/node>/, '$&$&');
    assert.throws(() => new Screen(duplicate).chargingValues(), rejects('unknown_state'));
    const wrongBounds = xml.replace('bounds="[820,700][960,820]"', 'bounds="[830,700][960,820]"');
    assert.throws(() => new Screen(wrongBounds).chargingValues(), rejects('unknown_state'));
});

test('native settings need the exact header, charging category and package-scoped list', () => {
    const xml = chargingSettingsScreen();
    assert.equal(new Screen(xml.replace('text="Einstellungen"', 'text="Andere Ansicht"')).chargingValues(), null);
    assert.throws(() => new Screen(xml.replace('text="Laden"', 'text="Fremde Kategorie"').replace('Optimierte Batterienutzung', 'Andere Option')).kind(), rejects('unknown_state'));
    assert.throws(() => new Screen(editNode(xml, 'resource-id="recycler_view"', { 'visible-to-user': 'false' })).kind(), rejects('unknown_state'));
    assert.throws(() => new Screen(editNode(xml, 'resource-id="toolbar"', { package: 'other.app' })).kind(), rejects('unknown_state'));
});

test('vehicle name is read only from its expected edit field and is never a charging value', () => {
    const xml = chargingSettingsScreen();
    const outside = node('inputText', { class: 'android.widget.EditText', text: 'Other car', bounds: '[0,0][20,20]' });
    assert.equal(new Screen(xml.replace('</hierarchy>', outside + '</hierarchy>')).chargingVehicleName(), 'Testwagen');
    assert.throws(() => new Screen(xml.replace('text="Testwagen"', 'text=""')).chargingVehicleName(), rejects('unknown_state'));
    assert.throws(() => new Screen(editNode(xml, 'resource-id="inputText"', { class: 'android.widget.TextView' })).chargingVehicleName(), rejects('unknown_state'));
    assert.deepEqual(Object.keys(new Screen(xml).chargingValues()).sort(), ['socLimit', 'reducedAcCurrent', 'autoUnlockAc', 'optimizedBatteryUse'].sort());
});

test('charging toggles target only the verified narrow leaf and accept typed boolean values', () => {
    const screen = new Screen(chargingSettingsScreen());
    for (const key of ['reducedAcCurrent', 'autoUnlockAc', 'optimizedBatteryUse']) {
        assert.deepEqual(screen.chargingToggleTarget(key, false), { ...POINTS[key], value: false });
        assert.deepEqual(screen.chargingToggleTarget(key, true), { ...POINTS[key], value: true });
    }
    for (const key of ['socLimit', 'start', 'constructor', 'vwd_save_button']) {
        assert.throws(() => screen.chargingToggleTarget(key, true), rejects('invalid_charging'));
    }
    for (const value of ['true', 1, null, undefined]) {
        assert.throws(() => screen.chargingToggleTarget('autoUnlockAc', value), rejects('invalid_charging'));
    }
    assert.throws(() => new Screen(rangeScreen()).chargingToggleTarget('autoUnlockAc', true), rejects('target_unavailable'));
});

test('disabled charging labels, switches and ancestors cannot provide a gesture', () => {
    const xml = chargingSettingsScreen();
    assert.throws(() => new Screen(editNode(xml, 'bounds="[820,700][960,820]"', { enabled: 'false' })).chargingToggleTarget('reducedAcCurrent', false), rejects('target_unavailable'));
    assert.throws(() => new Screen(editNode(xml, 'text="Reduzierter AC-Ladestrom"', { enabled: 'false' })).chargingToggleTarget('reducedAcCurrent', false), rejects('target_unavailable'));
    assert.throws(() => new Screen(editNode(xml, 'resource-id="recycler_view"', { enabled: 'false' })).chargingToggleTarget('autoUnlockAc', true), rejects('target_unavailable'));
});

test('slider context supplies only freshly checked accessibility bounds for native geometry matching', () => {
    const screen = new Screen(chargingSettingsScreen());
    assert.deepEqual(screen.chargingSliderContext(), { scopeBounds: [0, 100, 1000, 1400],
        subtitleBounds: [100, 410, 900, 470], valueBounds: [800, 500, 920, 560] });
    assert.throws(() => new Screen(rangeScreen()).chargingSliderContext(), rejects('target_unavailable'));
    assert.throws(() => new Screen(editNode(chargingSettingsScreen(), 'resource-id="subtitle"', { enabled: 'false' })).chargingSliderContext(), rejects('target_unavailable'));
    assert.throws(() => new Screen(chargingSettingsScreen().replace('100%', 'Laden')).chargingSliderContext(), rejects('unknown_state'));
});

test('pending charging state requires the exact observed Save button in the native toolbar', () => {
    const clean = new Screen(chargingSettingsScreen());
    const dirty = new Screen(chargingSettingsScreen({ dirty: true }));
    assert.equal(clean.hasPendingChargingSettings(), false);
    assert.equal(dirty.hasPendingChargingSettings(), true);
    assert.equal(dirty.kind(), 'vehicleSettings');
    assert.deepEqual(dirty.chargingValues(), clean.chargingValues());
    assert.deepEqual(dirty.chargingSaveTarget(), POINTS.saveCharging);
    assert.throws(() => clean.chargingSaveTarget(), rejects('target_unavailable'));
    assert.equal(new Screen(rangeScreen()).hasPendingChargingSettings(), null);
    assert.throws(() => new Screen(rangeScreen()).chargingSaveTarget(), rejects('target_unavailable'));
});

test('disabled Save remains pending and does not authorize leaving with unsaved changes', () => {
    const screen = new Screen(editNode(chargingSettingsScreen({ dirty: true }), 'resource-id="vwd_save_button"', { enabled: 'false' }));
    assert.equal(screen.hasPendingChargingSettings(), true);
    assert.throws(() => screen.chargingSaveTarget(), rejects('target_unavailable'));
    const nonClickable = new Screen(editNode(chargingSettingsScreen({ dirty: true }), 'resource-id="vwd_save_button"', { clickable: 'false' }));
    assert.equal(nonClickable.hasPendingChargingSettings(), true);
    assert.throws(() => nonClickable.chargingSaveTarget(), rejects('target_unavailable'));
});

test('hidden, duplicate, foreign, misplaced or relabeled charging Save controls fail closed', () => {
    const xml = chargingSettingsScreen({ dirty: true });
    for (const changes of [{ 'visible-to-user': 'false' }, { package: 'other.app' },
        { 'resource-id': 'other.app:id/vwd_save_button' }, { text: 'Jetzt laden' }, { class: 'android.widget.TextView' },
        { bounds: '[800,900][980,980]' }]) {
        const screen = new Screen(editNode(xml, 'resource-id="vwd_save_button"', changes));
        assert.throws(() => screen.hasPendingChargingSettings(), rejects('unknown_state'));
        assert.throws(() => screen.chargingSaveTarget(), rejects('unknown_state'));
    }
    const save = node('vwd_save_button', { class: 'android.widget.Button', text: 'Speichern', clickable: 'true', bounds: '[800,10][980,90]' });
    assert.throws(() => new Screen(xml.replace('</hierarchy>', save + '</hierarchy>')).hasPendingChargingSettings(), rejects('unknown_state'));
    assert.throws(() => new Screen(chargingSettingsScreen().replace('</hierarchy>', save + '</hierarchy>')).hasPendingChargingSettings(), rejects('unknown_state'));
});

test('overview normalization detects clipped cards below the actual sticky vehicle header', () => {
    assert.equal(new Screen(overviewChargingScreen()).overviewNeedsTop(), false);
    assert.equal(new Screen(overviewChargingScreen({ lower: true })).overviewNeedsTop(), true);
    const zero = editNode(overviewChargingScreen(), 'resource-id="climateTile"', { bounds: '[0,0][0,0]' });
    assert.equal(new Screen(zero).overviewNeedsTop(), true);
    assert.deepEqual(new Screen(zero).overviewScrollTarget('up'), { x1: 500, y1: 400, x2: 500, y2: 1000, durationMs: 400 });
    const touching = editNode(overviewChargingScreen(), 'resource-id="climateTile"', { bounds: '[550,150][950,600]' });
    assert.equal(new Screen(touching).overviewNeedsTop(), true);
    const english = overviewChargingScreen({ lower: true }).replace('Ihr Fahrzeug: Testwagen. Gerade synchronisiert', 'Your vehicle: Test car. Just synchronized');
    assert.equal(new Screen(english).overviewNeedsTop(), true);
});

test('overview normalization does not guess a header for legacy fixtures and rejects ambiguity', () => {
    assert.equal(new Screen(hierarchy([node('climateTile')])).overviewNeedsTop(), false);
    assert.equal(new Screen(overviewChargingScreen({ lower: true }).replace('Ihr Fahrzeug: Testwagen.', 'Anderes Merkmal: Testwagen.')).overviewNeedsTop(), false);
    const duplicateHeader = overviewChargingScreen().replace(/<node [^>]*content-desc="Ihr Fahrzeug: Testwagen\. Gerade synchronisiert"[^>]*><\/node>/, '$&$&');
    assert.throws(() => new Screen(duplicateHeader).overviewNeedsTop(), rejects('unknown_state'));
    assert.throws(() => new Screen(editNode(overviewChargingScreen(), 'resource-id="climateTile"', { bounds: 'invalid' })).overviewNeedsTop(), rejects('unknown_state'));
    assert.throws(() => new Screen(rangeScreen()).overviewNeedsTop(), rejects('target_unavailable'));
    const climateOnly = overviewChargingScreen({ lower: true, includeRange: false });
    assert.equal(new Screen(climateOnly).overviewNeedsTop(), true);
});

test('native charging scrolling stays recognized at the observed lower charging label without partial value guesses', () => {
    const full = chargingSettingsScreen();
    assert.deepEqual(new Screen(full).chargingSettingsScrollTarget('down'), { x1: 500, y1: 1075, x2: 500, y2: 425, durationMs: 400 });
    assert.deepEqual(new Screen(full).chargingSettingsScrollTarget('up'), { x1: 500, y1: 425, x2: 500, y2: 1075, durationMs: 400 });
    let lower = editNode(full, 'text="Laden"', { 'visible-to-user': 'false' });
    lower = editNode(lower, 'resource-id="subtitle"', { 'visible-to-user': 'false' });
    const screen = new Screen(lower);
    assert.equal(screen.kind(), 'vehicleSettings');
    assert.deepEqual(screen.chargingSettingsScrollTarget('up'), { x1: 500, y1: 425, x2: 500, y2: 1075, durationMs: 400 });
    assert.throws(() => screen.chargingValues(), rejects('unknown_state'));
    assert.throws(() => new Screen(lower.replace('Optimierte Batterienutzung', 'Fremde Option')).kind(), rejects('unknown_state'));
});

test('native charging scrolling rejects disabled or non-scrollable scopes and unsupported directions', () => {
    const xml = chargingSettingsScreen();
    assert.throws(() => new Screen(editNode(xml, 'resource-id="recycler_view"', { enabled: 'false' })).chargingSettingsScrollTarget('down'), rejects('target_unavailable'));
    assert.throws(() => new Screen(editNode(xml, 'resource-id="recycler_view"', { scrollable: 'false' })).chargingSettingsScrollTarget('down'), rejects('target_unavailable'));
    assert.throws(() => new Screen(xml).chargingSettingsScrollTarget('left'), rejects('invalid_action'));
    assert.throws(() => new Screen(overviewChargingScreen()).chargingSettingsScrollTarget('down'), rejects('target_unavailable'));
});

test('charging normalization requests top only while expected visible fields are missing', () => {
    const xml = chargingSettingsScreen();
    assert.equal(new Screen(xml).chargingNeedsTop(), false);
    assert.equal(new Screen(chargingSettingsScreen({ dirty: true })).chargingNeedsTop(), false);
    for (const marker of ['resource-id="subtitle"', 'resource-id="value"', 'resource-id="vehicle_name"',
        'resource-id="inputText"', 'text="Reduzierter AC-Ladestrom"', 'text="AC-Stecker automatisch entriegeln"',
        'text="Optimierte Batterienutzung"']) {
        assert.equal(new Screen(editNode(xml, marker, { 'visible-to-user': 'false' })).chargingNeedsTop(), true, marker);
    }
    assert.throws(() => new Screen(overviewChargingScreen()).chargingNeedsTop(), rejects('target_unavailable'));
});

test('charging normalization never tries to scroll away duplicate, malformed or contradictory visible controls', () => {
    const xml = chargingSettingsScreen();
    const noName = editNode(xml, 'resource-id="vehicle_name"', { 'visible-to-user': 'false' });
    const duplicateLabel = noName.replace(/<node [^>]*text="Reduzierter AC-Ladestrom"[^>]*><\/node>/, '$&$&');
    assert.throws(() => new Screen(duplicateLabel).chargingNeedsTop(), rejects('unknown_state'));
    const contradictory = noName.replace('checkable="true" checked="true"', 'checkable="true" checked="false"');
    assert.throws(() => new Screen(contradictory).chargingNeedsTop(), rejects('unknown_state'));
    const duplicateValue = noName.replace(/<node [^>]*resource-id="value"[^>]*><\/node>/, '$&$&');
    assert.throws(() => new Screen(duplicateValue).chargingNeedsTop(), rejects('unknown_state'));
    const noFirstFlag = editNode(xml, 'text="Reduzierter AC-Ladestrom"', { 'visible-to-user': 'false' });
    assert.throws(() => new Screen(noFirstFlag.replace('text="Testwagen"', 'text=""')).chargingNeedsTop(), rejects('unknown_state'));
    assert.throws(() => new Screen(noName.replace('100%', '80.5%')).chargingNeedsTop(), rejects('unknown_state'));
});

test('the observed synchronization footer remains a known settings page without inventing charging values', () => {
    const screen = new Screen(chargingFooterScreen());
    assert.equal(screen.kind(), 'vehicleSettings');
    assert.equal(screen.chargingNeedsTop(), true);
    assert.equal(screen.hasPendingChargingSettings(), false);
    assert.throws(() => screen.chargingValues(), rejects('unknown_state'));
    assert.deepEqual(screen.chargingNavigationTarget('synchronize'), POINTS.synchronize);
    assert.deepEqual(screen.chargingNavigationTarget('back'), POINTS.vehicleSettingsBack);
    assert.deepEqual(screen.chargingSettingsScrollTarget('up'), { x1: 500, y1: 425, x2: 500, y2: 1075, durationMs: 400 });
    assert.throws(() => new Screen(chargingSettingsScreen()).chargingNavigationTarget('synchronize'), rejects('target_unavailable'));
});

test('synchronization needs the exact link, category and direct sibling explanation in the native settings scope', () => {
    const xml = chargingFooterScreen();
    for (const replacement of [['Jetzt synchronisieren', 'Synchronisieren'], ['Fahrzeugdaten', 'Andere Daten'],
        ['Der Vorgang kann einige Minuten dauern.', 'Vorgang starten.']]) {
        assert.throws(() => new Screen(xml.replace(...replacement)).chargingNavigationTarget('synchronize'), rejects('unknown_state'));
    }
    for (const changes of [{ class: 'android.widget.Button' }, { package: 'other.app' }, { 'visible-to-user': 'false' },
        { 'resource-id': 'other_link' }]) {
        assert.throws(() => new Screen(editNode(xml, 'resource-id="subtitle_cta"', changes)).chargingNavigationTarget('synchronize'), rejects('unknown_state'));
    }
    const duplicate = xml.replace(/<node [^>]*resource-id="subtitle_cta"[^>]*><\/node>/, '$&$&');
    assert.throws(() => new Screen(duplicate).chargingNavigationTarget('synchronize'), rejects('unknown_state'));
    const outside = node('subtitle_cta', { class: 'android.widget.TextView', text: 'Jetzt synchronisieren', clickable: 'true', bounds: '[0,0][100,50]' });
    assert.throws(() => new Screen(chargingSettingsScreen().replace('</hierarchy>', outside + '</hierarchy>')).chargingNavigationTarget('synchronize'), rejects('target_unavailable'));
});

test('synchronization never returns a gesture through disabled controls or unsupported charging actions', () => {
    const xml = chargingFooterScreen();
    assert.throws(() => new Screen(editNode(xml, 'resource-id="subtitle_cta"', { enabled: 'false' })).chargingNavigationTarget('synchronize'), rejects('target_unavailable'));
    assert.throws(() => new Screen(editNode(xml, 'resource-id="subtitle_cta"', { clickable: 'false' })).chargingNavigationTarget('synchronize'), rejects('target_unavailable'));
    assert.throws(() => new Screen(editNode(xml, 'resource-id="recycler_view"', { enabled: 'false' })).chargingNavigationTarget('synchronize'), rejects('target_unavailable'));
    for (const destination of ['startCharging', 'stopCharging', 'delete', 'subtitle_cta']) {
        assert.throws(() => new Screen(xml).chargingNavigationTarget(destination), rejects('target_unavailable'));
    }
});

test('synchronization state distinguishes an enabled ready link from its own explicit busy state', () => {
    assert.equal(new Screen(chargingFooterScreen()).chargingSyncState(), 'ready');
    const busy = new Screen(chargingFooterScreen({ busy: true }));
    assert.equal(busy.kind(), 'vehicleSettings');
    assert.equal(busy.chargingSyncState(), 'busy');
    assert.throws(() => busy.chargingNavigationTarget('synchronize'), rejects('target_unavailable'));
    assert.equal(new Screen(chargingSettingsScreen()).chargingSyncState(), null);
    assert.equal(new Screen(overviewChargingScreen()).chargingSyncState(), null);
    assert.equal(new Screen(rangeScreen()).chargingSyncState(), null);
    assert.equal(new Screen(hierarchy()).chargingSyncState(), null);
});

test('a disabled or unclear synchronization container cannot masquerade as an accepted request', () => {
    for (const busy of [false, true]) {
        const xml = chargingFooterScreen({ busy });
        assert.throws(() => new Screen(editNode(xml, 'resource-id="recycler_view"', { enabled: 'false' })).chargingSyncState(), rejects('unknown_state'));
        assert.throws(() => new Screen(editNode(xml, 'bounds="[0,750][1000,1100]"', { enabled: 'false' })).chargingSyncState(), rejects('unknown_state'));
        assert.throws(() => new Screen(editNode(xml, 'resource-id="subtitle_cta"', { enabled: 'unknown' })).chargingSyncState(), rejects('unknown_state'));
    }
    const nonClickable = editNode(chargingFooterScreen(), 'resource-id="subtitle_cta"', { clickable: 'false' });
    assert.throws(() => new Screen(nonClickable).chargingSyncState(), rejects('target_unavailable'));
    const duplicate = chargingFooterScreen().replace(/<node [^>]*resource-id="subtitle_cta"[^>]*><\/node>/, '$&$&');
    assert.throws(() => new Screen(duplicate).chargingSyncState(), rejects('unknown_state'));
});
