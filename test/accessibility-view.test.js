'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extendedViewToXml } = require('../lib/accessibility-view');
const { Screen } = require('../lib/ui');
const { BridgeError } = require('../lib/errors');

const PACKAGE = 'com.volkswagen.weconnect';
const FORMAT = 'vw-app-extended-accessibility-v1';
const SECRET = 'PRIVATE-EXTENDED-VIEW-INPUT';
const BOOLEAN_FIELDS = ['visible', 'enabled', 'clickable', 'longClickable', 'checkable', 'checked', 'selected',
    'scrollable', 'focusable', 'focused', 'accessibilityFocused', 'password', 'heading', 'screenReaderFocusable', 'importantForAccessibility'];

// Every fixture is synthetic. No device dump, location name or native identity
// is copied into this published test suite.
function node(overrides = {}) {
    return { package: PACKAGE, id: null, class: 'android.widget.FrameLayout', text: null, description: null,
        stateDescription: null, bounds: [0, 0, 1080, 2400],
        visible: true, enabled: true, clickable: false, longClickable: false, checkable: false, checked: false,
        selected: false, scrollable: false, focusable: false, focused: false, accessibilityFocused: false,
        password: false, heading: false, screenReaderFocusable: false, importantForAccessibility: true,
        rangeInfo: null, actions: [], children: [], ...overrides };
}

function window(overrides = {}) {
    return { id: 7, type: 1, active: true, focused: true, accessibilityFocused: false, layer: 0,
        title: 'Synthetic app window', bounds: [0, 0, 1080, 2400], ...overrides };
}

function windows(overrides = {}) {
    return { vwWindows: [window()], multipleVwApplicationWindows: false, foreignWindowCount: 2, ...overrides };
}

function count(root) { return 1 + root.children.reduce((sum, child) => sum + count(child), 0); }
function observation(overrides = {}) {
    const root = overrides.root ?? node();
    return { format: FORMAT, package: PACKAGE, readOnly: true, startedAtEpochMs: 10000, finishedAtEpochMs: 10001,
        windowId: 7, windowsBefore: windows(), windowsAfter: windows(), root, nodeCount: count(root), ...overrides };
}
function convert(input) { return extendedViewToXml(JSON.stringify(input)); }
function invalid(operation) {
    assert.throws(operation, error => error instanceof BridgeError && error.code === 'extended_ui_unavailable'
        && !error.message.includes(SECRET) && !JSON.stringify(error.toJSON()).includes(SECRET));
}

test('extended native clock states, range metadata and action IDs become Screen-compatible XML without performing input', () => {
    const input = observation({ root: node({ children: [
        node({ id: PACKAGE + ':id/hour', class: 'android.widget.SeekBar', description: 'Hour', stateDescription: '08',
            bounds: [100, 500, 500, 700], clickable: true,
            rangeInfo: { type: 0, min: 0, max: 23, current: 8 }, actions: [{ id: 16908349, label: SECRET }, { id: 4096, label: null }] }),
        node({ id: PACKAGE + ':id/minute', description: 'Minute', stateDescription: '30',
            rangeInfo: { type: 0, min: 0, max: 59, current: 30 } }),
    ] }) });
    const xml = convert(input);
    const screen = new Screen(xml);
    assert.equal(screen.nodes.length, 3);
    const hour = screen.nodes[1].attrs;
    assert.equal(screen.nodes[0].attrs['a11y-path'], '0');
    assert.equal(hour['a11y-path'], '0.0');
    assert.equal(hour['resource-id'], PACKAGE + ':id/hour');
    assert.equal(hour['content-desc'], 'Hour');
    assert.equal(hour['state-description'], '08');
    assert.equal(hour['range-type'], '0');
    assert.equal(hour['range-min'], '0');
    assert.equal(hour['range-max'], '23');
    assert.equal(hour['range-current'], '8');
    assert.deepEqual(JSON.parse(hour['a11y-actions']), [16908349, 4096]);
    assert.equal(screen.nodes[2].attrs['state-description'], '30');
    assert.equal(xml.includes(SECRET), false);
    assert.equal(xml.includes('Synthetic app window'), false);
    assert.deepEqual(screen.target('hour', { navigation: true }), { x: 300, y: 600 });
    screen.checkClear();
});

test('null textual fields become empty attributes and exact boolean values are emitted as flat strings', () => {
    const input = observation({ root: node({ id: null, class: null, visible: false, enabled: false, selected: true,
        hintText: null, paneTitle: null, errorText: null }) });
    const attributes = new Screen(convert(input)).nodes[0].attrs;
    for (const name of ['resource-id', 'class', 'text', 'content-desc', 'state-description']) assert.equal(attributes[name], '');
    assert.equal(attributes['visible-to-user'], 'false');
    assert.equal(attributes.enabled, 'false');
    assert.equal(attributes.selected, 'true');
    assert.equal(attributes.password, 'false');
    assert.equal(attributes['long-clickable'], 'false');
    assert.equal(attributes['important-for-accessibility'], 'true');
    assert.equal(attributes['a11y-actions'], '[]');
    assert.equal(Object.hasOwn(attributes, 'range-current'), false);
    assert.ok(Object.values(attributes).every(value => typeof value === 'string'));
});

test('retained invisible nodes and descendants of invisible containers cannot become Screen gesture targets', () => {
    for (const hiddenAncestor of [false, true]) {
        const child = node({ id: PACKAGE + ':id/hour', clickable: true, visible: hiddenAncestor,
            stateDescription: '08', bounds: [100, 500, 500, 700] });
        const root = node({ visible: !hiddenAncestor, children: [child] });
        const screen = new Screen(convert(observation({ root })));
        assert.equal(screen.nodes.length, 2);
        assert.equal(screen.nodes[1].attrs.text, '');
        assert.equal(screen.nodes[1].attrs['content-desc'], '');
        assert.equal(screen.nodes[1].attrs['state-description'], '08');
        assert.throws(() => screen.target('hour', { navigation: true }), error => error.code === 'target_unavailable');
    }
});

test('UTF-8 buffers and strings preserve Unicode and malformed encodings or non-JSON input fail with fixed redacted errors', () => {
    const source = JSON.stringify(observation({ root: node({ text: 'Übermorgen 🚗' }) }));
    assert.equal(extendedViewToXml(Buffer.from(source, 'utf8')), extendedViewToXml(source));
    for (const raw of [null, false, 1, {}, [], undefined, '', SECRET, '{}', '[]', 'null',
        Buffer.from([0xc3, 0x28]), Buffer.from(source, 'utf16le'), source + SECRET,
        source + '\ud800']) invalid(() => extendedViewToXml(raw));
});

test('only the exact read-only Volkswagen format and required complete envelope are accepted', () => {
    for (const overrides of [{ format: FORMAT + ' ' }, { format: 'other' }, { package: 'other.application' },
        { readOnly: false }, { readOnly: 'true' }, { windowId: '7' }, { windowId: -1 }, { windowId: 7.5 },
        { nodeCount: '1' }, { nodeCount: 0 }, { nodeCount: 2001 }]) invalid(() => convert(observation(overrides)));
    for (const key of ['format', 'package', 'readOnly', 'windowId', 'windowsBefore', 'windowsAfter', 'root', 'nodeCount',
        'startedAtEpochMs', 'finishedAtEpochMs']) {
        const input = observation();
        delete input[key];
        invalid(() => convert(input));
    }
});

test('timestamps must be finite numeric values in monotonic order without numeric-string coercion', () => {
    for (const overrides of [{ startedAtEpochMs: null }, { startedAtEpochMs: '10000' }, { startedAtEpochMs: -1 },
        { startedAtEpochMs: NaN }, { startedAtEpochMs: Infinity }, { finishedAtEpochMs: null },
        { finishedAtEpochMs: '10001' }, { finishedAtEpochMs: 9999 }, { finishedAtEpochMs: Infinity },
        { finishedAtEpochMs: Number.MAX_SAFE_INTEGER + 1 }]) invalid(() => convert(observation(overrides)));
    invalid(() => extendedViewToXml(JSON.stringify(observation()).replace('"startedAtEpochMs":10000', '"startedAtEpochMs":1e999')));
    assert.ok(convert(observation({ startedAtEpochMs: 10000.25, finishedAtEpochMs: 10000.5 })).startsWith('<?xml'));
});

test('root window identity must remain the single active and focused Volkswagen application before and after capture', () => {
    const bad = [
        windows({ vwWindows: [] }), windows({ vwWindows: [window({ id: 8 })] }),
        windows({ vwWindows: [window({ active: false })] }), windows({ vwWindows: [window({ focused: false })] }),
        windows({ vwWindows: [window({ type: 3 })] }), windows({ multipleVwApplicationWindows: true }),
        windows({ vwWindows: [window(), window({ id: 8, active: false, focused: false })] }),
        windows({ vwWindows: [window(), window({ id: 8, type: 3, focused: false })] }),
        windows({ vwWindows: [window(), window({ id: 8, type: 3, active: false })] }),
        windows({ vwWindows: [window({ focused: false }), window({ id: 8, type: 3, active: false })] }),
        windows({ vwWindows: [window(), window({ type: 3, active: false, focused: false })] }),
    ];
    for (const snapshot of bad) {
        invalid(() => convert(observation({ windowsBefore: snapshot })));
        invalid(() => convert(observation({ windowsAfter: snapshot })));
    }
});

test('inactive auxiliary windows may move or reorder while active window geometry remains stable', () => {
    const auxiliary = window({ id: 8, type: 3, active: false, focused: false, title: null, layer: null, accessibilityFocused: null });
    const input = observation({
        windowsBefore: windows({ vwWindows: [auxiliary, window()] }),
        windowsAfter: windows({ vwWindows: [window(), { ...auxiliary, layer: 2, bounds: [20, 30, 500, 600] }] }),
    });
    assert.equal(new Screen(convert(input)).nodes.length, 1);
});

test('the active window must keep positive identical bounds before and after capture', () => {
    for (const coordinates of [[0, 0, 1080, 2300], [10, 0, 1080, 2400], [0, 10, 1080, 2400],
        [0, 0, 1000, 2400], [0, 0, 0, 2400], [0, 0, 1080, 0]]) {
        invalid(() => convert(observation({ windowsAfter: windows({ vwWindows: [window({ bounds: coordinates })] }) })));
    }
    for (const coordinates of [[0, 0, 0, 2400], [0, 0, 1080, 0]]) {
        const snapshot = windows({ vwWindows: [window({ bounds: coordinates })] });
        invalid(() => convert(observation({ windowsBefore: snapshot, windowsAfter: snapshot })));
    }
});

test('off-window, partially clipped and empty node rectangles keep metadata but cannot become visible gesture targets', () => {
    for (const coordinates of [[100, 3000, 200, 3100], [1200, 100, 1300, 200], [100, 2300, 200, 2500],
        [1000, 100, 1200, 200], [100, 100, 100, 200], [100, 100, 200, 100]]) {
        const input = observation({ root: node({ children: [node({ id: PACKAGE + ':id/clipped',
            text: 'Visible metadata', stateDescription: '07', bounds: coordinates, visible: true, clickable: true })] }) });
        const screen = new Screen(convert(input));
        const attributes = screen.nodes[1].attrs;
        assert.equal(attributes['visible-to-user'], 'false');
        assert.equal(attributes.text, 'Visible metadata');
        assert.equal(attributes['state-description'], '07');
        assert.equal(attributes.bounds, '[' + coordinates[0] + ',' + coordinates[1] + '][' + coordinates[2] + ',' + coordinates[3] + ']');
        assert.throws(() => screen.target('clipped'), error => error.code === 'target_unavailable');
    }
    const inside = observation({ root: node({ children: [node({ id: PACKAGE + ':id/inside',
        bounds: [100, 2300, 200, 2400], visible: true, clickable: true })] }) });
    assert.deepEqual(new Screen(convert(inside)).target('inside'), { x: 150, y: 2350 });
});

test('native node paths preserve original rich-tree indexes across invisible and clipped siblings without filtering', () => {
    const input = observation({ root: node({ children: [
        node({ id: PACKAGE + ':id/hidden', visible: false, children: [node({ id: PACKAGE + ':id/nested' })] }),
        node({ id: PACKAGE + ':id/outside', bounds: [100, 3000, 200, 3100], clickable: true }),
        node({ id: PACKAGE + ':id/target', bounds: [100, 500, 200, 600], clickable: true }),
    ] }) });
    const screen = new Screen(convert(input));
    const byId = name => screen.nodes.find(node => node.attrs['resource-id'] === PACKAGE + ':id/' + name).attrs;
    assert.equal(screen.nodes.length, 5);
    assert.equal(screen.nodes[0].attrs['a11y-path'], '0');
    assert.equal(byId('hidden')['a11y-path'], '0.0');
    assert.equal(byId('nested')['a11y-path'], '0.0.0');
    assert.equal(byId('outside')['a11y-path'], '0.1');
    assert.equal(byId('target')['a11y-path'], '0.2');
    assert.deepEqual(screen.target('target'), { x: 150, y: 550 });
    assert.throws(() => screen.target('nested'), error => error.code === 'target_unavailable');
    assert.throws(() => screen.target('outside'), error => error.code === 'target_unavailable');
});

test('a scrolled Home keeps signed off-window container metadata without turning it or its on-screen descendants into targets', () => {
    const input = observation({ root: node({ children: [
        node({ class: 'android.widget.ScrollView', id: PACKAGE + ':id/homeScroll', scrollable: true, children: [
            node({ class: 'android.view.View', id: PACKAGE + ':id/clipped', bounds: [0, -251, 1080, 454],
                description: 'Synthetic Home decoration', clickable: true, children: [
                    node({ id: PACKAGE + ':id/clippedChild', bounds: [100, 100, 200, 200], clickable: true }),
                ] }),
            node({ id: PACKAGE + ':id/vehicleMarker', description: 'Ihr Fahrzeug: SYNTHETIC', bounds: [100, 500, 900, 600] }),
            node({ id: PACKAGE + ':id/accessTile', description: 'Fahrzeug. Verriegelt. Details öffnen',
                bounds: [100, 700, 900, 900], clickable: true }),
        ] }),
    ] }) });
    const screen = new Screen(convert(input));
    const clipped = screen.nodes.find(node => node.attrs['resource-id'] === PACKAGE + ':id/clipped');
    assert.equal(clipped.attrs.bounds, '[0,-251][1080,454]');
    assert.equal(clipped.attrs['a11y-path'], '0.0.0');
    assert.equal(clipped.attrs['visible-to-user'], 'false');
    assert.equal(screen._bounds(clipped), null);
    assert.throws(() => screen.target('clipped'), error => error.code === 'target_unavailable');
    assert.throws(() => screen.target('clippedChild'), error => error.code === 'target_unavailable');
    assert.deepEqual(screen.target('accessTile'), { x: 500, y: 800 });
    assert.equal(screen.nodes.find(node => node.attrs['resource-id'] === PACKAGE + ':id/accessTile').attrs['a11y-path'], '0.0.2');
});

test('signed node bounds cannot relax nonnegative application or auxiliary window geometry', () => {
    for (const coordinates of [[-1, 0, 1080, 2400], [0, -251, 1080, 2400], [-20000, 0, 1080, 2400]]) {
        for (const key of ['windowsBefore', 'windowsAfter']) {
            invalid(() => convert(observation({ [key]: windows({ vwWindows: [window({ bounds: coordinates })] }) })));
            invalid(() => convert(observation({ [key]: windows({ vwWindows: [window(), window({ id: 8, type: 3,
                active: false, focused: false, bounds: coordinates })] }) })));
        }
    }
});

test('window metadata validates safe fields, unique IDs and bounded counts rather than trusting the multiple-window flag', () => {
    for (const overrides of [{ id: null }, { type: 0 }, { type: '1' }, { active: 'true' }, { focused: 1 },
        { accessibilityFocused: 'false' }, { layer: 0.5 }, { title: 1 }, { bounds: [-1, 0, 10, 10] }]) {
        invalid(() => convert(observation({ windowsBefore: windows({ vwWindows: [window(overrides)] }) })));
    }
    for (const overrides of [{ vwWindows: null }, { foreignWindowCount: -1 }, { foreignWindowCount: 16 },
        { foreignWindowCount: '2' }, { multipleVwApplicationWindows: null },
        { vwWindows: Array.from({ length: 17 }, (_, index) => window({ id: index + 1 })) }]) {
        invalid(() => convert(observation({ windowsBefore: windows(overrides) })));
    }
    const incomplete = window();
    delete incomplete.focused;
    invalid(() => convert(observation({ windowsBefore: windows({ vwWindows: [incomplete] }) })));
});

test('every node must belong to Volkswagen and password nodes fail even when nested or invisible', () => {
    for (const overrides of [{ package: 'foreign.application' }, { package: null }, { package: PACKAGE + ' ' },
        { password: true }, { password: null }]) {
        const input = observation({ root: node({ children: [node({ visible: false, ...overrides })] }) });
        invalid(() => convert(input));
    }
});

test('all known control and security boolean fields require actual booleans, including invisible children', () => {
    for (const field of BOOLEAN_FIELDS) {
        for (const value of [null, 'false', 'true', 0, 1, {}, []]) {
            invalid(() => convert(observation({ root: node({ [field]: value }) })));
        }
        const missing = node();
        delete missing[field];
        invalid(() => convert(observation({ root: missing })));
    }
});

test('text, description and state escapes preserve XML metacharacters and attribute whitespace exactly', () => {
    const label = '<&>"\'\t\n\rÄ 🚗';
    const input = observation({ root: node({ id: label, class: label, text: label, description: label, stateDescription: label }) });
    const xml = convert(input);
    const attributes = new Screen(xml).nodes[0].attrs;
    for (const name of ['resource-id', 'class', 'text', 'content-desc', 'state-description']) assert.equal(attributes[name], label);
    assert.ok(xml.includes('&lt;&amp;&gt;&quot;&apos;&#9;&#10;&#13;'));
});

test('markup, entities and attribute-looking data remain literal values rather than additional nodes or declarations', () => {
    const malicious = '\"/><node package="foreign" text="' + SECRET + '"/><!-- <!DOCTYPE root SYSTEM "https://invalid.example/"> &custom;';
    const xml = convert(observation({ root: node({ text: malicious, description: malicious, stateDescription: malicious }) }));
    assert.equal(xml.includes('<!DOCTYPE'), false);
    const screen = new Screen(xml);
    assert.equal(screen.nodes.length, 1);
    assert.equal(screen.nodes[0].attrs.text, malicious);
    assert.equal(screen.nodes[0].attrs['content-desc'], malicious);
    assert.equal(screen.nodes[0].attrs['state-description'], malicious);
});

test('known text fields reject unsafe XML characters, lone surrogates, unsupported types and excessive lengths', () => {
    for (const field of ['id', 'class', 'text', 'description', 'stateDescription', 'hintText', 'paneTitle', 'errorText']) {
        for (const value of [1, false, {}, [], '\x00' + SECRET, '\x08', '\x0b', '\x1f', '\ufffe', '\uffff',
            '\ud800', '\udfff', 'x'.repeat(5001)]) invalid(() => convert(observation({ root: node({ [field]: value }) })));
    }
});

test('node bounds require four ordered finite integer coordinates between minus 20000 and 20000', () => {
    for (const value of [null, {}, '0,0,10,10', [], [0, 0, 10], [0, 0, 10, 10, 10], [-20001, 0, 10, 10],
        [0, 0, 20001, 10], [0, 0, 1.5, 10], [0, 0, '10', 10], [0, 0, null, 10],
        [0, 0, Infinity, 10], [10, 0, 9, 10], [0, 10, 10, 9]]) {
        invalid(() => convert(observation({ root: node({ bounds: value }) })));
    }
    assert.equal(new Screen(convert(observation({ root: node({ bounds: [0, 0, 20000, 20000] }) }))).nodes[0].attrs.bounds,
        '[0,0][20000,20000]');
    assert.equal(new Screen(convert(observation({ root: node({ visible: false, bounds: [0, 0, 0, 0] }) }))).nodes.length, 1);
    const negative = new Screen(convert(observation({ root: node({ bounds: [-20000, -20000, 20000, 20000] }) })));
    assert.equal(negative.nodes[0].attrs.bounds, '[-20000,-20000][20000,20000]');
    assert.equal(negative.nodes[0].attrs['visible-to-user'], 'false');
});

test('range metadata preserves finite float values and rejects malformed, inconsistent or coerced ranges', () => {
    const range = { type: 1, min: -2.5, max: 3.75, current: 0.125 };
    const attributes = new Screen(convert(observation({ root: node({ rangeInfo: range }) }))).nodes[0].attrs;
    assert.equal(attributes['range-type'], '1');
    assert.equal(attributes['range-min'], '-2.5');
    assert.equal(attributes['range-max'], '3.75');
    assert.equal(attributes['range-current'], '0.125');
    for (const value of [false, [], {}, { ...range, type: 3 }, { ...range, type: '1' }, { ...range, min: 4 },
        { ...range, current: 4 }, { ...range, current: -3 }, { ...range, max: null }, { ...range, min: '0' },
        { ...range, current: Infinity }]) invalid(() => convert(observation({ root: node({ rangeInfo: value }) })));
    const source = JSON.stringify(observation({ root: node({ rangeInfo: range }) }));
    invalid(() => extendedViewToXml(source.replace('"current":0.125', '"current":1e999')));
});

test('action metadata contains only unique bounded integer IDs and never action labels', () => {
    const input = observation({ root: node({ actions: [{ id: 0 }, { id: 16, label: SECRET }, { id: 2147483647, label: null }] }) });
    const xml = convert(input);
    assert.equal(xml.includes(SECRET), false);
    assert.deepEqual(JSON.parse(new Screen(xml).nodes[0].attrs['a11y-actions']), [0, 16, 2147483647]);
    for (const actions of [null, {}, [16], [{ id: 16 }, { id: 16 }], [{ id: -1 }], [{ id: 1.5 }],
        [{ id: '16' }], [{ id: null }], [{ id: 2147483648 }], [{ id: 16, label: {} }],
        Array.from({ length: 65 }, (_, index) => ({ id: index }))]) {
        invalid(() => convert(observation({ root: node({ actions }) })));
    }
});

test('unknown metadata is ignored and never copied into XML or errors', () => {
    const input = observation({ arbitrary: SECRET, unsupportedGetters: [SECRET],
        root: node({ extras: { private: SECRET }, arbitrary: { private: SECRET }, collectionInfo: { private: SECRET },
            unknownInvalidUnicode: '\ud800', actions: [{ id: 16, arbitrary: SECRET }] }) });
    input.windowsBefore.arbitrary = SECRET;
    input.windowsBefore.vwWindows[0].arbitrary = SECRET;
    const xml = convert(input);
    assert.equal(xml.includes(SECRET), false);
    assert.equal(new Screen(xml).nodes.length, 1);
});

test('node-count agreement and child arrays are enforced without returning any partial view', () => {
    invalid(() => convert(observation({ root: node({ children: [node()] }), nodeCount: 1 })));
    invalid(() => convert(observation({ nodeCount: 2 })));
    for (const children of [null, {}, 'children', [null], [false]]) {
        const input = observation();
        input.root.children = children;
        invalid(() => convert(input));
    }
    const missing = observation();
    delete missing.root.children;
    invalid(() => convert(missing));
});

test('tree depth uses the producer zero-based limit and rejects one extra level', () => {
    let root = node();
    for (let depth = 0; depth < 40; depth++) root = node({ children: [root] });
    assert.equal(new Screen(convert(observation({ root }))).nodes.length, 41);
    root = node({ children: [root] });
    invalid(() => convert(observation({ root })));
});

test('at most 2000 nodes are converted and more nodes cannot hide behind a forged count', () => {
    const root = node({ children: Array.from({ length: 1999 }, () => node()) });
    assert.equal(new Screen(convert(observation({ root }))).nodes.length, 2000);
    root.children.push(node());
    invalid(() => convert(observation({ root, nodeCount: 2000 })));
});

test('both input bytes and XML expansion are bounded by two MiB', () => {
    const oversized = JSON.stringify(observation({ ignored: 'x'.repeat(2 * 1024 * 1024) }));
    invalid(() => extendedViewToXml(oversized));
    invalid(() => extendedViewToXml(Buffer.from(oversized)));
    const multibyte = JSON.stringify(observation({ ignored: 'é'.repeat(1050000) }));
    assert.ok(multibyte.length < 2 * 1024 * 1024);
    invalid(() => extendedViewToXml(multibyte));
    const expanded = observation({ root: node({ children: Array.from({ length: 90 }, () => node({ text: '&'.repeat(5000) })) }) });
    assert.ok(Buffer.byteLength(JSON.stringify(expanded)) < 2 * 1024 * 1024);
    invalid(() => convert(expanded));
});
