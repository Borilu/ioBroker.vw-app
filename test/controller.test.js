'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Controller } = require('../lib/controller');
const { BridgeError } = require('../lib/errors');
const { PACKAGE } = require('../lib/ui');

const VEHICLE = 'Ihr Fahrzeug: ID.7 GTX Tourer. ';

function escape(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function node(id = '', attrs = {}, children = []) {
    const values = { package: PACKAGE, enabled: 'true', bounds: '[10,20][110,80]', clickable: 'false', ...(id ? { 'resource-id': id } : {}), ...attrs };
    return '<node ' + Object.entries(values).map(([key, value]) => key + '="' + escape(value) + '"').join(' ') + '>' + children.join('') + '</node>';
}

function hierarchy(children = []) { return '<hierarchy>' + children.join('') + '</hierarchy>'; }
function overview(description = VEHICLE + 'Gerade synchronisiert', extras = []) {
    return hierarchy([node('', { 'content-desc': description }), node('climateTile', { bounds: '[10,100][110,160]' }), ...extras]);
}
function climate(state = 'off', mode = 'Klimatisierung', ctaAttrs = {}) {
    return hierarchy([node('clima_compose_view', { bounds: '[0,0][500,900]' }, [
        node(state === 'off' ? 'cta_start' : 'cta_stop', { bounds: '[10,300][110,360]', clickable: 'true', ...ctaAttrs }),
        node('clima_air_conditioning_pick', {}, [node('title', { text: mode })]),
    ])]);
}
function temperatureClimate(value = 22, state = 'off', mode = 'Klimatisierung') {
    const option = (number, x1, x2) => node('', { class: 'android.view.View', clickable: 'true', bounds: `[${x1},30][${x2},190]` }, [
        node('', { class: 'android.widget.TextView', text: String(number), bounds: `[${x1},30][${x2 - 30},190]` }),
        node('', { class: 'android.widget.TextView', text: '°', bounds: `[${x2 - 30},30][${x2},150]` }),
    ]);
    return hierarchy([
        node('clima_compose_view', { class: 'androidx.compose.ui.platform.ComposeView', bounds: '[0,10][1000,210]' }, [
            node('', { class: 'android.view.View', scrollable: 'true', bounds: '[0,10][1000,210]' }, [
                option(value - 0.5, 0, 200), option(value, 400, 600), option(value + 0.5, 800, 1000),
            ]),
        ]),
        node(state === 'off' ? 'cta_start' : 'cta_stop', { clickable: 'true', bounds: '[10,300][110,360]' }),
        node('clima_air_conditioning_pick', {}, [node('title', { text: mode })]),
    ]);
}
const OVERVIEW = overview();
const RUNNING_OVERVIEW = hierarchy([
    node('', { 'content-desc': VEHICLE + 'Gerade synchronisiert' }),
    node('climateTile', { bounds: '[10,100][110,160]' }, [
        node('', { 'content-desc': 'Vorklimatisierung. An. Details öffnen', bounds: '[10,100][110,160]' }),
    ]),
]);
const PENDING_OVERVIEW = RUNNING_OVERVIEW.replace('Vorklimatisierung. An.', 'Vorklimatisierung. Aus.');
const OFF = climate('off');
const ON = climate('on');

class FakePhone {
    constructor(screens, log) {
        this.screens = [...screens];
        this.log = log;
        this.calls = [];
        this.versions = ['4.8.1'];
        this.hooks = {};
        this.deadline = null;
        this.dumpCount = 0;
    }
    async _call(name, ...args) {
        this.calls.push([name, ...args]);
        this.log.push(name === 'tap' ? 'tap:' + args.join(',') : name);
        if (this.hooks[name]) await this.hooks[name](...args);
    }
    async connect() { await this._call('connect'); }
    async version() {
        await this._call('version');
        return this.versions.length > 1 ? this.versions.shift() : this.versions[0];
    }
    async launch() { await this._call('launch'); }
    async back() { await this._call('back'); }
    async tap(x, y) { await this._call('tap', x, y); }
    async dump() {
        this.dumpCount++;
        await this._call('dump', this.dumpCount);
        return this.screens.length > 1 ? this.screens.shift() : this.screens[0];
    }
}

function setup(screens = [OVERVIEW, OVERVIEW, OFF], overrides = {}) {
    const log = [];
    const phone = new FakePhone(screens, log);
    const clock = { value: 1700000000000 };
    const config = {
        approvedAppVersion: '4.8.1', vehicleMarker: { contentDescPrefix: VEHICLE },
        modeTitles: ['Klimatisierung'], allowWrites: true, commandTimeoutSeconds: 180,
        cooldownSeconds: 60, outcomeTimeoutSeconds: 120, ...overrides,
    };
    const store = {
        reservations: 0,
        async reserveCommand(seconds) { this.reservations++; log.push('reserve:' + seconds); },
    };
    const controller = new Controller({ config, phone, store, now: () => clock.value,
        sleep: async milliseconds => { clock.value += milliseconds; }, pollIntervalMs: 400 });
    return { controller, phone, store, log, config, clock };
}

function ctaCount(phone) { return phone.calls.filter(call => call[0] === 'tap' && call[2] === 330).length; }
function navCount(phone) { return phone.calls.filter(call => call[0] === 'tap' && call[2] === 130).length; }
async function rejectsCode(promise, expected) {
    await assert.rejects(promise, error => error instanceof BridgeError && error.code === expected && !error.message.includes('SECRET'));
}

test('status connects once and reports only app observation without a CTA or reservation', async () => {
    const { controller, phone, store, log, clock } = setup();
    const result = await controller.execute('status');
    assert.deepEqual(result, { appState: 'off', changed: false, source: 'volkswagen_android_app', confirmationSource: 'app_controls', temperature: null, vehicleConfirmed: false,
        appVersion: '4.8.1', observedAt: new Date(clock.value).toISOString() });
    assert.deepEqual(log.slice(0, 3), ['connect', 'version', 'launch']);
    assert.equal(navCount(phone), 1);
    assert.equal(ctaCount(phone), 0);
    assert.equal(store.reservations, 0);
    assert.equal(phone.calls.filter(call => call[0] === 'connect').length, 1);
    assert.equal(phone.deadline, null);
    assert.equal(controller.busy, false);
});

test('successful start rechecks version and state, reserves before the sole CTA, then observes on', async () => {
    const { controller, phone, store, log } = setup([OVERVIEW, OVERVIEW, OFF, OFF, ON, RUNNING_OVERVIEW]);
    const result = await controller.execute('start');
    assert.equal(result.appState, 'on');
    assert.equal(result.changed, true);
    assert.equal(result.vehicleConfirmed, false);
    assert.equal(result.confirmationSource, 'app_overview');
    assert.equal(store.reservations, 1);
    assert.equal(ctaCount(phone), 1);
    assert.equal(phone.calls.filter(call => call[0] === 'version').length, 2);
    assert.equal(log[log.indexOf('tap:60,330') - 1], 'reserve:60');
});

test('stop ends the shown climate operation without requiring the A/C-only mode', async () => {
    const windows = climate('on', 'Scheibenheizung');
    const { controller, phone } = setup([OVERVIEW, OVERVIEW, windows, windows, OFF]);
    const result = await controller.execute('stop');
    assert.equal(result.appState, 'off');
    assert.equal(ctaCount(phone), 1);
});

test('an already satisfied command is a no-op and start still checks the mode', async () => {
    for (const [action, screen] of [['start', ON], ['stop', OFF]]) {
        const { controller, phone, store } = setup([OVERVIEW, OVERVIEW, screen]);
        assert.equal((await controller.execute(action)).alreadyInState, true);
        assert.equal(ctaCount(phone), 0);
        assert.equal(store.reservations, 0);
    }
    const { controller, phone } = setup([OVERVIEW, OVERVIEW, climate('on', 'Scheibenheizung')]);
    await rejectsCode(controller.execute('start'), 'unsafe_mode');
    assert.equal(ctaCount(phone), 0);
});

test('dry run checks the clickable CTA despite writes being disabled and does not reserve', async () => {
    const { controller, phone, store } = setup(undefined, { allowWrites: false });
    const result = await controller.execute('start', { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.wouldRequest, 'on');
    assert.equal(result.appState, 'off');
    assert.equal(ctaCount(phone), 0);
    assert.equal(store.reservations, 0);
    const disabled = setup([OVERVIEW, OVERVIEW, climate('off', 'Klimatisierung', { enabled: 'false' })]);
    await rejectsCode(disabled.controller.execute('start', { dryRun: true }), 'target_unavailable');
});

test('write gate prevents a real CTA and journal mutation', async () => {
    const { controller, phone, store } = setup(undefined, { allowWrites: false });
    await rejectsCode(controller.execute('start'), 'writes_disabled');
    assert.equal(ctaCount(phone), 0);
    assert.equal(store.reservations, 0);
});

test('only a recognized climate sheet receives Back before opening the overview', async () => {
    const { controller, phone } = setup([OFF, OVERVIEW, OVERVIEW, OFF]);
    await controller.execute('status');
    assert.equal(phone.calls.filter(call => call[0] === 'back').length, 1);
    assert.equal(navCount(phone), 1);
});

test('unknown initial screens are bounded and receive no guesses or Back gestures', async () => {
    const { controller, phone, clock } = setup([hierarchy()]);
    await rejectsCode(controller.execute('status'), 'unexpected_screen');
    assert.equal(clock.value, 1700000008000);
    assert.ok(phone.dumpCount <= 23);
    assert.equal(phone.calls.filter(call => ['back', 'tap'].includes(call[0])).length, 0);
});

test('the overall deadline covers connection and UI waiting and is cleared on failure', async () => {
    const { controller, phone, clock } = setup([hierarchy()], { commandTimeoutSeconds: 1 });
    phone.hooks.connect = () => { assert.equal(phone.deadline, clock.value + 1000); };
    await rejectsCode(controller.execute('status'), 'phone_timeout');
    assert.equal(clock.value, 1700000001000);
    assert.equal(phone.deadline, null);
    assert.equal(controller.busy, false);
    assert.equal(navCount(phone), 0);
});

test('wrong vehicle, dialog, and a changed overview prevent navigation', async () => {
    for (const [screens, expected] of [
        [[overview('Ihr Fahrzeug: ID.5. Gerade synchronisiert')], 'wrong_vehicle'],
        [[overview(undefined, [node('alert_dialog')])], 'blocked_ui'],
        [[OVERVIEW, hierarchy()], 'unexpected_screen'],
    ]) {
        const { controller, phone } = setup(screens);
        await rejectsCode(controller.execute('status'), expected);
        assert.equal(navCount(phone), 0);
        assert.equal(ctaCount(phone), 0);
    }
});

test('a changed version, fresh climate state, or fresh mode prevents the CTA', async () => {
    const version = setup([OVERVIEW, OVERVIEW, OFF]);
    version.phone.versions = ['4.8.1', '4.8.2'];
    await rejectsCode(version.controller.execute('start'), 'version_not_approved');
    const state = setup([OVERVIEW, OVERVIEW, OFF, ON]);
    await rejectsCode(state.controller.execute('start'), 'state_changed');
    const mode = setup([OVERVIEW, OVERVIEW, OFF, climate('off', 'Scheibenheizung')]);
    await rejectsCode(mode.controller.execute('start'), 'unsafe_mode');
    for (const { phone, store } of [version, state, mode]) {
        assert.equal(ctaCount(phone), 0);
        assert.equal(store.reservations, 0);
    }
});

test('persistence errors and cooldown rejection never reach the CTA', async () => {
    for (const error of [new BridgeError('state_not_saved', 'Journal konnte nicht gespeichert werden.'), new BridgeError('cooldown', 'Bitte warten.'), new Error('SECRET')]) {
        const { controller, phone, store } = setup([OVERVIEW, OVERVIEW, OFF, OFF]);
        store.reserveCommand = async () => { throw error; };
        await rejectsCode(controller.execute('start'), error instanceof BridgeError ? error.code : 'internal_error');
        assert.equal(ctaCount(phone), 0);
    }
});

test('a failed or uncertain CTA is never repeated or reconnected', async () => {
    for (const failure of [new Error('SECRET'), new BridgeError('phone_unavailable', 'Verbindung fehlt.')]) {
        const { controller, phone, store } = setup([OVERVIEW, OVERVIEW, OFF, OFF]);
        phone.hooks.tap = (_x, y) => { if (y === 330) throw failure; };
        await rejectsCode(controller.execute('start'), 'outcome_unknown');
        assert.equal(ctaCount(phone), 1);
        assert.equal(store.reservations, 1);
        assert.equal(phone.calls.filter(call => call[0] === 'connect').length, 1);
        assert.equal(controller.busy, false);
    }
});

test('all exceptions during post-attempt observation become outcome_unknown', async () => {
    const { controller, phone } = setup([OVERVIEW, OVERVIEW, OFF, OFF, ON]);
    phone.hooks.dump = count => { if (count === 5) throw new Error('SECRET'); };
    await rejectsCode(controller.execute('start'), 'outcome_unknown');
    assert.equal(ctaCount(phone), 1);
});

test('outcome timeout includes zero timeout and never issues a second CTA', async () => {
    for (const seconds of [0, 0.005]) {
        const { controller, phone } = setup([OVERVIEW, OVERVIEW, OFF, OFF, OFF], { outcomeTimeoutSeconds: seconds });
        await rejectsCode(controller.execute('start'), 'outcome_unknown');
        assert.equal(ctaCount(phone), 1);
        assert.equal(phone.calls.filter(call => call[0] === 'connect').length, 1);
    }
});

test('post-command return to the overview can be reopened after checking the vehicle', async () => {
    const { controller, phone } = setup([OVERVIEW, OVERVIEW, OFF, OFF, OVERVIEW, OVERVIEW, ON, RUNNING_OVERVIEW]);
    assert.equal((await controller.execute('start')).appState, 'on');
    assert.equal(navCount(phone), 2);
    assert.equal(ctaCount(phone), 1);
});

test('a delayed start after 45 seconds succeeds once and uses the running overview label', async () => {
    const { controller, phone, clock } = setup([OVERVIEW, OVERVIEW, OFF, OFF, OFF, ON, RUNNING_OVERVIEW]);
    phone.hooks.dump = count => { if (count === 5) clock.value += 60000; };
    const result = await controller.execute('start');
    assert.equal(result.appState, 'on');
    assert.equal(result.confirmationSource, 'app_overview');
    assert.equal(result.vehicleConfirmed, false);
    assert.equal(ctaCount(phone), 1);
    assert.equal(phone.calls.filter(call => call[0] === 'connect').length, 1);
    assert.ok(clock.value > 1700000060000);
});

test('an active tile on automatic overview return confirms start without reopening climate controls', async () => {
    const { controller, phone } = setup([OVERVIEW, OVERVIEW, OFF, OFF, RUNNING_OVERVIEW]);
    const result = await controller.execute('start');
    assert.equal(result.appState, 'on');
    assert.equal(result.confirmationSource, 'app_overview');
    assert.equal(navCount(phone), 1);
    assert.equal(ctaCount(phone), 1);
});

test('missing active tile labels preserve the explicit controls evidence without inventing a countdown', async () => {
    const { controller, phone } = setup([OVERVIEW, OVERVIEW, OFF, OFF, ON, OVERVIEW]);
    const result = await controller.execute('start');
    assert.equal(result.confirmationSource, 'app_controls');
    assert.equal(result.appState, 'on');
    assert.equal('remainingMinutes' in result, false);
    assert.equal(ctaCount(phone), 1);
});

test('detail on with a still unconfirmed overview waits for the active tile without another CTA', async () => {
    const { controller, phone, clock } = setup([OVERVIEW, OVERVIEW, OFF, OFF, ON, PENDING_OVERVIEW, PENDING_OVERVIEW, RUNNING_OVERVIEW]);
    phone.hooks.dump = count => { if (count === 7) clock.value += 60000; };
    const result = await controller.execute('start');
    assert.equal(result.confirmationSource, 'app_overview');
    assert.ok(clock.value >= 1700000060000);
    assert.equal(ctaCount(phone), 1);
    assert.equal(navCount(phone), 1);
});

test('a persistently unconfirmed overview times out instead of falling back to a premature detail success', async () => {
    const { controller, phone } = setup([OVERVIEW, OVERVIEW, OFF, OFF, ON, PENDING_OVERVIEW], { outcomeTimeoutSeconds: 1 });
    await rejectsCode(controller.execute('start'), 'outcome_unknown');
    assert.equal(ctaCount(phone), 1);
});

test('conflicting initial detail and overview observations never trigger another start', async () => {
    for (const action of ['start', 'status']) {
        const { controller, phone } = setup([PENDING_OVERVIEW, PENDING_OVERVIEW, ON]);
        await rejectsCode(controller.execute(action), 'unknown_state');
        assert.equal(ctaCount(phone), 0);
    }
});

test('the wrong vehicle after a start reports uncertainty without another CTA', async () => {
    const { controller, phone } = setup([OVERVIEW, OVERVIEW, OFF, OFF, ON, overview('Ihr Fahrzeug: ID.5. Gerade synchronisiert')]);
    await rejectsCode(controller.execute('start'), 'outcome_unknown');
    assert.equal(ctaCount(phone), 1);
});

test('overview evidence is used for a matching status and never overrides an off detail state', async () => {
    const running = setup([RUNNING_OVERVIEW, RUNNING_OVERVIEW, ON]);
    const result = await running.controller.execute('status');
    assert.equal(result.confirmationSource, 'app_overview');
    assert.equal(result.appState, 'on');
    assert.equal(ctaCount(running.phone), 0);
    const changed = setup([RUNNING_OVERVIEW, RUNNING_OVERVIEW, OFF]);
    const off = await changed.controller.execute('status');
    assert.equal(off.appState, 'off');
    assert.equal(off.confirmationSource, 'app_controls');
});

test('a busy controller rejects a concurrent job synchronously without queuing phone calls', async () => {
    const { controller, phone } = setup();
    let release;
    phone.hooks.connect = () => new Promise(resolve => { release = resolve; });
    const first = controller.execute('status');
    assert.equal(controller.busy, true);
    await rejectsCode(controller.execute('status'), 'busy');
    assert.equal(phone.calls.length, 1);
    release();
    await first;
    assert.equal(phone.calls.filter(call => call[0] === 'connect').length, 1);
});

test('invalid actions and pre-cancelled controllers cause no phone operations', async () => {
    const invalid = setup();
    await rejectsCode(invalid.controller.execute('unlock'), 'invalid_action');
    assert.equal(invalid.phone.calls.length, 0);
    const stopped = setup();
    stopped.controller.cancel();
    await rejectsCode(stopped.controller.execute('status'), 'cancelled');
    assert.equal(stopped.phone.calls.length, 0);
});

test('cancel during connection stops all subsequent app operations', async () => {
    const { controller, phone } = setup();
    phone.hooks.connect = () => controller.cancel();
    await rejectsCode(controller.execute('start'), 'cancelled');
    assert.deepEqual(phone.calls, [['connect']]);
    assert.equal(phone.deadline, null);
});

test('cancel during the fresh dump or persisted reservation prevents the CTA', async () => {
    for (const stage of ['dump', 'reserve']) {
        const { controller, phone, store } = setup([OVERVIEW, OVERVIEW, OFF, OFF]);
        if (stage === 'dump') phone.hooks.dump = count => { if (count === 4) controller.cancel(); };
        else store.reserveCommand = async () => { store.reservations++; controller.cancel(); };
        await rejectsCode(controller.execute('start'), 'cancelled');
        assert.equal(ctaCount(phone), 0);
        assert.equal(phone.dumpCount, 4);
    }
});

test('cancel during a CTA reports uncertainty and prevents all later gestures and jobs', async () => {
    const { controller, phone } = setup([OVERVIEW, OVERVIEW, OFF, OFF, OVERVIEW]);
    phone.hooks.tap = (_x, y) => { if (y === 330) controller.cancel(); };
    await rejectsCode(controller.execute('start'), 'outcome_unknown');
    assert.equal(ctaCount(phone), 1);
    assert.equal(navCount(phone), 1);
    assert.equal(phone.dumpCount, 4);
    const length = phone.calls.length;
    await rejectsCode(controller.execute('stop'), 'cancelled');
    assert.equal(phone.calls.length, length);
});

function temperatureTaps(phone) { return phone.calls.filter(call => call[0] === 'tap' && call[2] === 110); }

test('status reads the app temperature without changing it', async () => {
    const { controller, phone } = setup([OVERVIEW, OVERVIEW, temperatureClimate(22.5)]);
    const result = await controller.execute('status');
    assert.equal(result.temperature, 22.5);
    assert.equal(result.appState, 'off');
    assert.equal(temperatureTaps(phone).length, 0);
    assert.equal(ctaCount(phone), 0);
});

test('temperature-only jobs follow fresh half-degree selections and never start climate control', async () => {
    const { controller, phone, store } = setup([OVERVIEW, OVERVIEW, temperatureClimate(22), temperatureClimate(22), temperatureClimate(22.5), temperatureClimate(23)]);
    const result = await controller.execute('setTemperature', { targetTemperature: 23 });
    assert.equal(result.temperature, 23);
    assert.equal(result.appState, 'off');
    assert.equal(result.changed, false);
    assert.equal(result.temperatureChanged, true);
    assert.equal(temperatureTaps(phone).length, 2);
    assert.equal(ctaCount(phone), 0);
    assert.equal(store.reservations, 0);
});

test('a start applies and verifies the selected temperature before its sole CTA', async () => {
    const { controller, phone, store, log } = setup([OVERVIEW, OVERVIEW, temperatureClimate(22), temperatureClimate(22),
        temperatureClimate(22.5), temperatureClimate(22.5), temperatureClimate(22.5, 'on'), RUNNING_OVERVIEW]);
    const result = await controller.execute('start', { targetTemperature: 22.5 });
    assert.equal(result.appState, 'on');
    assert.equal(result.temperature, 22.5);
    assert.equal(temperatureTaps(phone).length, 1);
    assert.equal(ctaCount(phone), 1);
    assert.equal(store.reservations, 1);
    assert.ok(log.indexOf('tap:900,110') < log.indexOf('reserve:60'));
    assert.equal(log[log.indexOf('tap:60,330') - 1], 'reserve:60');
});

test('temperature can be lowered or adjusted during existing climate operation without another start', async () => {
    for (const state of ['off', 'on']) {
        const overviewScreen = state === 'on' ? RUNNING_OVERVIEW : OVERVIEW;
        const { controller, phone } = setup([overviewScreen, overviewScreen, temperatureClimate(22, state), temperatureClimate(22, state), temperatureClimate(21.5, state)]);
        const result = await controller.execute(state === 'on' ? 'start' : 'setTemperature', { targetTemperature: 21.5 });
        assert.equal(result.temperature, 21.5);
        assert.equal(temperatureTaps(phone)[0][1], 100);
        assert.equal(ctaCount(phone), 0);
        assert.equal(result.temperatureChanged, true);
    }
});

test('an already selected temperature requires no temperature gesture or journal reservation', async () => {
    const { controller, phone, store } = setup([OVERVIEW, OVERVIEW, temperatureClimate(22)]);
    const result = await controller.execute('setTemperature', { targetTemperature: 22 });
    assert.equal(result.temperatureChanged, false);
    assert.equal(temperatureTaps(phone).length, 0);
    assert.equal(ctaCount(phone), 0);
    assert.equal(store.reservations, 0);
});

test('invalid or absent temperature selections are rejected before contacting the phone', async () => {
    for (const targetTemperature of [15.5, 30, 22.25, '22', false, NaN, Infinity]) {
        const { controller, phone } = setup();
        await rejectsCode(controller.execute('setTemperature', { targetTemperature }), 'invalid_temperature');
        assert.equal(phone.calls.length, 0);
    }
    const { controller, phone } = setup();
    await rejectsCode(controller.execute('setTemperature'), 'temperature_required');
    assert.equal(phone.calls.length, 0);
});

test('write permission, supported picker and A/C mode are required before temperature gestures', async () => {
    const cases = [
        [temperatureClimate(22), { allowWrites: false }, 'writes_disabled'],
        [OFF, {}, 'temperature_unavailable'],
        [temperatureClimate(22, 'off', 'Scheibenheizung'), {}, 'unsafe_mode'],
    ];
    for (const [screen, config, expected] of cases) {
        const { controller, phone } = setup([OVERVIEW, OVERVIEW, screen], config);
        await rejectsCode(controller.execute('setTemperature', { targetTemperature: 22.5 }), expected);
        assert.equal(temperatureTaps(phone).length, 0);
        assert.equal(ctaCount(phone), 0);
    }
});

test('an unconfirmed temperature tap is never repeated and prevents a climate start', async () => {
    const { controller, phone, store } = setup([OVERVIEW, OVERVIEW, temperatureClimate(22)]);
    await rejectsCode(controller.execute('start', { targetTemperature: 22.5 }), 'temperature_outcome_unknown');
    assert.equal(temperatureTaps(phone).length, 1);
    assert.equal(ctaCount(phone), 0);
    assert.equal(store.reservations, 0);
});

test('unexpected temperature, climate-state and app-version changes stop temperature selection', async () => {
    for (const after of [temperatureClimate(23), temperatureClimate(22.5, 'on')]) {
        const { controller, phone } = setup([OVERVIEW, OVERVIEW, temperatureClimate(22), temperatureClimate(22), after]);
        await rejectsCode(controller.execute('setTemperature', { targetTemperature: 22.5 }), 'temperature_outcome_unknown');
        assert.equal(temperatureTaps(phone).length, 1);
        assert.equal(ctaCount(phone), 0);
    }
    const version = setup([OVERVIEW, OVERVIEW, temperatureClimate(22), temperatureClimate(22), temperatureClimate(22.5)]);
    version.phone.versions = ['4.8.1', '4.8.1', '4.8.2'];
    await rejectsCode(version.controller.execute('setTemperature', { targetTemperature: 23 }), 'version_not_approved');
    assert.equal(temperatureTaps(version.phone).length, 1);
});

test('a changed temperature before the start CTA prevents the CTA', async () => {
    const { controller, phone, store } = setup([OVERVIEW, OVERVIEW, temperatureClimate(22), temperatureClimate(22), temperatureClimate(22.5), temperatureClimate(23)]);
    await rejectsCode(controller.execute('start', { targetTemperature: 22.5 }), 'temperature_not_confirmed');
    assert.equal(temperatureTaps(phone).length, 1);
    assert.equal(ctaCount(phone), 0);
    assert.equal(store.reservations, 0);
});

test('cancellation during a temperature tap stops every subsequent gesture', async () => {
    const { controller, phone } = setup([OVERVIEW, OVERVIEW, temperatureClimate(22)]);
    phone.hooks.tap = (_x, y) => { if (y === 110) controller.cancel(); };
    await rejectsCode(controller.execute('start', { targetTemperature: 22.5 }), 'temperature_outcome_unknown');
    assert.equal(temperatureTaps(phone).length, 1);
    assert.equal(ctaCount(phone), 0);
});

test('temperature dry runs check the visible neighbor and start CTA without input', async () => {
    const { controller, phone, store } = setup([OVERVIEW, OVERVIEW, temperatureClimate(22)]);
    const result = await controller.execute('start', { targetTemperature: 22.5, dryRun: true });
    assert.equal(result.wouldSetTemperature, 22.5);
    assert.equal(result.wouldRequest, 'on');
    assert.equal(result.temperature, 22);
    assert.equal(temperatureTaps(phone).length, 0);
    assert.equal(ctaCount(phone), 0);
    assert.equal(store.reservations, 0);
});

test('cooldown failure after a confirmed temperature selection remains a cooldown and sends no CTA', async () => {
    const { controller, phone, store } = setup([OVERVIEW, OVERVIEW, temperatureClimate(22), temperatureClimate(22), temperatureClimate(22.5), temperatureClimate(22.5)]);
    store.reserveCommand = async () => { throw new BridgeError('cooldown', 'Bitte warten.'); };
    await rejectsCode(controller.execute('start', { targetTemperature: 22.5 }), 'cooldown');
    assert.equal(temperatureTaps(phone).length, 1);
    assert.equal(ctaCount(phone), 0);
});
