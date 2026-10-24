'use strict';

const { TextDecoder } = require('node:util');
const { BridgeError } = require('./errors');

const PACKAGE = 'com.volkswagen.weconnect';
const SLIDER_CLASS = PACKAGE + '.resources.views.slider.GradientSlider';
const TEXT_CLASS = 'androidx.appcompat.widget.AppCompatTextView';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 40000;
const MAX_NODES = 20000;
const MAX_DEPTH = 256;
const MAX_NATIVE_COORDINATE = 1000000;
const MAX_SCREEN_COORDINATE = 20000;
const VIEW = /^( *)([A-Za-z_$][A-Za-z0-9_.$]*)\{([0-9a-fA-F]+) ([VIG][A-Z.]{8}) ([A-Z.]{8}) (-?[0-9]+),(-?[0-9]+)-(-?[0-9]+),(-?[0-9]+)([^{}]*)\}$/;

function unavailable() {
    // Native dumps can contain identifiers and private app state. Never return
    // parser exceptions, raw lines, activity tokens or caller-supplied values.
    return new BridgeError('charging_slider_unavailable', 'Die native Ladegrenze lässt sich nicht sicher mit der aktuellen App-Ansicht abgleichen.');
}

function requireCondition(condition) {
    if (!condition) throw unavailable();
}

function positive(bounds) {
    return bounds[2] > bounds[0] && bounds[3] > bounds[1];
}

function contains(outer, inner) {
    return inner[0] >= outer[0] && inner[1] >= outer[1]
        && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function same(left, right) {
    return left.every((coordinate, index) => coordinate === right[index]);
}

function contextBounds(value) {
    requireCondition(Array.isArray(value) && value.length === 4
        && value.every(coordinate => Number.isSafeInteger(coordinate) && coordinate >= 0 && coordinate <= MAX_SCREEN_COORDINATE));
    const bounds = [...value];
    requireCondition(positive(bounds));
    return bounds;
}

function parseContext(context) {
    const keys = ['scopeBounds', 'subtitleBounds', 'valueBounds'];
    requireCondition(context && typeof context === 'object' && !Array.isArray(context)
        && Object.keys(context).length === keys.length && keys.every(key => Object.hasOwn(context, key)));
    const checked = Object.fromEntries(keys.map(key => [key, contextBounds(context[key])]));
    requireCondition(contains(checked.scopeBounds, checked.subtitleBounds) && contains(checked.scopeBounds, checked.valueBounds));
    return checked;
}

function textSource(input) {
    let text;
    if (Buffer.isBuffer(input)) {
        requireCondition(input.length <= MAX_BYTES);
        text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } else {
        requireCondition(typeof input === 'string' && Buffer.byteLength(input, 'utf8') <= MAX_BYTES);
        text = input;
    }
    text = text.replaceAll('\r\n', '\n');
    requireCondition(text.length > 0 && !/[\x00-\x09\x0b-\x1f\ufffe\uffff]/.test(text) && !/[\ud800-\udfff]/u.test(text));
    return text;
}

function resource(tail) {
    let numeric = false;
    let name = '';
    let autofill = false;
    for (const token of tail.trim().split(/ +/).filter(Boolean)) {
        if (/^#[0-9a-fA-F]+$/.test(token)) {
            requireCondition(!numeric && !name && !autofill);
            numeric = true;
        } else if (/^[A-Za-z0-9_.]+:id\/[A-Za-z0-9_]+$/.test(token)) {
            requireCondition(numeric && !name && !autofill);
            name = token;
        } else if (/^aid=[0-9]+$/.test(token)) {
            requireCondition(!autofill && Number.isSafeInteger(Number(token.slice(4))));
            autofill = true;
        } else throw unavailable();
    }
    return name;
}

function localId(node) {
    const match = /^(app|com\.volkswagen\.weconnect):id\/([A-Za-z0-9_]+)$/.exec(node.resource);
    return match ? match[2] : null;
}

function parseTree(input) {
    const lines = textSource(input).split('\n');
    requireCondition(lines.length <= MAX_LINES);
    const activityLines = [];
    const stateLines = [];
    const hierarchyLines = [];
    for (let index = 0; index < lines.length; index++) {
        if (/^ *ACTIVITY(?: |$)/.test(lines[index])) activityLines.push(index);
        if (/^ *mResumed=/.test(lines[index])) stateLines.push(index);
        if (/^ *View Hierarchy: *$/.test(lines[index])) hierarchyLines.push(index);
    }
    requireCondition(activityLines.length === 1 && stateLines.length === 1 && hierarchyLines.length === 1);
    const activityIndex = activityLines[0];
    const activity = /^( *)ACTIVITY com\.volkswagen\.weconnect\/(?:\.SingleActivity|com\.volkswagen\.weconnect\.SingleActivity) [0-9a-fA-F]+ pid=[1-9][0-9]* *$/.exec(lines[activityIndex]);
    requireCondition(activity && lines.findIndex(line => line.trim()) === activityIndex);
    const stateIndex = stateLines[0];
    const hierarchyIndex = hierarchyLines[0];
    requireCondition(activityIndex < stateIndex && stateIndex < hierarchyIndex
        && /^ +mResumed=true +mStopped=false +mFinished=false *$/.test(lines[stateIndex]));
    const hierarchyIndent = lines[hierarchyIndex].search(/\S/);
    requireCondition(hierarchyIndent > activity[1].length && lines[stateIndex].search(/\S/) > activity[1].length);
    const treeLines = [];
    for (let index = hierarchyIndex + 1; index < lines.length; index++) {
        if (!lines[index].trim()) continue;
        if (lines[index].search(/\S/) <= hierarchyIndent) break;
        treeLines.push(lines[index]);
    }
    requireCondition(treeLines.length > 1);
    const decor = /^( *)DecorView@[0-9a-fA-F]+\[SingleActivity\]$/.exec(treeLines[0]);
    requireCondition(decor && decor[1].length === hierarchyIndent + 2);
    const root = { decor: true, indent: decor[1].length, absolute: [0, 0, 0, 0], parent: null, children: [] };
    const stack = [root];
    const nodes = [];
    for (const line of treeLines.slice(1)) {
        const match = VIEW.exec(line);
        requireCondition(match);
        const indent = match[1].length;
        while (stack.length && stack.at(-1).indent >= indent) stack.pop();
        const parent = stack.at(-1);
        requireCondition(parent && indent === parent.indent + 2 && stack.length <= MAX_DEPTH);
        const bounds = match.slice(6, 10).map(Number);
        requireCondition(bounds.every(value => Number.isSafeInteger(value) && Math.abs(value) <= MAX_NATIVE_COORDINATE)
            && bounds[2] >= bounds[0] && bounds[3] >= bounds[1]);
        const absolute = bounds.map((coordinate, index) => coordinate + parent.absolute[index % 2]);
        requireCondition(absolute.every(value => Number.isSafeInteger(value) && Math.abs(value) <= MAX_NATIVE_COORDINATE));
        const node = { className: match[2], flags: match[4], resource: resource(match[10]), indent,
            absolute, parent, children: [] };
        parent.children.push(node);
        nodes.push(node);
        requireCondition(nodes.length <= MAX_NODES);
        stack.push(node);
    }
    return nodes;
}

function enabledPath(node, targetBounds) {
    for (let current = node; current && !current.decor; current = current.parent) {
        if (current.flags[0] !== 'V' || current.flags[2] !== 'E'
            || !positive(current.absolute) || !contains(current.absolute, targetBounds)) return false;
    }
    return true;
}

function geometry(input, context) {
    const checked = parseContext(context);
    const nodes = parseTree(input);
    const sliders = nodes.filter(node => node.className === SLIDER_CLASS);
    requireCondition(sliders.length === 1);
    const slider = sliders[0];
    requireCondition(localId(slider) === 'slider' && slider.flags[1] === 'F' && slider.flags[6] === 'C');
    const row = slider.parent;
    const card = row?.parent;
    const scope = card?.parent;
    const container = scope?.parent;
    requireCondition(row?.className === 'androidx.constraintlayout.widget.ConstraintLayout' && row.resource === ''
        && card?.className === 'androidx.cardview.widget.CardView' && card.resource === ''
        && scope?.className === 'androidx.recyclerview.widget.RecyclerView' && localId(scope) === 'recycler_view'
        && container?.className === 'com.volkswagen.lib.ui.WindowCoordinatorLayout' && localId(container) === 'container');
    requireCondition(row.children.length === 4 && same(scope.absolute, checked.scopeBounds)
        && positive(row.absolute) && contains(scope.absolute, card.absolute) && contains(card.absolute, row.absolute));
    const labels = {};
    for (const name of ['subtitle', 'value', 'info']) {
        const matches = row.children.filter(node => localId(node) === name);
        requireCondition(matches.length === 1 && matches[0].className === TEXT_CLASS);
        labels[name] = matches[0];
        requireCondition(enabledPath(matches[0], matches[0].absolute));
    }
    requireCondition(same(labels.subtitle.absolute, checked.subtitleBounds) && same(labels.value.absolute, checked.valueBounds)
        && enabledPath(slider, slider.absolute)
        && labels.subtitle.absolute[3] <= slider.absolute[1]
        && labels.value.absolute[0] >= slider.absolute[2]
        && labels.value.absolute[1] >= slider.absolute[1] && labels.value.absolute[3] <= slider.absolute[3]
        && labels.info.absolute[1] >= slider.absolute[3]);
    return { bounds: [...slider.absolute], rowBounds: [...row.absolute] };
}

// The caller supplies a just-read accessibility context from the recognized
// vehicle-settings page. This parser neither acquires UI state nor maps SOC to
// pixels; bounds must be reacquired for each separately authorized gesture.
function chargingSliderGeometry(nativeDump, context) {
    try { return geometry(nativeDump, context); }
    catch (_) { throw unavailable(); }
}

function chargingSliderTarget(nativeDump, context) {
    const { bounds: [x1, y1, x2, y2] } = chargingSliderGeometry(nativeDump, context);
    return { x: x1 + Math.floor((x2 - x1) / 2), y: y1 + Math.floor((y2 - y1) / 2) };
}

module.exports = { chargingSliderGeometry, chargingSliderTarget };
