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
