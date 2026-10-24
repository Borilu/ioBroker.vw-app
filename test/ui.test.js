'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Screen, PACKAGE, MAX_XML_BYTES } = require('../lib/ui');
const { BridgeError } = require('../lib/errors');

function escape(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function node(resourceId = '', attributes = {}, children = []) {
    const attrs = {
        package: PACKAGE, enabled: 'true', bounds: '[10,20][110,80]', clickable: 'false',
        ...(resourceId ? { 'resource-id': resourceId } : {}), ...attributes,
    };
    return '<node ' + Object.entries(attrs).map(([key, value]) => key + '="' + escape(value) + '"').join(' ') + '>' + children.join('') + '</node>';
}

function hierarchy(children = []) {
    return '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">' + children.join('') + '</hierarchy>';
}

function climate(cta = 'cta_start', extras = [], ctaAttributes = {}, containerAttributes = {}) {
    return hierarchy([node('clima_compose_view', { bounds: '[0,0][500,900]', ...containerAttributes }, [node(cta, { clickable: 'true', ...ctaAttributes }), ...extras])]);
}

const TEMPERATURE_BOUNDS = '[0,100][1000,400]';

function temperatureOption(value, { x1 = 400, x2 = 600, degree = true, attrs = {}, numberAttrs = {}, degreeAttrs = {}, extra = [] } = {}) {
    const numberRight = degree ? x2 - 30 : x2;
    return node('', { class: 'android.view.View', clickable: 'true', bounds: `[${x1},140][${x2},340]`, ...attrs }, [
        node('', { class: 'android.widget.TextView', text: String(value), bounds: `[${x1},140][${numberRight},340]`, ...numberAttrs }),
        ...(degree ? [node('', { class: 'android.widget.TextView', text: '°', bounds: `[${numberRight},140][${x2},260]`, ...degreeAttrs })] : []),
        ...extra,
    ]);
}

function temperaturePicker({ options, anchorAttrs = {}, scrollAttrs = {}, anchorExtra = [], outside = [], cta = 'cta_start', outerAttrs } = {}) {
    const choices = options || [temperatureOption(21.5, { x1: 0, x2: 200 }), temperatureOption(22),
        temperatureOption(22.5, { x1: 800, x2: 1000, degree: false })];
    const content = [node('clima_compose_view', { class: 'androidx.compose.ui.platform.ComposeView', bounds: TEMPERATURE_BOUNDS, ...anchorAttrs }, [
        node('', { class: 'android.view.View', scrollable: 'true', bounds: TEMPERATURE_BOUNDS, ...scrollAttrs }, choices), ...anchorExtra,
    ]), ...(cta ? [node(cta, { clickable: 'true', bounds: '[0,500][1000,600]' })] : []), ...outside];
    return hierarchy(outerAttrs ? [node('', outerAttrs, content)] : content);
}

function code(expected, operation) {
    assert.throws(operation, error => error instanceof BridgeError && error.code === expected);
}

test('malformed, unsafe, oversized, or non-Android XML is rejected without exposing XML', () => {
    const invalid = [undefined, {}, '<hierarchy>', '<other/>', '<hierarchy><unexpected/></hierarchy>',
        '<hierarchy/><hierarchy/>', '<!DOCTYPE hierarchy [<!ENTITY secret "PRIVATE">]><hierarchy/>',
        '<!ENTITY secret "PRIVATE"><hierarchy/>', '<hierarchy>PRIVATE</hierarchy>',
        '<hierarchy><node enabled=true/></hierarchy>', '<hierarchy><node a="1" a="2"/></hierarchy>',
        '<hierarchy><node text="&unknown;"/></hierarchy>', '<hierarchy><node text="&nbsp;"/></hierarchy>',
        '<hierarchy><node text="&#0;"/></hierarchy>', '<hierarchy><node text="&#xD800;"/></hierarchy>',
        '<hierarchy><node text="&#x110000;"/></hierarchy>', '<hierarchy><node text="\ud800"/></hierarchy>',
        '<hierarchy><node text="&#42\n;"/></hierarchy>',
        Buffer.from([255]), '\u0000<hierarchy/>', ' '.repeat(MAX_XML_BYTES + 1), 'ä'.repeat(MAX_XML_BYTES / 2 + 1)];
    for (const input of invalid) {
        assert.throws(() => new Screen(input), error => error instanceof BridgeError && error.code === 'invalid_ui' && !error.message.includes('PRIVATE'));
    }
});

test('empty hierarchy, overview, and climate states are recognized', () => {
    assert.equal(new Screen(hierarchy()).kind(), 'unknown');
    assert.equal(new Screen(hierarchy([node('climateTile')])).kind(), 'overview');
    assert.equal(new Screen(climate()).kind(), 'climate');
    assert.equal(new Screen(climate()).climateState(), 'off');
    assert.equal(new Screen(Buffer.from(climate(PACKAGE + ':id/cta_stop'))).climateState(), 'on');
});

test('climate state requires exactly one visible anchor and one unambiguous CTA', () => {
    for (const extra of ['cta_stop', 'cta_start', 'clima_compose_view']) {
        code('unknown_state', () => new Screen(climate('cta_start', [node(extra)])).climateState());
    }
    code('unknown_state', () => new Screen(hierarchy([node('cta_start')])).climateState());
    code('unknown_state', () => new Screen(climate('cta_start', [], { 'visible-to-user': 'false' })).climateState());
    code('unknown_state', () => new Screen(climate('cta_start', [], {}, { 'visible-to-user': 'false' })).climateState());
});

test('overview evidence uses the exact observed on-description inside the climate tile', () => {
    const xml = hierarchy([node('climateTile', {}, [
        node('', { 'content-desc': 'Vorklimatisierung. An. Details öffnen' }),
        node('', { class: 'android.widget.Button', 'content-desc': '' }),
    ])]);
    assert.deepEqual(new Screen(xml).overviewClimateEvidence(), { appState: 'on', confirmationSource: 'app_overview' });
});

test('overview evidence never borrows descriptions from other tiles or outside the climate tile', () => {
    const on = node('', { 'content-desc': 'Vorklimatisierung. An. Details öffnen' });
    for (const children of [[on], [node('otherTile', {}, [on])], [node('climateTile'), on],
        [node('climateTile'), node('otherTile', {}, [on])]]) {
        assert.equal(new Screen(hierarchy(children)).overviewClimateEvidence(), null);
    }
    const ownOn = node('climateTile', {}, [on]);
    const unrelated = node('otherTile', {}, [node('', { 'content-desc': 'Vorklimatisierung. Anderer Modus.' })]);
    assert.deepEqual(new Screen(hierarchy([ownOn, unrelated])).overviewClimateEvidence(), { appState: 'on', confirmationSource: 'app_overview' });
});

test('overview evidence needs visible positive bounds on the tile and its description', () => {
    for (const attrs of [{ 'visible-to-user': 'false' }, { bounds: '[0,0][0,0]' }, { bounds: 'invalid' }]) {
        const label = node('', { 'content-desc': 'Vorklimatisierung. An. Details öffnen' });
        assert.equal(new Screen(hierarchy([node('climateTile', attrs, [label])])).overviewClimateEvidence(), null);
        const invalidLabel = node('', { 'content-desc': 'Vorklimatisierung. An. Details öffnen', ...attrs });
        assert.equal(new Screen(hierarchy([node('climateTile', {}, [invalidLabel])])).overviewClimateEvidence(), null);
    }
    const hiddenAncestor = node('', { 'visible-to-user': 'false' }, [node('', { 'content-desc': 'Vorklimatisierung. An. Details öffnen' })]);
    assert.equal(new Screen(hierarchy([node('climateTile', {}, [hiddenAncestor])])).overviewClimateEvidence(), null);
});

test('overview evidence ignores foreign packages and unrelated resource IDs', () => {
    const label = node('', { 'content-desc': 'Vorklimatisierung. An. Details öffnen' });
    const foreignTile = node('climateTile', { package: 'com.android.settings' }, [label]);
    assert.equal(new Screen(hierarchy([foreignTile])).overviewClimateEvidence(), null);
    const foreignLabel = node('', { package: 'com.android.settings', 'content-desc': 'Vorklimatisierung. An. Details öffnen' });
    assert.equal(new Screen(hierarchy([node('climateTile', {}, [foreignLabel])])).overviewClimateEvidence(), null);
    assert.equal(new Screen(hierarchy([node('other.package:id/climateTile', {}, [label])])).overviewClimateEvidence(), null);
});

test('overview evidence refuses duplicate visible tiles, duplicate on-labels, and competing descriptions', () => {
    const label = node('', { 'content-desc': 'Vorklimatisierung. An. Details öffnen' });
    code('unknown_state', () => new Screen(hierarchy([node('climateTile', {}, [label]), node('climateTile')])).overviewClimateEvidence());
    code('unknown_state', () => new Screen(hierarchy([node('climateTile', {}, [label, label])])).overviewClimateEvidence());
    for (const description of ['Vorklimatisierung. Aus. Details öffnen', 'Vorklimatisierung. Anderer Modus.', 'Vorklimatisierung. An. Details öffnen ']) {
        const competing = node('', { 'content-desc': description });
        code('unknown_state', () => new Screen(hierarchy([node('climateTile', {}, [label, competing])])).overviewClimateEvidence());
    }
});

test('overview evidence considers only visible valid candidates and does not infer minutes or other states', () => {
    const label = node('', { 'content-desc': 'Vorklimatisierung. An. Details öffnen' });
    const hiddenTile = node('climateTile', { 'visible-to-user': 'false' }, [label]);
    const invalidTile = node('climateTile', { bounds: '[0,0][0,0]' }, [label]);
    const hiddenLabel = node('', { 'visible-to-user': 'false', 'content-desc': 'Vorklimatisierung. An. Details öffnen' });
    assert.deepEqual(new Screen(hierarchy([node('climateTile', {}, [label, hiddenLabel]), hiddenTile, invalidTile])).overviewClimateEvidence(),
        { appState: 'on', confirmationSource: 'app_overview' });
    for (const description of ['30 Minuten', 'Restzeit: 30 Minuten', 'Preconditioning. On. Open details']) {
        const unknown = node('', { 'content-desc': description });
        assert.equal(new Screen(hierarchy([node('climateTile', {}, [unknown])])).overviewClimateEvidence(), null);
    }
    const minutes = node('', { text: '30 Minuten' });
    assert.deepEqual(new Screen(hierarchy([node('climateTile', {}, [label, minutes])])).overviewClimateEvidence(),
        { appState: 'on', confirmationSource: 'app_overview' });
});

test('unrecognized preconditioning descriptions remain explicitly unknown and never mean off', () => {
    for (const description of ['Vorklimatisierung. Aus. Details öffnen', 'Vorklimatisierung. An.',
        'Vorklimatisierung. An. Details öffnen ', 'Vorklimatisierung. Wird gestartet.', 'Vorklimatisierung.']) {
        const label = node('', { 'content-desc': description });
        assert.deepEqual(new Screen(hierarchy([node('climateTile', {}, [label])])).overviewClimateEvidence(),
            { appState: 'unknown', confirmationSource: 'none' });
    }
});

test('unknown preconditioning descriptions must also belong to a visible valid VW tile descendant', () => {
    const unknown = { 'content-desc': 'Vorklimatisierung. Aus. Details öffnen' };
    for (const children of [
        [node('climateTile'), node('', unknown)],
        [node('otherTile', {}, [node('', unknown)])],
        [node('climateTile', {}, [node('', { ...unknown, package: 'com.android.settings' })])],
        [node('climateTile', {}, [node('', { ...unknown, 'visible-to-user': 'false' })])],
        [node('climateTile', {}, [node('', { ...unknown, bounds: '[0,0][0,0]' })])],
    ]) {
        assert.equal(new Screen(hierarchy(children)).overviewClimateEvidence(), null);
    }
});

test('disabled dialogs, popup identifiers, and foreign foreground applications block gestures', () => {
    for (const attrs of [{ class: 'android.app.Dialog' }, { class: 'androidx.compose.ui.window.Dialog' },
        { 'resource-id': 'android:id/alertTitle' }, { 'resource-id': 'my_popup', enabled: 'false' },
        { package: 'com.android.settings' }]) {
        code('blocked_ui', () => new Screen(hierarchy([node('', attrs)])).checkClear());
    }
    new Screen(hierarchy([node('status_bar', { package: 'com.android.systemui' }), node('climateTile')])).checkClear();
    new Screen(hierarchy([node('other', { package: 'com.android.settings', 'visible-to-user': 'false' })])).checkClear();
});

test('vehicle text, description, and resource selectors match exactly and together', () => {
    const screen = new Screen(hierarchy([node(PACKAGE + ':id/vehicle', { text: 'My ID.7', 'content-desc': 'Family car' })]));
    screen.requireVehicle({ text: 'My ID.7', contentDesc: 'Family car', resourceId: 'vehicle' });
    for (const selector of [{ text: 'ID.7' }, { resourceId: 'vehicle' }, { text: 'My ID.7', contentDesc: 'Other car' },
        { text: 'My ID.7', unexpected: 'x' }, [], null, { contentDescPrefix: '   ' }, { contentDescPrefix: 42 }]) {
        code('wrong_vehicle', () => screen.requireVehicle(selector));
    }
});

test('full vehicle prefix supports both observed synchronization suffixes without trimming', () => {
    const prefix = 'Ihr Fahrzeug: ID.7 GTX Tourer. ';
    for (const suffix of ['Synchronisiert vor 45 Minuten', 'Synchronisiert vor 2 Stunden', 'Gerade synchronisiert']) {
        const screen = new Screen(hierarchy([node('', { 'content-desc': prefix + suffix })]));
        screen.requireVehicle({ contentDescPrefix: prefix });
        assert.equal(screen.summary()[0].contentDesc, prefix + suffix);
    }
    for (const description of ['Ihr Fahrzeug: ID.5 GTX Tourer. Gerade synchronisiert',
        'Ihr Fahrzeug: ID.7 GTX Tourer Plus. Gerade synchronisiert',
        'Ihr Fahrzeug: ID.7 GTX Tourer.Gerade synchronisiert',
        'ihr Fahrzeug: ID.7 GTX Tourer. Gerade synchronisiert']) {
        code('wrong_vehicle', () => new Screen(hierarchy([node('', { 'content-desc': description })])).requireVehicle({ contentDescPrefix: prefix }));
    }
});

test('duplicate vehicle markers are refused even with distinct dynamic suffixes', () => {
    const prefix = 'Ihr Fahrzeug: ID.7 GTX Tourer. ';
    const xml = hierarchy([node('', { 'content-desc': prefix + 'Gerade synchronisiert' }), node('', { 'content-desc': prefix + 'Synchronisiert vor 5 Minuten' })]);
    code('wrong_vehicle', () => new Screen(xml).requireVehicle({ contentDescPrefix: prefix }));
    const hidden = hierarchy([node('', { text: 'My ID.7' }), node('', { text: 'My ID.7', 'visible-to-user': 'false' })]);
    code('wrong_vehicle', () => new Screen(hidden).requireVehicle({ text: 'My ID.7' }));
});

test('vehicle marker requires positive bounds and visible ancestors', () => {
    for (const attrs of [{ 'visible-to-user': 'false' }, { bounds: '[0,0][0,0]' }]) {
        code('wrong_vehicle', () => new Screen(hierarchy([node('', { text: 'My ID.7', ...attrs })])).requireVehicle({ text: 'My ID.7' }));
    }
    const xml = hierarchy([node('', { 'visible-to-user': 'false' }, [node('', { text: 'My ID.7' })])]);
    code('wrong_vehicle', () => new Screen(xml).requireVehicle({ text: 'My ID.7' }));
});

test('prefix selectors can also require exact text and a specific resource', () => {
    const prefix = 'Ihr Fahrzeug: ID.7 GTX Tourer. ';
    const screen = new Screen(hierarchy([node('vehicle', { text: 'Family car', 'content-desc': prefix + 'Gerade synchronisiert' })]));
    screen.requireVehicle({ contentDescPrefix: prefix, text: 'Family car', resourceId: 'vehicle' });
    for (const extra of [{ text: 'Other car' }, { resourceId: 'another' }, { contentDesc: prefix + 'Synchronisiert vor 45 Minuten' }]) {
        code('wrong_vehicle', () => screen.requireVehicle({ contentDescPrefix: prefix, ...extra }));
    }
});

test('temperature picker reads the center and targets only exact currently visible values', () => {
    for (const cta of ['cta_start', 'cta_stop']) {
        const screen = new Screen(temperaturePicker({ cta }));
        assert.equal(screen.climateTemperature(), 22);
        assert.deepEqual(screen.temperatureTarget(21.5), { x: 100, y: 240, value: 21.5 });
        assert.deepEqual(screen.temperatureTarget(22), { x: 500, y: 240, value: 22 });
        assert.deepEqual(screen.temperatureTarget(22.5), { x: 900, y: 240, value: 22.5 });
        code('target_unavailable', () => screen.temperatureTarget(23));
    }
});

test('temperature reading requires the compose anchor, recognized CTA, and one observed scrollable picker', () => {
    assert.equal(new Screen(hierarchy()).climateTemperature(), null);
    assert.equal(new Screen(climate()).climateTemperature(), null);
    assert.equal(new Screen(temperaturePicker({ cta: null })).climateTemperature(), null);
    assert.equal(new Screen(temperaturePicker({ scrollAttrs: { class: 'android.widget.ScrollView' } })).climateTemperature(), null);
    assert.equal(new Screen(temperaturePicker({ scrollAttrs: { bounds: '[0,100][1000,399]' } })).climateTemperature(), null);
    assert.equal(new Screen(temperaturePicker({ scrollAttrs: { 'resource-id': 'another_control' } })).climateTemperature(), null);
    const secondScroll = node('', { class: 'android.view.View', scrollable: 'true', bounds: TEMPERATURE_BOUNDS });
    code('unknown_state', () => new Screen(temperaturePicker({ anchorExtra: [secondScroll] })).climateTemperature());
    const secondAnchor = node('clima_compose_view', { bounds: TEMPERATURE_BOUNDS });
    code('unknown_state', () => new Screen(temperaturePicker({ outside: [secondAnchor] })).climateTemperature());
    code('unknown_state', () => new Screen(temperaturePicker({ outside: [node('cta_stop')] })).climateTemperature());
});

test('temperature values outside the picker and foreign package descendants are not selectable', () => {
    const outsideValue = temperatureOption(23, { x1: 0, x2: 200 });
    const screen = new Screen(temperaturePicker({ outside: [outsideValue] }));
    assert.equal(screen.climateTemperature(), 22);
    code('target_unavailable', () => screen.temperatureTarget(23));
    assert.equal(new Screen(temperaturePicker({ anchorAttrs: { package: 'com.android.settings' } })).climateTemperature(), null);
    const foreignCenter = temperatureOption(22, { numberAttrs: { package: 'com.android.settings' } });
    const foreign = new Screen(temperaturePicker({ options: [temperatureOption(21.5, { x1: 0, x2: 200 }), foreignCenter] }));
    assert.equal(foreign.climateTemperature(), null);
    code('target_unavailable', () => foreign.temperatureTarget(22));
});

test('central temperature requires exactly one visible degree glyph and a complete numeric label', () => {
    const left = temperatureOption(21.5, { x1: 0, x2: 200 });
    for (const center of [temperatureOption(22, { degree: false }), temperatureOption(22, { degreeAttrs: { text: '°C' } }),
        temperatureOption(22, { degreeAttrs: { 'visible-to-user': 'false' } }),
        temperatureOption(22, { numberAttrs: { bounds: '[390,140][565,340]' } })]) {
        assert.equal(new Screen(temperaturePicker({ options: [left, center] })).climateTemperature(), null);
    }
    const duplicateDegree = node('', { class: 'android.widget.TextView', text: '°', bounds: '[570,140][600,260]' });
    code('unknown_state', () => new Screen(temperaturePicker({ options: [left, temperatureOption(22, { extra: [duplicateDegree] })] })).climateTemperature());
    const clippedCenter = temperatureOption(22, { x1: 400, x2: 1000, degree: false });
    assert.equal(new Screen(temperaturePicker({ options: [left, clippedCenter] })).climateTemperature(), null);
});

test('missing side degree glyph is accepted only at the observed right clipping edge', () => {
    const left = temperatureOption(21.5, { x1: 0, x2: 200 });
    const center = temperatureOption(22);
    const clipped = new Screen(temperaturePicker({ options: [left, center, temperatureOption(22.5, { x1: 800, x2: 1000, degree: false })] }));
    assert.equal(clipped.climateTemperature(), 22);
    assert.equal(clipped.temperatureTarget(22.5).value, 22.5);
    const unconfirmedEdge = new Screen(temperaturePicker({ options: [left, center, temperatureOption(22.5, { x1: 800, x2: 990, degree: false })] }));
    assert.equal(unconfirmedEdge.climateTemperature(), null);
    const missingLeftUnit = new Screen(temperaturePicker({ options: [temperatureOption(21.5, { x1: 0, x2: 200, degree: false }), center] }));
    assert.equal(missingLeftUnit.climateTemperature(), null);
});

test('temperature parsing never accepts partial numbers, other locale formats, special labels, or inferred ranges', () => {
    for (const value of ['22extra', '22,5', '22.0', 'NaN', 'Infinity', '022', '22.25', 'LO', 'HI']) {
        const xml = temperaturePicker({ options: [temperatureOption(21.5, { x1: 0, x2: 200 }), temperatureOption(value)] });
        assert.equal(new Screen(xml).climateTemperature(), null);
    }
    const numericShape = new Screen(temperaturePicker({ options: [temperatureOption(9.5, { x1: 0, x2: 200 }), temperatureOption(10)] }));
    assert.equal(numericShape.climateTemperature(), 10); // Allowed range is a separate, device-confirmed configuration.
});

test('numeric boundary temperatures remain readable and selectable beside peripheral LO or HI', () => {
    const minimum = new Screen(temperaturePicker({ options: [
        temperatureOption('LO', { x1: 0, x2: 200, degree: false }), temperatureOption(16),
        temperatureOption(16.5, { x1: 800, x2: 1000, degree: false }),
    ] }));
    assert.equal(minimum.climateTemperature(), 16);
    assert.deepEqual(minimum.temperatureTarget(16), { x: 500, y: 240, value: 16 });
    assert.deepEqual(minimum.temperatureTarget(16.5), { x: 900, y: 240, value: 16.5 });
    code('invalid_temperature', () => minimum.temperatureTarget('LO'));
    code('target_unavailable', () => minimum.temperatureTarget(15.5));
    const maximum = new Screen(temperaturePicker({ options: [
        temperatureOption(29, { x1: 0, x2: 200 }), temperatureOption(29.5),
        temperatureOption('HI', { x1: 800, x2: 1000, degree: false }),
    ] }));
    assert.equal(maximum.climateTemperature(), 29.5);
    assert.deepEqual(maximum.temperatureTarget(29), { x: 100, y: 240, value: 29 });
    assert.deepEqual(maximum.temperatureTarget(29.5), { x: 500, y: 240, value: 29.5 });
    code('invalid_temperature', () => maximum.temperatureTarget('HI'));
    code('target_unavailable', () => maximum.temperatureTarget(30));
});

test('central LO or HI stays unsupported and cannot provide even a neighboring numeric tap target', () => {
    const centralLow = new Screen(temperaturePicker({ options: [
        temperatureOption('LO', { degree: false }), temperatureOption(16, { x1: 800, x2: 1000, degree: false }),
    ] }));
    assert.equal(centralLow.climateTemperature(), null);
    code('target_unavailable', () => centralLow.temperatureTarget(16));
    const centralHigh = new Screen(temperaturePicker({ options: [
        temperatureOption(29.5, { x1: 0, x2: 200 }), temperatureOption('HI', { degree: false }),
    ] }));
    assert.equal(centralHigh.climateTemperature(), null);
    code('target_unavailable', () => centralHigh.temperatureTarget(29.5));
});

test('LO and HI are rejected away from their confirmed peripheral numeric boundaries', () => {
    const invalidChoices = [
        [temperatureOption('LO', { x1: 0, x2: 200, degree: false }), temperatureOption(22)],
        [temperatureOption(22), temperatureOption('HI', { x1: 800, x2: 1000, degree: false })],
        [temperatureOption(16, { x1: 0, x2: 200 }), temperatureOption(16.5), temperatureOption('LO', { x1: 800, x2: 1000, degree: false })],
        [temperatureOption('HI', { x1: 0, x2: 200, degree: false }), temperatureOption(29), temperatureOption(29.5, { x1: 800, x2: 1000 })],
        [temperatureOption('UNKNOWN', { x1: 0, x2: 200, degree: false }), temperatureOption(16)],
        [temperatureOption('LO', { x1: 0, x2: 200 }), temperatureOption(16)],
    ];
    for (const options of invalidChoices) {
        const screen = new Screen(temperaturePicker({ options }));
        assert.equal(screen.climateTemperature(), null);
        code('target_unavailable', () => screen.temperatureTarget(16));
    }
});

test('picker geometry and half-degree ordering must be unambiguous', () => {
    const left = temperatureOption(21.5, { x1: 0, x2: 200 });
    const center = temperatureOption(22);
    const overlap = temperatureOption(22.5, { x1: 550, x2: 1000 });
    code('unknown_state', () => new Screen(temperaturePicker({ options: [left, center, overlap] })).climateTemperature());
    assert.equal(new Screen(temperaturePicker({ options: [left, temperatureOption(23)] })).climateTemperature(), null);
    assert.equal(new Screen(temperaturePicker({ options: [temperatureOption(22.5, { x1: 0, x2: 200 }), center] })).climateTemperature(), null);
    assert.equal(new Screen(temperaturePicker({ options: [center] })).climateTemperature(), null);
    const duplicateNumber = node('', { class: 'android.widget.TextView', text: '22', bounds: '[400,140][565,340]' });
    code('unknown_state', () => new Screen(temperaturePicker({ options: [left, temperatureOption(22, { extra: [duplicateNumber] })] })).climateTemperature());
    const extra = temperatureOption(23, { x1: 700, x2: 780 });
    code('unknown_state', () => new Screen(temperaturePicker({ options: [left, center, extra, temperatureOption(23.5, { x1: 800, x2: 1000 })] })).climateTemperature());
});

test('temperature controls respect visible bounds, enabled ancestors, and actual clickability', () => {
    for (const options of [
        { anchorAttrs: { enabled: 'false' } }, { anchorAttrs: { 'visible-to-user': 'false' } },
        { scrollAttrs: { enabled: 'false' } }, { outerAttrs: { enabled: 'false' } },
    ]) {
        const screen = new Screen(temperaturePicker(options));
        assert.equal(screen.climateTemperature(), null);
        code('target_unavailable', () => screen.temperatureTarget(22));
    }
    const left = temperatureOption(21.5, { x1: 0, x2: 200 });
    const right = temperatureOption(22.5, { x1: 800, x2: 1000 });
    for (const attrs of [{ clickable: 'false' }, { enabled: 'false' }, { 'visible-to-user': 'false' }, { bounds: '[0,0][0,0]' }]) {
        assert.equal(new Screen(temperaturePicker({ options: [left, temperatureOption(22, { attrs }), right] })).climateTemperature(), null);
    }
    const disabledSide = new Screen(temperaturePicker({ options: [left, temperatureOption(22),
        temperatureOption(22.5, { x1: 800, x2: 1000, attrs: { enabled: 'false' } })] }));
    assert.equal(disabledSide.climateTemperature(), 22);
    code('target_unavailable', () => disabledSide.temperatureTarget(22.5));
    assert.equal(disabledSide.temperatureTarget(21.5).value, 21.5);
});

test('temperature target accepts only numeric half-degrees and never returns a climate CTA', () => {
    const screen = new Screen(temperaturePicker());
    for (const value of [undefined, null, '22.5', false, NaN, Infinity, 22.25]) {
        code('invalid_temperature', () => screen.temperatureTarget(value));
    }
    assert.ok(screen.temperatureTarget(22.5).y < 400);
    assert.equal(screen.target('cta_start').y, 550);
    const misleading = temperatureOption(22, { attrs: { 'resource-id': 'cta_start' } });
    code('unknown_state', () => new Screen(temperaturePicker({ options: [temperatureOption(21.5, { x1: 0, x2: 200 }), misleading] })).temperatureTarget(22));
});

test('each fresh picker snapshot resolves the current and neighboring values independently', () => {
    const before = new Screen(temperaturePicker());
    const after = new Screen(temperaturePicker({ options: [temperatureOption(22, { x1: 0, x2: 200 }), temperatureOption(22.5),
        temperatureOption(23, { x1: 800, x2: 1000, degree: false })] }));
    assert.equal(before.climateTemperature(), 22);
    assert.equal(after.climateTemperature(), 22.5);
    assert.deepEqual(before.temperatureTarget(22.5), { x: 900, y: 240, value: 22.5 });
    assert.deepEqual(after.temperatureTarget(22.5), { x: 500, y: 240, value: 22.5 });
    code('target_unavailable', () => before.temperatureTarget(23));
    assert.equal(after.temperatureTarget(23).value, 23);
});

test('A/C picker requires exactly the configured title inside the picker', () => {
    const make = title => new Screen(climate('cta_start', [node('title', { text: 'Klimatisierung' }),
        node('clima_air_conditioning_pick', {}, [node('title', { text: title })])]));
    make('Klimatisierung').requireAcMode(['Klimatisierung']);
    code('unsafe_mode', () => make('Klimatisierung').requireAcMode(['Klima']));
    code('unsafe_mode', () => make('Scheibenheizung').requireAcMode(['Klimatisierung']));
    code('unsafe_mode', () => make('Klimatisierung').requireAcMode('Klimatisierung'));
});

test('ambiguous or hidden picker titles fail closed', () => {
    const duplicate = node('clima_air_conditioning_pick', {}, [node('title', { text: 'A/C' }), node('title', { text: 'A/C' })]);
    code('unsafe_mode', () => new Screen(climate('cta_start', [duplicate])).requireAcMode(['A/C']));
    const hidden = node('clima_air_conditioning_pick', { 'visible-to-user': 'false' }, [node('title', { text: 'A/C' })]);
    code('unsafe_mode', () => new Screen(climate('cta_start', [hidden])).requireAcMode(['A/C']));
    const misplaced = [node('title', { text: 'A/C' }), node('clima_air_conditioning_pick')];
    code('unsafe_mode', () => new Screen(climate('cta_start', misplaced)).requireAcMode(['A/C']));
});

test('fallback toggle representation accepts A/C only and rejects windows-only or unknown', () => {
    const make = (ac, windows) => new Screen(climate('cta_start', [node('air_conditioning_toggle', { checked: ac }), node('window_heating_toggle', { checked: windows })]));
    make('true', 'false').requireAcMode([]);
    for (const [ac, windows] of [['false', 'true'], ['true', 'true'], ['false', 'false'], ['true', '']]) {
        code('unsafe_mode', () => make(ac, windows).requireAcMode([]));
    }
    code('unsafe_mode', () => new Screen(climate()).requireAcMode([]));
});

test('target derives coordinates from exact current resource bounds', () => {
    assert.deepEqual(new Screen(climate()).target(PACKAGE + ':id/cta_start'), { x: 60, y: 50 });
    code('target_unavailable', () => new Screen(climate()).target('foreign:id/cta_start'));
    code('target_unavailable', () => new Screen(climate()).target('missing'));
});

test('target rejects invisible, malformed, zero, negative, unsafe-number, and duplicate bounds', () => {
    for (const attrs of [{ bounds: '[-1,0][100,200]' }, { bounds: '[2,2][2,20]' }, { bounds: 'nonsense' }, { bounds: '[0,0][100,200]\n' },
        { bounds: '[0,0][9007199254740993,20]' }, { 'visible-to-user': 'false' }, { enabled: 'false' }]) {
        code('target_unavailable', () => new Screen(climate('cta_start', [], attrs)).target('cta_start'));
    }
    code('ambiguous_ui', () => new Screen(climate('cta_start', [node('cta_start', { 'visible-to-user': 'false' })])).target('cta_start'));
});

test('disabled, missing-enabled, or hidden ancestors prevent a target', () => {
    for (const attrs of [{ enabled: 'false' }, { enabled: '' }, { 'visible-to-user': 'false' }]) {
        code('target_unavailable', () => new Screen(climate('cta_start', [], {}, attrs)).target('cta_start'));
    }
    const noEnabled = hierarchy([node('clima_compose_view', {}, [node('cta_start', { clickable: 'true' })])]).replace(' enabled="true"', '');
    code('target_unavailable', () => new Screen(noEnabled).target('cta_start'));
});

test('non-clickable navigation exception is restricted to climateTile', () => {
    const screen = new Screen(hierarchy([node('climateTile'), node('cta_start')]));
    assert.deepEqual(screen.target('climateTile', { navigation: true }), { x: 60, y: 50 });
    code('target_unavailable', () => screen.target('climateTile'));
    code('target_unavailable', () => screen.target('cta_start', { navigation: true }));
    code('target_unavailable', () => screen.target('climateTile', { navigation: 'true' }));
});

test('clickable wrappers cannot borrow a sibling control or unrelated resource container', () => {
    const make = (attrs = {}, extras = []) => new Screen(hierarchy([node('', { clickable: 'true', ...attrs }, [node('cta_start'), ...extras])]));
    assert.deepEqual(make().target('cta_start'), { x: 60, y: 50 });
    code('target_unavailable', () => make({}, [node('cta_stop')]).target('cta_start'));
    code('target_unavailable', () => make({ 'resource-id': 'unrelated' }).target('cta_start'));
    code('target_unavailable', () => make({}, [node('', { clickable: 'true' })]).target('cta_start'));
});

test('summary includes only visible local-app labels and bounds are not exposed', () => {
    const screen = new Screen(hierarchy([node('vehicle', { text: 'N'.repeat(200), 'content-desc': 'Family & car' }),
        node('status_bar', { package: 'com.android.systemui', text: 'System' }), node('hidden', { text: 'Hidden', 'visible-to-user': 'false' })]));
    assert.deepEqual(screen.summary(), [{ resourceId: 'vehicle', text: 'N'.repeat(120), contentDesc: 'Family & car' }]);
});

test('attribute whitespace, numeric-looking labels, and XML escapes retain exact meaning', () => {
    const screen = new Screen(hierarchy([node('vehicle', { text: ' 0012 ', 'content-desc': 'Car "A" & family <GTX>. ' })]));
    screen.requireVehicle({ text: ' 0012 ', contentDesc: 'Car "A" & family <GTX>. ' });
    code('wrong_vehicle', () => screen.requireVehicle({ text: '0012' }));
    new Screen('<hierarchy><node package="' + PACKAGE + '" bounds="[0,0][100,100]" text="&#x49;&#68;.7"/></hierarchy>').requireVehicle({ text: 'ID.7' });
});

test('extreme nesting is refused before later ancestor traversals', () => {
    const xml = '<hierarchy>' + '<node>'.repeat(270) + '</node>'.repeat(270) + '</hierarchy>';
    code('invalid_ui', () => new Screen(xml));
});
