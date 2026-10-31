'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../lib/controller');
const { executeDepartures, returnFromDeparturePage } = require('../lib/departures-controller');
const { BridgeError } = require('../lib/errors');
const { nativeObservationFromXml } = require('./support/charging-mode-fixtures.cjs');

const PACKAGE = 'com.volkswagen.weconnect';
const MARKER = 'Ihr Fahrzeug: Testwagen. ';
const NOTICE = 'Aktivieren oder deaktivieren Sie Ihre bevorzugten Ladezeiten im Infotainment-System Ihres Fahrzeugs und legen Sie dort die genauen Zeitfenster fest.';
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const LABELS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const DAY_IDS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const clone = value => JSON.parse(JSON.stringify(value));

// All coordinates, names, times, IDs and layouts are synthetic. No private
// Android dump or actual vehicle setting is part of these fixtures.
function node(attrs = {}, children = []) {
    return { attrs: { package: PACKAGE, class: 'android.view.View', enabled: 'true', clickable: 'false',
        checkable: 'false', checked: 'false', selected: 'false', 'visible-to-user': 'true',
        bounds: '[0,0][1000,2000]', ...attrs }, children };
}
function text(value, bounds) { return node({ class: 'android.widget.TextView', text: value, bounds }); }
function escaped(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function render(tree) {
    return '<node ' + Object.entries(tree.attrs).map(([key, value]) => key + '="' + escaped(value) + '"').join(' ') + '>'
        + tree.children.map(render).join('') + '</node>';
}
function document(root) { return '<hierarchy>' + render(root) + '</hierarchy>'; }
function switched(bounds, enabled) {
    return node({ clickable: 'true', checkable: 'true', checked: String(enabled), bounds }, [
        node({ clickable: 'true', checkable: 'true', checked: String(enabled), bounds }),
    ]);
}
function page(title, children, { right = null, bodyClass = 'android.widget.ScrollView', actions = [], scrollable = true } = {}) {
    const back = node({ class: 'android.widget.Button', clickable: 'true', bounds: '[20,90][160,190]' });
    const heading = node({ 'content-desc': title, bounds: '[170,110][830,170]' });
    const trailing = right ? node({ class: 'android.widget.Button', clickable: 'true',
        text: right === 'save' ? 'Speichern' : '', bounds: '[840,90][980,190]' }) : null;
    return node({ class: 'androidx.compose.ui.platform.ComposeView', 'resource-id': 'composeView' }, [
        node({}, [
            node({ bounds: '[0,80][1000,200]' }, [back, heading, ...(trailing ? [trailing] : [])]),
            node({ class: bodyClass, scrollable: String(scrollable), 'a11y-actions': JSON.stringify(actions),
                bounds: '[0,200][1000,1900]' }, children),
        ]),
    ]);
}
function timerRow(timer, top, caption = null) {
    const daysText = caption ?? timer.days.map(day => LABELS[DAYS.indexOf(day)]).join(', ');
    return node({ clickable: 'true', bounds: '[50,' + top + '][950,' + (top + 200) + ']' }, [
        node({ bounds: '[70,' + (top + 10) + '][940,' + (top + 145) + ']' }, [
            text(timer.time, '[80,' + (top + 30) + '][250,' + (top + 90) + ']'),
            switched('[800,' + (top + 20) + '][930,' + (top + 140) + ']', timer.enabled),
        ]),
        text(daysText, '[80,' + (top + 125) + '][600,' + (top + 165) + ']'),
    ]);
}
function sampleTimer(id, overrides = {}) {
    return { id, enabled: id === '1', time: ['06:45', '19:20', '04:25'][Number(id) - 1],
        days: [DAYS[Number(id) - 1]], repeat: true, date: null, vehicleOffset: '+01:00',
        isLocalVehicleTime: false, ...overrides };
}
function recordTimer(timer, kind, profileId) {
    const recurring = 'Recurring(startTime=' + timer.time + ', isLocalVehicleTime=' + timer.isLocalVehicleTime
        + ', ' + ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(day => ({
            sun: 'sundays', mon: 'mondays', tue: 'tuesdays', wed: 'wednesdays', thu: 'thursdays', fri: 'fridays', sat: 'saturdays',
        })[day] + '=' + timer.days.includes(day)).join(', ') + ')';
    const value = timer.repeat ? recurring
        : 'Single(startTime=' + timer.date + 'T' + timer.time + ', isLocalVehicleTime=' + timer.isLocalVehicleTime + ')';
    const prefix = kind === 'climate' ? 'ClimaTimer' : 'ChargingTimer';
    return { fragment: 'EditDepartureTimerFragment', arguments: 'Bundle[{departureTimer=' + prefix
        + '(id=' + timer.id + ', isEnabled=' + timer.enabled + ', vehicleOffset=' + timer.vehicleOffset
        + (kind === 'climate' ? ', timeInCar=2030-01-01T12:00+01:00' : '') + ', timer=' + value
        + (kind === 'charging' ? ', climatisation=false, profileId=' + profileId + ', isPreferredTimesAvailable=true' : '') + ')}]' };
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

class App {
    constructor(options = {}) {
        this.page = 'home'; this.position = 0; this.gearPosition = 0; this.menuVisible = true;
        this.calls = []; this.versionValue = '4.8.1'; this.deadline = null;
        this.climate = [sampleTimer('1'), sampleTimer('2')];
        this.locations = [{ nativeId: '11', name: 'Synthetic place Alpha', activeCount: 1 },
            { nativeId: '22', name: 'Synthetic place Beta', activeCount: 1 }];
        this.charging = ['1', '2', '3'].map(id => sampleTimer(id));
        this.options = options;
        Object.assign(this, options);
        this.currentLocation ||= this.locations[0];
    }
    async connect() { this.calls.push(['connect']); if (this.connectGate) await this.connectGate; }
    async version() { this.calls.push(['version']); if (this.beforeVersion) await this.beforeVersion(); return this.versionValue; }
    async launch() { this.calls.push(['launch']); }
    view() {
        const targets = [];
        const target = (x, y, action) => targets.push({ x, y, action });
        let root;
        if (this.page === 'home') {
            target(500, 900, 'open');
            root = node({ class: 'androidx.compose.ui.platform.ComposeView', 'resource-id': 'composeView' }, [
                node({ class: 'android.widget.ScrollView', scrollable: 'true', bounds: '[20,100][980,1900]' }, [
                    node({ 'content-desc': this.wrongVehicle ? 'Ihr Fahrzeug: Anderes Auto. ' : MARKER + 'Synchronisiert',
                        bounds: '[50,100][950,180]' }),
                    node({ 'resource-id': 'climateTile', bounds: '[50,250][450,650]' }),
                    ...(this.menuVisible ? [node({ clickable: 'true', bounds: '[50,800][950,1000]' }, [
                        node({ 'content-desc': 'Abfahrtszeiten. Details öffnen', bounds: '[100,850][900,950]' }),
                    ])] : []),
                ]),
            ]);
        } else if (this.page === 'departuresOverview') {
            target(90, 140, 'home');
            const max = this.partial ? Math.max(0, Math.ceil(this.locations.length / 2) - 1) : 0;
            const actions = [...(this.position < max ? [4096] : []), ...(this.position > 0 ? [8192] : [])];
            if (this.unprovenBottom) actions.push(...(actions.includes(4096) ? [] : [4096]));
            const climateRows = this.climate.map((timer, index) => {
                target(165, 420 + index * 220, 'timer:climate:' + timer.id);
                if (this.writable) target(865, 440 + index * 220, 'enabled:climate:' + timer.id);
                return timerRow(timer, 360 + index * 220, this.caption);
            });
            const climate = node({ 'visible-to-user': String(this.position === 0), bounds: '[50,270][950,850]' }, [
                text('Klimatisierung', '[200,290][600,340]'), ...climateRows,
            ]);
            const places = this.locations.map((location, index) => {
                const visible = !this.partial || Math.floor(index / 2) === this.position;
                const rowIndex = this.partial ? index % 2 : index;
                const top = this.position === 0 ? 1100 + rowIndex * 145 : 380 + rowIndex * 220;
                if (visible) target(265, top + 25, 'location:' + location.nativeId);
                return node({ clickable: 'true', 'visible-to-user': String(visible),
                    bounds: '[50,' + (top - 10) + '][950,' + (top + 120) + ']' }, [
                    text(location.name, '[80,' + top + '][450,' + (top + 50) + ']'),
                    text(location.activeCount + ' aktive Abfahrtszeiten', '[80,' + (top + 60) + '][650,' + (top + 105) + ']'),
                    node({ clickable: 'true', bounds: '[800,' + top + '][930,' + (top + 110) + ']' }),
                ]);
            });
            const charging = node({ bounds: this.position === 0 ? '[50,900][950,1880]' : '[50,250][950,1880]' }, [
                text('Laden', this.position === 0 ? '[200,940][600,1000]' : '[200,270][600,330]'), ...places,
            ]);
            root = page('Abfahrtszeiten', [climate, charging], { actions });
        } else if (this.page === 'locationOverview') {
            target(90, 140, 'departures'); target(910, 140, 'gear');
            root = page(this.wrongTitle ? 'Synthetic other place' : this.currentLocation.name,
                this.charging.map((timer, index) => {
                    target(165, 420 + index * 250, 'timer:charging:' + timer.id);
                    if (this.writable) target(865, 440 + index * 250, 'enabled:charging:' + timer.id);
                    return timerRow(timer, 360 + index * 250, this.caption);
                }), { right: 'gear' });
        } else if (this.page === 'timerEditor') {
            target(90, 140, 'timerBack');
            if (this.writable) {
                if (this.dirtyEditor) target(910, 140, 'saveTimer');
                target(865, 1170, 'repeat');
            }
            const timer = this.activeTimer();
            const time = this.editorTime ?? timer.time;
            const wheels = ['Hour', 'Minute'].map((description, index) => node({ class: 'android.widget.SeekBar',
                'content-desc': description, 'state-description': time.split(':')[index],
                'range-type': '1', 'range-min': '0', 'range-max': index ? '119999' : '229999',
                'range-current': String(index ? this.minuteProgress ?? 60001 : this.hourProgress ?? 115001), 'a11y-actions': '[64,4096,8192,16908349]',
                bounds: index ? '[580,500][660,820]' : '[380,500][460,820]' }));
            const days = DAY_IDS.map((day, index) => {
                const x = 40 + index * 135;
                if (this.writable) target(x + 60, 965, 'day:' + DAYS[index]);
                return node({ 'resource-id': 'cta_' + day, clickable: 'true', bounds: '[' + x + ',900][' + (x + 120) + ',1030]' },
                    [text(SHORT[index], '[' + (x + 30) + ',940][' + (x + 90) + ',990]')]);
            });
            root = page('Zeit einstellen', [
                ...(!this.noWheels ? wheels : []),
                node({ 'resource-id': 'editDepartureTimerWeekday', bounds: '[50,910][950,1020]' }, days),
                node({ 'resource-id': 'editDepartureTimerRepeat', bounds: '[50,1080][950,1270]' }, [
                    text('Wiederholen', '[200,1130][600,1190]'),
                    switched('[800,1110][930,1230]', this.editorRepeat ?? timer.repeat),
                ]),
            ], { right: this.dirtyEditor ? 'save' : null });
        } else if (this.page === 'locationSettings') {
            target(90, 140, 'locationBack'); target(350, 1610, 'preferred');
            if (this.writable) {
                target(865, 1120, 'reduced'); target(865, 1360, 'unlock');
                if (this.dirtyGear) target(910, 140, 'saveGear');
            }
            const nameVisible = !this.splitGear || this.gearPosition === 0;
            const valuesVisible = !this.splitGear || this.gearPosition > 0;
            const toggle = (label, enabled, top) => node({ clickable: 'true', 'visible-to-user': String(valuesVisible),
                bounds: '[0,' + top + '][1000,' + (top + 200) + ']' }, [
                text(label, '[50,' + (top + 60) + '][700,' + (top + 120) + ']'),
                switched('[800,' + (top + 40) + '][930,' + (top + 160) + ']', enabled),
            ]);
            root = page('Ladeeinstellungen', [
                node({ class: 'android.widget.EditText', text: this.gearName ?? this.currentLocation.name,
                    'visible-to-user': String(nameVisible), clickable: 'true', bounds: '[50,280][950,400]' }),
                text('Direkt laden bis (0-50 %)', '[50,500][700,560]'),
                text('Laden bis (50-100 %)', '[50,800][700,860]'),
                toggle('Reduzierter AC-Ladestrom', this.gearReduced ?? false, 1020),
                toggle('AC-Stecker automatisch entriegeln', this.gearUnlock ?? true, 1260),
                ...(!this.noPreferred ? [node({ clickable: 'true', 'visible-to-user': String(valuesVisible && (!this.preferredLower || this.gearPosition > 0)),
                    bounds: '[0,1540][1000,1700]' }, [text('Bevorzugte Zeiten', '[50,1580][650,1640]')])] : []),
            ], { bodyClass: 'android.view.View', right: this.dirtyGear ? 'save' : null,
                actions: this.splitGear ? this.gearPosition ? [8192] : [4096] : [], scrollable: !this.nonScrollableGear });
        } else if (this.page === 'preferredTimes') {
            target(90, 140, 'gearBack');
            if (this.writable && this.dirtyPreferred) target(910, 140, 'savePreferred');
            const slots = ['20:15 - 05:45', '06:20 - 08:50', '11:10 - 13:40', '16:05 - 19:30'];
            root = page('Bevorzugte Zeiten', [
                node({ bounds: '[50,400][950,1550]' }, slots.flatMap((slot, index) => {
                    const top = 450 + index * 230;
                    if (this.writable) target(865, top + 60, 'preferredEnabled:' + index);
                    return [text(slot, '[50,' + (top + 30) + '][480,' + (top + 90) + ']'),
                        switched('[800,' + top + '][930,' + (top + 120) + ']', this.preferredEnabled?.[index] ?? index % 2 === 0)];
                })),
                text(NOTICE, '[50,1600][950,1790]'),
            ], { bodyClass: 'android.view.View', scrollable: false, right: this.dirtyPreferred ? 'save' : null });
        } else if (this.page === 'dialog') root = node({ 'resource-id': 'alert_dialog' });
        else root = node({ 'resource-id': 'unrecognized' });
        return { xml: document(root), targets, page: this.page };
    }
    savedTimer() { return (this.editorKind === 'climate' ? this.climate : this.charging).find(timer => timer.id === this.editorId); }
    activeTimer() { return this.writable && this.editorDraft ? this.editorDraft : this.savedTimer(); }
    async dump() { return this.view().xml; }
    async departureView() {
        if (this.beforeView) await this.beforeView();
        this.frame = this.view(); this.calls.push(['read', this.page, this.position]);
        if (this.afterView) await this.afterView();
        return { xml: this.frame.xml, observation: nativeObservationFromXml(this.frame.xml) };
    }
    async departureNative() {
        this.calls.push(['native', this.page]);
        if (this.beforeNative) await this.beforeNative();
        if (this.nativeOverride) return this.nativeOverride();
        if (this.page === 'timerEditor') return recordTimer(this.writable ? this.editorInitial : this.activeTimer(), this.editorKind,
            this.wrongTimerLocationId ?? this.currentLocation?.nativeId);
        const fragment = { locationOverview: 'ChargingLocationOverviewFragment',
            locationSettings: 'ChargingLocationSettingsFragment', preferredTimes: 'PreferredChargingTimesFragment' }[this.page];
        const id = this.wrongNativeId ?? this.currentLocation.nativeId;
        return { fragment, arguments: this.page === 'preferredTimes'
            ? 'Bundle[{preferredChargingTimes=OfProfile(profileId=' + id + ')}]'
            : 'Bundle[{chargingLocationId=' + id + (this.page === 'locationSettings' ? ', isOneTonCargo=false' : '') + '}]' };
    }
    async tap(x, y) {
        this.calls.push(['tap', this.page, x, y]);
        if (this.beforeTap) await this.beforeTap();
        const target = this.frame?.page === this.page && this.frame.targets.find(item => item.x === x && item.y === y);
        if (!target) throw new Error('SECRET mutation, Save or unknown navigation point');
        const action = target.action;
        if (action === 'open') { this.page = 'departuresOverview'; this.position = this.initialPosition ?? 0; }
        else if (action === 'home') { this.page = 'home'; if (this.wrongVehicleOnReturn) this.wrongVehicle = true; }
        else if (action === 'departures') {
            this.page = 'departuresOverview';
            if (this.reorder) this.locations.reverse();
        } else if (action.startsWith('location:')) {
            this.currentLocation = this.locations.find(location => location.nativeId === action.slice(9));
            this.page = 'locationOverview';
        } else if (action.startsWith('timer:')) {
            [, this.editorKind, this.editorId] = action.split(':'); this.page = 'timerEditor';
            if (this.writable) {
                this.editorInitial = clone(this.savedTimer()); this.editorDraft = clone(this.editorInitial);
                this.hourProgress = 115001; this.minuteProgress = 60001;
            }
        } else if (action === 'timerBack') {
            this.page = this.editorKind === 'climate' ? 'departuresOverview' : 'locationOverview';
            if (this.writable) this.editorDraft = null;
        }
        else if (action === 'gear') { this.page = 'locationSettings'; this.gearPosition = this.initialGearPosition ?? 0; }
        else if (action === 'preferred') this.page = 'preferredTimes';
        else if (action === 'gearBack') this.page = 'locationSettings';
        else if (action === 'locationBack') this.page = 'locationOverview';
        else if (this.writable && action === 'saveTimer') {
            if (!this.ignoreSave) {
                const saved = clone(this.editorDraft);
                if (!saved.repeat && (!saved.date || this.editorInitial.repeat || !sameDays(saved.days, this.editorInitial.days))) {
                    saved.date = ['2030-01-07', '2030-01-08', '2030-01-09', '2030-01-10', '2030-01-11', '2030-01-12', '2030-01-13'][DAYS.indexOf(saved.days[0])];
                }
                if (saved.repeat) saved.date = null;
                if (this.saveAutoEnables) saved.enabled = true;
                Object.assign(this.savedTimer(), saved);
                if (this.editorKind === 'charging') this.currentLocation.activeCount = this.charging.filter(timer => timer.enabled).length;
                this.dirtyEditor = false;
                if (this.afterSaveTimer) this.afterSaveTimer();
            }
        } else if (this.writable && action === 'repeat') {
            this.editorDraft.repeat = !this.editorDraft.repeat; this.dirtyEditor = true;
        } else if (this.writable && action.startsWith('day:')) {
            const day = action.slice(4);
            this.editorDraft.days = this.editorDraft.days.includes(day) ? this.editorDraft.days.filter(value => value !== day)
                : DAYS.filter(value => this.editorDraft.days.includes(value) || value === day);
            if (this.editorDraft.days.length > 1) this.editorDraft.repeat = true;
            this.dirtyEditor = true;
        } else if (this.writable && action.startsWith('enabled:')) {
            const [, kind, id] = action.split(':');
            const timer = (kind === 'climate' ? this.climate : this.charging).find(value => value.id === id);
            timer.enabled = !timer.enabled;
            if (kind === 'charging') this.currentLocation.activeCount = this.charging.filter(value => value.enabled).length;
            if (this.afterEnabled) this.afterEnabled(timer);
        } else if (this.writable && action === 'reduced') {
            this.gearReduced = !(this.gearReduced ?? false); this.dirtyGear = true;
        } else if (this.writable && action === 'unlock') {
            this.gearUnlock = !(this.gearUnlock ?? true); this.dirtyGear = true;
        } else if (this.writable && action === 'saveGear') {
            if (!this.ignoreSave) {
                if (this.gearName) this.currentLocation.name = this.gearName;
                this.dirtyGear = false;
                if (this.afterSaveGear) this.afterSaveGear();
            }
        } else if (this.writable && action.startsWith('preferredEnabled:')) {
            this.preferredEnabled ??= [true, false, true, false];
            const index = Number(action.split(':')[1]); this.preferredEnabled[index] = !this.preferredEnabled[index];
            this.dirtyPreferred = !this.preferredDirect;
        } else if (this.writable && action === 'savePreferred') {
            if (!this.ignoreSave) { this.dirtyPreferred = false; if (this.afterSavePreferred) this.afterSavePreferred(); }
        }
        else throw new Error('Unknown synthetic transition');
        if (this.afterTap) await this.afterTap(action);
    }
    async swipe(gesture) {
        this.calls.push(['swipe', this.page, clone(gesture)]);
        if (!this.noProgress) {
            if (this.page === 'home') this.menuVisible = true;
            else if (this.page === 'departuresOverview') {
                const max = this.partial ? Math.max(0, Math.ceil(this.locations.length / 2) - 1) : 0;
                this.position = Math.max(0, Math.min(max, this.position + (gesture.y2 < gesture.y1 ? 1 : -1)));
            } else if (this.page === 'locationSettings') this.gearPosition = gesture.y2 < gesture.y1 ? 1 : 0;
            else throw new Error('Unexpected synthetic swipe');
        }
    }
    async back() {
        if (this.page !== 'locationOverview') throw new Error('Android Back is forbidden outside the verified location overview');
        this.calls.push(['back', this.page]);
        if (!this.ignoreLocationBack) this.page = 'departuresOverview';
        if (this.afterSystemBack) await this.afterSystemBack();
    }
    async departureAction(request) {
        if (!this.writable) throw new Error('Departure writes must not run during reads');
        this.calls.push(['action', clone({ ...request, snapshot: undefined })]);
        if (this.beforeAction) await this.beforeAction(request);
        if (this.actionResult) return this.actionResult;
        if (this.actionThrow) throw new Error('SECRET transport problem');
        if (request.action === 'setProgress') {
            assert.equal(this.page, 'timerEditor'); assert.equal(request.header, 'Zeit einstellen');
            const index = request.target.description === 'Hour' ? 0 : 1;
            const key = index ? 'minuteProgress' : 'hourProgress';
            const delta = request.value - this[key], modulo = index ? 60 : 24;
            const parts = this.editorDraft.time.split(':').map(Number);
            parts[index] = (parts[index] + delta * (index ? 5 : 1) + modulo * 10) % modulo;
            this[key] = request.value;
            this.editorDraft.time = parts.map(value => String(value).padStart(2, '0')).join(':');
            this.dirtyEditor = true;
        } else {
            assert.equal(request.action, 'setText'); assert.equal(this.page, 'locationSettings');
            assert.equal(request.header, 'Ladeeinstellungen'); this.gearName = request.value; this.dirtyGear = true;
        }
        if (this.afterAction) await this.afterAction(request);
        return { beforeMatched: true, actionAttempted: true, actionAccepted: true, success: true,
            postRead: this.noActionPostRead ? null : await this.departureView() };
    }
}
function sameDays(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function setup(options = {}, config = {}) {
    const phone = new App(options), clock = { now: 1700000000000 };
    const store = { async read() { throw new Error('SECRET wishes must not be read'); },
        async write() { throw new Error('SECRET wishes must not be written'); },
        async reserveCommand() { throw new Error('Read must not reserve a vehicle command'); } };
    const c = new Controller({ phone, store, config: { approvedAppVersion: '4.8.1',
        vehicleMarker: { contentDescPrefix: MARKER }, modeTitles: ['Klimatisierung'], allowWrites: false,
        commandTimeoutSeconds: 300, outcomeTimeoutSeconds: 120, cooldownSeconds: 60, ...config },
    now: () => clock.now, sleep: async milliseconds => {
        clock.now += milliseconds;
        if (phone.afterSleep) await phone.afterSleep(milliseconds, clock.now);
    } });
    return { c, phone, clock };
}
async function rejects(operation, code) {
    await assert.rejects(operation, error => error instanceof BridgeError && (Array.isArray(code) ? code.includes(error.code) : error.code === code)
        && !error.message.includes('SECRET'));
}
function finished(c, phone) {
    assert.equal(phone.page, 'home'); assert.equal(phone.deadline, null); assert.equal(c.deadline, null);
    assert.equal(c.busy, false); assert.equal(c.readOnlyExecution, false); assert.equal(c.readHandoffProtected, false);
}

test('climate status reads both native timers, checks displayed values and returns safely home without any writes', async () => {
    const { c, phone } = setup();
    const result = await executeDepartures(c, 'departuresClimateStatus');
    assert.equal(result.domain, 'departureClimate'); assert.equal(result.source, 'volkswagen_android_app');
    assert.equal(result.vehicleConfirmed, false); assert.equal(result.appVersion, '4.8.1');
    assert.equal(result.observedAt, '2023-11-14T22:13:20.000Z');
    assert.deepEqual(result.timers.map(timer => timer.id), ['1', '2']);
    assert.deepEqual(result.timers[0].days, ['mon']); assert.equal(result.timers[0].daysSummary, 'Montag');
    assert.equal(result.timers[0].daysSummaryRecognized, true);
    assert.equal(result.timers[0].source, 'editor_initial_snapshot');
    assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[1] === 'timerEditor').length, 2);
    finished(c, phone);
});

test('overview-only climate reads visible rows twice without opening either timer editor', async () => {
    const { c, phone } = setup();
    const taps = []; phone.afterTap = action => taps.push(action);
    const result = await executeDepartures(c, 'departuresClimateStatus', { overviewOnly: true });
    assert.equal(result.partial, true); assert.equal(result.domain, 'departureClimate');
    assert.equal(result.timers.length, 2); assert.equal(phone.page, 'home');
    for (const row of result.timers) {
        assert.deepEqual(Object.keys(row).sort(), ['daysSummary', 'daysSummaryRecognized', 'enabled', 'id', 'time'].sort());
    }
    assert.equal(phone.calls.some(call => call[0] === 'tap' && call[1] === 'timerEditor'), false);
    assert.equal(phone.calls.some(call => call[0] === 'native' && call[1] === 'timerEditor'), false);
    assert.equal(phone.calls.some(call => call[0] === 'cleanBack'), false);
    assert.equal(taps.some(action => action.startsWith('timer:')), false);
});

test('overview-only charging location reads settings but never opens its timer editors', async () => {
    const { c, phone } = setup();
    const taps = []; phone.afterTap = action => taps.push(action);
    const result = await executeDepartures(c, 'departuresLocationStatus', {
        overviewOnly: true, location: { nativeId: '11', name: 'Synthetic place Alpha' },
    });
    assert.equal(result.partial, true); assert.equal(result.domain, 'departureLocation');
    assert.equal(result.timers.length, 3); assert.equal(result.settings.name, 'Synthetic place Alpha');
    assert.equal(result.preferredTimes.windows.length, 4); assert.equal(phone.page, 'home');
    assert.equal(phone.calls.some(call => call[0] === 'tap' && call[1] === 'timerEditor'), false);
    assert.equal(phone.calls.some(call => call[0] === 'native' && call[1] === 'timerEditor'), false);
    assert.equal(phone.calls.some(call => call[0] === 'cleanBack'), false);
    assert.equal(taps.some(action => action.startsWith('timer:')), false);
});

test('explicit dry-run reads validate the same navigation and never touch a write API or preference queue', async () => {
    const { c, phone } = setup();
    const before = clone({ climate: phone.climate, charging: phone.charging, locations: phone.locations });
    const result = await executeDepartures(c, 'departuresClimateStatus', { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.deepEqual({ climate: phone.climate, charging: phone.charging, locations: phone.locations }, before);
    finished(c, phone);
});

test('location discovery explicitly visits and binds every visible name, including empty and five-location collections', async () => {
    for (const length of [0, 1, 5]) {
        const locations = Array.from({ length }, (_, index) => ({ nativeId: String(100 + index), name: 'Synthetic place ' + index, activeCount: 1 }));
        const { c, phone } = setup({ locations, partial: true, reorder: true });
        const result = await executeDepartures(c, 'departuresLocationsStatus');
        assert.equal(result.domain, 'departureLocations');
        assert.deepEqual([...result.locations].sort((a, b) => a.nativeId.localeCompare(b.nativeId)),
            [...locations].sort((a, b) => a.nativeId.localeCompare(b.nativeId)));
        assert.equal(phone.calls.filter(call => call[0] === 'native' && call[1] === 'locationOverview').length, length * 2);
        assert.equal(phone.calls.some(call => call[0] === 'read' && call[1] === 'timerEditor'), false);
        finished(c, phone);
    }
});

test('read-only location overview returns once with Android Back after checking its identity', async () => {
    const { c, phone } = setup({ locations: [{ nativeId: '11', name: 'Synthetic place Alpha', activeCount: 1 }] });
    await executeDepartures(c, 'departuresLocationsStatus');
    assert.deepEqual(phone.calls.filter(call => call[0] === 'back'), [['back', 'locationOverview']]);
    assert.equal(phone.calls.some(call => call[0] === 'tap' && call[1] === 'locationOverview' && call[2] === 90), false);
    finished(c, phone);
});

test('unconfirmed location return and changed identity never cause a repeated Back', async () => {
    const stalled = setup({ locations: [{ nativeId: '11', name: 'Synthetic place Alpha', activeCount: 1 }], ignoreLocationBack: true });
    await rejects(executeDepartures(stalled.c, 'departuresLocationsStatus'), 'unexpected_screen');
    assert.deepEqual(stalled.phone.calls.filter(call => call[0] === 'back'), [['back', 'locationOverview']]);
    assert.equal(stalled.phone.page, 'locationOverview');

    const changed = setup({ locations: [{ nativeId: '11', name: 'Synthetic place Alpha', activeCount: 1 }] });
    let nativeReads = 0;
    changed.phone.beforeNative = () => {
        if (changed.phone.page === 'locationOverview' && ++nativeReads === 2) changed.phone.currentLocation.nativeId = '99';
    };
    await rejects(executeDepartures(changed.c, 'departuresLocationsStatus'), 'departure_location_mismatch');
    assert.equal(changed.phone.calls.some(call => call[0] === 'back'), false);
});

test('manual handoff before read-only location return prevents Android Back', async () => {
    const { c, phone } = setup({ locations: [{ nativeId: '11', name: 'Synthetic place Alpha', activeCount: 1 }] });
    let nativeReads = 0;
    phone.beforeNative = () => {
        if (phone.page === 'locationOverview' && ++nativeReads === 2) assert.equal(c.requestReadHandoff(), true);
    };
    await rejects(executeDepartures(c, 'departuresLocationsStatus'), 'cancelled');
    assert.equal(phone.calls.some(call => call[0] === 'back'), false);
    assert.equal(c.busy, false);
});

test('handoff after the last location read or after Android Back cannot repeat the gesture', async () => {
    const before = setup({ locations: [{ nativeId: '11', name: 'Synthetic place Alpha', activeCount: 1 }] });
    let nativeReads = 0;
    before.phone.beforeNative = () => { if (before.phone.page === 'locationOverview') nativeReads++; };
    before.phone.afterView = () => {
        if (before.phone.page === 'locationOverview' && nativeReads >= 2) before.c.requestReadHandoff();
    };
    await rejects(executeDepartures(before.c, 'departuresLocationsStatus'), 'cancelled');
    assert.equal(before.phone.calls.filter(call => call[0] === 'back').length, 0);

    const after = setup({ locations: [{ nativeId: '11', name: 'Synthetic place Alpha', activeCount: 1 }] });
    after.phone.afterSystemBack = () => { assert.equal(after.c.requestReadHandoff(), true); };
    await rejects(executeDepartures(after.c, 'departuresLocationsStatus'), 'cancelled');
    assert.equal(after.phone.calls.filter(call => call[0] === 'back').length, 1);
});

test('single-location status reads three timers, native profile metadata, partial gear fields and four read-only preferred windows', async () => {
    const { c, phone } = setup({ splitGear: true });
    const result = await executeDepartures(c, 'departuresLocationStatus', { location: { nativeId: '22', name: 'Synthetic place Beta' } });
    assert.equal(result.domain, 'departureLocation');
    assert.deepEqual(result.location, { nativeId: '22', name: 'Synthetic place Beta' });
    assert.deepEqual(result.timers.map(timer => timer.id), ['1', '2', '3']);
    for (const timer of result.timers) {
        assert.equal(timer.profileId, '22'); assert.equal(timer.climatisation, false);
        assert.equal(timer.isPreferredTimesAvailable, true);
    }
    assert.deepEqual(result.settings, { name: 'Synthetic place Beta', directSoc: null, socLimit: null,
        reducedAcCurrent: false, autoUnlockAc: true });
    assert.equal(result.preferredTimes.windows.length, 4);
    assert.ok(result.preferredTimes.windows.every(window => window.editable === false));
    assert.equal(result.preferredTimes.notice, NOTICE);
    finished(c, phone);
});

test('unknown days captions retain their raw text and native days without inventing an interpretation', async () => {
    const { c, phone } = setup({ caption: 'Unbekannte Datumsanzeige' });
    phone.climate[0] = sampleTimer('1', { repeat: false, date: '2024-02-29', days: ['thu'] });
    const result = await executeDepartures(c, 'departuresClimateStatus');
    assert.deepEqual(result.timers[0].days, ['thu']); assert.equal(result.timers[0].date, '2024-02-29');
    assert.equal(result.timers[0].daysSummary, 'Unbekannte Datumsanzeige');
    assert.equal(result.timers[0].daysSummaryRecognized, false);
    finished(c, phone);
});

test('known contradictory days, clock, enabled and repeat evidence prevents publication', async () => {
    for (const option of [{ caption: 'Dienstag' }, { editorTime: '01:23' }, { editorRepeat: false }]) {
        const { c } = setup(option);
        await rejects(executeDepartures(c, 'departuresClimateStatus'), 'departure_changed');
    }
    const { c, phone } = setup();
    phone.nativeOverride = () => recordTimer({ ...phone.activeTimer(), enabled: false }, phone.editorKind);
    await rejects(executeDepartures(c, 'departuresClimateStatus'), 'departure_changed');
});

test('an older editor without wheel metadata still requires the list clock and native snapshot to agree', async () => {
    const { c, phone } = setup({ noWheels: true });
    const result = await executeDepartures(c, 'departuresClimateStatus');
    assert.equal(result.timers[0].time, phone.climate[0].time);
    finished(c, phone);
});

test('invalid actions, malformed options and invalid native location selectors reject before any phone work', async () => {
    for (const [action, options, code] of [
        ['applyDepartureTimer', {}, 'invalid_action'], ['departuresClimateStatus', { location: {} }, 'invalid_departures_request'],
        ['departuresClimateStatus', { dryRun: 'true' }, 'invalid_departures_request'],
        ['departuresLocationStatus', {}, 'invalid_departures_request'],
        ['departuresLocationStatus', { location: { nativeId: 22, name: 'Synthetic place Beta' } }, 'invalid_departures_request'],
        ['departuresLocationStatus', { location: { nativeId: '022', name: 'Synthetic place Beta' } }, 'invalid_departures_request'],
        ['departuresLocationStatus', { location: { nativeId: '22\n', name: 'Synthetic place Beta' } }, 'invalid_departures_request'],
        ['departuresLocationStatus', { location: { nativeId: '22', name: ' name ' } }, 'invalid_departures_request'],
        ['departuresLocationStatus', { location: { nativeId: '22', name: 'Synthetic place Beta', other: 'SECRET' } }, 'invalid_departures_request'],
    ]) {
        const { c, phone } = setup();
        await rejects(executeDepartures(c, action, options), code);
        assert.deepEqual(phone.calls, []);
    }
    const { c, phone } = setup();
    const options = Object.defineProperty({}, 'location', { enumerable: true, get() { throw new Error('SECRET'); } });
    await rejects(executeDepartures(c, 'departuresLocationStatus', options), 'invalid_departures_request');
    assert.deepEqual(phone.calls, []);
});

test('location IDs are not substituted by list order, title or another native profile', async () => {
    for (const options of [{ wrongNativeId: '99' }, { wrongTitle: true }, { wrongTimerLocationId: '11' }]) {
        const { c } = setup(options);
        await rejects(executeDepartures(c, 'departuresLocationStatus', { location: { nativeId: '22', name: 'Synthetic place Beta' } }),
            ['departure_location_mismatch', 'departure_native_unavailable', 'target_unavailable']);
    }
});

test('discovery rejects duplicate names, duplicate native IDs and contradictory active counts', async () => {
    const duplicateNames = setup({ locations: [{ nativeId: '1', name: 'Same synthetic label', activeCount: 1 },
        { nativeId: '2', name: 'Same synthetic label', activeCount: 1 }] });
    await rejects(executeDepartures(duplicateNames.c, 'departuresLocationsStatus'), 'unknown_state');
    const duplicateIds = setup();
    duplicateIds.phone.wrongNativeId = '77';
    await rejects(executeDepartures(duplicateIds.c, 'departuresLocationsStatus'), 'departure_location_mismatch');
    const badCount = setup({ locations: [{ nativeId: '1', name: 'Synthetic count mismatch', activeCount: 2 }] });
    await rejects(executeDepartures(badCount.c, 'departuresLocationsStatus'), 'departure_changed');
});

test('missing or nonprogressing rich discovery does not publish a partial location list', async () => {
    const { c, phone, clock } = setup({ partial: true, locations: Array.from({ length: 5 }, (_, index) =>
        ({ nativeId: String(index), name: 'Synthetic place ' + index, activeCount: 1 })), noProgress: true });
    await rejects(executeDepartures(c, 'departuresLocationsStatus'), 'departure_incomplete');
    assert.ok(clock.now >= 1700000005000);
    assert.equal(phone.calls.some(call => call[0] === 'native'), false);
});

test('the menu is found by exact fresh description after a bounded overview scroll', async () => {
    const { c, phone } = setup({ menuVisible: false });
    await executeDepartures(c, 'departuresClimateStatus');
    assert.ok(phone.calls.some(call => call[0] === 'swipe' && call[1] === 'home'));
    finished(c, phone);
});

test('a pre-existing timer editor is left open with an accurate fixed instruction and no navigation input', async () => {
    const { c, phone } = setup({ page: 'timerEditor', editorKind: 'climate', editorId: '1' });
    await rejects(executeDepartures(c, 'departuresClimateStatus'), 'unsaved_settings');
    assert.equal(phone.calls.some(call => call[0] === 'tap' || call[0] === 'swipe'), false);
    assert.equal(phone.page, 'timerEditor');
});

test('dirty gear, preferred or newly changed timer drafts are neither saved nor discarded', async () => {
    for (const options of [{ page: 'locationSettings', dirtyGear: true }, { page: 'preferredTimes', dirtyPreferred: true }]) {
        const { c, phone } = setup(options);
        await rejects(executeDepartures(c, 'departuresClimateStatus'), 'unsaved_settings');
        assert.equal(phone.calls.some(call => call[0] === 'tap'), false);
    }
    const { c, phone } = setup();
    phone.afterTap = action => { if (action.startsWith('timer:')) phone.dirtyEditor = true; };
    await rejects(executeDepartures(c, 'departuresClimateStatus'), 'unsaved_settings');
    assert.equal(phone.calls.some(call => call[0] === 'tap' && call[1] === 'timerEditor'), false);
});

test('clean recognized location settings and preferred pages recover through native-bound headers to home', async () => {
    for (const page of ['locationOverview', 'locationSettings', 'preferredTimes']) {
        const { c, phone } = setup({ page });
        const result = await returnFromDeparturePage(c);
        assert.equal(result.kind(), 'overview');
        assert.equal(phone.page, 'home');
        assert.equal(phone.calls.some(call => call[0] === 'connect' || call[0] === 'launch'), false);
    }
});

test('recovery returns null on other UI or dialogs without issuing input or recursively calling overview', async () => {
    for (const page of ['other', 'dialog', 'home']) {
        const { c, phone } = setup({ page });
        c._overview = () => { throw new Error('Recovery must not recurse'); };
        assert.equal(await returnFromDeparturePage(c), null);
        assert.equal(phone.calls.some(call => call[0] === 'tap' || call[0] === 'swipe' || call[0] === 'launch'), false);
    }
});

test('soft handoff during an owned timer editor first completes its clean header return', async () => {
    const { c, phone } = setup();
    phone.afterTap = action => { if (action.startsWith('timer:')) assert.equal(c.requestReadHandoff(), true); };
    await rejects(executeDepartures(c, 'departuresClimateStatus'), 'cancelled');
    assert.equal(phone.page, 'departuresOverview');
    assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[1] === 'timerEditor').length, 1);
    assert.equal(c.readHandoffProtected, false); assert.equal(c.busy, false);
});

test('soft handoff during owned gear navigation completes the clean location return', async () => {
    const { c, phone } = setup();
    phone.afterTap = action => { if (action === 'gear') assert.equal(c.requestReadHandoff(), true); };
    await rejects(executeDepartures(c, 'departuresLocationStatus', { location: { nativeId: '11', name: 'Synthetic place Alpha' } }), 'cancelled');
    assert.equal(phone.page, 'locationOverview');
    assert.equal(c.readHandoffProtected, false);
});

test('hard cancellation remains effective inside a protected editor and prevents every later input', async () => {
    const { c, phone } = setup();
    phone.afterTap = action => { if (action.startsWith('timer:')) c.cancel(); };
    await rejects(executeDepartures(c, 'departuresClimateStatus'), 'cancelled');
    assert.equal(phone.page, 'timerEditor');
    assert.equal(phone.calls.some(call => call[0] === 'tap' && call[1] === 'timerEditor'), false);
    assert.equal(c.readHandoffProtected, false); assert.equal(c.busy, false); assert.equal(phone.deadline, null);
});

test('a native timer read failure leaves an owned editor open without inventing a safe return', async () => {
    for (const failedRead of [1, 2]) {
        const { c, phone } = setup(); let nativeReads = 0;
        phone.beforeNative = () => {
            if (phone.page === 'timerEditor' && ++nativeReads === failedRead) {
                throw new BridgeError('adb_timeout', 'Synthetic read failure.');
            }
        };
        await rejects(executeDepartures(c, 'departuresClimateStatus'), 'adb_timeout');
        assert.equal(phone.page, 'timerEditor');
        assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[1] === 'timerEditor').length, 0);
        assert.equal(phone.calls.some(call => call[0] === 'back'), false);
        assert.equal(c.busy, false); assert.equal(c.readHandoffProtected, false);
    }
});

test('a concurrent unsaved edit after opening an owned editor is not discarded following a read failure', async () => {
    const { c, phone } = setup(); let nativeReads = 0;
    phone.beforeNative = () => {
        if (phone.page === 'timerEditor' && ++nativeReads === 2) {
            phone.dirtyEditor = true;
            throw new BridgeError('adb_timeout', 'Synthetic read failure.');
        }
    };
    await rejects(executeDepartures(c, 'departuresClimateStatus'), 'adb_timeout');
    assert.equal(phone.page, 'timerEditor'); assert.equal(phone.dirtyEditor, true);
    assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[1] === 'timerEditor').length, 0);
    assert.equal(phone.calls.some(call => call[0] === 'back'), false);
});

test('version changes, wrong vehicles and a wrong return-home marker prevent successful observations', async () => {
    const wrong = setup({ wrongVehicle: true });
    await rejects(executeDepartures(wrong.c, 'departuresClimateStatus'), 'wrong_vehicle');
    assert.equal(wrong.phone.calls.some(call => call[0] === 'tap'), false);
    const version = setup();
    version.phone.afterTap = action => { if (action === 'open') version.phone.versionValue = 'changed'; };
    await rejects(executeDepartures(version.c, 'departuresClimateStatus'), 'version_not_approved');
    assert.equal(version.phone.calls.some(call => call[0] === 'tap' && call[1] === 'departuresOverview'), false);
    const returned = setup({ wrongVehicleOnReturn: true });
    await rejects(executeDepartures(returned.c, 'departuresClimateStatus'), 'wrong_vehicle');
});

test('concurrent rejected calls do not alter a running read and no writes are queued', async () => {
    const gate = deferred();
    const { c, phone } = setup({ connectGate: gate.promise });
    const active = executeDepartures(c, 'departuresClimateStatus');
    assert.equal(c.busy, true); assert.equal(c.readOnlyExecution, true);
    await rejects(executeDepartures(c, 'departuresLocationsStatus'), 'busy');
    assert.equal(c.busy, true); assert.equal(c.readOnlyExecution, true);
    c.cancel(); gate.resolve();
    await rejects(active, 'cancelled');
    assert.equal(phone.calls.some(call => call[0] === 'tap'), false);
    assert.equal(c.busy, false);
});

const ALPHA = { nativeId: '11', name: 'Synthetic place Alpha' };
function writeSetup(options = {}, config = {}) { return setup({ writable: true, ...options }, { allowWrites: true, ...config }); }
function mutationCalls(phone) {
    return phone.calls.filter(call => call[0] === 'action' || call[0] === 'tap' && (call[2] === 910 && call[1] !== 'locationOverview'
        || call[2] === 865 || call[1] === 'timerEditor' && call[3] === 965));
}
function saves(phone) { return phone.calls.filter(call => call[0] === 'tap' && call[2] === 910 && call[1] !== 'locationOverview'); }

test('location settings dry-run may use a verified Back, actual writes do not', async () => {
    const dry = writeSetup();
    await executeDepartures(dry.c, 'applyDepartureLocationSettings', { location: ALPHA,
        targetSettings: { reducedAcCurrent: true }, dryRun: true });
    const backwards = dry.phone.calls.filter(call => call[0] === 'back');
    assert.ok(backwards.length > 0 && backwards.every(call => call[1] === 'locationOverview'));
    assert.deepEqual(mutationCalls(dry.phone), []);

    const actual = writeSetup();
    await executeDepartures(actual.c, 'applyDepartureLocationSettings', { location: ALPHA,
        targetSettings: { reducedAcCurrent: true } });
    assert.equal(actual.phone.calls.some(call => call[0] === 'back'), false);
});

test('timer writes reject unsupported five-minute values, malformed wishes and disabled permission before connecting', async () => {
    for (const [action, options, code] of [
        ['applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:31' } }, 'unsupported_departure_time'],
        ['applyDepartureLocationTimer', { location: ALPHA, timerId: '3', targetTimer: { time: '08:01' } }, 'unsupported_departure_time'],
        ['applyDepartureClimateTimer', { timerId: '3', targetTimer: { enabled: true } }, 'invalid_departures_request'],
        ['applyDepartureClimateTimer', { timerId: '1', targetTimer: { enabled: 'true' } }, 'invalid_departures_request'],
        ['applyDepartureClimateTimer', { timerId: '1', targetTimer: {} }, 'departures_settings_required'],
        ['applyDepartureLocationSettings', { location: ALPHA, targetSettings: { socLimit: 80 } }, 'invalid_departures_request'],
        ['applyDepartureLocationSettings', { location: ALPHA, targetSettings: { name: 'Abfahrtszeiten' } }, 'invalid_departures_request'],
        ['applyDeparturePreferredTimes', { location: ALPHA, targetPreferredTimes: [{ id: '1', enabled: true }] }, 'invalid_departures_request'],
    ]) {
        const { c, phone } = writeSetup();
        await rejects(executeDepartures(c, action, options), code); assert.deepEqual(phone.calls, []);
    }
    const { c, phone } = writeSetup({}, { allowWrites: false });
    await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30' } }), 'writes_disabled');
    assert.deepEqual(phone.calls, []);
});

test('time writes use fresh relative raw progress, save once and reopen the native snapshot before returning all timers', async () => {
    const { c, phone } = writeSetup();
    const result = await executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30' } });
    assert.equal(result.changed, true); assert.equal(result.timers[0].time, '08:30');
    assert.equal(result.timers.length, 2); assert.equal(result.timers[0].enabled, true);
    const actions = phone.calls.filter(call => call[0] === 'action').map(call => call[1]);
    assert.deepEqual(actions.map(action => [action.target.description, action.value]), [['Hour', 115003], ['Minute', 59998]]);
    assert.deepEqual(actions.map(action => action.target.bounds), [[380, 500, 460, 820], [580, 500, 660, 820]]);
    assert.equal(saves(phone).length, 1);
    assert.ok(phone.calls.filter(call => call[0] === 'tap' && call[1] === 'departuresOverview').length >= 4);
    finished(c, phone);
});

test('clock wraparound uses the shortest step and a missing action post-read is observed without repeating input', async () => {
    const { c, phone } = writeSetup({ noActionPostRead: true });
    phone.climate[0].time = '23:55';
    const result = await executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '00:00' } });
    assert.equal(result.timers[0].time, '00:00');
    assert.deepEqual(phone.calls.filter(call => call[0] === 'action').map(call => call[1].value), [115002, 60002]);
    assert.equal(saves(phone).length, 1); finished(c, phone);
});

test('charging timer time and enabled are applied in order with the saved profile and untouched metadata preserved', async () => {
    const { c, phone } = writeSetup();
    const result = await executeDepartures(c, 'applyDepartureLocationTimer', { location: ALPHA, timerId: '2',
        targetTimer: { time: '20:35', enabled: true } });
    assert.equal(result.timers[1].time, '20:35'); assert.equal(result.timers[1].enabled, true);
    assert.equal(result.timers[1].profileId, '11'); assert.equal(result.timers[1].climatisation, false);
    assert.equal(result.timers[1].isPreferredTimesAvailable, true); assert.equal(result.timers.length, 3);
    const enabledIndex = phone.calls.findIndex(call => call[0] === 'tap' && call[1] === 'locationOverview' && call[2] === 865);
    const saveIndex = phone.calls.findIndex(call => call[0] === 'tap' && call[1] === 'timerEditor' && call[2] === 910);
    assert.ok(enabledIndex > saveIndex); assert.equal(saves(phone).length, 1); finished(c, phone);
});

test('enabled-only writes do not save or use an accessibility action and require a reopened native enabled state', async () => {
    const { c, phone } = writeSetup();
    const result = await executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '2', targetTimer: { enabled: true } });
    assert.equal(result.changed, true); assert.equal(result.timers[1].enabled, true);
    assert.equal(saves(phone).length, 0); assert.equal(phone.calls.some(call => call[0] === 'action'), false);
    finished(c, phone);
});

test('native persistence mismatch after a single enabled gesture produces an unknown outcome and no retry', async () => {
    const { c, phone } = writeSetup();
    phone.afterEnabled = timer => { phone.nativeOverride = () => recordTimer({ ...timer, enabled: false }, 'climate'); };
    await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '2', targetTimer: { enabled: true } }), 'departure_outcome_unknown');
    assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[2] === 865).length, 1);
    assert.equal(saves(phone).length, 0);
});

test('recurring days are toggled from the saved selection once each, adding before removal, then fully reopened', async () => {
    const { c, phone } = writeSetup();
    const result = await executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { days: ['tue', 'thu'] } });
    assert.deepEqual(result.timers[0].days, ['tue', 'thu']); assert.equal(result.timers[0].repeat, true);
    assert.deepEqual(phone.calls.filter(call => call[0] === 'tap' && call[1] === 'timerEditor' && call[3] === 965).map(call => call[2]),
        [235, 505, 100]);
    assert.equal(saves(phone).length, 1); finished(c, phone);
});

test('a recurring selection can become a verified Single only after reducing to one day', async () => {
    const { c, phone } = writeSetup(); phone.climate[0].days = ['mon', 'wed'];
    const result = await executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1',
        targetTimer: { repeat: false, days: ['wed'] } });
    assert.equal(result.timers[0].repeat, false); assert.deepEqual(result.timers[0].days, ['wed']);
    assert.equal(result.timers[0].date, '2030-01-09'); assert.equal(saves(phone).length, 1);
    const taps = phone.calls.filter(call => call[0] === 'tap' && call[1] === 'timerEditor');
    assert.ok(taps.findIndex(call => call[3] === 965) < taps.findIndex(call => call[3] === 1170)); finished(c, phone);
});

test('unsupported Single combinations are blocked before the first value input', async () => {
    for (const scenario of [
        { initial: {}, target: { repeat: false, days: ['mon', 'tue'] } },
        { initial: { repeat: false, days: ['mon'], date: '2030-01-07' }, target: { days: ['tue', 'wed'] } },
    ]) {
        const { c, phone } = writeSetup(); Object.assign(phone.climate[0], scenario.initial);
        await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: scenario.target }),
            'unsupported_departure_combination');
        assert.deepEqual(mutationCalls(phone), []);
    }
});

test('a Single day change follows add/remove and observed automatic Repeat, then explicitly restores Single before Save', async () => {
    const { c, phone } = writeSetup({ saveAutoEnables: true });
    Object.assign(phone.climate[1], { repeat: false, days: ['sat'], date: '2030-01-12', enabled: false });
    const result = await executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '2', targetTimer: { days: ['mon'] } });
    assert.equal(result.timers[1].repeat, false); assert.deepEqual(result.timers[1].days, ['mon']);
    assert.equal(result.timers[1].date, '2030-01-07'); assert.equal(result.timers[1].enabled, false);
    const taps = phone.calls.filter(call => call[0] === 'tap' && call[1] === 'timerEditor');
    assert.deepEqual(taps.filter(call => call[3] === 965).map(call => call[2]), [100, 775]);
    assert.equal(taps.filter(call => call[3] === 1170).length, 1);
    assert.equal(saves(phone).length, 1); finished(c, phone);
});

test('timer Save auto-enabling is reconciled against the original nullable enabled wish with one verified switch', async () => {
    for (const enabled of [undefined, false, true]) {
        const { c, phone } = writeSetup({ saveAutoEnables: true });
        const targetTimer = { time: '20:35', ...(enabled === undefined ? {} : { enabled }) };
        const result = await executeDepartures(c, 'applyDepartureLocationTimer', { location: ALPHA, timerId: '2', targetTimer });
        assert.equal(result.timers[1].enabled, enabled === true);
        assert.equal(result.timers[1].time, '20:35'); assert.equal(saves(phone).length, 1);
        assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[1] === 'locationOverview' && call[2] === 865).length,
            enabled === true ? 0 : 1);
        finished(c, phone);
    }
});

test('a failed corrective disable after automatic Save activation never claims the original disabled value was preserved', async () => {
    const { c, phone } = writeSetup({ saveAutoEnables: true });
    phone.afterEnabled = timer => { phone.nativeOverride = () => recordTimer({ ...timer, enabled: true }, 'charging', '11'); };
    await rejects(executeDepartures(c, 'applyDepartureLocationTimer', { location: ALPHA, timerId: '2',
        targetTimer: { time: '20:35' } }), 'departure_outcome_unknown');
    assert.equal(saves(phone).length, 1);
    assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[1] === 'locationOverview' && call[2] === 865).length, 1);
});

test('single time-only edits preserve the app calendar date and timezone without host date calculation', async () => {
    const { c, phone } = writeSetup();
    Object.assign(phone.climate[1], { repeat: false, date: '2024-02-29', days: ['thu'], isLocalVehicleTime: true, vehicleOffset: '-03:30' });
    const result = await executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '2', targetTimer: { time: '08:30' } });
    assert.equal(result.timers[1].date, '2024-02-29'); assert.equal(result.timers[1].vehicleOffset, '-03:30');
    assert.equal(result.timers[1].isLocalVehicleTime, true); finished(c, phone);
});

test('dry-run timer preflight returns a complete observation without Save, toggles, actions or applying preferences', async () => {
    const { c, phone } = writeSetup({}, { allowWrites: false });
    const before = clone(phone.climate);
    const result = await executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30', enabled: false }, dryRun: true });
    assert.equal(result.dryRun, true); assert.equal(result.changed, false); assert.equal(result.wouldSetTimer.time, '08:30');
    assert.deepEqual(phone.climate, before); assert.deepEqual(mutationCalls(phone), []); finished(c, phone);
});

test('already satisfied wishes complete as no-op observations without any settings input', async () => {
    const { c, phone } = writeSetup();
    const result = await executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '06:45', enabled: true, repeat: true, days: ['mon'] } });
    assert.equal(result.changed, false); assert.deepEqual(mutationCalls(phone), []); finished(c, phone);
});

test('accessibility rejection is definite only before an attempted action; accepted-null and transport failure are never retried', async () => {
    for (const options of [
        { actionResult: { actionAttempted: false, actionAccepted: null }, code: 'departure_setting_not_confirmed' },
        { actionResult: { actionAttempted: true, actionAccepted: null }, code: 'departure_outcome_unknown' },
        { actionResult: { actionAttempted: true, actionAccepted: false }, code: 'departure_outcome_unknown' },
        { actionThrow: true, code: 'departure_outcome_unknown' },
    ]) {
        const { c, phone } = writeSetup(options);
        await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30' } }), options.code);
        assert.equal(phone.calls.filter(call => call[0] === 'action').length, 1); assert.equal(saves(phone).length, 0);
    }
});

test('an unconfirmed wheel or Save leaves the draft untouched by cleanup and never repeats its action', async () => {
    const wheel = writeSetup();
    wheel.phone.afterAction = () => { wheel.phone.editorDraft.time = '06:45'; };
    await rejects(executeDepartures(wheel.c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30' } }), 'departure_outcome_unknown');
    assert.equal(wheel.phone.calls.filter(call => call[0] === 'action').length, 1); assert.equal(saves(wheel.phone).length, 0);
    assert.equal(wheel.phone.page, 'timerEditor');
    const save = writeSetup({ ignoreSave: true });
    await rejects(executeDepartures(save.c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30' } }), 'departure_outcome_unknown');
    assert.equal(saves(save.phone).length, 1); assert.equal(save.phone.page, 'timerEditor');
});

test('a fresh version or native identity change before the first action prevents input', async () => {
    const version = writeSetup();
    let editorVersions = 0;
    version.phone.beforeVersion = () => { if (version.phone.page === 'timerEditor' && ++editorVersions === 1) version.phone.versionValue = 'changed'; };
    await rejects(executeDepartures(version.c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30' } }), 'version_not_approved');
    assert.deepEqual(mutationCalls(version.phone), []);
    const native = writeSetup(); let calls = 0;
    native.phone.beforeNative = () => { if (native.phone.page === 'timerEditor' && ++calls === 2) native.phone.editorInitial.enabled = false; };
    await rejects(executeDepartures(native.c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30' } }), 'departure_changed');
    assert.deepEqual(mutationCalls(native.phone), []);
});

test('hard cancellation after a possible action prevents Save and every later input', async () => {
    const { c, phone } = writeSetup(); phone.afterAction = () => c.cancel();
    await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30' } }), 'departure_outcome_unknown');
    assert.equal(phone.calls.filter(call => call[0] === 'action').length, 1); assert.equal(saves(phone).length, 0);
    assert.equal(c.busy, false); assert.equal(phone.deadline, null);
});

test('gear toggles and an anonymous name input save once and rebind a confirmed rename by native ID', async () => {
    const { c, phone } = writeSetup({ splitGear: true });
    const result = await executeDepartures(c, 'applyDepartureLocationSettings', { location: ALPHA,
        targetSettings: { name: 'Synthetic renamed location', reducedAcCurrent: true, autoUnlockAc: false } });
    assert.equal(result.changed, true); assert.equal(result.location.nativeId, '11');
    assert.equal(result.location.name, 'Synthetic renamed location'); assert.equal(result.renamedFrom, ALPHA.name);
    assert.equal(result.settings.reducedAcCurrent, true); assert.equal(result.settings.autoUnlockAc, false);
    assert.equal(result.settings.directSoc, null); assert.equal(result.settings.socLimit, null);
    const action = phone.calls.find(call => call[0] === 'action')[1];
    assert.equal(action.action, 'setText'); assert.deepEqual(action.target, { class: 'android.widget.EditText', bounds: [50, 280, 950, 400] });
    assert.equal(saves(phone).length, 1); finished(c, phone);
});

test('non-scrollable location settings reject setting and preferred-window writes before mutation', async () => {
    for (const [action, target] of [
        ['applyDepartureLocationSettings', { targetSettings: { name: 'Synthetic renamed location', reducedAcCurrent: true } }],
        ['applyDeparturePreferredTimes', { targetPreferredTimes: ['1', '2', '3', '4'].map(id => ({ id, enabled: id === '2' ? true : null })) }],
    ]) {
        const { c, phone } = writeSetup({ nonScrollableGear: true });
        await rejects(executeDepartures(c, action, { location: ALPHA, ...target }), 'target_unavailable');
        assert.deepEqual(mutationCalls(phone), []);
        assert.equal(saves(phone).length, 0);
    }
});

test('a conflicting location name is rejected before any value input and existing location drafts are preserved', async () => {
    const collision = writeSetup();
    await rejects(executeDepartures(collision.c, 'applyDepartureLocationSettings', { location: ALPHA,
        targetSettings: { name: 'Synthetic place Beta' } }), 'departure_location_mismatch');
    assert.deepEqual(mutationCalls(collision.phone), []);
    const dirty = writeSetup({ page: 'locationSettings', dirtyGear: true });
    await rejects(executeDepartures(dirty.c, 'applyDepartureLocationSettings', { location: ALPHA,
        targetSettings: { reducedAcCurrent: true } }), 'unsaved_settings');
    assert.equal(dirty.phone.calls.some(call => call[0] === 'tap'), false);
});

test('preferred window writes change only requested enabled flags, save once and reopen all immutable times', async () => {
    const { c, phone } = writeSetup({ splitGear: true });
    const target = ['4', '2', '1', '3'].map(id => ({ id, enabled: id === '2' ? true : id === '3' ? false : null }));
    const beforeSlots = ['20:15', '06:20', '11:10', '16:05'];
    const result = await executeDepartures(c, 'applyDeparturePreferredTimes', { location: ALPHA, targetPreferredTimes: target });
    assert.deepEqual(result.preferredTimes.windows.map(row => row.enabled), [true, true, false, false]);
    assert.deepEqual(result.preferredTimes.windows.map(row => row.start), beforeSlots);
    assert.ok(result.preferredTimes.windows.every(row => row.editable === false));
    assert.equal(result.changed, true); assert.equal(saves(phone).length, 1);
    assert.equal(phone.calls.some(call => call[0] === 'action'), false); finished(c, phone);
});

test('preferred Apply seeks its own navigation even when the preceding gear toggles are already visible', async () => {
    const { c, phone } = writeSetup({ preferredLower: true });
    const result = await executeDepartures(c, 'applyDeparturePreferredTimes', { location: ALPHA,
        targetPreferredTimes: ['1', '2', '3', '4'].map(id => ({ id, enabled: id === '2' ? true : null })) });
    assert.equal(result.preferredTimes.windows[1].enabled, true);
    assert.ok(phone.calls.some(call => call[0] === 'swipe' && call[1] === 'locationSettings'));
    assert.equal(saves(phone).length, 1); finished(c, phone);
});

test('dry-run gear and preferred requests retain every observed setting and never Save or toggle', async () => {
    for (const [action, options] of [
        ['applyDepartureLocationSettings', { targetSettings: { name: 'Synthetic dry-run name', reducedAcCurrent: true } }],
        ['applyDeparturePreferredTimes', { targetPreferredTimes: ['1', '2', '3', '4'].map(id => ({ id, enabled: false })) }],
    ]) {
        const { c, phone } = writeSetup({}, { allowWrites: false });
        const result = await executeDepartures(c, action, { location: ALPHA, ...options, dryRun: true });
        assert.equal(result.dryRun, true); assert.equal(result.changed, false); assert.deepEqual(mutationCalls(phone), []);
        assert.equal(result.location.name, ALPHA.name); assert.equal(result.settings.reducedAcCurrent, false); finished(c, phone);
    }
});

test('caller wishes are snapshotted before the first await and a competing write never changes the running flags', async () => {
    const gate = deferred(), { c, phone } = writeSetup({ connectGate: gate.promise });
    const options = { timerId: '1', targetTimer: { time: '08:30', days: ['mon'] } };
    const active = executeDepartures(c, 'applyDepartureClimateTimer', options);
    options.targetTimer.time = '09:00'; options.targetTimer.days.push('tue');
    assert.equal(c.readOnlyExecution, false); assert.equal(c.requestReadHandoff(), false);
    await rejects(executeDepartures(c, 'applyDepartureClimateTimer', options), 'busy');
    assert.equal(c.busy, true); assert.equal(c.readOnlyExecution, false);
    gate.resolve(); const result = await active;
    assert.equal(result.timers[0].time, '08:30'); assert.deepEqual(result.timers[0].days, ['mon']); finished(c, phone);
});

test('a timer dry-run handoff closes the owned editor before yielding without any value action', async () => {
    const { c, phone } = writeSetup({}, { allowWrites: false });
    phone.afterTap = action => { if (action.startsWith('timer:')) assert.equal(c.requestReadHandoff(), true); };
    await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30' }, dryRun: true }), 'cancelled');
    assert.notEqual(phone.page, 'timerEditor'); assert.deepEqual(mutationCalls(phone), []);
    assert.equal(c.readHandoffProtected, false); assert.equal(c.busy, false);
});

test('a native change after Save never reports success or repeats Save even when the edited display looks right', async () => {
    for (const change of [
        timer => { timer.days = ['fri']; }, timer => { timer.time = '10:00'; },
        timer => { timer.vehicleOffset = '+02:00'; }, timer => { timer.isLocalVehicleTime = true; },
    ]) {
        const { c, phone } = writeSetup(); phone.afterSaveTimer = () => change(phone.climate[0]);
        await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30' } }), 'departure_outcome_unknown');
        assert.equal(saves(phone).length, 1);
        assert.equal(phone.calls.filter(call => call[0] === 'action').length, 2);
    }
});

test('a repeat change induced by an unobservable day gesture is not saved or counter-toggled blindly', async () => {
    const { c, phone } = writeSetup();
    phone.afterTap = action => { if (action === 'day:tue') phone.editorDraft.repeat = false; };
    await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { days: ['mon', 'tue'] } }), 'departure_outcome_unknown');
    assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[3] === 965).length, 1);
    assert.equal(saves(phone).length, 0);
});

test('a confirmed wheel draft followed by a version rejection keeps that failure and does not Save', async () => {
    const { c, phone } = writeSetup();
    phone.afterAction = () => { phone.versionValue = 'changed'; };
    await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30' } }), 'version_not_approved');
    assert.equal(phone.calls.filter(call => call[0] === 'action').length, 1); assert.equal(saves(phone).length, 0);
});

test('an unrelated gear preference changed just before Save prevents saving the combined form', async () => {
    const { c, phone } = writeSetup();
    phone.beforeVersion = () => { if (phone.page === 'locationSettings' && phone.dirtyGear) phone.gearUnlock = false; };
    await rejects(executeDepartures(c, 'applyDepartureLocationSettings', { location: ALPHA, targetSettings: { reducedAcCurrent: true } }), 'departure_changed');
    assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[2] === 865).length, 1);
    assert.equal(saves(phone).length, 0); assert.equal(phone.page, 'locationSettings');
    const hidden = writeSetup({ splitGear: true });
    hidden.phone.afterAction = () => { hidden.phone.gearUnlock = false; };
    await rejects(executeDepartures(hidden.c, 'applyDepartureLocationSettings', { location: ALPHA,
        targetSettings: { name: 'Synthetic renamed place' } }), 'departure_changed');
    assert.equal(saves(hidden.phone).length, 0);
});

test('a saved gear value or location ID that fails reopen remains unknown without another Save or rebinding', async () => {
    for (const change of [phone => { phone.gearReduced = false; }, phone => { phone.wrongNativeId = '88'; }]) {
        const { c, phone } = writeSetup(); phone.afterSaveGear = () => change(phone);
        await rejects(executeDepartures(c, 'applyDepartureLocationSettings', { location: ALPHA, targetSettings: { reducedAcCurrent: true } }), 'departure_outcome_unknown');
        assert.equal(saves(phone).length, 1);
    }
});

test('an unexpected second preferred toggle during an owned draft prevents Save rather than applying the remaining wishes', async () => {
    const { c, phone } = writeSetup();
    phone.afterTap = action => { if (action === 'preferredEnabled:1') phone.preferredEnabled[0] = false; };
    await rejects(executeDepartures(c, 'applyDeparturePreferredTimes', { location: ALPHA,
        targetPreferredTimes: ['1', '2', '3', '4'].map(id => ({ id, enabled: id === '2' ? true : id === '3' ? false : null })) }), 'departure_outcome_unknown');
    assert.equal(saves(phone).length, 0);
    assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[1] === 'preferredTimes' && call[2] === 865).length, 1);
});

test('a request already open in a clean foreign editor blocks both dry-run and real writes without input', async () => {
    for (const dryRun of [true, false]) {
        const { c, phone } = writeSetup({ page: 'timerEditor', editorKind: 'climate', editorId: '1' });
        phone.editorInitial = clone(phone.savedTimer()); phone.editorDraft = clone(phone.editorInitial);
        await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30' }, dryRun }), 'unsaved_settings');
        assert.equal(phone.calls.some(call => call[0] === 'tap' || call[0] === 'action'), false);
    }
});

test('a changed full timer row after closing the verified editor prevents the enabled gesture', async () => {
    const { c, phone } = writeSetup(); let changed = false;
    phone.afterTap = action => {
        if (action === 'timerBack' && !changed) { changed = true; phone.climate[1].days = ['fri']; }
    };
    await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '2', targetTimer: { enabled: true } }), 'departure_changed');
    assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[2] === 865).length, 0);
    assert.equal(phone.climate[1].enabled, false); assert.equal(saves(phone).length, 0);
});

test('Save and a corrective enabled request are separated by twenty-second observation periods in cancellable slices', async () => {
    const { c, phone, clock } = writeSetup({ saveAutoEnables: true });
    let savedAt, toggledAt; const slices = [];
    phone.afterTap = action => { if (action === 'saveTimer') savedAt = clock.now; if (action.startsWith('enabled:')) toggledAt = clock.now; };
    phone.afterSleep = milliseconds => slices.push(milliseconds);
    const result = await executeDepartures(c, 'applyDepartureLocationTimer', { location: ALPHA, timerId: '2', targetTimer: { time: '20:35' } });
    assert.ok(toggledAt - savedAt >= 20000); assert.ok(clock.now - toggledAt >= 20000);
    assert.ok(slices.length >= 80 && slices.every(milliseconds => milliseconds <= 500));
    assert.equal(result.timers[1].enabled, false); finished(c, phone);
});

test('hard cancellation or job expiry inside Save settling prevents the following corrective switch', async () => {
    for (const expire of [false, true]) {
        const { c, phone } = writeSetup({ saveAutoEnables: true }, { commandTimeoutSeconds: expire ? 1 : 300 });
        if (!expire) phone.afterSleep = () => c.cancel();
        await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '2', targetTimer: { time: '20:35' } }), 'departure_outcome_unknown');
        assert.equal(saves(phone).length, 1);
        assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[2] === 865).length, 0);
        assert.equal(c.busy, false); assert.equal(phone.deadline, null);
    }
});

test('a delayed backend reversion during Save settling is caught before another persistence request', async () => {
    const { c, phone, clock } = writeSetup({ saveAutoEnables: true }); let savedAt, reverted = false;
    phone.afterSaveTimer = () => { savedAt = clock.now; };
    phone.afterSleep = () => {
        if (savedAt !== undefined && clock.now - savedAt >= 10000 && !reverted) {
            reverted = true; phone.climate[1].time = '19:20';
        }
    };
    await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '2', targetTimer: { time: '20:35' } }), 'departure_outcome_unknown');
    assert.equal(saves(phone).length, 1); assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[2] === 865).length, 0);
});

test('the complete final timer observation must still satisfy the requested values after an earlier valid reopen', async () => {
    const { c, phone } = writeSetup(); let closes = 0;
    phone.afterTap = action => { if (action === 'timerBack' && ++closes === 2) phone.climate[0].time = '06:45'; };
    await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '1', targetTimer: { time: '08:30' } }), 'departure_outcome_unknown');
    assert.equal(saves(phone).length, 1);
});

test('the complete final gear and preferred observations cannot turn reverted wishes into a changed success', async () => {
    for (const preferred of [false, true]) {
        const { c, phone } = writeSetup(); let closes = 0;
        phone.afterTap = action => {
            if (action === 'locationBack' && ++closes === 3) {
                if (preferred) phone.preferredEnabled[1] = false; else phone.gearReduced = false;
            }
        };
        const action = preferred ? 'applyDeparturePreferredTimes' : 'applyDepartureLocationSettings';
        const options = preferred ? { targetPreferredTimes: ['1', '2', '3', '4'].map(id => ({ id, enabled: id === '2' ? true : null })) }
            : { targetSettings: { reducedAcCurrent: true } };
        await rejects(executeDepartures(c, action, { location: ALPHA, ...options }), 'departure_outcome_unknown');
        assert.equal(saves(phone).length, 1);
    }
});

test('directly persisted preferred switches settle and reopen separately without any Save or overlapping requests', async () => {
    const { c, phone, clock } = writeSetup({ preferredDirect: true }); const requests = [];
    phone.afterTap = action => { if (action.startsWith('preferredEnabled:')) requests.push(clock.now); };
    const result = await executeDepartures(c, 'applyDeparturePreferredTimes', { location: ALPHA,
        targetPreferredTimes: ['1', '2', '3', '4'].map(id => ({ id, enabled: id === '2' ? true : id === '3' ? false : null })) });
    assert.deepEqual(result.preferredTimes.windows.map(row => row.enabled), [true, true, false, false]);
    assert.equal(requests.length, 2); assert.ok(requests[1] - requests[0] >= 20000); assert.ok(clock.now - requests[1] >= 20000);
    assert.equal(saves(phone).length, 0); finished(c, phone);
});

test('a rejected direct preferred switch stops after its quiet period and cannot repeat or advance to another switch', async () => {
    const { c, phone } = writeSetup({ preferredDirect: true }); let reverted = false;
    phone.afterSleep = () => { if (!reverted) { reverted = true; phone.preferredEnabled[1] = false; } };
    await rejects(executeDepartures(c, 'applyDeparturePreferredTimes', { location: ALPHA,
        targetPreferredTimes: ['1', '2', '3', '4'].map(id => ({ id, enabled: id === '2' ? true : id === '3' ? false : null })) }), 'departure_outcome_unknown');
    assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[1] === 'preferredTimes' && call[2] === 865).length, 1);
    assert.equal(saves(phone).length, 0);
});

test('a timer no-op must still meet each explicit wish in the final observation after external changes', async () => {
    for (const [targetTimer, change] of [
        [{ enabled: false }, timer => { timer.enabled = true; }],
        [{ time: '19:20' }, timer => { timer.time = '20:35'; }],
        [{ days: ['tue'] }, timer => { timer.days = ['fri']; }],
        [{ repeat: true }, timer => { timer.repeat = false; timer.date = '2030-01-08'; }],
    ]) {
        const { c, phone } = writeSetup(); let changed = false;
        phone.afterTap = action => {
            if (action === 'timerBack' && !changed) { changed = true; change(phone.climate[1]); }
        };
        await rejects(executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '2', targetTimer }), 'departure_setting_not_confirmed');
        assert.deepEqual(mutationCalls(phone), []); assert.equal(phone.page, 'home');
    }
});

test('gear and preferred no-ops reject a final value that no longer meets the explicit wish without attempting repair', async () => {
    for (const preferred of [false, true]) {
        const { c, phone } = writeSetup(); let changed = false;
        phone.afterTap = action => {
            if (action === 'locationBack' && !changed) {
                changed = true;
                if (preferred) phone.preferredEnabled = [false, false, true, false]; else phone.gearReduced = true;
            }
        };
        const action = preferred ? 'applyDeparturePreferredTimes' : 'applyDepartureLocationSettings';
        const options = preferred ? { targetPreferredTimes: ['1', '2', '3', '4'].map(id => ({ id, enabled: id === '1' ? true : null })) }
            : { targetSettings: { reducedAcCurrent: false } };
        await rejects(executeDepartures(c, action, { location: ALPHA, ...options }), 'departure_setting_not_confirmed');
        assert.deepEqual(mutationCalls(phone), []); assert.equal(phone.page, 'home');
    }
});

test('dry-run no-op planning may report an unmet wish after final observation changes and never repairs it', async () => {
    for (const domain of ['timer', 'gear', 'preferred']) {
        const { c, phone } = writeSetup({}, { allowWrites: false }); let changed = false;
        phone.afterTap = action => {
            if ((domain === 'timer' ? action === 'timerBack' : action === 'locationBack') && !changed) {
                changed = true;
                if (domain === 'timer') phone.climate[1].enabled = true;
                else if (domain === 'gear') phone.gearReduced = true;
                else phone.preferredEnabled = [false, false, true, false];
            }
        };
        const [action, options] = domain === 'timer'
            ? ['applyDepartureClimateTimer', { timerId: '2', targetTimer: { enabled: false } }]
            : domain === 'gear' ? ['applyDepartureLocationSettings', { location: ALPHA, targetSettings: { reducedAcCurrent: false } }]
                : ['applyDeparturePreferredTimes', { location: ALPHA,
                    targetPreferredTimes: ['1', '2', '3', '4'].map(id => ({ id, enabled: id === '1' ? true : null })) }];
        const result = await executeDepartures(c, action, { ...options, dryRun: true });
        assert.equal(result.dryRun, true); assert.equal(result.changed, false);
        assert.deepEqual(mutationCalls(phone), []); finished(c, phone);
    }
});

test('a no-op only requires the explicitly selected fields and preserves independently changed observations', async () => {
    const { c, phone } = writeSetup(); let changed = false;
    phone.afterTap = action => {
        if (action === 'timerBack' && !changed) { changed = true; phone.climate[1].enabled = true; }
    };
    const result = await executeDepartures(c, 'applyDepartureClimateTimer', { timerId: '2', targetTimer: { time: '19:20' } });
    assert.equal(result.changed, false); assert.equal(result.timers[1].time, '19:20'); assert.equal(result.timers[1].enabled, true);
    assert.deepEqual(mutationCalls(phone), []); finished(c, phone);
});
