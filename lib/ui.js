'use strict';

// A fresh Android UI Automator dump must be inspected immediately before a
// gesture. Controls are identified by resource ID; no coordinates are saved.
const { TextDecoder } = require('node:util');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { BridgeError } = require('./errors');

const PACKAGE = 'com.volkswagen.weconnect';
const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_XML_DEPTH = 256;
const MAX_UI_NODES = 20000;
const DIALOG = /dialog|alert|popup/i;
const BOUNDS = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/;
const SELECTOR_KEYS = new Set(['text', 'contentDesc', 'contentDescPrefix', 'resourceId']);

function invalidUi() {
    return new BridgeError('invalid_ui', 'Das Handy hat keine gültige Android-Ansicht geliefert.');
}

function validateXmlReferences(source) {
    const named = new Set(['amp', 'apos', 'quot', 'lt', 'gt']);
    for (let offset = source.indexOf('&'); offset !== -1;) {
        const end = source.indexOf(';', offset + 1);
        if (end < 0) throw invalidUi();
        const reference = source.slice(offset + 1, end);
        if (!named.has(reference)) {
            let point;
            if (/^#[0-9]+$/.exec(reference)?.[0] === reference) point = Number(reference.slice(1));
            else if (/^#x[0-9A-Fa-f]+$/.exec(reference)?.[0] === reference) point = Number.parseInt(reference.slice(2), 16);
            else throw invalidUi();
            if (!Number.isSafeInteger(point) || !(
                point === 0x9 || point === 0xa || point === 0xd ||
                (point >= 0x20 && point <= 0xd7ff) ||
                (point >= 0xe000 && point <= 0xfffd) ||
                (point >= 0x10000 && point <= 0x10ffff)
            )) throw invalidUi();
        }
        offset = source.indexOf('&', end + 1);
    }
}

function parseXml(xml) {
    try {
        let source;
        if (Buffer.isBuffer(xml)) {
            if (xml.length > MAX_XML_BYTES) throw invalidUi();
            source = new TextDecoder('utf-8', { fatal: true }).decode(xml);
        } else if (typeof xml === 'string') {
            if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) throw invalidUi();
            source = xml;
        } else {
            throw invalidUi();
        }
        // UI Automator has no DTD, custom entities, or binary/UTF-16 input.
        // Built-in XML escapes remain necessary for legitimate app labels.
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(source) || /[\ud800-\udfff]/u.test(source) ||
            /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw invalidUi();
        validateXmlReferences(source);
        if (XMLValidator.validate(source, { allowBooleanAttributes: false }) !== true) throw invalidUi();
        const parser = new XMLParser({
            preserveOrder: true,
            ignoreAttributes: false,
            attributeNamePrefix: '',
            parseAttributeValue: false,
            parseTagValue: false,
            trimValues: false,
            processEntities: true,
            // This parser version enables numeric references with htmlEntities.
            // The validation above restricts named references to the five XML
            // built-ins, so HTML-only and custom entities remain disallowed.
            htmlEntities: true,
            ignoreDeclaration: true,
            ignorePiTags: true,
        });
        const ordered = parser.parse(source);
        if (!Array.isArray(ordered) || ordered.length !== 1 || !Array.isArray(ordered[0].hierarchy)) throw invalidUi();
        const root = { tag: 'hierarchy', attrs: Object.create(null), children: [], parent: null };
        const nodes = [];
        const stack = [{ items: ordered[0].hierarchy, parent: root, depth: 0 }];
        while (stack.length) {
            const { items, parent, depth } = stack.pop();
            if (depth > MAX_XML_DEPTH) throw invalidUi();
            const pending = [];
            for (const item of items) {
                const names = Object.keys(item).filter(name => name !== ':@');
                if (names.length !== 1) throw invalidUi();
                if (names[0] === '#text' && typeof item['#text'] === 'string' && !item['#text'].trim()) continue;
                if (names[0] !== 'node' || !Array.isArray(item.node)) throw invalidUi();
                const attrs = item[':@'] || {};
                if (Object.values(attrs).some(value => typeof value !== 'string')) throw invalidUi();
                const node = { tag: 'node', attrs: Object.assign(Object.create(null), attrs), children: [], parent };
                parent.children.push(node);
                nodes.push(node);
                if (nodes.length > MAX_UI_NODES) throw invalidUi();
                pending.push({ items: item.node, parent: node, depth: depth + 1 });
            }
            for (let i = pending.length - 1; i >= 0; i--) stack.push(pending[i]);
        }
        return { root, nodes };
    } catch (_) {
        // Parser messages and XML snippets can contain personal vehicle data.
        throw invalidUi();
    }
}

class Screen {
    constructor(xml, packageName = PACKAGE) {
        if (typeof packageName !== 'string' || !packageName.trim()) throw invalidUi();
        this.package = packageName;
        const parsed = parseXml(xml);
        this.root = parsed.root;
        this.nodes = parsed.nodes;
    }

    *_ancestors(node) {
        for (let current = node; current && current.tag === 'node'; current = current.parent) yield current;
    }

    *_descendants(node) {
        const pending = [node];
        while (pending.length) {
            const current = pending.pop();
            yield current;
            for (let i = current.children.length - 1; i >= 0; i--) pending.push(current.children[i]);
        }
    }

    _package(node) {
        for (const ancestor of this._ancestors(node)) {
            if (ancestor.attrs.package) return ancestor.attrs.package;
        }
        return this.package;
    }

    _name(value) {
        if (typeof value !== 'string' || !value) return null;
        const separator = value.indexOf(':id/');
        if (separator >= 0) {
            const name = value.slice(separator + 4);
            return value.slice(0, separator) === this.package && name ? name : null;
        }
        return !value.includes('/') && !value.includes(':') ? value : null;
    }

    _resource(node) {
        return this._name(node.attrs['resource-id'] || '');
    }

    _find(resourceId) {
        const name = this._name(resourceId);
        if (name === null) throw new BridgeError('target_unavailable', 'Die Kennung des Bedienelements ist ungültig.');
        return this.nodes.filter(node => this._package(node) === this.package && this._resource(node) === name);
    }

    _visible(node) {
        for (const ancestor of this._ancestors(node)) {
            if ((ancestor.attrs['visible-to-user'] ?? 'true') !== 'true') return false;
        }
        return true;
    }

    _bounds(node) {
        const value = node.attrs.bounds || '';
        const match = BOUNDS.exec(value);
        if (!match || match[0] !== value) return null;
        const values = match.slice(1).map(Number);
        if (!values.every(Number.isSafeInteger)) return null;
        const [x1, y1, x2, y2] = values;
        return x2 > x1 && y2 > y1 ? values : null;
    }

    _unique(resourceId) {
        const matches = this._find(resourceId);
        if (matches.length > 1) throw new BridgeError('ambiguous_ui', 'Das Handy zeigt mehrere passende Bedienelemente.');
        if (matches.length !== 1 || !this._visible(matches[0]) || !this._bounds(matches[0])) {
            throw new BridgeError('target_unavailable', 'Das benötigte Bedienelement ist nicht eindeutig sichtbar.');
        }
        return matches[0];
    }

    checkClear() {
        for (const node of this.nodes) {
            // A disabled popup still blocks operation; never tap through it.
            if (DIALOG.test(node.attrs['resource-id'] || '') || DIALOG.test(node.attrs.class || '')) {
                throw new BridgeError('blocked_ui', 'Einen Dialog oder ein Popup zuerst am Handy prüfen.');
            }
            const owner = this._package(node);
            if (this._visible(node) && owner !== this.package && owner !== 'com.android.systemui') {
                throw new BridgeError('blocked_ui', 'Eine andere Anwendung ist auf dem Handy sichtbar.');
            }
        }
    }

    kind() {
        if (this._find('clima_compose_view').length && (this._find('cta_start').length || this._find('cta_stop').length)) return 'climate';
        return this._find('climateTile').length ? 'overview' : 'unknown';
    }

    requireVehicle(selector) {
        if (!selector || typeof selector !== 'object' || Array.isArray(selector) ||
            !Object.keys(selector).length || Object.keys(selector).some(key => !SELECTOR_KEYS.has(key)) ||
            !['text', 'contentDesc', 'contentDescPrefix'].some(key => typeof selector[key] === 'string' && selector[key].trim()) ||
            Object.values(selector).some(value => typeof value !== 'string' || !value.trim())) {
            throw new BridgeError('wrong_vehicle', 'Ein eindeutiges Fahrzeugmerkmal zuerst konfigurieren.');
        }
        const resource = selector.resourceId === undefined ? null : this._name(selector.resourceId);
        if (selector.resourceId !== undefined && resource === null) {
            throw new BridgeError('wrong_vehicle', 'Die Kennung des Fahrzeugmerkmals ist ungültig.');
        }
        const matches = this.nodes.filter(node => this._package(node) === this.package &&
            (selector.text === undefined || (node.attrs.text || '') === selector.text) &&
            (selector.contentDesc === undefined || (node.attrs['content-desc'] || '') === selector.contentDesc) &&
            (selector.contentDescPrefix === undefined || (node.attrs['content-desc'] || '').startsWith(selector.contentDescPrefix)) &&
            (resource === null || this._resource(node) === resource));
        if (matches.length !== 1 || !this._visible(matches[0]) || !this._bounds(matches[0])) {
            throw new BridgeError('wrong_vehicle', 'Das konfigurierte Fahrzeugmerkmal fehlt oder ist mehrdeutig.');
        }
    }

    climateState() {
        try {
            this._unique('clima_compose_view');
            const start = this._find('cta_start');
            const stop = this._find('cta_stop');
            if (start.length + stop.length !== 1) throw new Error('ambiguous state');
            this._unique(start.length ? 'cta_start' : 'cta_stop');
            return start.length ? 'off' : 'on';
        } catch (_) {
            throw new BridgeError('unknown_state', 'Der angezeigte Klimazustand ist nicht eindeutig erkennbar.');
        }
    }

    overviewClimateEvidence() {
        const tiles = this._find('climateTile').filter(node => this._visible(node) && this._bounds(node));
        if (tiles.length > 1) {
            throw new BridgeError('unknown_state', 'Die Übersicht zeigt mehrere passende Klima-Kacheln.');
        }
        if (!tiles.length) return null;
        const observedOn = 'Vorklimatisierung. An. Details öffnen';
        const descriptions = [...this._descendants(tiles[0])].filter(node => node !== tiles[0] &&
            this._package(node) === this.package && this._visible(node) && this._bounds(node)).map(node => node.attrs['content-desc'] || '');
        const onLabels = descriptions.filter(description => description === observedOn);
        if (!onLabels.length) {
            // A climate description with an unrecognized state must prevent a
            // positive fallback from a different view; it does not prove off.
            return descriptions.some(description => description.startsWith('Vorklimatisierung.'))
                ? { appState: 'unknown', confirmationSource: 'none' } : null;
        }
        if (onLabels.length !== 1 || descriptions.some(description =>
            description.startsWith('Vorklimatisierung.') && description !== observedOn)) {
            throw new BridgeError('unknown_state', 'Die Klima-Kachel zeigt keinen eindeutigen Zustand.');
        }
        // This is an observed accessibility label, not a countdown or an
        // independent vehicle acknowledgement. No other state label is inferred.
        return { appState: 'on', confirmationSource: 'app_overview' };
    }

    requireAcMode(allowedTitles) {
        if (!Array.isArray(allowedTitles) || allowedTitles.some(title => typeof title !== 'string' || !title.trim())) {
            throw new BridgeError('unsafe_mode', 'Die zugelassenen Bezeichnungen für Klimatisierung sind ungültig.');
        }
        if (this._find('clima_air_conditioning_pick').length) {
            try {
                const picker = this._unique('clima_air_conditioning_pick');
                const titles = [...this._descendants(picker)].filter(node => this._resource(node) === 'title');
                if (titles.length === 1 && this._visible(titles[0]) && allowedTitles.includes(titles[0].attrs.text || '')) return;
            } catch (_) {
                // Every absent/ambiguous picker fails closed below.
            }
            throw new BridgeError('unsafe_mode', 'Den geprüften Modus Klimatisierung zuerst am Handy auswählen.');
        }
        try {
            const ac = this._unique('air_conditioning_toggle');
            const windows = this._unique('window_heating_toggle');
            if (ac.attrs.checked === 'true' && windows.attrs.checked === 'false') return;
        } catch (_) {
            // Missing and contradictory toggle states never authorize a start.
        }
        throw new BridgeError('unsafe_mode', 'Der Modus nur Klimatisierung ist nicht bestätigt; Handy prüfen.');
    }

    _sameControlAncestor(node) {
        if (node.attrs.clickable === 'true') return node;
        const targetName = this._resource(node);
        let branch = node;
        for (let parent = node.parent; parent && parent.tag === 'node'; parent = parent.parent) {
            const parentName = this._resource(parent);
            if (parentName !== null && parentName !== targetName) return null;
            for (const sibling of parent.children) {
                if (sibling === branch) continue;
                for (const other of this._descendants(sibling)) {
                    if (this._resource(other) !== null || other.attrs.clickable === 'true') return null;
                }
            }
            if (parent.attrs.clickable === 'true') return parent;
            branch = parent;
        }
        return null;
    }

    target(resourceId, { navigation = false } = {}) {
        const node = this._unique(resourceId);
        for (const ancestor of this._ancestors(node)) {
            if (ancestor.attrs.enabled !== 'true') {
                throw new BridgeError('target_unavailable', 'Das Bedienelement oder sein Container ist deaktiviert.');
            }
        }
        // Some app versions expose climateTile without clickable=true. This
        // exception is limited to opening that tile, never a start/stop button.
        if (!(navigation === true && this._resource(node) === 'climateTile') && !this._sameControlAncestor(node)) {
            throw new BridgeError('target_unavailable', 'Das Bedienelement ist nicht sicher anklickbar.');
        }
        const [x1, y1, x2, y2] = this._bounds(node);
        return { x: x1 + Math.floor((x2 - x1) / 2), y: y1 + Math.floor((y2 - y1) / 2) };
    }

    summary() {
        // Local diagnostics only. Labels can contain personal vehicle names.
        return this.nodes.filter(node => this._package(node) === this.package && this._visible(node)).map(node => ({
            resourceId: (node.attrs['resource-id'] || '').slice(0, 120),
            text: (node.attrs.text || '').slice(0, 120),
            contentDesc: (node.attrs['content-desc'] || '').slice(0, 120),
        })).filter(row => Object.values(row).some(Boolean));
    }
}

module.exports = { Screen, PACKAGE, MAX_XML_BYTES };
