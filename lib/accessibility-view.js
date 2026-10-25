'use strict';

const { TextDecoder } = require('node:util');
const { BridgeError } = require('./errors');

const PACKAGE = 'com.volkswagen.weconnect';
const FORMAT = 'vw-app-extended-accessibility-v1';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 2000;
const MAX_DEPTH = 40;
const MAX_TEXT = 5000;
const MAX_WINDOWS = 16;
const MAX_ACTIONS = 64;
const MAX_INTEGER = 2147483647;
const BOOLEAN_ATTRIBUTES = Object.freeze({ visible: 'visible-to-user', enabled: 'enabled', clickable: 'clickable',
    longClickable: 'long-clickable', checkable: 'checkable', checked: 'checked', selected: 'selected',
    scrollable: 'scrollable', focusable: 'focusable', focused: 'focused', accessibilityFocused: 'accessibility-focused',
    password: 'password', heading: 'heading', screenReaderFocusable: 'screen-reader-focusable',
    importantForAccessibility: 'important-for-accessibility' });

function unavailable() {
    return new BridgeError('extended_ui_unavailable', 'Die erweiterte Android-Ansicht lässt sich nicht sicher auslesen.');
}

function requireValue(condition) { if (!condition) throw unavailable(); }
function record(value) { requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)); return value; }
function own(value, key) { requireValue(Object.hasOwn(value, key)); return value[key]; }
function integer(value, minimum = 0, maximum = MAX_INTEGER) {
    requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum);
    return value;
}
function boolean(value) { requireValue(typeof value === 'boolean'); return value; }
function finite(value) { requireValue(typeof value === 'number' && Number.isFinite(value)); return value; }

function text(value) {
    if (value === null) return '';
    requireValue(typeof value === 'string' && value.length <= MAX_TEXT
        && !/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(value) && !/[\ud800-\udfff]/u.test(value));
    return value;
}

function escaped(value) {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
        .replaceAll('\t', '&#9;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;');
}

function bounds(value) {
    requireValue(Array.isArray(value) && value.length === 4);
    const points = value.map(point => integer(point, 0, 20000));
    requireValue(points[2] >= points[0] && points[3] >= points[1]);
    return points;
}

function windows(value, rootWindowId) {
    const input = record(value);
    requireValue(own(input, 'multipleVwApplicationWindows') === false);
    const entries = own(input, 'vwWindows');
    requireValue(Array.isArray(entries) && entries.length >= 1 && entries.length <= MAX_WINDOWS);
    integer(own(input, 'foreignWindowCount'), 0, MAX_WINDOWS - entries.length);
    const ids = new Set();
    let applications = 0;
    const active = [];
    const focused = [];
    for (const entry of entries) {
        const window = record(entry);
        const id = integer(own(window, 'id'));
        requireValue(!ids.has(id));
        ids.add(id);
        const type = integer(own(window, 'type'), 1);
        const coordinates = bounds(own(window, 'bounds'));
        if (type === 1) applications++;
        const isActive = boolean(own(window, 'active'));
        const isFocused = boolean(own(window, 'focused'));
        if (isActive) active.push({ id, type, bounds: coordinates });
        if (isFocused) focused.push({ id, type });
        const accessibilityFocused = own(window, 'accessibilityFocused');
        if (accessibilityFocused !== null) boolean(accessibilityFocused);
        const layer = own(window, 'layer');
        if (layer !== null) integer(layer, -2147483648);
        text(own(window, 'title'));
    }
    requireValue(applications === 1 && active.length === 1 && focused.length === 1
        && active[0].id === rootWindowId && focused[0].id === rootWindowId
        && active[0].type === 1 && focused[0].type === 1);
    requireValue(active[0].bounds[2] > active[0].bounds[0] && active[0].bounds[3] > active[0].bounds[1]);
    return { signature: active[0].id + ':' + active[0].type + ':true:true', bounds: active[0].bounds };
}

function actionIds(value) {
    requireValue(Array.isArray(value) && value.length <= MAX_ACTIONS);
    const ids = [];
    for (const item of value) {
        const action = record(item);
        const id = integer(own(action, 'id'));
        requireValue(!ids.includes(id));
        if (Object.hasOwn(action, 'label')) text(action.label);
        ids.push(id);
    }
    return ids;
}

function rangeAttributes(value) {
    if (value === null) return {};
    const range = record(value);
    const type = integer(own(range, 'type'), 0, 2);
    const min = finite(own(range, 'min'));
    const max = finite(own(range, 'max'));
    const current = finite(own(range, 'current'));
    requireValue(min <= current && current <= max);
    return { 'range-type': String(type), 'range-min': String(min), 'range-max': String(max), 'range-current': String(current) };
}

function convert(raw) {
    let source;
    if (Buffer.isBuffer(raw)) {
        requireValue(raw.length <= MAX_BYTES);
        source = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } else {
        requireValue(typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') <= MAX_BYTES
            && !/[\ud800-\udfff]/u.test(raw));
        source = raw;
    }
    const input = record(JSON.parse(source));
    requireValue(own(input, 'format') === FORMAT && own(input, 'package') === PACKAGE && own(input, 'readOnly') === true);
    const started = finite(own(input, 'startedAtEpochMs'));
    const finished = finite(own(input, 'finishedAtEpochMs'));
    requireValue(started >= 0 && finished <= Number.MAX_SAFE_INTEGER && finished >= started);
    const windowId = integer(own(input, 'windowId'));
    const beforeWindow = windows(own(input, 'windowsBefore'), windowId);
    const afterWindow = windows(own(input, 'windowsAfter'), windowId);
    requireValue(beforeWindow.signature === afterWindow.signature
        && beforeWindow.bounds.every((point, index) => point === afterWindow.bounds[index]));
    const viewport = beforeWindow.bounds;
    const expectedCount = integer(own(input, 'nodeCount'), 1, MAX_NODES);
    let count = 0;
    let bytes = 0;
    const parts = [];
    const append = part => {
        bytes += Buffer.byteLength(part, 'utf8');
        requireValue(bytes <= MAX_BYTES);
        parts.push(part);
    };
    const node = (value, depth, index, path) => {
        // The producer counts the root at depth zero, allowing at most 40 edges.
        requireValue(depth <= MAX_DEPTH && ++count <= MAX_NODES);
        const current = record(value);
        requireValue(own(current, 'package') === PACKAGE);
        const coordinates = bounds(own(current, 'bounds'));
        const attributes = { index: String(index), 'a11y-path': path, package: PACKAGE,
            'resource-id': text(own(current, 'id')), class: text(own(current, 'class')),
            text: text(own(current, 'text')), 'content-desc': text(own(current, 'description')),
            'state-description': text(own(current, 'stateDescription')),
            bounds: '[' + coordinates[0] + ',' + coordinates[1] + '][' + coordinates[2] + ',' + coordinates[3] + ']' };
        for (const [field, attribute] of Object.entries(BOOLEAN_ATTRIBUTES)) attributes[attribute] = String(boolean(own(current, field)));
        // Keep the original rectangles and every child index for exact native
        // selectors. A clipped/off-window rectangle is not a visible target;
        // clamping it would invent coordinates that differ from Android's node.
        const insideWindow = coordinates[2] > coordinates[0] && coordinates[3] > coordinates[1]
            && coordinates[0] >= viewport[0] && coordinates[1] >= viewport[1]
            && coordinates[2] <= viewport[2] && coordinates[3] <= viewport[3];
        attributes['visible-to-user'] = String(current.visible && insideWindow);
        requireValue(current.password === false);
        for (const field of ['hintText', 'paneTitle', 'errorText']) {
            if (Object.hasOwn(current, field)) text(current[field]);
        }
        Object.assign(attributes, rangeAttributes(own(current, 'rangeInfo')));
        attributes['a11y-actions'] = JSON.stringify(actionIds(own(current, 'actions')));
        const children = own(current, 'children');
        requireValue(Array.isArray(children) && children.length <= MAX_NODES);
        append('<node ' + Object.entries(attributes).map(([key, value]) => key + '="' + escaped(value) + '"').join(' ') + '>');
        children.forEach((child, index) => node(child, depth + 1, index, path + '.' + index));
        append('</node>');
    };
    append('<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">');
    node(own(input, 'root'), 0, 0, '0');
    requireValue(count === expectedCount);
    append('</hierarchy>');
    return parts.join('');
}

function extendedViewToXml(raw) {
    try { return convert(raw); }
    catch (_) { throw unavailable(); }
}

module.exports = { extendedViewToXml };
