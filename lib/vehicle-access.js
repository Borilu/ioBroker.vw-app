'use strict';

const { BridgeError } = require('./errors');

const ACCESS_POSITIONS = Object.freeze(['frontLeft', 'frontRight', 'rearLeft', 'rearRight']);
const ACCESS_COMPONENTS = Object.freeze({
    'Tür vorne links': ['doors', 'frontLeft'], 'Tür vorne rechts': ['doors', 'frontRight'],
    'Tür hinten links': ['doors', 'rearLeft'], 'Tür hinten rechts': ['doors', 'rearRight'],
    'Fenster vorne links': ['windows', 'frontLeft'], 'Fenster vorne rechts': ['windows', 'frontRight'],
    'Fenster hinten links': ['windows', 'rearLeft'], 'Fenster hinten rechts': ['windows', 'rearRight'],
    Kofferraum: ['trunkOpen'],
});
const MODEL_KEYS = ['doors', 'windows', 'trunkOpen', 'locked', 'synchronizationText', 'warningText'];
const WARNING_PREFIX = 'Etwas ist noch offen oder eingeschaltet:.';
const MAX_WARNING = 4096;

function fail(code = 'invalid_vehicle_access') {
    throw new BridgeError(code, code === 'unknown_state'
        ? 'Die Türen-, Fenster- und Verriegelungsanzeige ist nicht eindeutig lesbar.'
        : 'Die ausgelesenen Öffnungs- und Verriegelungswerte sind ungültig.');
}

function record(value, keys) {
    if (value === null || typeof value !== 'object') fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length) fail();
    const result = {};
    for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        result[key] = descriptor.value;
    }
    return result;
}

function boolean(value) {
    if (value !== null && typeof value !== 'boolean') fail();
    return value;
}

function text(value, max, empty = false) {
    if (typeof value !== 'string' || value.length > max || !empty && !value.trim()
        || /[\u0000-\u001f\u007f]/u.test(value)) fail();
    return value;
}

function validateVehicleAccess(value) {
    try {
        const input = record(value, MODEL_KEYS);
        const group = value => {
            const result = record(value, ACCESS_POSITIONS);
            return Object.fromEntries(ACCESS_POSITIONS.map(key => [key, boolean(result[key])]));
        };
        return { doors: group(input.doors), windows: group(input.windows),
            trunkOpen: boolean(input.trunkOpen), locked: boolean(input.locked),
            synchronizationText: text(input.synchronizationText, 512), warningText: text(input.warningText, MAX_WARNING, true) };
    } catch (error) {
        // Data may contain accessors or proxies. Never include their exception,
        // a vehicle label or untrusted model values in a public error.
        if (error instanceof BridgeError && error.code === 'invalid_vehicle_access') throw error;
        return fail();
    }
}

function openings(initial) {
    return { doors: Object.fromEntries(ACCESS_POSITIONS.map(key => [key, initial])),
        windows: Object.fromEntries(ACCESS_POSITIONS.map(key => [key, initial])), trunkOpen: initial };
}

function contains(outer, inner) {
    return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function fullyVisible(screen, node) {
    const bounds = screen._bounds(node);
    if (!bounds || !screen._visible(node) || !screen._enabledPath(node) || screen._package(node) !== screen.package) return false;
    for (const ancestor of screen._ancestors(node)) {
        const outer = screen._bounds(ancestor);
        if (!outer || !contains(outer, bounds)) return false;
    }
    return true;
}

function unique(list) {
    if (list.length !== 1) fail('unknown_state');
    return list[0];
}

function readWarning(description, locked, blankSlot) {
    if (!description) return openings(blankSlot ? false : null);
    const result = openings(null);
    if (description.length > MAX_WARNING || /[\u0000-\u001f\u007f]/u.test(description)) fail('unknown_state');
    const prefix = /^Fahrzeug ist (entriegelt|verriegelt)\. /u.exec(description);
    if (prefix && (prefix[1] === 'verriegelt') !== locked) fail('unknown_state');
    if (!prefix) return result;
    const suffix = description.slice(prefix[0].length);
    if (!suffix.startsWith(WARNING_PREFIX + ' ')) return result;
    const body = suffix.slice(WARNING_PREFIX.length + 1).trim();
    // The observed label has a final full stop. A truncated list cannot prove
    // that an omitted component is closed.
    if (!body.endsWith('.')) return result;
    const labels = body.slice(0, -1).split('. ').map(label => label.trim());
    if (!labels.length || labels.some(label => !label) || new Set(labels).size !== labels.length) return result;
    const known = labels.filter(label => Object.hasOwn(ACCESS_COMPONENTS, label));
    const complete = known.length === labels.length;
    const observed = complete ? openings(false) : result;
    for (const label of known) {
        const [group, key] = ACCESS_COMPONENTS[label];
        if (key) observed[group][key] = true;
        else observed[group] = true;
    }
    return observed;
}

function readVehicleAccess(screen) {
    screen.checkClear();
    if (screen.kind() !== 'overview') fail('unknown_state');
    const page = screen._overviewPage();
    if (!page || !fullyVisible(screen, page.scope) || !fullyVisible(screen, page.scroll)) fail('unknown_state');
    const appNodes = screen.nodes.filter(node => screen._package(node) === screen.package);
    const headers = appNodes.filter(node => (node.attrs['content-desc'] || '').startsWith('Ihr Fahrzeug: '));
    const header = unique(headers);
    if (!screen._within(header, page.scope) || !fullyVisible(screen, header)) fail('unknown_state');
    const headerLabel = header.attrs['content-desc'];
    const sync = /^Ihr Fahrzeug: [^\r\n]{1,200}\. (Gerade synchronisiert|Synchronisiert vor [^.\r\n]{1,160})$/u.exec(headerLabel);
    if (!sync) fail('unknown_state');

    const range = unique(screen._find('rangeTile'));
    const climate = unique(screen._find('climateTile'));
    if (![range, climate].every(node => fullyVisible(screen, node))) fail('unknown_state');
    const rangeBounds = screen._bounds(range);
    const climateBounds = screen._bounds(climate);
    const headerBounds = screen._bounds(header);
    if (rangeBounds[1] !== climateBounds[1] || rangeBounds[3] !== climateBounds[3]
        || rangeBounds[2] >= climateBounds[0] || rangeBounds[1] <= headerBounds[3]) fail('unknown_state');
    // These are the actual complete car-graphic and status-slot roles. When
    // nothing is open the slot remains present, but has no accessibility text.
    // Requiring it prevents an absent/clipped warning from being read as closed.
    const graphics = page.scroll.children.filter(node => node.attrs.class === 'androidx.compose.ui.viewinterop.ViewFactoryHolder');
    const graphic = unique(graphics);
    const graphicBounds = screen._bounds(graphic);
    const scrollBounds = screen._bounds(page.scroll);
    if (!fullyVisible(screen, graphic) || graphicBounds[0] !== scrollBounds[0] || graphicBounds[2] !== scrollBounds[2]
        || graphicBounds[3] <= headerBounds[3] || graphicBounds[3] > rangeBounds[1]) fail('unknown_state');
    const slots = page.scroll.children.filter(node => {
        const bounds = screen._bounds(node);
        return bounds && bounds[0] === scrollBounds[0] && bounds[2] === scrollBounds[2]
            && bounds[1] === graphicBounds[3] && bounds[1] <= rangeBounds[1] && bounds[3] > rangeBounds[1];
    });
    const placeholders = slots.filter(node => node.attrs.class === 'android.view.View' && !node.attrs['content-desc'] && !node.attrs.text);
    const placeholder = unique(placeholders);
    const warningImages = slots.filter(node => node.attrs.class === 'android.widget.ImageView');
    if (warningImages.length > 1 || slots.length !== 1 + warningImages.length || slots.some(node =>
        !fullyVisible(screen, node) || node.attrs['resource-id'] || node.children.length)) fail('unknown_state');
    const slot = warningImages[0] || placeholder;

    const lockLabels = appNodes.filter(node => (node.attrs['content-desc'] || '').startsWith('Fahrzeug.'));
    const lockLabel = unique(lockLabels);
    if (!screen._within(lockLabel, page.scroll) || !fullyVisible(screen, lockLabel)) fail('unknown_state');
    const lockMatch = /^Fahrzeug\. (Entriegelt|Verriegelt)\. Details öffnen$/u.exec(lockLabel.attrs['content-desc']);
    if (!lockMatch) fail('unknown_state');
    const locked = lockMatch[1] === 'Verriegelt';
    const lockBounds = screen._bounds(lockLabel);
    if (lockBounds[1] <= rangeBounds[3] || !lockLabel.parent || !screen._within(lockLabel.parent, page.scroll)) fail('unknown_state');
    const lockTexts = screen._scopeNodes(lockLabel.parent).filter(node => node.attrs.class === 'android.widget.TextView'
        && ['Entriegelt', 'Verriegelt'].includes(node.attrs.text));
    const lockText = unique(lockTexts);
    if (!fullyVisible(screen, lockText) || lockText.attrs.text !== lockMatch[1]) fail('unknown_state');
    const outsideWarnings = appNodes.filter(node => (node.attrs['content-desc'] || '').startsWith('Fahrzeug ist '));
    if (outsideWarnings.length > 1 || outsideWarnings.some(node => node !== slot)) fail('unknown_state');
    const warningText = slot.attrs['content-desc'] || slot.attrs.text || '';
    const blankSlot = slot === placeholder;
    return validateVehicleAccess({ ...readWarning(warningText, locked, blankSlot), locked,
        synchronizationText: sync[1], warningText });
}

module.exports = { ACCESS_POSITIONS, ACCESS_COMPONENTS, validateVehicleAccess, readVehicleAccess };
