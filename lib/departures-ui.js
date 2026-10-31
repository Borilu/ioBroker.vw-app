'use strict';

const { Screen } = require('./ui');
const { BridgeError } = require('./errors');

const DAY_INFO = Object.freeze({ mon: ['MONDAY', 'Mo', 'Montag'], tue: ['TUESDAY', 'Di', 'Dienstag'],
    wed: ['WEDNESDAY', 'Mi', 'Mittwoch'], thu: ['THURSDAY', 'Do', 'Donnerstag'],
    fri: ['FRIDAY', 'Fr', 'Freitag'], sat: ['SATURDAY', 'Sa', 'Samstag'], sun: ['SUNDAY', 'So', 'Sonntag'] });
const DAY_KEYS = Object.freeze(Object.keys(DAY_INFO));
const TITLES = Object.freeze({ overview: 'Abfahrtszeiten', editor: 'Zeit einstellen', settings: 'Ladeeinstellungen', preferred: 'Bevorzugte Zeiten' });
const CLOCK = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const PREFERRED_NOTICE = 'Aktivieren oder deaktivieren Sie Ihre bevorzugten Ladezeiten im Infotainment-System Ihres Fahrzeugs und legen Sie dort die genauen Zeitfenster fest.';

function stateFailure() { return new BridgeError('unknown_state', 'Die angezeigten Abfahrtszeiten sind nicht eindeutig erkennbar.'); }
function unavailable() { return new BridgeError('target_unavailable', 'Das bestätigte Abfahrtszeit-Bedienelement ist nicht verfügbar.'); }
function requireState(condition) { if (!condition) throw stateFailure(); }
function same(left, right) { return left.every((value, index) => value === right[index]); }
function contains(outer, inner) { return inner && inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]; }
function nameValue(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\x00-\x1f]/.test(value); }

class DepartureScreen extends Screen {
    _members(scope) {
        return [...this._descendants(scope)].filter(node => this._package(node) === this.package && this._visible(node));
    }

    _valid(node, scope) {
        requireState(node && this._package(node) === this.package && this._visible(node)
            && this._bounds(node) && this._enabledPath(node) && this._within(node, scope)
            && contains(this._bounds(scope), this._bounds(node)));
        return node;
    }

    _text(scope, text) {
        return this._members(scope).filter(node => node.attrs.class === 'android.widget.TextView' && node.attrs.text === text);
    }

    _readable(node, scope) {
        requireState(node && this._package(node) === this.package && this._within(node, scope) && this._enabledPath(node));
        if (!this._visible(node)) return false;
        const bounds = this._bounds(node);
        if (!bounds) {
            const raw = /^\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]$/.exec(node.attrs.bounds || '');
            requireState(raw && raw.slice(1).every(value => Number.isSafeInteger(Number(value)))
                && Number(raw[3]) >= Number(raw[1]) && Number(raw[4]) >= Number(raw[2]));
            return false;
        }
        return contains(this._bounds(scope), bounds);
    }

    _base() {
        this.checkClear();
        const scopes = this._find('composeView');
        if (!scopes.length) return null;
        requireState(scopes.length === 1);
        const scope = scopes[0];
        requireState(scope.attrs.class === 'androidx.compose.ui.platform.ComposeView');
        this._valid(scope, scope);
        const headers = this._members(scope).filter(node => node.attrs.class === 'android.view.View'
            && nameValue(node.attrs['content-desc']) && node.parent?.children.some(sibling => sibling.attrs.class === 'android.widget.Button'));
        if (!headers.length) return null;
        requireState(headers.length === 1);
        const title = this._valid(headers[0], scope);
        const titleBounds = this._bounds(title);
        const buttons = title.parent.children.filter(node => this._package(node) === this.package
            && this._visible(node) && node.attrs.class === 'android.widget.Button');
        requireState(buttons.length >= 1 && buttons.length <= 2);
        let back = null;
        let right = null;
        for (const button of buttons) {
            this._valid(button, scope);
            requireState(button.attrs.clickable === 'true');
            const b = this._bounds(button);
            const x = (b[0] + b[2]) / 2;
            const y = (b[1] + b[3]) / 2;
            requireState(y >= titleBounds[1] && y <= titleBounds[3]);
            if (x < titleBounds[0]) { requireState(!back); back = button; }
            else if (x > titleBounds[2]) { requireState(!right); right = button; }
            else throw stateFailure();
        }
        requireState(back);
        requireState(this._members(back).every(node => !(node.attrs.text || '') && !(node.attrs['content-desc'] || '')));
        let bodies = this._members(scope).filter(node => node.attrs.class === 'android.widget.ScrollView');
        let readOnlyNonScrollable = false;
        if (!bodies.length && [TITLES.settings, TITLES.preferred].includes(title.attrs['content-desc'])) {
            bodies = title.parent.parent?.children.filter(node => node !== title.parent
                && this._package(node) === this.package && this._visible(node) && node.attrs.class === 'android.view.View') || [];
            if (title.attrs['content-desc'] === TITLES.settings && bodies.length === 1 && bodies[0].attrs.scrollable === 'false') {
                const candidate = bodies[0];
                const rawActions = candidate.attrs['a11y-actions'];
                let actions;
                try { actions = JSON.parse(rawActions); } catch (_) { throw stateFailure(); }
                requireState(Array.isArray(actions) && actions.every(Number.isInteger)
                    && !actions.includes(4096) && !actions.includes(8192));
                const labels = ['Direkt laden bis (0-50 %)', 'Laden bis (50-100 %)', 'Reduzierter AC-Ladestrom',
                    'AC-Stecker automatisch entriegeln', 'Bevorzugte Zeiten'];
                const entries = this._members(candidate);
                const names = entries.filter(node => node.attrs.class === 'android.widget.EditText');
                requireState(names.length === 1);
                this._valid(names[0], candidate);
                for (const label of labels) {
                    const matches = this._text(candidate, label);
                    requireState(matches.length === 1);
                    this._valid(matches[0], candidate);
                }
                readOnlyNonScrollable = true;
            } else if (title.attrs['content-desc'] === TITLES.settings) {
                requireState(bodies.every(node => node.attrs.scrollable === 'true'));
            }
        }
        requireState(bodies.length === 1);
        const body = this._valid(bodies[0], scope);
        return { scope, body, title: title.attrs['content-desc'], header: title.parent, back, right, readOnlyNonScrollable };
    }

    _verifiedNavigationPoint(page, target, point) {
        if (page.readOnlyNonScrollable) {
            for (const node of this.nodes) {
                if (node === target || node.attrs.clickable !== 'true' || !this._visible(node)) continue;
                const bounds = this._bounds(node);
                requireState(bounds && !(point.x >= bounds[0] && point.x < bounds[2] && point.y >= bounds[1] && point.y < bounds[3]));
            }
        }
        return point;
    }

    _page(title) {
        const page = this._base();
        if (!page || page.title !== title) throw unavailable();
        return page;
    }

    _hasDepartureEvidence() {
        if (['editDepartureTimerWeekday', 'editDepartureTimerRepeat'].some(id => this._find(id).some(node => this._visible(node)))) return true;
        if (this.nodes.some(node => this._package(node) === this.package && this._visible(node)
            && node.attrs.class === 'android.view.View' && Object.values(TITLES).includes(node.attrs['content-desc']))) return true;
        // A charging-location title is private/dynamic. Its known topology has
        // three timer rows and a header with two anonymous Button siblings.
        for (const scope of this._find('composeView').filter(node => this._visible(node))) {
            const members = this._members(scope);
            if (this._timeLabels(scope).length !== 3 || members.filter(node => node.attrs.checkable === 'true').length < 3) continue;
            if (members.some(node => node.attrs.class === 'android.view.View' && nameValue(node.attrs['content-desc'])
                && node.parent?.children.filter(child => this._package(child) === this.package && this._visible(child)
                    && child.attrs.class === 'android.widget.Button').length === 2)) return true;
        }
        return false;
    }

    kind() {
        this.checkClear();
        const inherited = super.kind();
        // Home tiles also have description/Button pairs. Let the established
        // parser recognize its own screens before looking for departure headers,
        // unless an actual departure page/draft is visible over that screen.
        if (inherited !== 'unknown' && !this._hasDepartureEvidence()) return inherited;
        const page = this._base();
        if (!page) return super.kind();
        if (page.title === TITLES.overview) return 'departuresOverview';
        if (page.title === TITLES.editor && this._find('editDepartureTimerWeekday').length && this._find('editDepartureTimerRepeat').length) return 'timerEditor';
        if (page.title === TITLES.settings) return 'locationSettings';
        if (page.title === TITLES.preferred) return 'preferredTimes';
        if (page.right && this._timeLabels(page.body).length === 3) return 'locationOverview';
        return super.kind();
    }

    _timeLabels(scope) {
        return this._members(scope).filter(node => node.attrs.class === 'android.widget.TextView' && CLOCK.test(node.attrs.text || ''));
    }

    _section(page, title, allowPartial = false) {
        const labels = [...this._descendants(page.body)].filter(node => this._package(node) === this.package
            && node.attrs.class === 'android.widget.TextView' && node.attrs.text === title);
        if (!labels.length && allowPartial) return null;
        requireState(labels.length === 1);
        if (!allowPartial) this._valid(labels[0], page.body);
        let section = labels[0];
        while (section.parent && section.parent !== page.body) section = section.parent;
        requireState(section.parent === page.body && section.attrs.class === 'android.view.View');
        if (!allowPartial) return this._valid(section, page.body);
        requireState(this._enabledPath(section));
        return section;
    }

    _switch(row, scope) {
        const controls = this._members(row).filter(node => node.attrs.checkable === 'true');
        requireState(controls.length >= 1 && controls.length <= 3);
        const bounds = this._bounds(controls[0]);
        const checked = controls[0].attrs.checked;
        requireState(bounds && ['true', 'false'].includes(checked));
        for (const node of controls) {
            this._valid(node, scope);
            const currentBounds = this._bounds(node);
            // Android versions can report slightly shifted rectangles for the
            // two semantics nodes of one switch. Accept only equal-size copies
            // with a very small displacement; larger differences stay unsafe.
            const nearCopy = controls.length === 2 && currentBounds
                && currentBounds[2] - currentBounds[0] === bounds[2] - bounds[0]
                && currentBounds[3] - currentBounds[1] === bounds[3] - bounds[1]
                && Math.abs(currentBounds[0] + currentBounds[2] - bounds[0] - bounds[2]) * 10 <= bounds[2] - bounds[0]
                && Math.abs(currentBounds[1] + currentBounds[3] - bounds[1] - bounds[3]) * 10 <= bounds[3] - bounds[1];
            requireState(node.attrs.class === 'android.view.View' && node.attrs.clickable === 'true'
                && node.attrs.checked === checked && (same(currentBounds, bounds) || nearCopy)
                && controls.every(other => this._within(node, other) || this._within(other, node)));
        }
        const leaf = controls.find(node => controls.every(other => this._within(node, other)));
        requireState(leaf);
        const point = this._point(leaf);
        requireState(controls.every(node => {
            const b = this._bounds(node);
            return point.x >= b[0] && point.x < b[2] && point.y >= b[1] && point.y < b[3];
        }));
        return { node: leaf, nodes: controls, value: checked === 'true' };
    }

    _switchTarget(control) {
        // Shifted copies are accepted for observations and safe navigation only.
        // A setting change still requires the previously verified exact bounds.
        const bounds = this._bounds(control.node);
        requireState(control.nodes.every(node => same(this._bounds(node), bounds)));
        return this._point(control.node);
    }

    _days(text) {
        if (text === 'Jeden Tag') return [...DAY_KEYS];
        if (text === 'Am Wochenende') return ['sat', 'sun'];
        const words = text.split(', ');
        const keys = words.map(word => DAY_KEYS.find(key => DAY_INFO[key][2] === word));
        if (keys.some(key => !key) || new Set(keys).size !== keys.length) return null;
        return DAY_KEYS.filter(key => keys.includes(key));
    }

    _timerRows(scope, page, count) {
        const labels = this._timeLabels(scope);
        requireState(labels.length === count);
        const rows = labels.map(label => {
            this._valid(label, page.body);
            let row = label.parent;
            while (row && row !== scope && row.attrs.clickable !== 'true') row = row.parent;
            requireState(row && row !== scope && row.attrs.class === 'android.view.View' && row.attrs.checkable !== 'true' && this._within(row, scope));
            this._valid(row, page.body);
            const texts = this._members(row).filter(node => node.attrs.class === 'android.widget.TextView' && node.attrs.text);
            requireState(texts.length === 2 && texts.includes(label));
            const summary = texts.find(node => node !== label);
            this._valid(summary, page.body);
            requireState(nameValue(summary.attrs.text));
            const control = this._switch(row, page.body);
            const point = this._labelPoint(label, row, page.body);
            requireState(control.nodes.every(node => {
                const switchBounds = this._bounds(node);
                return !(point.x >= switchBounds[0] && point.x <= switchBounds[2]
                    && point.y >= switchBounds[1] && point.y <= switchBounds[3]);
            }));
            return { row, label, control, time: label.attrs.text, daysText: summary.attrs.text };
        }).sort((a, b) => this._bounds(a.row)[1] - this._bounds(b.row)[1]);
        requireState(new Set(rows.map(item => item.row)).size === count);
        for (let index = 1; index < rows.length; index++) requireState(this._bounds(rows[index - 1].row)[3] <= this._bounds(rows[index].row)[1]);
        return rows.map((row, index) => ({ ...row, id: String(index + 1) }));
    }

    _timerValues(rows) {
        return rows.map(row => ({ id: row.id, time: row.time, days: this._days(row.daysText), daysText: row.daysText, enabled: row.control.value }));
    }

    _places(page, scope, allowPartial = false) {
        requireState(scope);
        const descendants = [...this._descendants(scope)].filter(node => this._package(node) === this.package);
        const summaries = descendants.filter(node => node.attrs.class === 'android.widget.TextView'
            && typeof node.attrs.text === 'string' && node.attrs.text.includes('aktive Abfahrtszeit'));
        requireState(summaries.length <= 5);
        const rows = summaries.map(summary => {
            const match = /^([0-3]) aktive Abfahrtszeit(?:en)?$/.exec(summary.attrs.text);
            requireState(match);
            let row = summary.parent;
            while (row && row !== scope && row.attrs.clickable !== 'true') row = row.parent;
            requireState(row && row !== scope && row.attrs.class === 'android.view.View');
            const texts = row.children.filter(node => this._package(node) === this.package
                && node.attrs.class === 'android.widget.TextView' && node.attrs.text);
            requireState(texts.length === 2 && texts.includes(summary));
            const label = texts.find(node => node !== summary);
            requireState(nameValue(label.attrs.text));
            const complete = [row, label, summary, ...[...this._descendants(row)].filter(node => this._package(node) === this.package
                && node.attrs.class === 'android.widget.TextView' && node.attrs.text)]
                .every(node => this._readable(node, page.body));
            if (!allowPartial) requireState(complete);
            return { name: label.attrs.text, activeCount: Number(match[1]), row, label, complete };
        });
        requireState(new Set(rows.map(row => row.name)).size === rows.length && new Set(rows.map(row => row.row)).size === rows.length);
        const roots = descendants.filter(node => node !== scope && node.attrs.clickable === 'true'
            && node.attrs.class === 'android.view.View' && ![...this._ancestors(node.parent)]
                .some(ancestor => ancestor !== scope && this._within(ancestor, scope) && ancestor.attrs.clickable === 'true'));
        requireState(roots.length === rows.length && roots.every(node => rows.some(row => row.row === node)));
        return rows.filter(row => row.complete);
    }

    _scrollState(page) {
        const encoded = page.body.attrs['a11y-actions'];
        if (encoded === undefined) return { forward: null, backward: null };
        requireState(typeof encoded === 'string' && encoded.length <= 2048);
        let actions;
        try { actions = JSON.parse(encoded); } catch (_) { throw stateFailure(); }
        requireState(Array.isArray(actions) && actions.length <= 32 && actions.every(id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647)
            && new Set(actions).size === actions.length);
        return { forward: actions.includes(4096), backward: actions.includes(8192) };
    }

    departuresOverview({ allowPartial = false } = {}) {
        requireState(typeof allowPartial === 'boolean');
        const page = this._page(TITLES.overview);
        const climate = this._section(page, 'Klimatisierung', allowPartial);
        const charging = this._section(page, 'Laden', allowPartial);
        requireState(climate !== charging);
        let climateTimers = null;
        if (!allowPartial) climateTimers = this._timerValues(this._timerRows(climate, page, 2));
        else if (climate) {
            const times = this._timeLabels(climate);
            requireState(times.length <= 2);
            const texts = this._members(climate).filter(node => node.attrs.class === 'android.widget.TextView' && node.attrs.text);
            if (times.length === 2 && this._readable(climate, page.body) && texts.every(node => this._readable(node, page.body))) {
                climateTimers = this._timerValues(this._timerRows(climate, page, 2));
            }
        }
        return { climateTimers, locations: this._places(page, charging, allowPartial).map(({ name, activeCount }) => ({ name, activeCount })),
            scrollState: this._scrollState(page) };
    }

    locationOverview(expectedName) {
        if (!nameValue(expectedName)) throw unavailable();
        const page = this._page(expectedName);
        requireState(page.right && !Object.values(TITLES).includes(page.title));
        this._gearButton(page);
        return { name: page.title, timers: this._timerValues(this._timerRows(page.body, page, 3)) };
    }

    _gearButton(page) {
        requireState(page.right && this._members(page.right).every(node => !(node.attrs.text || '') && !(node.attrs['content-desc'] || '')));
        return page.right;
    }

    _labelPoint(label, control, scope) {
        this._valid(label, scope);
        this._valid(control, scope);
        requireState(control.attrs.clickable === 'true' && this._within(label, control));
        const bounds = this._bounds(label);
        const x = Math.floor((bounds[0] + bounds[2]) / 2);
        const y = Math.floor((bounds[1] + bounds[3]) / 2);
        const outer = this._bounds(control);
        requireState(x >= outer[0] && x <= outer[2] && y >= outer[1] && y <= outer[3]);
        return { x, y };
    }

    overviewTimer(id, part = 'editor') {
        if (!['editor', 'enabled'].includes(part)) throw unavailable();
        const page = this._base();
        if (!page) throw unavailable();
        const rows = page.title === TITLES.overview
            ? this._timerRows(this._section(page, 'Klimatisierung'), page, 2)
            : this.kind() === 'locationOverview' ? this._timerRows(page.body, page, 3) : null;
        const row = rows?.find(item => item.id === id);
        if (!row) throw unavailable();
        return part === 'enabled' ? this._switchTarget(row.control) : this._labelPoint(row.label, row.row, page.body);
    }

    locationOpen(name) {
        if (!nameValue(name)) throw unavailable();
        const page = this._page(TITLES.overview);
        const row = this._places(page, this._section(page, 'Laden', true), true).find(item => item.name === name);
        if (!row) throw unavailable();
        return this._labelPoint(row.label, row.row, page.body);
    }

    _weekdayControls(page) {
        const anchors = this._find('editDepartureTimerWeekday');
        requireState(anchors.length === 1);
        const anchor = this._valid(anchors[0], page.body);
        const controls = {};
        for (const [key, [native, text]] of Object.entries(DAY_INFO)) {
            const matches = this._find('cta_' + native);
            requireState(matches.length === 1);
            const node = this._valid(matches[0], page.body);
            requireState(node.parent === anchor && node.attrs.class === 'android.view.View'
                && node.attrs.clickable === 'true' && node.attrs.checkable === 'false');
            const labels = this._text(node, text);
            requireState(labels.length === 1);
            this._valid(labels[0], node);
            controls[key] = node;
        }
        requireState(anchor.children.filter(node => this._package(node) === this.package && this._visible(node)
            && node.attrs.clickable === 'true').length === 7);
        return controls;
    }

    _repeat(page) {
        const anchors = this._find('editDepartureTimerRepeat');
        requireState(anchors.length === 1);
        const row = this._valid(anchors[0], page.body);
        const labels = this._text(row, 'Wiederholen');
        requireState(labels.length === 1);
        this._valid(labels[0], page.body);
        return this._switch(row, page.body);
    }

    _wheelVisibility(node, page) {
        const bounds = this._bounds(node);
        requireState(bounds && contains(this._bounds(page.body), bounds) && this._within(node, page.body));
        let wrapper = null;
        for (const ancestor of this._ancestors(node)) {
            requireState(this._package(ancestor) === this.package && ancestor.attrs.enabled === 'true'
                && this._bounds(ancestor) && contains(this._bounds(ancestor), bounds));
            if ((ancestor.attrs['visible-to-user'] ?? 'true') === 'true') continue;
            // The observed Compose time wheel has exactly one non-important
            // semantics wrapper marked invisible around a visible inner View.
            // This exception belongs only to these two verified editor wheels.
            const child = ancestor.children[0];
            requireState(!wrapper && ancestor !== node && ancestor.parent === page.body
                && ancestor.attrs['visible-to-user'] === 'false'
                && ancestor.attrs.class === 'android.view.View' && !(ancestor.attrs['resource-id'] || '')
                && !(ancestor.attrs.text || '') && !(ancestor.attrs['content-desc'] || '') && !(ancestor.attrs['state-description'] || '')
                && ancestor.attrs['important-for-accessibility'] === 'false'
                && ancestor.attrs.clickable === 'false' && ancestor.attrs.checkable === 'false'
                && ancestor.attrs['long-clickable'] !== 'true' && ancestor.attrs.scrollable !== 'true'
                && ancestor.attrs.focusable !== 'true' && ancestor.attrs['a11y-actions'] === '[64]' && ancestor.children.length === 1
                && child.attrs.class === 'android.view.View' && child.attrs['visible-to-user'] === 'true'
                && child.attrs.enabled === 'true' && this._bounds(child)
                && same(this._bounds(ancestor), this._bounds(child)) && this._within(node, child)
                && contains(this._bounds(page.body), this._bounds(ancestor)));
            wrapper = ancestor;
        }
        return wrapper;
    }

    _wheel(page, part, optional = false) {
        const description = part === 'hour' ? 'Hour' : part === 'minute' ? 'Minute' : null;
        if (!description) throw unavailable();
        const matches = [...this._descendants(page.body)].filter(node => this._package(node) === this.package && node.attrs['content-desc'] === description);
        if (!matches.length && optional) return null;
        requireState(matches.length === 1);
        const node = matches[0];
        const wrapper = this._wheelVisibility(node, page);
        requireState(node.attrs.class === 'android.widget.SeekBar' && node.attrs['range-type'] === '1');
        const raw = node.attrs['state-description'];
        requireState(typeof raw === 'string' && /^[0-9]{2}$/.test(raw));
        const state = Number(raw);
        requireState(state <= (part === 'hour' ? 23 : 59));
        const range = { type: 1 };
        for (const key of ['min', 'max', 'current']) {
            const value = node.attrs['range-' + key];
            requireState(typeof value === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value));
            range[key] = Number(value);
            requireState(Number.isFinite(range[key]) && range[key] <= 1000000000);
        }
        requireState(range.max > range.min && range.current >= range.min && range.current <= range.max);
        const encoded = node.attrs['a11y-actions'];
        requireState(typeof encoded === 'string' && encoded.length <= 2048);
        let actions;
        try { actions = JSON.parse(encoded); } catch (_) { throw stateFailure(); }
        requireState(Array.isArray(actions) && actions.length > 0 && actions.length <= 32
            && actions.every(id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647)
            && new Set(actions).size === actions.length && [4096, 8192, 16908349].every(id => actions.includes(id)));
        return { node, wrapper, bounds: [...this._bounds(node)], range, state, actions: [...actions] };
    }

    _wheels(page, optional = false) {
        const hour = this._wheel(page, 'hour', optional);
        const minute = this._wheel(page, 'minute', optional);
        requireState(Boolean(hour) === Boolean(minute));
        if (hour) requireState(hour.node.parent === minute.node.parent && hour.wrapper === minute.wrapper
            && this._bounds(hour.node)[2] < this._bounds(minute.node)[0]);
        return { hour, minute };
    }

    _save(page) {
        if (!page.right) return null;
        const button = page.right;
        const labels = this._text(button, 'Speichern');
        requireState(button.attrs.text === 'Speichern' || button.attrs['content-desc'] === 'Speichern' || labels.length === 1);
        requireState(labels.length <= 1);
        const texts = this._members(button).flatMap(node => [node.attrs.text || '', node.attrs['content-desc'] || '']).filter(Boolean);
        requireState(texts.length > 0 && texts.every(text => text === 'Speichern'));
        for (const label of labels) this._valid(label, page.scope);
        return button;
    }

    timerEditor() {
        const page = this._page(TITLES.editor);
        this._weekdayControls(page);
        const repeat = this._repeat(page).value;
        const { hour, minute } = this._wheels(page, true);
        return { time: hour ? String(hour.state).padStart(2, '0') + ':' + String(minute.state).padStart(2, '0') : null,
            repeat, days: null, canSave: Boolean(this._save(page)) };
    }

    dayTarget(day) {
        if (!DAY_KEYS.includes(day)) throw unavailable();
        const page = this._page(TITLES.editor);
        const control = this._weekdayControls(page)[day];
        if (!control) throw unavailable();
        return this._point(control);
    }

    wheelTarget(part) {
        if (!['hour', 'minute'].includes(part)) throw unavailable();
        const page = this._page(TITLES.editor);
        const { bounds, range, state, actions } = this._wheels(page)[part];
        return { bounds, range, state, actions };
    }

    repeatTarget(wanted) {
        if (typeof wanted !== 'boolean') throw unavailable();
        return this._switchTarget(this._repeat(this._page(TITLES.editor)));
    }

    headerTarget(side) {
        const page = this._base();
        if (!page || !['departuresOverview', 'locationOverview', 'timerEditor', 'locationSettings', 'preferredTimes'].includes(this.kind())) throw unavailable();
        if (side === 'back') {
            if ([TITLES.editor, TITLES.settings, TITLES.preferred].includes(page.title) && this._save(page)) {
                throw new BridgeError('unsaved_settings', 'Offene Abfahrtszeit-Einstellungen zuerst am Handy speichern oder verwerfen.');
            }
            return this._verifiedNavigationPoint(page, page.back, this._point(page.back));
        }
        if (side === 'right' && page.right) {
            if (this.kind() === 'locationOverview') return this._point(this._gearButton(page));
            if ([TITLES.editor, TITLES.settings, TITLES.preferred].includes(page.title)) return this.saveTarget();
        }
        throw unavailable();
    }

    saveTarget() {
        const page = this._base();
        if (!page || ![TITLES.editor, TITLES.settings, TITLES.preferred].includes(page.title)) throw unavailable();
        if (page.readOnlyNonScrollable) throw unavailable();
        const save = this._save(page);
        if (!save) throw unavailable();
        return this._point(save);
    }

    _settingControl(page, label, optional = false) {
        const labels = this._text(page.body, label);
        if (!labels.length && optional) return null;
        requireState(labels.length === 1);
        this._valid(labels[0], page.body);
        let row = labels[0].parent;
        while (row && row !== page.body && row.attrs.clickable !== 'true') row = row.parent;
        requireState(row && row !== page.body && row.attrs.class === 'android.view.View');
        this._valid(row, page.body);
        return { row, label: labels[0], ...this._switch(row, page.body) };
    }

    gearSettings() {
        const page = this._page(TITLES.settings);
        const names = this._members(page.body).filter(node => node.attrs.class === 'android.widget.EditText');
        requireState(names.length <= 1);
        let name = null;
        if (names.length) {
            const bounds = this._bounds(names[0]);
            requireState(bounds && contains(this._bounds(page.scope), bounds));
            if (contains(this._bounds(page.body), bounds)) {
                this._valid(names[0], page.body);
                requireState(nameValue(names[0].attrs.text));
                name = names[0].attrs.text;
            }
        }
        const reduced = this._settingControl(page, 'Reduzierter AC-Ladestrom', true);
        const unlock = this._settingControl(page, 'AC-Stecker automatisch entriegeln', true);
        const preferred = this._text(page.body, TITLES.preferred);
        requireState(preferred.length <= 1);
        for (const label of preferred) this._valid(label, page.body);
        // These two Canvas values are absent from the observed accessibility
        // trees. Never substitute the global charging limits or a guessed SOC.
        return { name, directSoc: null, socLimit: null, reducedAcCurrent: reduced?.value ?? null,
            autoUnlockAc: unlock?.value ?? null, preferredTimesAvailable: preferred.length === 1,
            canSave: Boolean(this._save(page)) };
    }

    gearToggleTarget(key, wanted) {
        if (typeof wanted !== 'boolean') throw unavailable();
        const labels = { reducedAcCurrent: 'Reduzierter AC-Ladestrom', autoUnlockAc: 'AC-Stecker automatisch entriegeln' };
        if (!Object.hasOwn(labels, key)) throw unavailable();
        const page = this._page(TITLES.settings);
        if (page.readOnlyNonScrollable) throw unavailable();
        return this._switchTarget(this._settingControl(page, labels[key]));
    }

    preferredNavTarget() {
        const page = this._page(TITLES.settings);
        const labels = this._text(page.body, TITLES.preferred);
        requireState(labels.length === 1);
        let row = labels[0].parent;
        while (row && row !== page.body && row.attrs.clickable !== 'true') row = row.parent;
        requireState(row && row !== page.body && row.attrs.class === 'android.view.View');
        return this._verifiedNavigationPoint(page, row, this._labelPoint(labels[0], row, page.body));
    }

    _preferredRows(page) {
        const labels = this._members(page.body).filter(node => node.attrs.class === 'android.widget.TextView'
            && /[0-9]{2}:[0-9]{2} - [0-9]{2}:[0-9]{2}/.test(node.attrs.text || ''));
        requireState(labels.length === 4);
        const rows = labels.map(label => {
            this._valid(label, page.body);
            const parts = label.attrs.text.split(' - ');
            requireState(parts.length === 2 && parts.every(value => CLOCK.test(value)));
            const parent = label.parent;
            this._valid(parent, page.body);
            requireState(parent.attrs.class === 'android.view.View' && parent.attrs.clickable !== 'true' && label.attrs.clickable !== 'true');
            const labelBounds = this._bounds(label);
            const roots = parent.children.filter(node => this._package(node) === this.package && this._visible(node)
                && node.attrs.checkable === 'true' && this._bounds(node)
                && (labelBounds[1] + labelBounds[3]) / 2 >= this._bounds(node)[1]
                && (labelBounds[1] + labelBounds[3]) / 2 <= this._bounds(node)[3]);
            requireState(roots.length === 1 && parent.children.indexOf(roots[0]) === parent.children.indexOf(label) + 1);
            const control = this._switch(roots[0], page.body);
            const controlBounds = control.nodes.map(node => this._bounds(node));
            requireState(controlBounds.every(bounds => labelBounds[2] < bounds[0]));
            const bounds = [labelBounds[0], Math.min(labelBounds[1], ...controlBounds.map(box => box[1])),
                Math.max(...controlBounds.map(box => box[2])), Math.max(labelBounds[3], ...controlBounds.map(box => box[3]))];
            return { control, bounds, start: parts[0], end: parts[1] };
        }).sort((a, b) => a.bounds[1] - b.bounds[1]);
        requireState(new Set(rows.map(row => row.control.node)).size === 4);
        for (let i = 1; i < rows.length; i++) requireState(rows[i - 1].bounds[3] <= rows[i].bounds[1]);
        return rows.map((row, index) => ({ ...row, id: String(index + 1) }));
    }

    preferredTimes() {
        const page = this._page(TITLES.preferred);
        const notices = this._text(page.body, PREFERRED_NOTICE);
        requireState(notices.length <= 1);
        for (const notice of notices) this._valid(notice, page.body);
        return { windows: this._preferredRows(page).map(row => ({ id: row.id, start: row.start, end: row.end,
            enabled: row.control.value, editable: false })), notice: notices.length ? PREFERRED_NOTICE : null,
            canSave: Boolean(this._save(page)) };
    }

    preferredToggleTarget(id, wanted) {
        if (typeof wanted !== 'boolean') throw unavailable();
        const row = this._preferredRows(this._page(TITLES.preferred)).find(item => item.id === id);
        if (!row) throw unavailable();
        return this._switchTarget(row.control);
    }

    scrollTarget(direction) {
        const page = this._base();
        if (!page || !['departuresOverview', 'locationSettings'].includes(this.kind())) throw unavailable();
        return this._scrollGesture(page.body, direction);
    }
}

module.exports = { DepartureScreen };
