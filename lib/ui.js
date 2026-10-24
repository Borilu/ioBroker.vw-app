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
        const views = [this._modePage() ? 'mode' : null,
            this._composePage('Einstellungen') ? 'settings' : null, this._composePage('Zonen') ? 'zones' : null].filter(Boolean);
        if (views.length > 1) throw new BridgeError('unknown_state', 'Mehrere Einstellungsansichten sind gleichzeitig sichtbar.');
        if (views.length) return views[0];
        if (this._find('clima_compose_view').length && (this._find('cta_start').length || this._find('cta_stop').length)) return 'climate';
        return this._find('climateTile').length ? 'overview' : 'unknown';
    }

    _within(node, scope) {
        for (let current = node; current; current = current.parent) if (current === scope) return true;
        return false;
    }

    _scopeNodes(scope) {
        const outer = this._bounds(scope);
        if (!outer) return [];
        return [...this._descendants(scope)].filter(node => {
            const bounds = this._bounds(node);
            return this._package(node) === this.package && this._visible(node) && bounds &&
                bounds[0] >= outer[0] && bounds[1] >= outer[1] && bounds[2] <= outer[2] && bounds[3] <= outer[3];
        });
    }

    _stateFailure() {
        return new BridgeError('unknown_state', 'Die angezeigten Klimaeinstellungen sind nicht eindeutig erkennbar.');
    }

    _point(node) {
        const bounds = node && this._bounds(node);
        if (!node || this._package(node) !== this.package || !this._visible(node) || !bounds ||
            !this._enabledPath(node) || node.attrs.clickable !== 'true') {
            throw new BridgeError('target_unavailable', 'Die Einstellung ist nicht sicher anwählbar.');
        }
        return { x: bounds[0] + Math.floor((bounds[2] - bounds[0]) / 2), y: bounds[1] + Math.floor((bounds[3] - bounds[1]) / 2) };
    }

    _modePage() {
        const anchors = this._find('ventilation_layout');
        if (!anchors.length) return null;
        if (anchors.length !== 1) throw this._stateFailure();
        const scope = anchors[0];
        if (!this._visible(scope) || !this._bounds(scope)) return null;
        if (scope.attrs.class !== 'androidx.compose.ui.platform.ComposeView') throw this._stateFailure();
        const titles = this._find('vwd_title');
        if (titles.length !== 1 || titles[0].attrs.text !== 'Modus wählen' || !this._visible(titles[0]) || !this._bounds(titles[0])) {
            throw this._stateFailure();
        }
        const sheets = [...this._ancestors(scope)].filter(node => this._resource(node) === 'design_bottom_sheet');
        if (sheets.length !== 1 || !this._within(titles[0], sheets[0])) throw this._stateFailure();
        return { scope, sheet: sheets[0] };
    }

    _modeChoices(page) {
        const labels = { climate: 'Klimatisierung', windowHeating: 'Scheibenheizung' };
        const controls = this._scopeNodes(page.scope).filter(node => node.attrs.checkable === 'true');
        if (controls.length !== 2) throw this._stateFailure();
        const firstBounds = this._bounds(controls[0]);
        const secondBounds = this._bounds(controls[1]);
        if (firstBounds[0] < secondBounds[2] && secondBounds[0] < firstBounds[2] &&
            firstBounds[1] < secondBounds[3] && secondBounds[1] < firstBounds[3]) throw this._stateFailure();
        const result = {};
        for (const control of controls) {
            if (control.attrs.class !== 'android.view.View' || (control.attrs['resource-id'] || '') ||
                control.attrs.clickable !== 'true' || !['true', 'false'].includes(control.attrs.checked)) throw this._stateFailure();
            const matching = Object.entries(labels).filter(([, label]) => this._scopeNodes(control).filter(node =>
                node.attrs.class === 'android.widget.TextView' && node.attrs.text === label).length === 1);
            if (matching.length !== 1 || result[matching[0][0]]) throw this._stateFailure();
            result[matching[0][0]] = { node: control, checked: control.attrs.checked === 'true' };
        }
        if (!result.climate || !result.windowHeating || Number(result.climate.checked) + Number(result.windowHeating.checked) !== 1) {
            throw this._stateFailure();
        }
        return result;
    }

    _composePage(title) {
        const matches = [];
        for (const scope of this._find('compose_view')) {
            if (scope.attrs.class !== 'androidx.compose.ui.platform.ComposeView' || !this._visible(scope) || !this._bounds(scope)) continue;
            const titles = this._scopeNodes(scope).filter(node => node.attrs.class === 'android.view.View' && node.attrs['content-desc'] === title);
            if (titles.length > 1) throw this._stateFailure();
            if (!titles.length) continue;
            const header = titles[0].parent;
            if (!header || !this._within(header, scope)) throw this._stateFailure();
            const buttons = this._scopeNodes(header).filter(node => node.attrs.class === 'android.widget.Button' &&
                (title === 'Einstellungen' ? this._resource(node) === 'climatisationSettingsLeading' : !(node.attrs['resource-id'] || '')));
            if (buttons.length !== 1) throw this._stateFailure();
            matches.push({ scope, back: buttons[0] });
        }
        if (matches.length > 1) throw this._stateFailure();
        return matches[0] || null;
    }

    _settingsRow(scope, text) {
        const labels = this._scopeNodes(scope).filter(node => node.attrs.class === 'android.widget.TextView' && node.attrs.text === text);
        if (labels.length !== 1) throw this._stateFailure();
        for (let row = labels[0].parent; row && row !== scope; row = row.parent) {
            if (row.attrs.clickable === 'true') {
                if (row.attrs.class !== 'android.view.View' || (row.attrs['resource-id'] || '') || !this._scopeNodes(scope).includes(row)) {
                    throw this._stateFailure();
                }
                return row;
            }
        }
        throw this._stateFailure();
    }

    _rowSwitch(row, resourceId = null) {
        const controls = this._scopeNodes(row).filter(node => node.attrs.checkable === 'true');
        if (!controls.length) throw this._stateFailure();
        const bounds = this._bounds(controls[0]);
        const checked = controls[0].attrs.checked;
        if (!['true', 'false'].includes(checked)) throw this._stateFailure();
        for (const control of controls) {
            if (control.attrs.class !== 'android.view.View' || control.attrs.clickable !== 'true' || control.attrs.checked !== checked ||
                !this._bounds(control).every((coordinate, index) => coordinate === bounds[index]) ||
                (control.attrs['resource-id'] && this._resource(control) !== resourceId)) throw this._stateFailure();
            for (const other of controls) if (!this._within(control, other) && !this._within(other, control)) throw this._stateFailure();
        }
        const identified = resourceId ? controls.filter(node => this._resource(node) === resourceId) : [];
        if (resourceId && identified.length !== 1) throw this._stateFailure();
        const leaf = controls.find(node => controls.every(other => this._within(node, other)));
        if (!leaf) throw this._stateFailure();
        return { node: resourceId ? identified[0] : leaf, value: checked === 'true' };
    }

    climateMode() {
        const page = this._modePage();
        if (page) {
            const choices = this._modeChoices(page);
            return choices.climate.checked ? 'climate' : 'windowHeating';
        }
        const pickers = this._find('clima_air_conditioning_pick');
        if (!pickers.length) return null;
        if (pickers.length !== 1) throw this._stateFailure();
        this.climateState();
        const titles = this._scopeNodes(pickers[0]).filter(node => this._resource(node) === 'title');
        if (titles.length !== 1) throw this._stateFailure();
        const modes = { Klimatisierung: 'climate', Scheibenheizung: 'windowHeating' };
        return Object.hasOwn(modes, titles[0].attrs.text) ? modes[titles[0].attrs.text] : null;
    }

    settingsValues() {
        const page = this._composePage('Einstellungen');
        if (!page) return null;
        return {
            climateOnUnlock: this._rowSwitch(this._settingsRow(page.scope, 'Standklimatisierung'), 'ClimatisationAtUnlockEnabled').value,
            autoWindowHeating: this._rowSwitch(this._settingsRow(page.scope, 'Automatische Scheibenheizung'), 'WindowHeatingEnabled').value,
        };
    }

    zonesValues() {
        const page = this._composePage('Zonen');
        if (!page) return null;
        const frontLeft = this._rowSwitch(this._settingsRow(page.scope, 'Vorne links')).value;
        const frontRight = this._rowSwitch(this._settingsRow(page.scope, 'Vorne rechts')).value;
        return { frontLeft, frontRight, zones: frontLeft ? (frontRight ? 'both' : 'frontLeft') : (frontRight ? 'frontRight' : 'none') };
    }

    modeChoice(wanted) {
        if (!['climate', 'windowHeating'].includes(wanted)) throw new BridgeError('invalid_settings', 'Unbekannter Klimamodus.');
        const page = this._modePage();
        if (!page) throw new BridgeError('target_unavailable', 'Die Modusauswahl ist nicht sichtbar.');
        const choice = this._modeChoices(page)[wanted];
        return { ...this._point(choice.node), value: wanted };
    }

    settingsTarget(key, wanted) {
        const fields = { climateOnUnlock: ['Standklimatisierung', 'ClimatisationAtUnlockEnabled'],
            autoWindowHeating: ['Automatische Scheibenheizung', 'WindowHeatingEnabled'] };
        if (!Object.hasOwn(fields, key) || typeof wanted !== 'boolean') throw new BridgeError('invalid_settings', 'Ungültige Klimaeinstellung.');
        const page = this._composePage('Einstellungen');
        if (!page) throw new BridgeError('target_unavailable', 'Die Klimaeinstellungen sind nicht sichtbar.');
        this.settingsValues();
        const control = this._rowSwitch(this._settingsRow(page.scope, fields[key][0]), fields[key][1]);
        return { ...this._point(control.node), value: wanted };
    }

    zoneToggleTarget(side, wanted) {
        const labels = { frontLeft: 'Vorne links', frontRight: 'Vorne rechts' };
        if (!Object.hasOwn(labels, side) || typeof wanted !== 'boolean') throw new BridgeError('invalid_settings', 'Ungültige Klimazone.');
        const page = this._composePage('Zonen');
        if (!page) throw new BridgeError('target_unavailable', 'Die Klimazonen sind nicht sichtbar.');
        this.zonesValues();
        return { ...this._point(this._rowSwitch(this._settingsRow(page.scope, labels[side])).node), value: wanted };
    }

    navigationTarget(destination) {
        const kind = this.kind();
        if (destination === 'mode' && kind === 'climate' && this.climateMode()) return this.target('clima_air_conditioning_pick');
        if (destination === 'settings' && kind === 'climate') {
            return this._point(this._settingsRow(this._unique('clima_settings_compose_view'), 'Einstellungen'));
        }
        if (destination === 'zones' && kind === 'settings') {
            const row = this._settingsRow(this._composePage('Einstellungen').scope, 'Zonen');
            const scoped = this._scopeNodes(row);
            const labels = scoped.filter(node => node.attrs.class === 'android.widget.TextView' && typeof node.attrs.text === 'string' &&
                /^[012] Zonen?$/.exec(node.attrs.text || '')?.[0] === node.attrs.text);
            if (labels.length > 1) throw this._stateFailure();
            if (labels.length !== 1 || !this._enabledPath(labels[0])) {
                throw new BridgeError('target_unavailable', 'Die Zonen-Auswahl ist nicht eindeutig sichtbar.');
            }
            const controls = [...this._ancestors(labels[0])].filter(node => node !== labels[0] && node !== row &&
                this._within(node, row) && scoped.includes(node) && node.attrs.class === 'android.view.View' &&
                node.attrs.clickable === 'true' && node.attrs.checkable !== 'true' && !(node.attrs['resource-id'] || '') &&
                this._scopeNodes(node).includes(labels[0]));
            if (controls.length > 1) throw this._stateFailure();
            if (controls.length !== 1) {
                throw new BridgeError('target_unavailable', 'Die Zonen-Auswahl besitzt kein bestätigtes Bedienelement.');
            }
            // The surrounding row also contains a long description. Its center
            // is not the observed inner selection control's touch surface.
            return this._point(controls[0]);
        }
        if (destination === 'back') {
            if (kind === 'settings' || kind === 'zones') return this._point(this._composePage(kind === 'settings' ? 'Einstellungen' : 'Zonen').back);
            if (kind === 'mode' || kind === 'climate') return this.target('vwd_navigation_button');
        }
        throw new BridgeError('target_unavailable', 'Das bestätigte Navigationsziel ist nicht verfügbar.');
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

    _enabledPath(node) {
        return [...this._ancestors(node)].every(ancestor => ancestor.attrs.enabled === 'true');
    }

    _temperaturePicker() {
        const anchors = this._find('clima_compose_view');
        if (!anchors.length) return null;
        if (anchors.length !== 1) {
            throw new BridgeError('unknown_state', 'Der Temperaturbereich ist nicht eindeutig erkennbar.');
        }
        const anchor = anchors[0];
        const anchorBounds = this._bounds(anchor);
        if (!this._visible(anchor) || !anchorBounds || !this._enabledPath(anchor)) return null;
        if (!this._find('cta_start').length && !this._find('cta_stop').length) return null;
        this.climateState();
        const contains = (outer, inner) => inner && inner[0] >= outer[0] && inner[1] >= outer[1] &&
            inner[2] <= outer[2] && inner[3] <= outer[3];
        const inScope = node => this._package(node) === this.package && this._visible(node) &&
            contains(anchorBounds, this._bounds(node));
        const scrolls = [...this._descendants(anchor)].filter(node => node !== anchor &&
            node.attrs.scrollable === 'true' && inScope(node));
        if (scrolls.length > 1) {
            throw new BridgeError('unknown_state', 'Mehrere Temperatur-Auswahlbereiche sind sichtbar.');
        }
        if (scrolls.length !== 1 || scrolls[0].attrs.class !== 'android.view.View' ||
            (scrolls[0].attrs['resource-id'] || '') || !this._enabledPath(scrolls[0])) return null;
        const scroll = scrolls[0];
        const scrollBounds = this._bounds(scroll);
        if (!scrollBounds.every((coordinate, index) => coordinate === anchorBounds[index])) return null;
        const candidates = [...this._descendants(scroll)].filter(node => node !== scroll &&
            node.attrs.clickable === 'true' && inScope(node));
        if (candidates.length < 2) return null;
        if (candidates.length > 3) {
            throw new BridgeError('unknown_state', 'Die Temperatur-Auswahl enthält zu viele Bedienelemente.');
        }
        const candidateSet = new Set(candidates);
        const options = [];
        const decorations = [];
        for (const candidate of candidates) {
            if (candidate.attrs.class !== 'android.view.View' || (candidate.attrs['resource-id'] || '') ||
                [...this._ancestors(candidate)].some(ancestor => ancestor !== candidate && candidateSet.has(ancestor))) return null;
            const bounds = this._bounds(candidate);
            const labels = [...this._descendants(candidate)].filter(node => node !== candidate &&
                node.attrs.class === 'android.widget.TextView' && inScope(node));
            if (labels.some(label => !contains(bounds, this._bounds(label)) || (label.attrs['resource-id'] || ''))) return null;
            const numbers = labels.filter(label => typeof label.attrs.text === 'string' &&
                /^(?:0|[1-9][0-9]*)(?:\.5)?$/.exec(label.attrs.text)?.[0] === label.attrs.text);
            const degrees = labels.filter(label => label.attrs.text === '°');
            const specials = labels.filter(label => label.attrs.text === 'LO' || label.attrs.text === 'HI');
            if (specials.length) {
                if (specials.length !== 1 || labels.length !== 1) return null;
                decorations.push({ bounds, label: specials[0].attrs.text });
                continue;
            }
            if (numbers.length > 1 || degrees.length > 1) {
                throw new BridgeError('unknown_state', 'Ein Temperaturwert ist mehrfach beschriftet.');
            }
            if (numbers.length !== 1 || labels.length !== numbers.length + degrees.length) return null;
            const value = Number(numbers[0].attrs.text);
            if (!Number.isFinite(value) || !Number.isSafeInteger(value * 2)) return null;
            const numberBounds = this._bounds(numbers[0]);
            if (degrees.length) {
                if (this._bounds(degrees[0])[0] < numberBounds[2]) return null;
            } else if (bounds[2] !== anchorBounds[2] || numberBounds[2] !== anchorBounds[2]) {
                // The observed rightmost option can lose its degree glyph when
                // both the number and the control are clipped at the anchor.
                return null;
            }
            options.push({ node: candidate, bounds, value, degrees: degrees.length,
                enabled: this._enabledPath(candidate) && labels.every(label => this._enabledPath(label)) });
        }
        options.sort((left, right) => left.bounds[0] - right.bounds[0]);
        if (!options.length) return null;
        const controls = [...options, ...decorations].sort((left, right) => left.bounds[0] - right.bounds[0]);
        for (let index = 1; index < controls.length; index++) {
            if (controls[index - 1].bounds[2] > controls[index].bounds[0]) {
                throw new BridgeError('unknown_state', 'Temperatur-Bedienelemente überlappen sich.');
            }
        }
        // LO/HI were observed only beyond the numeric endpoints. They remain
        // non-numeric decoration and are never exposed as selectable targets.
        if (decorations.length > 1) return null;
        for (const decoration of decorations) {
            const first = options[0];
            const last = options.at(-1);
            const lowEdge = decoration.label === 'LO' && first.value === 16 && decoration.bounds[2] <= first.bounds[0];
            const highEdge = decoration.label === 'HI' && last.value === 29.5 && decoration.bounds[0] >= last.bounds[2];
            if (!lowEdge && !highEdge) return null;
        }
        for (let index = 1; index < options.length; index++) {
            if (options[index].value - options[index - 1].value !== 0.5) return null;
        }
        const centerX = anchorBounds[0] + (anchorBounds[2] - anchorBounds[0]) / 2;
        const central = options.filter(option => option.bounds[0] <= centerX && option.bounds[2] > centerX);
        if (central.length > 1) {
            throw new BridgeError('unknown_state', 'Der ausgewählte Temperaturwert ist mehrdeutig.');
        }
        if (central.length !== 1 || central[0].degrees !== 1 || !central[0].enabled) return null;
        return { current: central[0], options };
    }

    climateTemperature() {
        return this._temperaturePicker()?.current.value ?? null;
    }

    temperatureTarget(wantedCelsius) {
        if (typeof wantedCelsius !== 'number' || !Number.isFinite(wantedCelsius) || !Number.isSafeInteger(wantedCelsius * 2)) {
            throw new BridgeError('invalid_temperature', 'Die Zieltemperatur muss als Zahl in halben Grad vorliegen.');
        }
        const picker = this._temperaturePicker();
        const option = picker?.options.find(candidate => candidate.value === wantedCelsius);
        if (!option || !option.enabled) {
            throw new BridgeError('target_unavailable', 'Die gewünschte Temperatur ist nicht sicher sichtbar und anwählbar.');
        }
        const [x1, y1, x2, y2] = option.bounds;
        return { x: x1 + Math.floor((x2 - x1) / 2), y: y1 + Math.floor((y2 - y1) / 2), value: option.value };
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
