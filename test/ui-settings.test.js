'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Screen } = require('../lib/ui');
const { BridgeError } = require('../lib/errors');
const { completeDemoClimate, modeScreen, settingsScreen, zonesScreen, POINTS, node } = require('./support/settings-fixtures.cjs');

function code(expected, operation) {
    assert.throws(operation, error => error instanceof BridgeError && error.code === expected);
}
function attribute(tag, name) { return new RegExp('\\b' + name + '="([^"]*)"').exec(tag)?.[1]; }
function editTag(xml, predicate, changes, occurrence = 0) {
    let found = 0;
    let changed = false;
    const result = xml.replace(/<node\b[^>]*>/g, tag => {
        if (!predicate(tag) || found++ !== occurrence) return tag;
        changed = true;
        for (const [name, value] of Object.entries(changes)) {
            const pattern = new RegExp(' ' + name + '="[^"]*"');
            if (value === null) tag = tag.replace(pattern, '');
            else if (pattern.test(tag)) tag = tag.replace(pattern, ' ' + name + '="' + value + '"');
            else tag = tag.slice(0, -1) + ' ' + name + '="' + value + '">';
        }
        return tag;
    });
    assert.equal(changed, true, 'synthetic mutation must match one intended node');
    return result;
}
const id = value => tag => attribute(tag, 'resource-id') === value;
const checkable = tag => attribute(tag, 'checkable') === 'true';

test('recognized detail, mode, settings and zones views have separate exact APIs', () => {
    for (const mode of ['climate', 'windowHeating']) {
        const detail = new Screen(completeDemoClimate('off', mode));
        assert.equal(detail.kind(), 'climate');
        assert.equal(detail.climateMode(), mode);
        const picker = new Screen(modeScreen(mode));
        picker.checkClear();
        assert.equal(picker.kind(), 'mode');
        assert.equal(picker.climateMode(), mode);
        assert.deepEqual(picker.modeChoice(mode), { ...POINTS[mode], value: mode });
    }
    assert.equal(new Screen(settingsScreen()).kind(), 'settings');
    assert.equal(new Screen(zonesScreen()).kind(), 'zones');
    const empty = new Screen('<hierarchy/>');
    assert.equal(empty.climateMode(), null);
    assert.equal(empty.settingsValues(), null);
    assert.equal(empty.zonesValues(), null);
});

test('navigation targets are derived from the recognized local header or climate row', () => {
    const detail = new Screen(completeDemoClimate());
    assert.deepEqual(detail.navigationTarget('mode'), POINTS.mode);
    assert.deepEqual(detail.navigationTarget('settings'), POINTS.settings);
    assert.deepEqual(detail.navigationTarget('back'), POINTS.back);
    assert.deepEqual(new Screen(modeScreen()).navigationTarget('back'), POINTS.back);
    assert.deepEqual(new Screen(settingsScreen()).navigationTarget('back'), POINTS.back);
    assert.deepEqual(new Screen(settingsScreen()).navigationTarget('zones'), POINTS.zones);
    assert.deepEqual(new Screen(zonesScreen()).navigationTarget('back'), POINTS.back);
    code('target_unavailable', () => detail.navigationTarget('zones'));
    code('target_unavailable', () => new Screen(zonesScreen()).navigationTarget('mode'));
    code('target_unavailable', () => detail.navigationTarget('cta_start'));
});

test('zone navigation targets the inner observed count selection rather than its description row', () => {
    for (const label of ['0 Zonen', '1 Zone', '2 Zonen']) {
        const target = new Screen(settingsScreen(true, true, label)).navigationTarget('zones');
        assert.deepEqual(target, { x: 875, y: 800 });
        assert.notDeepEqual(target, { x: 500, y: 875 });
        assert.ok(target.x >= 800 && target.x < 950 && target.y >= 760 && target.y < 840);
    }
});

test('zone navigation accepts the observed directional summaries and their changed control width', () => {
    for (const label of ['Vorne links', 'Vorne rechts']) {
        const screen = new Screen(settingsScreen(true, true, label, true));
        assert.deepEqual(screen.navigationTarget('zones'), POINTS.zonesDirectional);
        assert.notDeepEqual(screen.navigationTarget('zones'), POINTS.zones);
        assert.equal(screen.hasPendingSettings(), true);
        assert.equal(screen.zonesValues(), null); // The summary is navigation, not a replacement for zone checkbox readback.
    }
    for (const label of ['vorne links', 'Vorne links ', 'Vorne rechts extra']) {
        code('target_unavailable', () => new Screen(settingsScreen(true, true, label)).navigationTarget('zones'));
    }
});

test('zone navigation refuses absent, disabled, foreign or non-clickable inner selections', () => {
    const selection = tag => attribute(tag, 'bounds') === '[800,760][950,840]';
    for (const changes of [{ clickable: 'false' }, { enabled: 'false' }, { 'visible-to-user': 'false' },
        { bounds: '[0,0][0,0]' }, { package: 'com.android.settings' }, { class: 'android.view.ViewGroup' }]) {
        const xml = editTag(settingsScreen(), selection, changes);
        code('target_unavailable', () => new Screen(xml).navigationTarget('zones'));
    }
    const disabledLabel = editTag(settingsScreen(), tag => attribute(tag, 'text') === '2 Zonen', { enabled: 'false' });
    code('target_unavailable', () => new Screen(disabledLabel).navigationTarget('zones'));
    const missingLabel = editTag(settingsScreen(), tag => attribute(tag, 'text') === '2 Zonen', { text: null });
    code('target_unavailable', () => new Screen(missingLabel).navigationTarget('zones'));
});

test('zone navigation rejects unknown count labels and ambiguous duplicated selections', () => {
    for (const label of ['', '3 Zonen', '2 zones', '1 Zone ', '2 Zonen\n']) {
        code('target_unavailable', () => new Screen(settingsScreen(true, true, label)).navigationTarget('zones'));
    }
    let injected = false;
    const duplicate = settingsScreen().replace(/<node\b[^>]*>/g, tag => {
        if (!injected && attribute(tag, 'bounds') === '[800,760][950,840]') {
            injected = true;
            return tag + node('', { class: 'android.widget.TextView', text: '2 Zonen', bounds: '[810,780][940,820]' });
        }
        return tag;
    });
    assert.equal(injected, true);
    code('unknown_state', () => new Screen(duplicate).navigationTarget('zones'));
});

test('settings switches report explicit true and false despite duplicated virtual accessibility layers', () => {
    for (const left of [false, true]) for (const right of [false, true]) {
        const screen = new Screen(settingsScreen(left, right));
        screen.checkClear();
        assert.deepEqual(screen.settingsValues(), { climateOnUnlock: left, autoWindowHeating: right });
        assert.deepEqual(screen.settingsTarget('climateOnUnlock', !left), { ...POINTS.climateOnUnlock, value: !left });
        assert.deepEqual(screen.settingsTarget('autoWindowHeating', !right), { ...POINTS.autoWindowHeating, value: !right });
    }
});

test('pending settings are recognized only by the observed Save button in the settings header', () => {
    const clean = new Screen(settingsScreen());
    assert.equal(clean.hasPendingSettings(), false);
    code('target_unavailable', () => clean.settingsSaveTarget());
    const dirty = new Screen(settingsScreen(false, true, '2 Zonen', true));
    assert.equal(dirty.kind(), 'settings');
    assert.deepEqual(dirty.settingsValues(), { climateOnUnlock: false, autoWindowHeating: true });
    assert.equal(dirty.hasPendingSettings(), true);
    assert.deepEqual(dirty.settingsSaveTarget(), POINTS.saveSettings);
    assert.deepEqual(dirty.navigationTarget('back'), POINTS.back);
    for (const xml of [completeDemoClimate(), modeScreen(), zonesScreen(), '<hierarchy/>']) {
        assert.equal(new Screen(xml).hasPendingSettings(), null);
        code('target_unavailable', () => new Screen(xml).settingsSaveTarget());
    }
});

test('disabled Save stays pending while no Save gesture is made available', () => {
    for (const changes of [{ enabled: 'false' }, { clickable: 'false' }]) {
        const xml = editTag(settingsScreen(false, true, '2 Zonen', true), id('climatisationSettingsTrailing'), changes);
        const screen = new Screen(xml);
        assert.equal(screen.hasPendingSettings(), true);
        code('target_unavailable', () => screen.settingsSaveTarget());
    }
    const disabledPage = editTag(settingsScreen(false, true, '2 Zonen', true), id('compose_view'), { enabled: 'false' });
    assert.equal(new Screen(disabledPage).hasPendingSettings(), true);
    code('target_unavailable', () => new Screen(disabledPage).settingsSaveTarget());
});

test('unrecognized, hidden or misplaced Save buttons cannot be mistaken for a clean page', () => {
    for (const changes of [{ text: 'Save' }, { text: 'Speichern ' }, { class: 'android.view.View' },
        { 'visible-to-user': 'false' }, { bounds: '[800,150][980,230]' }]) {
        const xml = editTag(settingsScreen(false, true, '2 Zonen', true), id('climatisationSettingsTrailing'), changes);
        code('unknown_state', () => new Screen(xml).hasPendingSettings());
        code('unknown_state', () => new Screen(xml).settingsSaveTarget());
    }
    const extra = node('climatisationSettingsTrailing', { class: 'android.widget.Button', text: 'Speichern', clickable: 'true', bounds: '[800,10][980,90]' });
    const duplicate = settingsScreen(false, true, '2 Zonen', true).replace('</hierarchy>', extra + '</hierarchy>');
    code('unknown_state', () => new Screen(duplicate).hasPendingSettings());
});

test('zones report all observed combinations including none without guessing from a summary count', () => {
    for (const [left, right, zones] of [[true, true, 'both'], [true, false, 'frontLeft'], [false, true, 'frontRight'], [false, false, 'none']]) {
        const screen = new Screen(zonesScreen(left, right));
        assert.deepEqual(screen.zonesValues(), { frontLeft: left, frontRight: right, zones });
        assert.deepEqual(screen.zoneToggleTarget('frontLeft', !left), { ...POINTS.frontLeft, value: !left });
        assert.deepEqual(screen.zoneToggleTarget('frontRight', !right), { ...POINTS.frontRight, value: !right });
    }
    assert.equal(new Screen(settingsScreen(true, true, '1 Zone')).zonesValues(), null);
    assert.equal(new Screen(zonesScreen()).settingsValues(), null);
});

test('mode titles use a closed mapping and do not inherit JavaScript object properties', () => {
    for (const title of ['constructor', 'toString', '__proto__', 'Air conditioning', 'Klimatisierung ', 'Klima']) {
        assert.equal(new Screen(completeDemoClimate('off', title)).climateMode(), null);
    }
    code('invalid_settings', () => new Screen(modeScreen()).modeChoice('Scheibenheizung'));
    code('invalid_settings', () => new Screen(modeScreen()).modeChoice('constructor'));
});

test('mode radios require exactly one checked option and complete exact labels', () => {
    const both = editTag(modeScreen(), checkable, { checked: 'true' }, 1);
    const neither = editTag(modeScreen(), checkable, { checked: 'false' });
    const missing = editTag(modeScreen(), checkable, { checked: null });
    const badLabel = modeScreen().replace('text="Scheibenheizung"', 'text="Scheibenheizung extra"');
    for (const xml of [both, neither, missing, badLabel]) {
        code('unknown_state', () => new Screen(xml).climateMode());
        code('unknown_state', () => new Screen(xml).modeChoice('windowHeating'));
    }
});

test('overlapping mode choices cannot expose identical coordinates for different modes', () => {
    const xml = modeScreen().replace('bounds="[50,550][950,850]"', 'bounds="[50,150][950,450]"')
        .replace('bounds="[200,580][700,630]"', 'bounds="[200,180][700,230]"');
    code('unknown_state', () => new Screen(xml).modeChoice('climate'));
    code('unknown_state', () => new Screen(xml).modeChoice('windowHeating'));
});

test('mode selection refuses foreign or disabled radio controls', () => {
    const foreign = editTag(modeScreen(), checkable, { package: 'com.android.settings' });
    code('unknown_state', () => new Screen(foreign).modeChoice('climate'));
    const disabled = editTag(modeScreen(), checkable, { enabled: 'false' });
    assert.equal(new Screen(disabled).climateMode(), 'climate');
    code('target_unavailable', () => new Screen(disabled).modeChoice('climate'));
    const disabledSheet = editTag(modeScreen(), id('design_bottom_sheet'), { enabled: 'false' });
    code('target_unavailable', () => new Screen(disabledSheet).modeChoice('windowHeating'));
});

test('settings never treat missing, hidden, foreign or malformed named switches as false', () => {
    const cases = [
        { 'resource-id': 'anotherControl' }, { 'visible-to-user': 'false' }, { bounds: '[0,0][0,0]' },
        { package: 'com.android.settings' }, { checked: null }, { checked: 'unknown' }, { checkable: 'false' },
    ];
    for (const changes of cases) {
        const xml = editTag(settingsScreen(), id('ClimatisationAtUnlockEnabled'), changes);
        code('unknown_state', () => new Screen(xml).settingsValues());
        code('unknown_state', () => new Screen(xml).settingsTarget('climateOnUnlock', false));
    }
});

test('contradictory states or geometry across virtual switch copies are rejected', () => {
    for (const changes of [{ checked: 'false' }, { bounds: '[851,170][950,250]' }]) {
        const xml = editTag(settingsScreen(), id('ClimatisationAtUnlockEnabled'), changes);
        code('unknown_state', () => new Screen(xml).settingsValues());
    }
    const contradictoryZone = editTag(zonesScreen(), checkable, { checked: 'false' }, 1);
    code('unknown_state', () => new Screen(contradictoryZone).zonesValues());
});

test('settings and zone target arguments are typed closed selectors, never raw resource IDs', () => {
    const settings = new Screen(settingsScreen());
    for (const [key, wanted] of [['constructor', true], ['ClimatisationAtUnlockEnabled', true], ['autoWindowHeating', 'false'], ['climateOnUnlock', null]]) {
        code('invalid_settings', () => settings.settingsTarget(key, wanted));
    }
    const zones = new Screen(zonesScreen());
    for (const [side, wanted] of [['none', false], ['both', true], ['frontLeft', 'true'], ['frontRight', null]]) {
        code('invalid_settings', () => zones.zoneToggleTarget(side, wanted));
    }
});

test('targets respect disabled ancestors and never use a settings checkbox as a climate CTA', () => {
    const xml = editTag(settingsScreen(), id('compose_view'), { enabled: 'false' });
    const screen = new Screen(xml);
    assert.deepEqual(screen.settingsValues(), { climateOnUnlock: true, autoWindowHeating: true });
    code('target_unavailable', () => screen.settingsTarget('autoWindowHeating', false));
    code('target_unavailable', () => screen.navigationTarget('zones'));
    const hiddenBack = editTag(zonesScreen(), tag => attribute(tag, 'class') === 'android.widget.Button', { enabled: 'false' });
    code('target_unavailable', () => new Screen(hiddenBack).navigationTarget('back'));
    assert.ok(new Screen(settingsScreen()).settingsTarget('climateOnUnlock', false).y < POINTS.cta.y);
});

test('unknown page headers or packages cannot supply settings state or navigation', () => {
    const unknownTitle = settingsScreen().replace('content-desc="Einstellungen"', 'content-desc="Andere Einstellungen"');
    assert.equal(new Screen(unknownTitle).settingsValues(), null);
    code('target_unavailable', () => new Screen(unknownTitle).settingsTarget('climateOnUnlock', false));
    const foreignPage = editTag(zonesScreen(), id('compose_view'), { package: 'com.android.settings' });
    assert.equal(new Screen(foreignPage).zonesValues(), null);
    const duplicateLabel = zonesScreen().replace('text="Vorne rechts"', 'text="Vorne links"');
    code('unknown_state', () => new Screen(duplicateLabel).zonesValues());
});

test('genuine unexpected dialogs remain blocked instead of becoming allowed settings screens', () => {
    const xml = editTag(settingsScreen(), id('compose_view'), { class: 'android.app.Dialog' });
    code('blocked_ui', () => new Screen(xml).checkClear());
});
