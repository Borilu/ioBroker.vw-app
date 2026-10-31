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

test('an automatic status connection offers the controller handoff checkpoint to the transport', async () => {
    const { controller, phone, store } = setup();
    phone.connect = async ({ checkpoint }) => {
        assert.equal(typeof checkpoint, 'function');
        checkpoint();
        assert.equal(controller.requestReadHandoff(), true);
        checkpoint();
        assert.fail('The handoff must interrupt connection before any further work.');
    };
    await rejectsCode(controller.execute('status'), 'cancelled');
    assert.equal(store.reservations, 0);
    assert.deepEqual(phone.calls, []);
    assert.equal(controller.busy, false);
});

test('status connects once and reports only app observation without a CTA or reservation', async () => {
    const { controller, phone, store, log, clock } = setup();
    const result = await controller.execute('status');
    assert.deepEqual(result, { appState: 'off', changed: false, source: 'volkswagen_android_app', confirmationSource: 'app_controls', temperature: null, vehicleConfirmed: false,
        settings: { mode: 'climate', climateOnUnlock: null, autoWindowHeating: null, zones: null },
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

function vehicleInfoSetup(t, options = {}) {
    const context = setup([], { allowWrites: false });
    const { controller, phone, clock, store } = context;
    const ui = require('../lib/vehicle-info-ui');
    const flow = require('../lib/vehicle-info-controller');
    const syntheticVin = 'TESTCAR0000000001';
    phone.page = options.initialPage || 'overview';
    phone.vehicleMatches = true;
    phone.infoMatches = true;
    phone.infoReads = 0;
    phone.versionReads = 0;
    phone.readNative = async () => {
        phone.dumpCount++;
        await phone._call('nativeRead', phone.dumpCount);
        if (options.wrongVehicleAtRead === phone.dumpCount) phone.vehicleMatches = false;
        if (options.handoffAtRead === phone.dumpCount) assert.equal(controller.requestReadHandoff(), true);
        if (options.cancelAtRead === phone.dumpCount) controller.cancel();
        const page = phone.page;
        const vehicleMatches = phone.vehicleMatches;
        return { page, known: page === 'vehicleInfo', infoMatches: phone.infoMatches,
            kind: () => page, checkClear: () => {},
            requireVehicle: marker => {
                assert.deepEqual(marker, controller.config.vehicleMarker);
                if (!vehicleMatches) throw new BridgeError('wrong_vehicle', 'SECRET WRONG VEHICLE');
            }, overviewNeedsTop: () => false, _find: () => [] };
    };
    phone.dump = async () => { throw new Error('Standard UI dumps are not a FIN-read fallback'); };
    phone.version = async () => {
        phone.versionReads++;
        await phone._call('version');
        return phone.versionReads === options.changedAtVersion ? '999.0' : '4.8.1';
    };
    phone.tap = async (x, y) => {
        await phone._call('tap', x, y);
        if (x === 111 && y === 222 && phone.page === 'overview') {
            phone.page = options.pageAfterEntry || 'vehicleInfo';
            if (options.expireAfterEntry) clock.value += controller.config.commandTimeoutSeconds * 1000;
        } else if (x === 33 && y === 44 && phone.page === 'vehicleInfo') {
            phone.page = 'overview';
            if (options.wrongAfterReturn) phone.vehicleMatches = false;
        } else assert.fail('No vehicle selection, add, delete, edit or vehicle command may be tapped');
    };
    t.mock.method(flow, 'readVehicleInfoScreen', current => {
        assert.equal(current, controller);
        return current._step(() => phone.readNative());
    });
    for (const name of ['read', 'write']) store[name] = async () => assert.fail('A FIN read does not access wishes or command history');
    t.mock.method(ui, 'vehicleInfoPage', screen => screen.kind() === 'vehicleInfo' && screen.known);
    t.mock.method(ui, 'vehicleInfoEntryTarget', screen => {
        assert.equal(screen.kind(), 'overview');
        return { x: 111, y: 222 };
    });
    t.mock.method(ui, 'vehicleInfoBackTarget', screen => {
        assert.equal(screen.kind(), 'vehicleInfo'); assert.equal(screen.known, true);
        return { x: 33, y: 44 };
    });
    t.mock.method(ui, 'readVehicleInfo', (screen, marker) => {
        assert.equal(screen.kind(), 'vehicleInfo');
        assert.deepEqual(marker, controller.config.vehicleMarker);
        phone.infoReads++;
        if (options.parserError) {
            if (options.formAfterParserError) phone.page = 'vehicleEditForm';
            throw options.parserError;
        }
        if (!screen.infoMatches) throw new BridgeError('wrong_vehicle', 'SECRET WRONG VIN CARD');
        return { vin: options.changeVinAtRead === phone.infoReads ? 'TESTCAR0000000002' : syntheticVin };
    });
    return { ...context, syntheticVin };
}

test('FIN read uses only inspected navigation, rechecks its value and returns Home before reporting', async t => {
    const { controller, phone, store, clock, syntheticVin } = vehicleInfoSetup(t);
    const unused = Object.defineProperty({}, 'targetTemperature', { get() { throw new Error('No staged setting is consulted'); } });
    const result = await controller.execute('refreshVehicleInfo', unused);
    assert.deepEqual(result, { domain: 'vehicleInfo', source: 'volkswagen_android_app', vehicleConfirmed: false,
        appVersion: '4.8.1', vehicleInfo: { vin: syntheticVin }, observedAt: new Date(clock.value).toISOString() });
    assert.deepEqual(phone.calls.filter(call => call[0] === 'tap'), [['tap', 111, 222], ['tap', 33, 44]]);
    assert.equal(phone.calls.filter(call => ['back', 'swipe'].includes(call[0])).length, 0);
    assert.equal(phone.infoReads, 2); assert.equal(phone.versionReads, 5);
    assert.equal(phone.page, 'overview'); assert.equal(store.reservations, 0);
    assert.equal(phone.deadline, null); assert.equal(controller.busy, false);
    assert.equal(controller.readOnlyExecution, false); assert.equal(controller.readHandoffProtected, false);
    assert.equal(controller.readVehicleInfoNative, false);
});

test('a malformed FIN returns through the known header once and never exposes the parser message', async t => {
    const { controller, phone, store } = vehicleInfoSetup(t, {
        parserError: new BridgeError('invalid_vehicle_info', 'SECRET VIN IN PARSER FAILURE'),
    });
    await rejectsCode(controller.execute('refreshVehicleInfo'), 'invalid_vehicle_info');
    assert.equal(phone.page, 'overview');
    assert.deepEqual(phone.calls.filter(call => call[0] === 'tap'), [['tap', 111, 222], ['tap', 33, 44]]);
    assert.equal(store.reservations, 0); assert.equal(phone.deadline, null); assert.equal(controller.busy, false);
});

test('FIN failure cleanup never closes an unrecognized vehicle-editing form', async t => {
    const { controller, phone } = vehicleInfoSetup(t, {
        parserError: new BridgeError('invalid_vehicle_info', 'SECRET VIN'), formAfterParserError: true,
    });
    await rejectsCode(controller.execute('refreshVehicleInfo'), 'invalid_vehicle_info');
    assert.equal(phone.page, 'vehicleEditForm');
    assert.deepEqual(phone.calls.filter(call => call[0] === 'tap'), [['tap', 111, 222]]);
    assert.equal(phone.calls.filter(call => call[0] === 'back').length, 0);
});

test('a wrong enrolled vehicle in the fresh Home snapshot blocks FIN navigation', async t => {
    const { controller, phone } = vehicleInfoSetup(t, { wrongVehicleAtRead: 2 });
    await rejectsCode(controller.execute('refreshVehicleInfo'), 'wrong_vehicle');
    assert.equal(phone.calls.filter(call => call[0] === 'tap').length, 0);
    assert.equal(phone.infoReads, 0); assert.equal(phone.page, 'overview');
});

test('a vehicle mismatch after the FIN header return prevents a successful result', async t => {
    const { controller, phone } = vehicleInfoSetup(t, { wrongAfterReturn: true });
    await rejectsCode(controller.execute('refreshVehicleInfo'), 'wrong_vehicle');
    assert.deepEqual(phone.calls.filter(call => call[0] === 'tap'), [['tap', 111, 222], ['tap', 33, 44]]);
    assert.equal(phone.page, 'overview'); assert.equal(controller.busy, false);
});

test('a FIN changing between fresh views is rejected and only the known header is used to return', async t => {
    const { controller, phone } = vehicleInfoSetup(t, { changeVinAtRead: 2 });
    await rejectsCode(controller.execute('refreshVehicleInfo'), 'vehicle_info_changed');
    assert.equal(phone.infoReads, 2); assert.equal(phone.page, 'overview');
    assert.deepEqual(phone.calls.filter(call => call[0] === 'tap'), [['tap', 111, 222], ['tap', 33, 44]]);
});

test('a final app-version change prevents a FIN result even after a successful Home return', async t => {
    const { controller, phone } = vehicleInfoSetup(t, { changedAtVersion: 5 });
    await rejectsCode(controller.execute('refreshVehicleInfo'), 'version_not_approved');
    assert.equal(phone.page, 'overview'); assert.equal(phone.versionReads, 5);
    assert.deepEqual(phone.calls.filter(call => call[0] === 'tap'), [['tap', 111, 222], ['tap', 33, 44]]);
});

test('a cooperative handoff during FIN reading waits for a verified Home return and publishes no result', async t => {
    const { controller, phone } = vehicleInfoSetup(t, { handoffAtRead: 3 });
    await rejectsCode(controller.execute('refreshVehicleInfo'), 'cancelled');
    assert.equal(phone.page, 'overview'); assert.equal(phone.infoReads, 2);
    assert.deepEqual(phone.calls.filter(call => call[0] === 'tap'), [['tap', 111, 222], ['tap', 33, 44]]);
    assert.equal(controller.readOnlyExecution, false); assert.equal(controller.readHandoffRequested, false);
    assert.equal(controller.readHandoffProtected, false); assert.equal(controller.busy, false);
});

test('an unknown destination has a bounded wait without a guessed return or vehicle-selection gesture', async t => {
    const { controller, phone, clock } = vehicleInfoSetup(t, { pageAfterEntry: 'unknown' });
    await rejectsCode(controller.execute('refreshVehicleInfo'), 'unexpected_screen');
    assert.equal(clock.value, 1700000020000);
    assert.deepEqual(phone.calls.filter(call => call[0] === 'tap'), [['tap', 111, 222]]);
    assert.equal(phone.calls.filter(call => call[0] === 'back').length, 0);
    assert.equal(phone.deadline, null); assert.equal(controller.busy, false);
});

for (const [label, options, code] of [['expired deadline', { expireAfterEntry: true }, 'phone_timeout'],
    ['shutdown', { cancelAtRead: 3 }, 'cancelled']]) {
    test('a FIN ' + label + ' stops inputs and always releases the bounded lifecycle', async t => {
        const { controller, phone } = vehicleInfoSetup(t, options);
        await rejectsCode(controller.execute('refreshVehicleInfo'), code);
        assert.deepEqual(phone.calls.filter(call => call[0] === 'tap'), [['tap', 111, 222]]);
        assert.equal(phone.deadline, null); assert.equal(controller.deadline, null);
        assert.equal(controller.busy, false); assert.equal(controller.readHandoffProtected, false);
        assert.equal(controller.readVehicleInfoNative, false);
    });
}

test('a competing FIN request cannot clear the active reader reservation or handoff flags', async t => {
    const { controller, phone } = vehicleInfoSetup(t);
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const connected = new Promise(resolve => { entered = resolve; });
    phone.hooks.connect = async () => { entered(); await gate; };
    const active = controller.execute('refreshVehicleInfo');
    await connected;
    await rejectsCode(controller.execute('refreshVehicleInfo'), 'busy');
    assert.equal(controller.busy, true); assert.equal(controller.readOnlyExecution, true);
    release(); await active;
    assert.equal(controller.busy, false); assert.equal(controller.readOnlyExecution, false);
});

test('a recognized vehicle-information page is safely recovered before another overview read', async t => {
    const { controller, phone } = vehicleInfoSetup(t, { initialPage: 'vehicleInfo' });
    controller.readVehicleInfoNative = true;
    const result = await controller._overview();
    assert.equal(result.kind(), 'overview'); assert.equal(phone.page, 'overview');
    assert.equal(phone.infoReads, 0);
    assert.deepEqual(phone.calls.filter(call => call[0] === 'tap'), [['tap', 33, 44]]);
    assert.equal(phone.calls.filter(call => call[0] === 'back').length, 0);
});

test('foreign FIN errors never expose their code getter or arbitrary message', async t => {
    let reads = 0;
    const foreign = Object.defineProperty({ message: 'SECRET PERSONAL IDENTIFIER' }, 'code', {
        get() { reads++; return 'SECRET'; },
    });
    const { controller, phone } = vehicleInfoSetup(t, { parserError: foreign });
    await rejectsCode(controller.execute('refreshVehicleInfo'), 'vehicle_info_unavailable');
    assert.equal(reads, 0); assert.equal(phone.page, 'overview');
});

function syntheticFinNativeObservation() {
    const window = { id: 7, type: 1, active: true, focused: true, accessibilityFocused: false, layer: 0,
        title: 'Synthetic FIN window', bounds: [0, 0, 1080, 2400] };
    const windows = { vwWindows: [window], multipleVwApplicationWindows: false, foreignWindowCount: 0 };
    return { format: 'vw-app-extended-accessibility-v1', package: PACKAGE, readOnly: true,
        startedAtEpochMs: 10000, finishedAtEpochMs: 10001, windowId: 7,
        windowsBefore: structuredClone(windows), windowsAfter: structuredClone(windows), nodeCount: 1,
        root: { package: PACKAGE, id: null, class: 'android.widget.FrameLayout',
            text: 'Synthetic native FIN view', description: null, stateDescription: null,
            bounds: [0, 0, 1080, 2400], visible: true, enabled: true, clickable: false, longClickable: false,
            checkable: false, checked: false, selected: false, scrollable: false, focusable: false, focused: false,
            accessibilityFocused: false, password: false, heading: false, screenReaderFocusable: false,
            importantForAccessibility: true, rangeInfo: null, actions: [], children: [] } };
}

test('the FIN native reader rebuilds validated XML from its own observation without a standard dump or supplied XML', async () => {
    const { readVehicleInfoScreen } = require('../lib/vehicle-info-controller');
    let nativeReads = 0;
    const controller = { phone: {
        async departureView() { nativeReads++; return { observation: syntheticFinNativeObservation(), xml: 'SECRET UNRELATED XML' }; },
        async dump() { assert.fail('A standard dump must not be used'); },
    }, async _step(operation) { return operation(); }, _check() {} };
    const screen = await readVehicleInfoScreen(controller);
    assert.equal(nativeReads, 1);
    assert.equal(screen.nodes.length, 1);
    assert.equal(screen.nodes[0].attrs.text, 'Synthetic native FIN view');
    assert.equal(screen.summary().some(row => Object.values(row).some(value => value.includes('SECRET'))), false);
});

test('missing, incomplete or foreign native FIN observations fail closed without standard-UI fallback', async () => {
    const { readVehicleInfoScreen } = require('../lib/vehicle-info-controller');
    const foreign = syntheticFinNativeObservation(); foreign.package = 'unrelated.package';
    const badWindow = syntheticFinNativeObservation(); badWindow.windowsAfter.vwWindows[0].focused = false;
    for (const observation of [null, {}, foreign, badWindow]) {
        const controller = { phone: {
            async departureView() { return { observation, xml: OVERVIEW }; },
            async dump() { assert.fail('A standard dump must not be used'); },
        }, async _step(operation) { return operation(); }, _check() {} };
        await rejectsCode(readVehicleInfoScreen(controller), 'extended_ui_unavailable');
    }
    const missing = { phone: { async dump() { assert.fail('No missing-native fallback'); } },
        async _step(operation) { return operation(); }, _check() {} };
    await rejectsCode(readVehicleInfoScreen(missing), 'extended_ui_unavailable');
});

test('the native FIN reader rejects a protected PIN view without returning its contents', async () => {
    const { readVehicleInfoScreen } = require('../lib/vehicle-info-controller');
    for (const password of [true, false]) {
        const observation = syntheticFinNativeObservation();
        observation.root.password = password;
        observation.root.text = password ? 'SECRET PROTECTED VALUE' : 'S-PIN eingeben SECRET';
        const controller = { phone: { async departureView() { return { observation }; } },
            async _step(operation) { return operation(); }, _check() {} };
        await rejectsCode(readVehicleInfoScreen(controller), password ? 'extended_ui_unavailable' : 'security_ui_active');
    }
});

test('FIN controller and actual UI helpers read only the active vehicle from complete native frames', async () => {
    const { controller, phone, store } = setup([], { allowWrites: false });
    const base = syntheticFinNativeObservation();
    const nativeNode = (attributes = {}, children = []) => ({
        ...structuredClone(base.root), class: 'android.view.View', text: null, ...attributes, children,
    });
    const nativeText = (text, bounds) => nativeNode({ class: 'android.widget.TextView', text, bounds });
    const vehicleCard = (name, vin, active, y) => nativeNode({ clickable: true, bounds: [0, y, 1080, y + 353] }, [
        nativeText(name, [53, y + 21, 850, y + 100]),
        nativeText(vin, [53, y + 121, 1027, y + 177]),
        nativeText('Hauptnutzer', [53, y + 198, 1027, y + 254]),
        nativeText('', [53, y + 275, 1027, y + 332]),
        ...(active ? [nativeNode({ id: 'activeBadge', bounds: [903, y + 34, 1027, y + 87] }, [
            nativeText('Aktiv', [924, y + 39, 1006, y + 82]),
        ])] : []),
    ]);
    const home = nativeNode({ class: 'android.widget.FrameLayout' }, [
        nativeNode({ description: VEHICLE + 'Gerade synchronisiert', bounds: [53, 100, 900, 172] }),
        nativeNode({ id: 'climateTile', bounds: [10, 1000, 500, 1200] }),
        nativeNode({ id: 'vehicleCarPlus', clickable: true, bounds: [933, 79, 1059, 205] }, [
            nativeNode({ description: 'Fahrzeuge verwalten', bounds: [965, 111, 1028, 174] }),
        ]),
    ]);
    const garage = nativeNode({ class: 'android.widget.FrameLayout' }, [
        nativeNode({ id: 'garageBack', class: 'android.widget.Button', clickable: true, bounds: [22, 79, 148, 205] }),
        nativeNode({ description: 'Meine Fahrzeuge', bounds: [137, 111, 943, 172] }),
        vehicleCard('Anderes synthetisches Fahrzeug', 'TESTCAR0000000002', false, 205),
        vehicleCard('ID.7 GTX Tourer', 'TESTCAR0000000001', true, 700),
        nativeNode({ class: 'android.widget.Button', text: 'Fahrzeug verbinden', clickable: true, bounds: [100, 1500, 980, 1640] }),
    ]);
    const count = root => 1 + root.children.reduce((sum, child) => sum + count(child), 0);
    let page = 'overview'; let nativeReads = 0;
    phone.departureView = async () => {
        nativeReads++;
        await phone._call('nativeRead');
        const root = structuredClone(page === 'overview' ? home : garage);
        return { observation: { ...structuredClone(base), root, nodeCount: count(root) }, xml: 'UNRELATED XML MUST NOT BE USED' };
    };
    phone.dump = async () => { throw new Error('No standard dump or cached view is permitted for FIN'); };
    phone.tap = async (x, y) => {
        await phone._call('tap', x, y);
        if (page === 'overview' && x === 996 && y === 142) page = 'vehicleInfo';
        else if (page === 'vehicleInfo' && x === 85 && y === 142) page = 'overview';
        else assert.fail('No other vehicle, card, connect or edit control may be touched');
    };
    for (const name of ['read', 'write']) store[name] = async () => assert.fail('FIN never reads wishes or a command journal');
    const result = await controller.execute('refreshVehicleInfo');
    assert.equal(result.vehicleInfo.vin, 'TESTCAR0000000001', 'The first, inactive vehicle must be ignored');
    assert.equal(result.domain, 'vehicleInfo'); assert.equal(result.vehicleConfirmed, false);
    assert.equal(nativeReads, 6); assert.equal(page, 'overview');
    assert.deepEqual(phone.calls.filter(call => call[0] === 'tap'), [['tap', 996, 142], ['tap', 85, 142]]);
    assert.equal(phone.calls.filter(call => ['back', 'swipe', 'dump'].includes(call[0])).length, 0);
    assert.equal(store.reservations, 0); assert.equal(controller.readVehicleInfoNative, false);
});
