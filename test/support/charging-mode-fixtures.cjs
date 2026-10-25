'use strict';

// Synthetic layouts built from control metadata, without phone or vehicle data.
const { node, hierarchy } = require('./charging-fixtures.cjs');
const MODE_LABELS = Object.freeze({ immediate: 'Sofortladen', departure: 'Laden zur Abfahrtszeit',
    departureClimate: 'Laden & Klima zur Abfahrt' });
const OPTION_LABELS = Object.freeze({ immediate: 'Sofortladen', departure: 'Laden zur Abfahrtszeit',
    departureClimate: 'Laden & Klima zur Abfahrt' });
const MODE_POINTS = Object.freeze({ open: { x: 500, y: 1170 }, back: { x: 70, y: 50 },
    immediate: { x: 500, y: 375 }, departure: { x: 500, y: 655 }, departureClimate: { x: 500, y: 935 } });

function rangeModeScreen({ mode = 'departureClimate', description, extraMode = '', enabled = true } = {}) {
    const bounds = '[50,1120][950,1220]';
    const summary = description ?? `Ladeverfahren. ${MODE_LABELS[mode]}. Ladeverfahren ändern`;
    return hierarchy([node('', {}, [
        node('', { bounds: '[0,600][1000,1400]' }, [
            node('', { clickable: 'true', bounds: '[30,630][130,730]' }, [
                node('', { 'content-desc': 'Schließen', bounds: '[50,650][110,710]' }),
                node('', { class: 'android.widget.Button', bounds: '[50,650][110,710]' }),
            ]),
            node('', { class: 'android.widget.ScrollView', bounds: '[0,750][1000,1250]' }, [
                node('', { bounds: '[50,750][950,1250]' }, [
                    node('', { bounds: '[200,770][800,950]' }, [
                        node('', { 'content-desc': 'Übersicht Reichweite. Batteriereichweite: 205 Kilometer', bounds: '[200,770][800,950]' }),
                        node('rangeArcRangeAndUnit', { bounds: '[350,850][650,940]' }),
                    ]),
                    node('rangeArcBatterySoc', { class: 'android.widget.TextView', text: 'Batterie 52 %',
                        'content-desc': 'Ladestatus. Batterieladung: 52 Prozent.', bounds: '[150,1000][850,1060]' }),
                    node('', { bounds }, [
                        node('', { clickable: 'true', enabled: String(enabled), bounds }, [
                            node('', { 'content-desc': summary, bounds }),
                            node('', { bounds: '[200,1150][750,1200]' }),
                            node('', { class: 'android.widget.Button', bounds }),
                        ]),
                    ]),
                    extraMode,
                ]),
            ]),
            node('', { clickable: 'true', enabled: 'false', bounds: '[100,1270][900,1390]' }, [
                node('', { 'content-desc': 'Laden starten. Ladestatus prüfen', bounds: '[100,1270][900,1390]' }),
            ]),
        ]),
    ])]);
}

function chargingModeScreen({ mode = 'departure', order = ['immediate', 'departure', 'departureClimate'] } = {}) {
    const options = order.map((key, index) => {
        const selected = key === mode;
        const top = 250 + index * 280;
        return node('', { class: 'android.widget.Button', clickable: 'false', checkable: String(selected), checked: String(selected), selected: 'false',
            'state-description': selected ? 'Ausgewählt' : '', 'a11y-actions': '[256,512,64,131072]',
            'content-desc': `${OPTION_LABELS[key]}. Erklärung des Ladeverfahrens. ${selected ? 'Ausgewählt' : 'Dieses Ladeverfahren wählen'}`,
            bounds: `[50,${top}][950,${top + 250}]` });
    });
    return hierarchy([node('composeView', { class: 'androidx.compose.ui.platform.ComposeView' }, [
        node('', {}, [
            node('', { bounds: '[0,0][1000,100]' }, [
                node('chargeModeSelectionBack', { clickable: 'true', 'a11y-actions': '[1,64,16]', bounds: '[20,0][120,100]' }, [
                    node('', { bounds: '[30,10][110,90]' }),
                    node('', { class: 'android.widget.Button', bounds: '[30,10][110,90]' }),
                ]),
                node('', { 'content-desc': 'Ladeverfahren', bounds: '[150,20][850,80]' }),
            ]),
            node('', { bounds: '[0,100][1000,1400]' }, [
                node('', { bounds: '[50,100][950,230]' }),
                ...options,
            ]),
        ]),
    ])]);
}

function nativeObservationFromXml(xml) {
    const { Screen } = require('../../lib/ui');
    const screen = new Screen(xml);
    const coordinates = node => {
        const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(node.attrs.bounds || '');
        if (!match) throw new Error('Synthetic fixture has invalid bounds');
        return match.slice(1).map(Number);
    };
    const width = Math.max(1080, ...screen.nodes.map(node => coordinates(node)[2]));
    const height = Math.max(2400, ...screen.nodes.map(node => coordinates(node)[3]));
    let count = 1;
    const convert = node => {
        count++;
        const a = node.attrs;
        const converted = { package: screen._package(node), id: a['resource-id'] || null,
            class: a.class || 'android.view.View', text: a.text || null, description: a['content-desc'] || null,
            stateDescription: a['state-description'] || null, bounds: coordinates(node),
            rangeInfo: null, actions: JSON.parse(a['a11y-actions'] || '[]').map(id => ({ id })),
            children: node.children.map(convert) };
        for (const [field, attribute, fallback] of [
            ['visible', 'visible-to-user', true], ['enabled', 'enabled', true], ['clickable', 'clickable', false],
            ['longClickable', 'long-clickable', false], ['checkable', 'checkable', false], ['checked', 'checked', false],
            ['selected', 'selected', false], ['scrollable', 'scrollable', false], ['focusable', 'focusable', false],
            ['focused', 'focused', false], ['accessibilityFocused', 'accessibility-focused', false],
            ['password', 'password', false], ['heading', 'heading', false],
            ['screenReaderFocusable', 'screen-reader-focusable', false], ['importantForAccessibility', 'important-for-accessibility', true],
        ]) converted[field] = Object.hasOwn(a, attribute) ? a[attribute] === 'true' : fallback;
        return converted;
    };
    const root = { package: 'com.volkswagen.weconnect', id: null, class: 'android.widget.FrameLayout',
        text: null, description: null, stateDescription: null, bounds: [0, 0, width, height],
        visible: true, enabled: true, clickable: false, longClickable: false, checkable: false, checked: false,
        selected: false, scrollable: false, focusable: false, focused: false, accessibilityFocused: false,
        password: false, heading: false, screenReaderFocusable: false, importantForAccessibility: true,
        rangeInfo: null, actions: [], children: screen.root.children.map(convert) };
    const window = { id: 7, type: 1, active: true, focused: true, accessibilityFocused: false, layer: 0,
        title: 'Synthetic adapter test window', bounds: [0, 0, width, height] };
    const windows = { vwWindows: [window], multipleVwApplicationWindows: false, foreignWindowCount: 0 };
    return { format: 'vw-app-extended-accessibility-v1', package: 'com.volkswagen.weconnect', readOnly: true,
        startedAtEpochMs: 10000, finishedAtEpochMs: 10001, windowId: 7, windowsBefore: structuredClone(windows),
        windowsAfter: structuredClone(windows), nodeCount: count, root };
}

module.exports = { rangeModeScreen, chargingModeScreen, nativeObservationFromXml, MODE_LABELS, OPTION_LABELS, MODE_POINTS };
