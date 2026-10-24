'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAdapterClass, DEFINITIONS } = require('../lib/adapter');
const { BridgeError } = require('../lib/errors');
const { PACKAGE } = require('../lib/ui');
const ADMIN = require('../admin/jsonConfig.json');
const { MIN_TEMPERATURE_CELSIUS, MAX_TEMPERATURE_CELSIUS, TEMPERATURE_STEP_CELSIUS } = require('../lib/temperature');

const VEHICLE = 'Ihr Fahrzeug: ID.7 GTX Tourer. ';
const DEVICE = 'serial:TEST-ADAPTER-42';
const HOST = '192.0.2.42';
const PORT = 37123;
const clone = value => structuredClone(value);

function xmlNode(id = '', attrs = {}, children = []) {
    const attributes = { package: PACKAGE, enabled: 'true', clickable: 'false', bounds: '[10,20][110,80]',
        ...(id ? { 'resource-id': id } : {}), ...attrs };
    const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    return '<node ' + Object.entries(attributes).map(([name, value]) => name + '="' + escape(value) + '"').join(' ')
        + '>' + children.join('') + '</node>';
}

function overview(description = VEHICLE + 'Gerade synchronisiert', activeClimate = false) {
    return '<hierarchy>' + xmlNode('', { 'content-desc': description })
        + xmlNode('climateTile', { bounds: '[10,100][110,160]' }, activeClimate
            ? [xmlNode('', { 'content-desc': 'Vorklimatisierung. An. Details öffnen' })] : []) + '</hierarchy>';
}

function climate(state, mode = 'Klimatisierung', enabled = true) {
    return '<hierarchy>' + xmlNode('clima_compose_view', { bounds: '[0,0][500,900]' }, [
        xmlNode(state === 'on' ? 'cta_stop' : 'cta_start', { clickable: 'true', enabled: String(enabled), bounds: '[10,300][110,360]' }),
        xmlNode('clima_air_conditioning_pick', {}, [xmlNode('title', { text: mode })]),
    ]) + '</hierarchy>';
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function singleAdminSuccess(controlName, response, result) {
    const control = ADMIN.items[controlName];
    assert.equal(typeof control.result[result], 'string');
    // ConfigSendto shows the mapped message and then its native branch avoids
    // the additional raw-result alert. The empty native object changes no form.
    assert.equal(control.useNative, true);
    assert.deepEqual(response, { result, native: {} });
}

async function rejectsCode(promise, code) {
    await assert.rejects(promise, error => error instanceof BridgeError && error.code === code);
}

async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-app-adapter-test-'));
    const config = { hostIp: HOST, connectPort: PORT, approvedAppVersion: '', vehicleMarker: '',
        modeTitles: 'Klimatisierung|Air conditioning', allowWrites: false, useBundledAdb: true,
        commandTimeoutSeconds: 300, outcomeTimeoutSeconds: 120, cooldownSeconds: 60, pollIntervalSeconds: 0,
        stayAwakeOnCharge: false, ...options.config };
    const memory = clone({ ...(options.enrollment ? { enrollment: options.enrollment } : {}), ...options.memory });
    const records = { runtime: [], phones: [], stores: [], leases: [], controllers: [], controllerCalls: [], events: [] };
    const environment = { appState: options.appState || 'off' };

    class FakeAdapter extends EventEmitter {
        constructor() {
            super();
            this.config = config; this.namespace = 'vw-app.0';
            this.states = new Map(); this.objects = new Map(); this.writes = [];
            this.foreignObjects = new Map(); this.foreignWrites = []; this.subscriptions = [];
            this.logs = []; this.responses = []; this.intervals = []; this.clearedIntervals = [];
            this.log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, message => this.logs.push({ level, message })]));
        }
        async setObjectNotExistsAsync(id, value) { if (!this.objects.has(id)) this.objects.set(id, clone(value)); }
        async setStateAsync(id, value) {
            if (this.stopping && id === 'info.connection' && options.shutdownStateFailure) throw new Error('SECRET STATE WRITE ERROR');
            this.writes.push({ id, value: clone(value) }); this.states.set(id, clone(value));
        }
        async subscribeStatesAsync(pattern) { this.subscriptions.push(['own', pattern]); }
        async subscribeForeignStatesAsync(pattern) { this.subscriptions.push(['foreign', pattern]); }
        async getForeignObjectAsync(id) { return this.foreignObjects.get(id) || null; }
        async setForeignStateAsync(id, value) { this.foreignWrites.push({ id, value: clone(value) }); }
        sendTo(from, command, message, callback) { this.responses.push({ from, command, message: clone(message), callback }); }
        setInterval(callback, milliseconds) { const timer = { callback, milliseconds }; this.intervals.push(timer); return timer; }
        clearInterval(timer) { this.clearedIntervals.push(timer); }
    }

    class FakeRuntime {
        constructor(settings) { this.settings = settings; this.ready = !options.runtimeMissing; this.calls = []; records.runtime.push(this); }
        async start() {
            this.calls.push(['start']);
            if (!this.ready) throw new BridgeError('runtime_missing', 'Install Android tools in adapter settings.');
        }
        async install(value) {
            this.calls.push(['install', clone(value)]);
            if (value.acceptLicense !== true) throw new BridgeError('license_required', 'Accept the Android tools license first.');
            this.ready = true;
        }
        async pair(endpoint, code) {
            this.calls.push(['pair', endpoint, code]);
            if (options.pairFailure) throw options.pairFailure;
        }
        async stop() { this.calls.push(['stop']); records.events.push('runtime.stop'); if (options.stopFailure) throw options.stopFailure; }
    }

    class FakeStore {
        constructor(directory) { this.directory = directory; this.writes = []; this.reservations = 0; records.stores.push(this); }
        async read(name, fallback) { return clone(memory[name] ?? fallback); }
        async write(name, value) {
            this.writes.push({ name, value: clone(value) });
            if (options.storeWrite) await options.storeWrite(name, value);
            memory[name] = clone(value);
        }
        async reserveCommand(seconds) { this.reservations++; records.events.push('reserve:' + seconds); }
    }

    class FakeLease {
        constructor(compromised) { this.compromised = compromised; this.acquisitions = []; this.closed = 0; records.leases.push(this); }
        async acquire(deviceId) { this.acquisitions.push(deviceId); }
        async close() { this.closed++; records.events.push('lease.close'); if (options.leaseFailure) throw options.leaseFailure; }
    }

    class FakePhone {
        constructor(settings) { this.settings = settings; this.calls = []; this.page = 'overview'; this.versions = [...(options.versions || ['4.8.1'])]; records.phones.push(this); }
        async invoke(name, ...args) {
            this.calls.push([name, ...args]);
            if (options.hooks?.[name]) await options.hooks[name](this, ...args);
        }
        async connect(value = {}) {
            await this.invoke('connect', value);
            const deviceId = options.deviceId || DEVICE;
            if (this.settings.deviceId && this.settings.deviceId !== deviceId) throw new BridgeError('wifi_wrong_device', 'Wrong phone.');
            if (!value.allowUnpinned && !this.settings.deviceId) throw new BridgeError('wifi_identity_required', 'Phone check required.');
            await this.settings.onVerified(deviceId);
            return { deviceId };
        }
        async version() { await this.invoke('version'); return this.versions.length > 1 ? this.versions.shift() : this.versions[0]; }
        async launch() { await this.invoke('launch'); }
        async back() { await this.invoke('back'); this.page = 'overview'; }
        async dump() {
            await this.invoke('dump');
            return this.page === 'overview' ? overview(options.description, options.overviewEvidence && environment.appState === 'on')
                : climate(environment.appState, options.mode, options.ctaEnabled !== false);
        }
        async tap(x, y) {
            await this.invoke('tap', x, y);
            if (y === 130) this.page = 'climate';
            else if (y === 330) environment.appState = environment.appState === 'on' ? 'off' : 'on';
            else assert.fail('Unexpected simulated app coordinate');
        }
        async keepAwake() { await this.invoke('keepAwake'); return { active: options.keepAwakeActive !== false }; }
    }

    class FakeController {
        constructor(settings) { Object.assign(this, settings); records.controllers.push(this); }
        async execute(action, input) {
            records.controllerCalls.push({ action, input: clone(input) });
            if (options.controllerExecute) return options.controllerExecute(action, input);
            return { appState: environment.appState, appVersion: '4.8.1', vehicleConfirmed: false,
                observedAt: new Date().toISOString(), temperature: input.targetTemperature,
                confirmationSource: 'app_controls' };
        }
        cancel() { this.cancelled = true; }
    }

    const utils = { Adapter: FakeAdapter, getAbsoluteInstanceDataDir: () => root };
    const Adapter = createAdapterClass(utils, { Runtime: FakeRuntime, Phone: FakePhone, Store: FakeStore, Lease: FakeLease,
        ...(options.fakeController ? { Controller: FakeController } : {}) });
    const adapter = new Adapter();
    t.after(async () => {
        if (!adapter.stopping) await adapter.onUnload(() => {}).catch(() => {});
        // Delete only this explicitly created fixture directory.
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('vw-app-adapter-test-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    await adapter.onReady();
    return {
        adapter, config, records, memory, environment,
        value: id => adapter.states.get(id)?.val,
        async message(command, message = {}) {
            await adapter.onMessage({ from: 'system.adapter.admin.0', command, message, callback: { id: 1 } });
            return adapter.responses.at(-1)?.message;
        },
        ctas: () => records.phones.flatMap(phone => phone.calls).filter(call => call[0] === 'tap' && call[2] === 330),
    };
}

function enrolled() { return { deviceId: DEVICE, profile: { appVersion: '4.8.1', vehicleMarker: VEHICLE } }; }

test('ready keeps an unconfigured instance alive with runtime_missing and never downloads or touches a phone', async t => {
    const f = await fixture(t, { runtimeMissing: true, config: { hostIp: '', connectPort: 0 } });
    assert.equal(f.value('info.runtimeReady'), false);
    assert.equal(f.value('info.status'), 'runtime_missing');
    assert.equal(f.value('operation.lastErrorCode'), 'runtime_missing');
    assert.equal(f.value('climate.confirmationSource'), 'none');
    assert.equal(f.adapter.stopping, false);
    assert.equal(f.records.phones.length, 0);
    assert.deepEqual(f.records.runtime[0].calls, [['start']]);
    assert.ok(f.adapter.subscriptions.some(([kind, pattern]) => kind === 'own' && pattern === 'commands.*'));
    for (const event of ['ready', 'stateChange', 'message', 'unload']) assert.equal(f.adapter.listenerCount(event), 1);
    const response = await f.message('installRuntime', { acceptLicense: true });
    singleAdminSuccess('_installRuntime', response, 'runtime_installed');
    assert.equal(f.value('info.runtimeReady'), true);
    assert.equal(f.records.phones.length, 0);
});

test('state objects match their schema and quality wrappers remain flat on failure', async t => {
    const f = await fixture(t);
    for (const [id, [type, role, , write]] of Object.entries(DEFINITIONS)) {
        const object = f.adapter.objects.get(id);
        assert.equal(object.type, 'state');
        assert.equal(object.common.type, type);
        assert.equal(object.common.role, role);
        assert.equal(object.common.write, write);
        assert.equal(f.adapter.states.get(id).ack, true);
        if (f.value(id) === null) assert.equal(type, 'number');
        else assert.equal(typeof f.value(id), type);
    }
    await f.adapter.observation({ appState: 'on', appVersion: '4.8.1', observedAt: new Date().toISOString(), confirmationSource: 'app_overview' });
    await f.adapter.failure(new Error('SECRET PHONE DUMP'));
    assert.deepEqual(f.adapter.states.get('climate.active'), { val: false, ack: true, q: 0x82 });
    assert.equal(f.value('climate.appState'), 'unknown');
    assert.equal(f.value('climate.confirmationSource'), 'none');
    assert.equal(f.value('operation.lastUpdated'), '');
    assert.ok(!JSON.stringify(f.adapter.logs).includes('SECRET'));
});

test('buttons accept only explicit ack=false and true values, reset acknowledged, and map refresh to status', async t => {
    const f = await fixture(t);
    const actions = [];
    f.adapter.command = async action => { actions.push(action); };
    for (const state of [null, { val: true }, { val: true, ack: true }, { val: true, ack: 0 },
        { val: true, ack: null }, { val: true, ack: 'false' }, { val: false, ack: false }, { val: 'true', ack: false }]) {
        await f.adapter.onStateChange('vw-app.0.commands.start', state);
    }
    await f.adapter.onStateChange('vw-app.0.commands.unlock', { val: true, ack: false });
    await f.adapter.onStateChange('other.0.commands.start', { val: true, ack: false });
    assert.deepEqual(actions, []);
    for (const name of ['start', 'stop', 'refresh', 'setTemperature', 'clearTemperature']) {
        await f.adapter.onStateChange('vw-app.0.commands.' + name, { val: true, ack: false });
        assert.deepEqual(f.adapter.states.get('commands.' + name), { val: false, ack: true });
    }
    assert.deepEqual(actions, ['start', 'stop', 'status', 'setTemperature']);
});

test('legacy controls reset existing user states without creating or writing unrelated objects', async t => {
    const prefix = '0_userdata.0.old_vw';
    const f = await fixture(t, { config: { legacyStatePrefix: prefix } });
    const actions = [];
    f.adapter.command = async action => actions.push(action);
    f.adapter.foreignObjects.set(prefix + '.start', { type: 'state' });
    await f.adapter.onStateChange(prefix + '.start', { val: true, ack: false });
    assert.deepEqual(actions, ['start']);
    assert.deepEqual(f.adapter.foreignWrites.filter(row => row.id.endsWith('.start')), [
        { id: prefix + '.start', value: { val: false, ack: true } },
    ]);
    await f.adapter.onStateChange('0_userdata.0.unrelated.start', { val: true, ack: false });
    assert.deepEqual(actions, ['start']);
    assert.equal(f.adapter.foreignWrites.filter(row => row.id.includes('unrelated')).length, 0);
});

test('probe binds identity privately and returns safe network values without approving the app', async t => {
    const f = await fixture(t);
    const response = await f.message('probe', { hostIp: '203.0.113.80', connectPort: '40001' });
    assert.deepEqual(response, { result: 'probe_success', actualAppVersion: '4.8.1',
        native: { hostIp: '203.0.113.80', connectPort: 40001 } });
    assert.equal(f.memory.enrollment.deviceId, DEVICE);
    assert.equal(f.memory.enrollment.profile, undefined);
    assert.equal(f.adapter.settings.approvedAppVersion, '');
    assert.equal(f.value('info.appVersion'), '4.8.1');
    assert.equal(f.records.phones[0].settings.endpoint, '203.0.113.80:40001');
    assert.ok(!JSON.stringify({ response, writes: f.adapter.writes, logs: f.adapter.logs }).includes(DEVICE));
    assert.deepEqual(f.records.phones[0].calls.map(call => call[0]), ['connect', 'version']);
    assert.equal(f.ctas().length, 0);
});

test('calibration recognizes Gerade synchronisiert and checks mode and clickable CTA without switching', async t => {
    const f = await fixture(t, { enrollment: { deviceId: DEVICE }, appState: 'on' });
    const response = await f.message('calibrate', { hostIp: HOST, connectPort: String(PORT) });
    assert.deepEqual(response, { result: 'calibration_success', native: { approvedAppVersion: '4.8.1', vehicleMarker: VEHICLE }, saveConfig: true });
    assert.deepEqual(f.memory.enrollment, enrolled());
    assert.equal(f.value('climate.appState'), 'on');
    assert.equal(f.value('climate.confirmationSource'), 'app_controls');
    assert.equal(f.value('climate.vehicleConfirmed'), false);
    assert.equal(f.ctas().length, 0);
    assert.equal(f.records.stores[0].reservations, 0);
    assert.equal(f.records.phones[0].calls.filter(call => call[0] === 'version').length, 2);
    assert.ok(!JSON.stringify({ response, writes: f.adapter.writes, logs: f.adapter.logs }).includes(DEVICE));
});

test('calibration refuses unsafe modes, disabled CTA, or an app changing during inspection', async t => {
    for (const [options, expected] of [[{ mode: 'Scheibenheizung' }, 'unsafe_mode'],
        [{ ctaEnabled: false }, 'target_unavailable'], [{ versions: ['4.8.1', '4.8.2'] }, 'version_not_approved']]) {
        const f = await fixture(t, { enrollment: { deviceId: DEVICE }, ...options });
        const response = await f.message('calibrate', { hostIp: HOST, connectPort: PORT });
        assert.ok(response.error.startsWith(expected + ':'));
        assert.equal(f.memory.enrollment.profile, undefined);
        assert.equal(f.ctas().length, 0);
        assert.equal(f.value('climate.appState'), 'unknown');
    }
});

test('confirmation source distinguishes app overview evidence from controls without claiming vehicle telemetry or a timer', async t => {
    const f = await fixture(t);
    assert.equal(f.value('climate.confirmationSource'), 'none');
    for (const confirmationSource of ['app_overview', 'app_controls']) {
        await f.adapter.observation({ appState: 'on', appVersion: '4.8.1', confirmationSource, observedAt: '2026-10-24T15:00:00.000Z' });
        assert.equal(f.value('climate.confirmationSource'), confirmationSource);
        assert.equal(f.value('climate.appState'), 'on');
        assert.equal(f.value('climate.vehicleConfirmed'), false);
    }
    await f.adapter.observation({ appState: 'off', appVersion: '4.8.1', observedAt: '2026-10-24T15:01:00.000Z' });
    assert.equal(f.value('climate.confirmationSource'), 'app_controls');
    assert.equal(f.value('climate.vehicleConfirmed'), false);
    assert.equal(f.adapter.objects.has('climate.remainingMinutes'), false);
});

test('pair preserves all six code digits without echoing them to configuration, replies, states or logs', async t => {
    const f = await fixture(t);
    const code = '000123';
    const response = await f.message('pair', { hostIp: HOST, pairPort: '42001', code });
    singleAdminSuccess('_pair', response, 'pair_success');
    assert.deepEqual(f.records.runtime[0].calls.filter(call => call[0] === 'pair'), [['pair', HOST + ':42001', code]]);
    assert.ok(!JSON.stringify({ response, native: f.config, states: f.adapter.writes, logs: f.adapter.logs, stored: f.memory }).includes(code));
    assert.equal(f.records.phones.length, 0);
});

test('unexpected setup exceptions are redacted and malformed or unacknowledged messages cannot operate a phone', async t => {
    const f = await fixture(t, { pairFailure: new Error('SECRET CODE=000123 PRIVATE-KEY=VALUE') });
    const response = await f.message('pair', { hostIp: HOST, pairPort: PORT, code: '000123' });
    assert.ok(response.error.startsWith('internal_error:'));
    assert.ok(!JSON.stringify({ response, logs: f.adapter.logs, states: f.adapter.writes }).includes('SECRET'));
    assert.ok(!JSON.stringify(response).includes('000123'));
    const callCount = f.records.runtime[0].calls.length;
    await f.adapter.onMessage({ from: 'system.adapter.admin.0', command: 'pair', message: { code: '000123' } });
    await f.adapter.onMessage({ command: 'pair', callback: { id: 1 }, message: { code: '000123' } });
    assert.equal(f.records.runtime[0].calls.length, callCount);
    const invalid = await f.message('runShell', { command: 'arbitrary' });
    assert.ok(invalid.error.startsWith('invalid_action:'));
    assert.equal(f.records.phones.length, 0);
});

test('all runtime commands require a calibrated profile and profile edits are gated before phone access', async t => {
    const missing = await fixture(t, { enrollment: { deviceId: DEVICE } });
    for (const action of ['start', 'stop', 'status']) await rejectsCode(missing.adapter.command(action), 'profile_required');
    assert.equal(missing.records.phones.length, 0);
    for (const config of [{ approvedAppVersion: '9.9.9' }, { vehicleMarker: 'Ihr Fahrzeug: Other car. ' }]) {
        const f = await fixture(t, { enrollment: enrolled(), config });
        await rejectsCode(f.adapter.command('start'), 'profile_mismatch');
        assert.equal(f.records.phones.length, 0);
        assert.equal(f.ctas().length, 0);
    }
});

test('wrong phone, changed version, unsafe mode and disabled writes block real climate gestures', async t => {
    const scenarios = [[{ deviceId: 'serial:OTHER-TEST-PHONE' }, 'wifi_wrong_device'],
        [{ versions: ['9.9.9'] }, 'version_not_approved'], [{ mode: 'Scheibenheizung' }, 'unsafe_mode'],
        [{ config: { allowWrites: false } }, 'writes_disabled']];
    for (const [options, expected] of scenarios) {
        const f = await fixture(t, { enrollment: enrolled(), config: { allowWrites: true, ...options.config }, ...options });
        await rejectsCode(f.adapter.command('start'), expected);
        assert.equal(f.ctas().length, 0);
        assert.equal(f.records.stores[0].reservations, 0);
        assert.equal(f.value('climate.appState'), 'unknown');
        assert.equal(f.value('operation.lastResult'), 'failed');
    }
});

test('a start remains unknown until observed and competing requests never queue another gesture', async t => {
    const entered = deferred();
    const release = deferred();
    const f = await fixture(t, { enrollment: enrolled(), overviewEvidence: true, config: { allowWrites: true, outcomeTimeoutSeconds: 90 }, hooks: {
        async tap(phone, x, y) { if (y === 330) { entered.resolve(); await release.promise; } },
    } });
    t.after(() => release.resolve());
    const operation = f.adapter.command('start');
    await entered.promise;
    assert.equal(f.value('operation.busy'), true);
    assert.equal(f.adapter.controller.config.commandTimeoutSeconds, 300);
    assert.equal(f.adapter.controller.config.outcomeTimeoutSeconds, 90);
    assert.equal(f.value('climate.appState'), 'unknown');
    assert.ok(!f.adapter.writes.some(row => row.id === 'climate.appState' && row.value.val === 'on'));
    await rejectsCode(f.adapter.command('stop'), 'busy');
    assert.equal(f.ctas().length, 1);
    release.resolve();
    const result = await operation;
    assert.equal(result.appState, 'on');
    assert.equal(result.confirmationSource, 'app_overview');
    assert.equal(f.value('climate.appState'), 'on');
    assert.equal(f.value('climate.confirmationSource'), 'app_overview');
    assert.equal(f.value('climate.vehicleConfirmed'), false);
    assert.deepEqual(f.adapter.states.get('climate.active'), { val: true, ack: true });
    assert.equal(f.value('operation.busy'), false);
    assert.equal(f.records.stores[0].reservations, 1);
    assert.equal(f.ctas().length, 1);
});

test('keepAwake is an explicit setup operation and automatic application remains opt-in', async t => {
    const f = await fixture(t, { enrollment: enrolled() });
    assert.equal(f.records.phones.length, 0);
    singleAdminSuccess('_keepAwake', await f.message('keepAwake', { hostIp: HOST, connectPort: PORT }), 'keep_awake_applied');
    assert.deepEqual(f.records.phones[0].calls.map(call => call[0]), ['connect', 'keepAwake']);
    assert.equal(f.ctas().length, 0);
    await f.adapter.command('status');
    assert.equal(f.records.phones[1].calls.some(call => call[0] === 'keepAwake'), false);
});

test('temperature selection is privately staged and acknowledged without operating the phone, including while runtime is missing', async t => {
    const f = await fixture(t, { runtimeMissing: true });
    const callsBefore = clone(f.records.runtime[0].calls);
    await f.adapter.onStateChange('vw-app.0.climate.targetTemperature', { val: 22.5, ack: false });
    assert.equal(f.value('climate.targetTemperature'), 22.5);
    assert.deepEqual(f.adapter.states.get('climate.targetTemperature'), { val: 22.5, ack: true });
    assert.deepEqual(f.memory['temperature-preference'], { targetCelsius: 22.5 });
    assert.equal(f.value('climate.temperature'), null);
    assert.equal(f.records.phones.length, 0);
    assert.deepEqual(f.records.runtime[0].calls, callsBefore);
    await f.adapter.onStateChange('vw-app.0.climate.targetTemperature', { val: 23, ack: true });
    assert.equal(f.value('climate.targetTemperature'), 22.5);
});

test('invalid staged values restore the last accepted preference and never cause app input', async t => {
    const f = await fixture(t);
    await f.adapter.stageTemperature(22.5);
    await f.adapter.state('operation.lastErrorCode', 'outcome_unknown');
    await f.adapter.state('operation.lastError', 'Earlier phone result was uncertain.');
    for (const value of [15.5, 30, 22.25, '22.5', 'null', true, NaN, Infinity, undefined]) {
        await f.adapter.onStateChange('vw-app.0.climate.targetTemperature', { val: value, ack: false });
        assert.deepEqual(f.adapter.states.get('climate.targetTemperature'), { val: 22.5, ack: true });
        assert.deepEqual(f.memory['temperature-preference'], { targetCelsius: 22.5 });
        assert.ok(f.value('climate.targetTemperatureError').startsWith('invalid_temperature:'));
        assert.equal(f.value('operation.lastErrorCode'), 'outcome_unknown');
        assert.equal(f.value('operation.lastError'), 'Earlier phone result was uncertain.');
    }
    await f.adapter.stageTemperature(23);
    assert.equal(f.value('climate.targetTemperatureError'), '');
    assert.equal(f.value('operation.lastErrorCode'), 'outcome_unknown');
    assert.equal(f.records.phones.length, 0);
    assert.equal(f.records.controllerCalls.length, 0);
});

test('saved temperature is restored without an initial reset and null explicitly preserves the app setting', async t => {
    const first = await fixture(t);
    await first.adapter.stageTemperature(23.5);
    const second = await fixture(t, { memory: first.memory });
    assert.deepEqual(second.adapter.writes.filter(row => row.id === 'climate.targetTemperature'), [
        { id: 'climate.targetTemperature', value: { val: 23.5, ack: true } },
    ]);
    await second.adapter.onStateChange('vw-app.0.commands.clearTemperature', { val: true, ack: false });
    assert.deepEqual(second.adapter.states.get('commands.clearTemperature'), { val: false, ack: true });
    assert.deepEqual(second.memory['temperature-preference'], { targetCelsius: null });
    assert.deepEqual(second.adapter.states.get('climate.targetTemperature'), { val: null, ack: true });
    await rejectsCode(second.adapter.command('setTemperature'), 'invalid_temperature');
    assert.equal(second.records.phones.length, 0);
});

test('failed preference persistence restores the accepted value and does not poison the later update queue', async t => {
    const f = await fixture(t, { storeWrite: async (name, value) => {
        if (name === 'temperature-preference' && value.targetCelsius === 23) throw new BridgeError('state_not_saved', 'The preference could not be saved.');
    } });
    await f.adapter.stageTemperature(22);
    await rejectsCode(f.adapter.stageTemperature(23), 'state_not_saved');
    assert.equal(f.value('climate.targetTemperature'), 22);
    assert.deepEqual(f.memory['temperature-preference'], { targetCelsius: 22 });
    await f.adapter.stageTemperature(24);
    assert.equal(f.value('climate.targetTemperature'), 24);
    assert.equal(f.records.phones.length, 0);
});

test('a failed pending selection blocks an immediately submitted start or apply until explicit reselect or clear', async t => {
    for (const kind of ['invalid', 'persistence']) {
        const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true },
            storeWrite: async (name, value) => {
                if (name === 'temperature-preference' && value.targetCelsius === 23 && kind === 'persistence') {
                    throw new BridgeError('state_not_saved', 'The preference could not be saved.');
                }
            },
        });
        await f.adapter.stageTemperature(22);
        const selection = f.adapter.stageTemperature(kind === 'invalid' ? 22.25 : 23);
        const immediateStart = f.adapter.command('start');
        await rejectsCode(selection, kind === 'invalid' ? 'invalid_temperature' : 'state_not_saved');
        await rejectsCode(immediateStart, 'temperature_selection_failed');
        await rejectsCode(f.adapter.command('setTemperature'), 'temperature_selection_failed');
        assert.equal(f.records.phones.length, 0);
        assert.equal(f.records.controllerCalls.length, 0);
        assert.equal(f.value('climate.targetTemperature'), 22);
        await f.adapter.command('status');
        await f.adapter.command('stop');
        assert.deepEqual(f.records.controllerCalls.map(call => call.action), ['status', 'stop']);
        if (kind === 'invalid') await f.adapter.stageTemperature(23.5);
        else await f.adapter.onStateChange('vw-app.0.commands.clearTemperature', { val: true, ack: false });
        assert.equal(f.adapter.temperatureUpdateFailed, false);
        await f.adapter.command('start');
        assert.deepEqual(f.records.controllerCalls.at(-1), { action: 'start', input: { targetTemperature: kind === 'invalid' ? 23.5 : null } });
    }
});

test('a damaged stored preference blocks commands until a valid selection is explicitly saved', async t => {
    const f = await fixture(t, { enrollment: enrolled(), memory: { 'temperature-preference': { targetCelsius: '22.5' } },
        config: { allowWrites: true }, fakeController: true });
    assert.equal(f.value('operation.lastErrorCode'), 'invalid_state');
    assert.ok(f.adapter.subscriptions.some(([kind, pattern]) => kind === 'own' && pattern === 'climate.targetTemperature'));
    await rejectsCode(f.adapter.command('start'), 'invalid_state');
    assert.equal(f.records.phones.length, 0);
    await f.adapter.command('status');
    assert.equal(f.records.controllerCalls[0].action, 'status');
    f.records.controllerCalls.length = 0;
    await f.adapter.stageTemperature(22.5);
    await f.adapter.command('start');
    assert.deepEqual(f.records.controllerCalls, [{ action: 'start', input: { targetTemperature: 22.5 } }]);
});

test('temperature-only apply requires a non-null selection and write permission before phone access', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true });
    await rejectsCode(f.adapter.command('setTemperature'), 'invalid_temperature');
    await f.adapter.stageTemperature(22.5);
    await rejectsCode(f.adapter.command('setTemperature'), 'writes_disabled');
    assert.equal(f.records.phones.length, 0);
    assert.equal(f.records.controllerCalls.length, 0);
    f.adapter.settings.allowWrites = true;
    await f.adapter.onStateChange('vw-app.0.commands.setTemperature', { val: true, ack: false });
    assert.deepEqual(f.records.controllerCalls, [{ action: 'setTemperature', input: { targetTemperature: 22.5 } }]);
    assert.deepEqual(f.adapter.states.get('commands.setTemperature'), { val: false, ack: true });
    assert.equal(f.value('climate.temperature'), 22.5);
    assert.equal(f.value('climate.vehicleConfirmed'), false);
    assert.equal(f.ctas().length, 0);
});

test('a start waits for previous preference persistence but later staging cannot change the accepted job snapshot', async t => {
    const writing = deferred(); const save = deferred(); const executing = deferred(); const finish = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true },
        storeWrite: async (name, value) => {
            if (name === 'temperature-preference' && value.targetCelsius === 22.5) { writing.resolve(); await save.promise; }
        },
        controllerExecute: async (action, input) => {
            executing.resolve(); await finish.promise;
            return { appState: 'on', appVersion: '4.8.1', observedAt: new Date().toISOString(), temperature: input.targetTemperature };
        },
    });
    t.after(() => { save.resolve(); finish.resolve(); });
    const firstSelection = f.adapter.stageTemperature(22.5);
    await writing.promise;
    const start = f.adapter.command('start');
    const nextSelection = f.adapter.stageTemperature(23);
    assert.equal(f.records.controllerCalls.length, 0);
    assert.equal(f.records.phones.length, 0);
    save.resolve(); await firstSelection; await nextSelection; await executing.promise;
    assert.equal(f.value('climate.targetTemperature'), 23);
    assert.equal(f.value('operation.busy'), true);
    await f.adapter.onStateChange('vw-app.0.climate.targetTemperature', { val: 22.25, ack: false });
    assert.equal(f.adapter.temperatureUpdateFailed, true);
    assert.equal(f.value('operation.lastResult'), 'running');
    assert.equal(f.value('operation.lastErrorCode'), '');
    assert.equal(f.value('operation.lastError'), '');
    await f.adapter.onStateChange('vw-app.0.commands.clearTemperature', { val: true, ack: false });
    assert.equal(f.adapter.temperatureUpdateFailed, false);
    assert.equal(f.value('climate.targetTemperature'), null);
    assert.deepEqual(f.memory['temperature-preference'], { targetCelsius: null });
    assert.deepEqual(f.records.controllerCalls, [{ action: 'start', input: { targetTemperature: 22.5 } }]);
    finish.resolve(); await start;
    assert.equal(f.value('climate.temperature'), 22.5);
    assert.equal(f.value('climate.targetTemperature'), null);
});

test('status and stop complete real simulated phone operations while a preference write is still blocked', { timeout: 2000 }, async t => {
    const writing = deferred(); const save = deferred();
    const f = await fixture(t, { enrollment: enrolled(), appState: 'on', config: { allowWrites: true },
        storeWrite: async name => {
            if (name === 'temperature-preference') { writing.resolve(); await save.promise; }
        },
    });
    t.after(() => save.resolve());
    const selection = f.adapter.stageTemperature(22.5);
    await writing.promise;
    const status = await f.adapter.command('status');
    assert.equal(status.appState, 'on');
    assert.ok(f.records.phones[0].calls.some(call => call[0] === 'connect'));
    const stopped = await f.adapter.command('stop');
    assert.equal(stopped.appState, 'off');
    assert.ok(f.records.phones[1].calls.some(call => call[0] === 'connect'));
    assert.equal(f.ctas().length, 1);
    assert.equal(f.memory['temperature-preference'], undefined);
    assert.equal(f.adapter.targetTemperature, null);
    save.resolve(); await selection;
    assert.deepEqual(f.memory['temperature-preference'], { targetCelsius: 22.5 });
});

test('unload waits for an in-flight preference write so restart restores the saved selection', async t => {
    const writing = deferred(); const save = deferred();
    const f = await fixture(t, { storeWrite: async name => {
        if (name === 'temperature-preference') { writing.resolve(); await save.promise; }
    } });
    t.after(() => save.resolve());
    const selection = f.adapter.stageTemperature(22.5);
    await writing.promise;
    let unloaded = false;
    const unload = f.adapter.onUnload(() => { unloaded = true; });
    await Promise.resolve();
    assert.equal(unloaded, false);
    save.resolve(); await selection; await unload;
    assert.equal(unloaded, true);
    assert.deepEqual(f.memory['temperature-preference'], { targetCelsius: 22.5 });
    const restarted = await fixture(t, { memory: f.memory });
    assert.equal(restarted.value('climate.targetTemperature'), 22.5);
});

test('a stuck preference write cannot keep unload waiting beyond the bounded shutdown timer', async t => {
    const writing = deferred(); const save = deferred(); const timerStarted = deferred();
    const f = await fixture(t, { storeWrite: async name => {
        if (name === 'temperature-preference') { writing.resolve(); await save.promise; }
    } });
    const originalSetTimeout = global.setTimeout;
    let expire;
    const mocked = t.mock.method(global, 'setTimeout', (callback, milliseconds, ...args) => {
        if (milliseconds === 3000) {
            expire = callback; timerStarted.resolve();
            return originalSetTimeout(() => {}, 3000);
        }
        return originalSetTimeout(callback, milliseconds, ...args);
    });
    const selection = f.adapter.stageTemperature(22.5);
    await writing.promise;
    let callbackCount = 0;
    const unload = f.adapter.onUnload(() => { callbackCount++; });
    await timerStarted.promise;
    expire(); await unload;
    assert.equal(callbackCount, 1);
    assert.equal(f.records.leases[0].closed, 1);
    mocked.mock.restore();
    save.resolve(); await selection;
});

test('observed temperatures remain separate, numeric, qualified and constrained to the verified picker range', async t => {
    const f = await fixture(t);
    const common = f.adapter.objects.get('climate.targetTemperature').common;
    assert.equal(common.name, 'Gewünschte Temperatur für nächsten Start');
    assert.equal(common.unit, '°C');
    assert.equal(common.min, MIN_TEMPERATURE_CELSIUS);
    assert.equal(common.max, MAX_TEMPERATURE_CELSIUS);
    assert.equal(common.step, TEMPERATURE_STEP_CELSIUS);
    await f.adapter.stageTemperature(21);
    await f.adapter.observation({ appState: 'off', appVersion: '4.8.1', observedAt: new Date().toISOString(), temperature: 22.5 });
    assert.deepEqual(f.adapter.states.get('climate.temperature'), { val: 22.5, ack: true });
    assert.equal(f.value('climate.targetTemperature'), 21);
    for (const temperature of [null, undefined, '22.5', NaN, 30]) {
        await f.adapter.observation({ appState: 'off', appVersion: '4.8.1', observedAt: new Date().toISOString(), temperature });
        assert.deepEqual(f.adapter.states.get('climate.temperature'), { val: null, ack: true, q: 0x82 });
    }
    assert.equal(f.value('climate.vehicleConfirmed'), false);
});

test('unload aborts operations, cancels controller, stops runtime and releases lease even when cleanup throws', async t => {
    for (const kind of ['none', 'runtime', 'lease', 'controller', 'state']) {
        const f = await fixture(t, { config: { pollIntervalSeconds: 300 },
            stopFailure: kind === 'runtime' ? new Error('SECRET STOP ERROR') : null,
            leaseFailure: kind === 'lease' ? new Error('SECRET LEASE ERROR') : null,
            shutdownStateFailure: kind === 'state' });
        let cancelled = 0;
        let callbackCount = 0;
        f.adapter.controller = { cancel() { cancelled++; if (kind === 'controller') throw new Error('SECRET CANCEL ERROR'); } };
        f.adapter.currentOperation = Promise.resolve();
        await f.adapter.state('info.connection', true);
        assert.equal(f.value('info.runtimeReady'), true);
        await f.adapter.onUnload(() => { callbackCount++; }).catch(() => {});
        assert.equal(callbackCount, 1, kind + ' failure must still acknowledge unload');
        assert.equal(f.adapter.abortController.signal.aborted, true);
        assert.equal(cancelled, 1);
        assert.equal(f.records.runtime[0].calls.filter(call => call[0] === 'stop').length, 1);
        assert.equal(f.records.leases[0].closed, 1, kind + ' failure must not skip lease release');
        assert.deepEqual(f.adapter.states.get('info.runtimeReady'), { val: false, ack: true });
        if (kind !== 'state') assert.deepEqual(f.adapter.states.get('info.connection'), { val: false, ack: true });
        assert.deepEqual(f.adapter.clearedIntervals, f.adapter.intervals);
        assert.ok(!JSON.stringify(f.adapter.logs).includes('SECRET'));
    }
});
