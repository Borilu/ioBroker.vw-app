'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../lib/controller');
const { BridgeError } = require('../lib/errors');
const { completeDemoClimate, modeScreen, settingsScreen, zonesScreen, node, hierarchy, POINTS } = require('./support/settings-fixtures.cjs');

const VEHICLE = 'Ihr Fahrzeug: Testwagen. ';
class AppPhone {
    constructor(options = {}) {
        Object.assign(this, { page: 'overview', state: 'off', mode: 'climate', temperature: 22,
            climateOnUnlock: true, autoWindowHeating: true, frontLeft: true, frontRight: true,
            calls: [], mutations: [], ctas: 0, modeLag: 0, deadline: null }, options);
        this.savedSettings = Object.fromEntries(['climateOnUnlock', 'autoWindowHeating', 'frontLeft', 'frontRight'].map(key => [key, this[key]]));
        this.settingsDirty = options.settingsDirty || false;
        this.saves = 0;
    }
    async connect() { this.calls.push('connect'); }
    async launch() { this.calls.push('launch'); }
    async version() { if (this.beforeVersion) this.beforeVersion(); return this.versionOverride || '4.8.1'; }
    async back() {
        this.calls.push('back');
        if (this.page === 'zones') { Object.assign(this, this.zoneEntry || {}); this.page = 'settings'; }
        else if (this.page === 'settings') { if (this.settingsDirty) Object.assign(this, this.savedSettings); this.settingsDirty = false; this.page = 'climate'; }
        else if (this.page === 'mode') this.page = 'climate';
        else if (this.page === 'climate') this.page = 'overview';
        else throw new Error('Back outside a known fake page');
    }
    async dump() {
        if (this.beforeDump) this.beforeDump();
        if (this.pendingSettings !== undefined && this.pendingSettings-- <= 0) {
            delete this.pendingSettings; this.page = 'settings';
        }
        if (this.pendingMode && this.modeLag-- <= 0) {
            this.mode = this.pendingMode; this.pendingMode = null; this.page = 'climate';
        }
        if (this.page === 'overview') return hierarchy([
            node('', { 'content-desc': VEHICLE + 'Gerade synchronisiert' }),
            node('climateTile', { bounds: '[10,100][110,160]' }, this.state === 'on' ? [
                node('', { 'content-desc': 'Vorklimatisierung. An. Details öffnen', bounds: '[10,100][110,160]' }),
            ] : []),
        ]);
        if (this.page === 'climate') return completeDemoClimate(this.state, this.mode, this.temperature);
        if (this.page === 'mode') return modeScreen(this.mode);
        if (this.page === 'settings') return settingsScreen(this.climateOnUnlock, this.autoWindowHeating,
            this.frontLeft ? (this.frontRight ? '2 Zonen' : 'Vorne links') : (this.frontRight ? 'Vorne rechts' : '0 Zonen'), this.settingsDirty);
        if (this.page === 'zones') return zonesScreen(this.frontLeft, this.frontRight);
        throw new Error('Unexpected fake app page');
    }
    async _change(key, value) {
        this[key] = value;
        if (['climateOnUnlock', 'autoWindowHeating'].includes(key)) this.settingsDirty = true;
        this.mutations.push([key, value]);
        if (this.afterChange) await this.afterChange(key, value);
    }
    async tap(x, y) {
        this.calls.push(['tap', this.page, x, y]);
        if (this.page === 'overview' && x === 60 && y === 130) { this.page = 'climate'; return; }
        if (this.page === 'settings' && x === 890 && y === 50) {
            this.saves++;
            if (this.failSave) throw new Error('Save response lost');
            if (this.ignoreSave) return;
            this.savedSettings = Object.fromEntries(['climateOnUnlock', 'autoWindowHeating', 'frontLeft', 'frontRight'].map(key => [key, this[key]]));
            this.settingsDirty = false;
            if (this.resetModeOnSave) this.mode = 'climate';
            this.page = 'climate';
            return;
        }
        if (x >= 20 && x <= 100 && y >= 10 && y <= 90) {
            if (this.page === 'zones') { this.settingsDirty ||= this.frontLeft !== this.zoneEntry.frontLeft || this.frontRight !== this.zoneEntry.frontRight; this.page = 'settings'; }
            else if (['settings', 'mode'].includes(this.page)) this.page = 'climate';
            else throw new Error('Unexpected fake Back tap');
            return;
        }
        if (this.page === 'climate') {
            if (y === 550) { this.page = 'mode'; return; }
            if (y === 700) {
                if (this.settingsDelayReads) { this.pendingSettings = this.settingsDelayReads; this.settingsDelayReads = 0; }
                else this.page = 'settings';
                return;
            }
            if (y === 240 && [100, 900].includes(x)) { await this._change('temperature', this.temperature + (x === 900 ? 0.5 : -0.5)); return; }
            if (y === 1200) { this.ctas++; await this._change('state', this.state === 'off' ? 'on' : 'off'); return; }
        }
        const modeTarget = ['climate', 'windowHeating'].find(key => POINTS[key].x === x && POINTS[key].y === y);
        if (this.page === 'mode' && modeTarget) {
            const mode = modeTarget;
            if (this.modeLag) this.pendingMode = mode;
            else { await this._change('mode', mode); this.page = 'climate'; }
            return;
        }
        if (this.page === 'settings') {
            if (x === 900 && [210, 510].includes(y)) {
                const key = y === 210 ? 'climateOnUnlock' : 'autoWindowHeating';
                await this._change(key, !this[key]); return;
            }
            if (y >= 750 && y <= 1000) { this.zoneEntry = { frontLeft: this.frontLeft, frontRight: this.frontRight }; this.page = 'zones'; return; }
        }
        if (this.page === 'zones' && x === 900 && [510, 810].includes(y)) {
            const key = y === 510 ? 'frontLeft' : 'frontRight';
            await this._change(key, !this[key]); return;
        }
        throw new Error('Unexpected fake UI tap: ' + JSON.stringify([this.page, x, y]));
    }
}
function setup(options = {}, config = {}) {
    const phone = new AppPhone(options);
    const clock = { now: 1700000000000 };
    const store = { reservations: 0, async reserveCommand() { this.reservations++; } };
    const controller = new Controller({ phone, store, config: {
        approvedAppVersion: '4.8.1', vehicleMarker: { contentDescPrefix: VEHICLE }, modeTitles: ['Klimatisierung'],
        allowWrites: true, commandTimeoutSeconds: 300, outcomeTimeoutSeconds: 120, cooldownSeconds: 60, ...config,
    }, now: () => clock.now, sleep: async ms => { clock.now += ms; } });
    return { controller, phone, store };
}
async function rejectsCode(promise, code) {
    await assert.rejects(promise, error => error instanceof BridgeError && error.code === code);
}

test('status visits settings and both zones, then returns verified observations without mutations', async () => {
    const { controller, phone, store } = setup({ climateOnUnlock: false, frontLeft: false });
    const result = await controller.execute('status');
    assert.deepEqual(result.settings, { mode: 'climate', climateOnUnlock: false, autoWindowHeating: true, zones: 'frontRight' });
    assert.equal(result.vehicleConfirmed, false);
    assert.equal(result.temperature, 22);
    assert.equal(phone.page, 'climate');
    assert.deepEqual(phone.mutations, []);
    assert.equal(store.reservations, 0);
});

test('all four settings apply with per-control readback and without any Start or Stop', async () => {
    const { controller, phone, store } = setup();
    const result = await controller.execute('applySettings', { targetSettings: {
        mode: 'windowHeating', climateOnUnlock: false, autoWindowHeating: false, zones: 'frontLeft',
    } });
    assert.deepEqual(result.settings, { mode: 'windowHeating', climateOnUnlock: false, autoWindowHeating: false, zones: 'frontLeft' });
    assert.equal(result.settingsChanged, true);
    assert.equal(result.appState, 'off');
    assert.equal(phone.temperature, 22);
    assert.equal(phone.ctas, 0); assert.equal(store.reservations, 0);
    assert.equal(phone.saves, 1);
    assert.deepEqual(phone.savedSettings, { climateOnUnlock: false, autoWindowHeating: false, frontLeft: true, frontRight: false });
    assert.deepEqual(phone.mutations, [['climateOnUnlock', false], ['autoWindowHeating', false], ['frontRight', false], ['mode', 'windowHeating']]);
});

test('left-to-right and right-to-left transitions enable the destination before disabling the other zone', async () => {
    for (const [from, to] of [['frontLeft', 'frontRight'], ['frontRight', 'frontLeft']]) {
        const { controller, phone } = setup({ frontLeft: from === 'frontLeft', frontRight: from === 'frontRight' });
        await controller.execute('applySettings', { targetSettings: { zones: to } });
        assert.deepEqual(phone.mutations, [[to, true], [from, false]]);
        assert.equal(phone.ctas, 0);
    }
});

test('both zones can be selected and an observed none can be repaired without an unsupported target', async () => {
    for (const [left, right, wanted] of [[true, false, 'both'], [false, true, 'both'], [false, false, 'frontLeft']]) {
        const { controller, phone } = setup({ frontLeft: left, frontRight: right });
        const result = await controller.execute('applySettings', { targetSettings: { zones: wanted } });
        assert.equal(result.settings.zones, wanted);
        assert.equal(phone.frontLeft || phone.frontRight, true);
        assert.equal(phone.ctas, 0);
    }
});

test('an already satisfied selection does not toggle controls or reserve a vehicle command', async () => {
    const { controller, phone, store } = setup();
    const result = await controller.execute('applySettings', { targetSettings: {
        mode: 'climate', climateOnUnlock: true, autoWindowHeating: true, zones: 'both',
    } });
    assert.equal(result.settingsChanged, false);
    assert.deepEqual(phone.mutations, []); assert.equal(store.reservations, 0);
});

test('write permission and explicit selections are required before settings mutate', async () => {
    const { controller, phone } = setup({}, { allowWrites: false });
    await rejectsCode(controller.execute('applySettings', { targetSettings: { climateOnUnlock: false } }), 'writes_disabled');
    assert.deepEqual(phone.mutations, []);
    const empty = setup();
    await rejectsCode(empty.controller.execute('applySettings'), 'settings_required');
    assert.deepEqual(empty.phone.calls, []);
});

test('mode changes are refused while running, before unrelated setting changes or an implicit Stop', async () => {
    const { controller, phone } = setup({ state: 'on' });
    await rejectsCode(controller.execute('applySettings', { targetSettings: { mode: 'windowHeating', climateOnUnlock: false } }), 'mode_change_requires_stop');
    assert.deepEqual(phone.mutations, []); assert.equal(phone.ctas, 0);
});

test('legacy Start rejects a selected window-only app before changing other staged settings', async () => {
    const { controller, phone } = setup({ mode: 'windowHeating' });
    await rejectsCode(controller.execute('start', { targetSettings: { climateOnUnlock: false } }), 'unsafe_mode');
    assert.deepEqual(phone.mutations, []); assert.equal(phone.ctas, 0);
});

test('an explicit window-only Start ignores the temperature target and sends one CTA in the verified mode', async () => {
    const { controller, phone, store } = setup();
    const result = await controller.execute('start', { targetTemperature: 24.5, targetSettings: { mode: 'windowHeating' } });
    assert.equal(result.appState, 'on'); assert.equal(result.settings.mode, 'windowHeating');
    assert.equal(phone.temperature, 22); assert.equal(phone.ctas, 1); assert.equal(store.reservations, 1);
    assert.deepEqual(phone.mutations, [['mode', 'windowHeating'], ['state', 'on']]);
});

test('a climate Start applies the settings and temperature before its sole Start CTA', async () => {
    const { controller, phone } = setup({ mode: 'windowHeating' });
    const result = await controller.execute('start', { targetTemperature: 22.5,
        targetSettings: { mode: 'climate', climateOnUnlock: false, zones: 'frontRight' } });
    assert.equal(result.appState, 'on'); assert.equal(result.temperature, 22.5);
    assert.equal(result.settings.climateOnUnlock, false); assert.equal(result.settings.zones, 'frontRight');
    assert.equal(phone.ctas, 1);
    assert.deepEqual(phone.mutations.at(-1), ['state', 'on']);
});

test('a changed staged setting after temperature selection prevents the following Start', async () => {
    const { controller, phone, store } = setup({ climateOnUnlock: false });
    phone.afterChange = key => { if (key === 'temperature') phone.climateOnUnlock = true; };
    await rejectsCode(controller.execute('start', { targetTemperature: 22.5, targetSettings: { climateOnUnlock: false } }), 'settings_not_confirmed');
    assert.equal(phone.ctas, 0); assert.equal(store.reservations, 0);
});

test('a lost response to a settings toggle is unknown and never repeated or followed by Start', async () => {
    const { controller, phone, store } = setup();
    phone.afterChange = key => { if (key === 'climateOnUnlock') throw new Error('Lost transport response'); };
    await rejectsCode(controller.execute('start', { targetSettings: { climateOnUnlock: false } }), 'settings_outcome_unknown');
    assert.deepEqual(phone.mutations, [['climateOnUnlock', false]]);
    assert.equal(phone.ctas, 0); assert.equal(store.reservations, 0);
});

test('an unconfirmed toggle is attempted once and terminates on its bounded wait', async () => {
    const { controller, phone } = setup();
    phone.afterChange = key => { if (key === 'autoWindowHeating') phone.autoWindowHeating = true; };
    await rejectsCode(controller.execute('applySettings', { targetSettings: { autoWindowHeating: false } }), 'settings_outcome_unknown');
    assert.equal(phone.mutations.length, 1); assert.equal(phone.ctas, 0);
});

test('partial setting failure never claims success and does not start the climate operation', async () => {
    const { controller, phone } = setup();
    phone.afterChange = key => { if (key === 'autoWindowHeating') throw new Error('Connection lost'); };
    await rejectsCode(controller.execute('applySettings', { targetSettings: {
        mode: 'windowHeating', climateOnUnlock: false, autoWindowHeating: false, zones: 'frontLeft',
    } }), 'settings_outcome_unknown');
    assert.equal(phone.mode, 'climate'); assert.equal(phone.climateOnUnlock, false);
    assert.equal(phone.frontRight, true); assert.equal(phone.ctas, 0);
});

test('a delayed mode transition is observed without a repeated selection', async () => {
    const { controller, phone } = setup({ modeLag: 2 });
    const result = await controller.execute('applySettings', { targetSettings: { mode: 'windowHeating' } });
    assert.equal(result.settings.mode, 'windowHeating');
    assert.equal(phone.calls.filter(call => Array.isArray(call) && call[1] === 'mode' && call[3] === POINTS.windowHeating.y).length, 1);
});

test('a confirmed setting followed by a version failure retains that failure code', async () => {
    const { controller, phone } = setup();
    phone.afterChange = key => { if (key === 'mode') phone.versionOverride = 'CHANGED'; };
    await rejectsCode(controller.execute('start', { targetSettings: { mode: 'windowHeating' } }), 'version_not_approved');
    assert.equal(phone.mode, 'windowHeating'); assert.equal(phone.ctas, 0);
});

test('dry run of a mode-changing Start plans the requested mode without changing settings or HVAC', async () => {
    const { controller, phone, store } = setup();
    const result = await controller.execute('start', { dryRun: true, targetSettings: { mode: 'windowHeating', climateOnUnlock: false } });
    assert.equal(result.dryRun, true); assert.equal(result.wouldRequest, 'on');
    assert.equal(result.wouldSetSettings.mode, 'windowHeating');
    assert.deepEqual(phone.mutations, []); assert.equal(store.reservations, 0);
});

test('recognized settings pages are navigated back before checking the calibrated vehicle overview', async () => {
    for (const page of ['mode', 'settings']) {
        const { controller, phone } = setup({ page });
        const result = await controller.execute('status');
        assert.equal(result.settings.zones, 'both'); assert.equal(phone.page, 'climate');
        assert.deepEqual(phone.mutations, []);
    }
});

test('a switch already changed during the version check is re-read rather than inverted again', async () => {
    const { controller, phone } = setup();
    phone.beforeVersion = () => { if (phone.page === 'settings') phone.climateOnUnlock = false; };
    const result = await controller.execute('applySettings', { targetSettings: { climateOnUnlock: false } });
    assert.equal(result.settings.climateOnUnlock, false);
    assert.deepEqual(phone.mutations, []); assert.equal(phone.ctas, 0);
});

test('an app page changed during the version check prevents a stale settings tap', async () => {
    const { controller, phone } = setup();
    phone.beforeVersion = () => { if (phone.page === 'settings') phone.page = 'mode'; };
    await rejectsCode(controller.execute('applySettings', { targetSettings: { climateOnUnlock: false } }), 'state_changed');
    assert.deepEqual(phone.mutations, []); assert.equal(phone.ctas, 0);
});

test('a mode changed during its version check is read back without repeating the selection', async () => {
    const { controller, phone } = setup();
    phone.beforeVersion = () => { if (phone.page === 'mode') phone.mode = 'windowHeating'; };
    const result = await controller.execute('applySettings', { targetSettings: { mode: 'windowHeating' } });
    assert.equal(result.settings.mode, 'windowHeating');
    assert.deepEqual(phone.mutations, []); assert.equal(phone.ctas, 0);
});

test('slow settings navigation is bounded but can finish after the previous eight-second window', async () => {
    const { controller, phone } = setup({ settingsDelayReads: 25 });
    const result = await controller.execute('status');
    assert.equal(result.settings.zones, 'both');
    assert.equal(phone.calls.filter(call => Array.isArray(call) && call[1] === 'climate' && call[3] === 700).length, 1);
    assert.deepEqual(phone.mutations, []);
});

test('navigation accepts zones via their header and uses Android Back only for clean settings', async () => {
    const { controller, phone } = setup();
    const result = await controller.execute('status');
    assert.equal(result.settings.zones, 'both');
    assert.equal(phone.calls.filter(call => call === 'back').length, 1);
    assert.equal(phone.calls.filter(call => Array.isArray(call) && call[0] === 'tap' && call[1] === 'zones' && call[3] === 50).length, 1);
});

test('a settings Save is sent once and its durable values survive reopening the page', async () => {
    const { controller, phone } = setup();
    await controller.execute('applySettings', { targetSettings: { climateOnUnlock: false, zones: 'frontLeft' } });
    const result = await controller.execute('status');
    assert.equal(result.settings.climateOnUnlock, false); assert.equal(result.settings.zones, 'frontLeft');
    assert.equal(phone.saves, 1); assert.equal(phone.ctas, 0);
});

test('a lost Save response is unknown and is not repeated or followed by Start', async () => {
    const { controller, phone } = setup({ failSave: true });
    await rejectsCode(controller.execute('start', { targetSettings: { climateOnUnlock: false } }), 'settings_outcome_unknown');
    assert.equal(phone.saves, 1); assert.equal(phone.ctas, 0);
});

test('a Save that never confirms is bounded and never repeated', async () => {
    const { controller, phone } = setup({ ignoreSave: true });
    await rejectsCode(controller.execute('applySettings', { targetSettings: { climateOnUnlock: false } }), 'settings_outcome_unknown');
    assert.equal(phone.saves, 1); assert.equal(phone.ctas, 0);
});

test('preexisting unsaved settings or a zone editor are left for manual review without discarding them', async () => {
    for (const options of [{ page: 'settings', settingsDirty: true }, { page: 'zones' }]) {
        const { controller, phone } = setup(options);
        await rejectsCode(controller.execute('status'), 'unsaved_settings');
        assert.equal(phone.calls.includes('back'), false); assert.equal(phone.saves, 0); assert.deepEqual(phone.mutations, []);
    }
});

test('an explicitly requested mode is restored if saving the global preferences resets the picker', async () => {
    const { controller, phone } = setup({ resetModeOnSave: true });
    const result = await controller.execute('start', { targetSettings: { mode: 'windowHeating', autoWindowHeating: false } });
    assert.equal(result.settings.mode, 'windowHeating'); assert.equal(result.settings.autoWindowHeating, false);
    assert.equal(phone.saves, 1); assert.equal(phone.ctas, 1);
});

test('global settings are saved before the sole final mode selection', async () => {
    const { controller, phone } = setup({ resetModeOnSave: true });
    await controller.execute('applySettings', { targetSettings: { mode: 'windowHeating', autoWindowHeating: false, zones: 'frontLeft' } });
    const save = phone.calls.findIndex(call => Array.isArray(call) && call[1] === 'settings' && call[2] === POINTS.saveSettings.x && call[3] === POINTS.saveSettings.y);
    const mode = phone.calls.findIndex(call => Array.isArray(call) && call[1] === 'mode' && call[3] === POINTS.windowHeating.y);
    assert.ok(save >= 0 && mode > save);
    assert.equal(phone.calls.filter(call => Array.isArray(call) && call[1] === 'mode' && call[3] === POINTS.windowHeating.y).length, 1);
    assert.equal(phone.mode, 'windowHeating'); assert.equal(phone.ctas, 0);
});
