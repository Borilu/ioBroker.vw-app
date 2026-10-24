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
const { DEFAULT_TARGET_SETTINGS, SETTINGS_KEYS } = require('../lib/settings');
const { DEFAULT_TARGET_CHARGING, CHARGING_KEYS, MIN_TARGET_SOC, MAX_TARGET_SOC, TARGET_SOC_STEP } = require('../lib/charging');
const { REPORT_CATEGORIES } = require('../lib/vehicle-report');

const VEHICLE = 'Ihr Fahrzeug: ID.7 GTX Tourer. ';
const DEVICE = 'serial:TEST-ADAPTER-42';
const SETTING_TARGETS = { mode: 'climate.targetMode', climateOnUnlock: 'climate.targetClimateOnUnlock',
    autoWindowHeating: 'climate.targetAutoWindowHeating', zones: 'climate.targetZones' };
const SETTING_OBSERVED = { mode: 'climate.mode', climateOnUnlock: 'climate.climateOnUnlock',
    autoWindowHeating: 'climate.autoWindowHeating', zones: 'climate.zones' };
const CHARGING_TARGETS = { socLimit: 'charging.targetSoc', reducedAcCurrent: 'charging.targetReducedAcCurrent',
    autoUnlockAc: 'charging.targetAutoUnlockAc', optimizedBatteryUse: 'charging.targetOptimizedBatteryUse' };
const CHARGING_OBSERVED = { socLimit: 'charging.socLimit', reducedAcCurrent: 'charging.reducedAcCurrent',
    autoUnlockAc: 'charging.autoUnlockAc', optimizedBatteryUse: 'charging.optimizedBatteryUse' };
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
function fakeClock(start = Date.parse('2026-10-24T19:00:00.000Z')) {
    let current = start; let sequence = 0; const timers = new Map();
    const settle = async () => { for (let index = 0; index < 700; index++) await Promise.resolve(); };
    return { now: () => current, timers,
        setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { at: current + delay, callback }); return id; },
        clearTimeout(id) { timers.delete(id); },
        async advance(milliseconds) {
            const target = current + milliseconds;
            while (true) {
                const next = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
                if (!next) break;
                current = next[1].at; timers.delete(next[0]); await next[1].callback(); await settle();
            }
            current = target; await settle();
        }, settle };
}
class RecordingScheduler {
    constructor(options) { this.options = options; this.requests = []; this.available = 0; this.started = false; }
    start() { this.started = true; }
    stop() { this.started = false; }
    notifyAvailable() { this.available++; }
    request(domain, options) { this.requests.push({ domain, ...options }); return this.started; }
    snapshot() { return { runningDomain: null, estimatedCycleMs: 112500, domains: {} }; }
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
            this.states = new Map(Object.entries(clone(options.initialStates || {}))); this.objects = new Map(); this.writes = [];
            this.foreignObjects = new Map(); this.foreignWrites = []; this.subscriptions = [];
            this.logs = []; this.responses = []; this.intervals = []; this.clearedIntervals = [];
            this.log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, message => this.logs.push({ level, message })]));
        }
        async setObjectNotExistsAsync(id, value) { if (!this.objects.has(id)) this.objects.set(id, clone(value)); }
        async getStateAsync(id) { return clone(this.states.get(id) || null); }
        async setStateAsync(id, value) {
            if (this.stopping && id === 'info.connection' && options.shutdownStateFailure) throw new Error('SECRET STATE WRITE ERROR');
            if (options.stateWrite) await options.stateWrite(id, value, this);
            this.writes.push({ id, value: clone(value) }); this.states.set(id, clone(value));
        }
        async subscribeStatesAsync(pattern) { this.subscriptions.push(['own', pattern]); }
        async subscribeForeignStatesAsync(pattern) { this.subscriptions.push(['foreign', pattern]); }
        async getForeignObjectAsync(id) { return this.foreignObjects.get(id) || null; }
        async setForeignStateAsync(id, value) { this.foreignWrites.push({ id, value: clone(value) }); }
        sendTo(from, command, message, callback) { this.responses.push({ from, command, message: clone(message), callback }); }
        setInterval(callback, milliseconds) { const timer = { callback, milliseconds }; this.intervals.push(timer); return timer; }
        clearInterval(timer) { this.clearedIntervals.push(timer); }
        setTimeout(callback, milliseconds) { return options.clock ? options.clock.setTimeout(callback, milliseconds) : setTimeout(callback, milliseconds); }
        clearTimeout(timer) { if (options.clock) options.clock.clearTimeout(timer); else clearTimeout(timer); }
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
            const observedAt = new Date(options.clock ? options.clock.now() : Date.now()).toISOString();
            if (['chargingStatus', 'applyChargingSettings', 'synchronize'].includes(action)) return { ...chargingResult(input.targetCharging), ...(options.clock ? { observedAt } : {}) };
            if (action === 'vehicleReportStatus') return { ...vehicleReportResult(), ...(options.clock ? { observedAt } : {}) };
            return { appState: environment.appState, appVersion: '4.8.1', vehicleConfirmed: false,
                observedAt, temperature: input.targetTemperature,
                confirmationSource: 'app_controls' };
        }
        cancel() { this.cancelled = true; if (options.controllerCancel) options.controllerCancel(this); }
    }

    const utils = { Adapter: FakeAdapter, getAbsoluteInstanceDataDir: () => root };
    const Adapter = createAdapterClass(utils, { Runtime: FakeRuntime, Phone: FakePhone, Store: FakeStore, Lease: FakeLease,
        ...(options.clock ? { now: options.clock.now } : {}),
        ...(options.RefreshScheduler ? { RefreshScheduler: options.RefreshScheduler } : {}),
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
function expectedCall(action, targetTemperature, targetSettings = DEFAULT_TARGET_SETTINGS) {
    return { action, input: { targetTemperature,
        ...(['start', 'applySettings'].includes(action) ? { targetSettings: { ...targetSettings } } : {}) } };
}
function expectedChargingCall(action, targetCharging = DEFAULT_TARGET_CHARGING) {
    return { action, input: { targetCharging: { ...targetCharging } } };
}
function chargingResult(charging = DEFAULT_TARGET_CHARGING) {
    return { domain: 'charging', appVersion: '4.8.1', observedAt: '2026-10-24T16:00:00.000Z',
        battery: { soc: 52, rangeKm: 205 }, charging: { ...charging } };
}
function vehicleReportModel() {
    return { odometerText: '12.345 km', odometerKm: 12345,
        nextServiceText: '123 Tage', nextServiceDays: 123, nextServiceKm: null,
        summary: 'Keine Meldungen', hasMessages: false, messageCount: 0,
        synchronizationText: 'Gerade synchronisiert', notice: 'Hinweise in der App beachten.',
        additionalTexts: ['Zusätzlicher sichtbarer Berichttext'],
        categories: Object.fromEntries(Object.entries(REPORT_CATEGORIES)
            .map(([key, label]) => [key, { label, status: 'no_messages', texts: [] }])) };
}
function vehicleReportResult(vehicleReport = vehicleReportModel()) {
    return { domain: 'vehicleReport', source: 'volkswagen_android_app', vehicleConfirmed: false,
        appVersion: '4.8.1', observedAt: '2026-10-24T19:00:00.000Z', vehicleReport };
}
function reportStates(f) { return new Map([...f.adapter.states].filter(([id]) => id.startsWith('vehicleReport.'))); }
function assertReportInvalid(f, previous = null) {
    for (const [id, definition] of Object.entries(DEFINITIONS).filter(([key]) => key.startsWith('vehicleReport.'))) {
        if (id === 'vehicleReport.observedAt' && previous) assert.deepEqual(f.adapter.states.get(id), previous.get(id));
        else assert.deepEqual(f.adapter.states.get(id), { val: previous ? previous.get(id).val : definition[2], ack: true, q: 0x82 }, id);
    }
}

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
    for (const [id, [type, role, initial, write]] of Object.entries(DEFINITIONS)) {
        const object = f.adapter.objects.get(id);
        assert.equal(object.type, 'state');
        assert.equal(object.common.type, type);
        assert.equal(object.common.role, role);
        assert.equal(object.common.write, write);
        assert.equal(f.adapter.states.get(id).ack, true);
        if (f.value(id) === null) assert.equal(initial, null);
        else assert.equal(typeof f.value(id), type);
    }
    await f.adapter.observation({ appState: 'on', appVersion: '4.8.1', observedAt: new Date().toISOString(), confirmationSource: 'app_overview' });
    await f.adapter.failure(new Error('SECRET PHONE DUMP'));
    assert.deepEqual(f.adapter.states.get('climate.active'), { val: true, ack: true, q: 0x82 });
    assert.equal(f.value('climate.appState'), 'on');
    assert.equal(f.value('climate.confirmationSource'), 'app_overview');
    assert.notEqual(f.value('operation.lastUpdated'), '');
    assert.equal(f.value('refresh.climate.status'), 'error');
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
    for (const name of ['start', 'stop', 'refresh', 'setTemperature', 'clearTemperature', 'applySettings', 'clearSettings',
        'refreshCharging', 'applyChargingSettings', 'clearChargingSettings', 'synchronize', 'refreshVehicleReport']) {
        await f.adapter.onStateChange('vw-app.0.commands.' + name, { val: true, ack: false });
        assert.deepEqual(f.adapter.states.get('commands.' + name), { val: false, ack: true });
    }
    assert.deepEqual(actions, ['start', 'stop', 'status', 'setTemperature', 'applySettings', 'chargingStatus', 'applyChargingSettings', 'synchronize', 'vehicleReportStatus']);
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
    const delegated = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { stayAwakeOnCharge: true } });
    await delegated.adapter.command('status');
    assert.equal(delegated.records.controllers[0].config.stayAwakeOnCharge, true);
    assert.deepEqual(delegated.records.phones[0].calls, []);
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
        assert.deepEqual(f.records.controllerCalls.at(-1), expectedCall('start', kind === 'invalid' ? 23.5 : null));
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
    assert.deepEqual(f.records.controllerCalls, [expectedCall('start', 22.5)]);
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
    assert.deepEqual(f.records.controllerCalls, [expectedCall('start', 22.5)]);
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

test('four climate settings stage strictly and persist explicit false without touching the phone', async t => {
    const f = await fixture(t, { runtimeMissing: true });
    const wishes = { mode: 'windowHeating', climateOnUnlock: false, autoWindowHeating: true, zones: 'frontRight' };
    for (const [key, value] of Object.entries(wishes)) {
        await f.adapter.onStateChange('vw-app.0.' + SETTING_TARGETS[key], { val: value, ack: false });
        assert.deepEqual(f.adapter.states.get(SETTING_TARGETS[key]), { val: value, ack: true });
    }
    assert.deepEqual(f.memory['settings-preference'], wishes);
    assert.equal(f.records.phones.length, 0);
    assert.deepEqual(f.records.runtime[0].calls, [['start']]);
    assert.equal(f.value('climate.targetSettingsError'), '');
    await f.adapter.onStateChange('vw-app.0.climate.targetClimateOnUnlock', { val: true, ack: true });
    assert.equal(f.value('climate.targetClimateOnUnlock'), false);
});

test('settings restart restores all wishes and clearSettings atomically preserves the app values without clearing temperature', async t => {
    const selected = { mode: 'climate', climateOnUnlock: false, autoWindowHeating: true, zones: 'both' };
    const f = await fixture(t, { memory: { 'settings-preference': selected, 'temperature-preference': { targetCelsius: 22.5 } } });
    for (const [key, value] of Object.entries(selected)) {
        assert.deepEqual(f.adapter.writes.filter(row => row.id === SETTING_TARGETS[key]), [
            { id: SETTING_TARGETS[key], value: { val: value, ack: true } },
        ]);
    }
    const before = f.records.stores[0].writes.length;
    await f.adapter.onStateChange('vw-app.0.commands.clearSettings', { val: true, ack: false });
    assert.deepEqual(f.memory['settings-preference'], DEFAULT_TARGET_SETTINGS);
    assert.equal(f.records.stores[0].writes.length, before + 1);
    assert.deepEqual(f.adapter.states.get('commands.clearSettings'), { val: false, ack: true });
    assert.equal(f.value('climate.targetTemperature'), 22.5);
    assert.equal(f.records.phones.length, 0);
    const restarted = await fixture(t, { memory: f.memory });
    assert.deepEqual(restarted.adapter.targetSettings, DEFAULT_TARGET_SETTINGS);
});

test('an invalid mode blocks immediate apply and another successful field cannot heal its error', async t => {
    const f = await fixture(t, { enrollment: enrolled(), config: { allowWrites: true }, fakeController: true });
    await f.adapter.stageSetting('mode', 'climate');
    const rejectedSelection = f.adapter.stageSetting('mode', 'INVALID');
    const apply = f.adapter.command('applySettings');
    const other = f.adapter.stageSetting('zones', 'both');
    await rejectsCode(rejectedSelection, 'invalid_settings');
    await rejectsCode(apply, 'settings_selection_failed');
    await other;
    await rejectsCode(f.adapter.command('start'), 'settings_selection_failed');
    assert.equal(f.records.phones.length, 0);
    assert.equal(f.value('climate.targetMode'), 'climate');
    assert.equal(f.value('climate.targetZones'), 'both');
    assert.ok(f.value('climate.targetSettingsError').includes('mode: invalid_settings:'));
    await f.adapter.stageSetting('mode', 'windowHeating');
    assert.equal(f.value('climate.targetSettingsError'), '');
    await f.adapter.command('applySettings');
    assert.deepEqual(f.records.controllerCalls, [expectedCall('applySettings', null, {
        mode: 'windowHeating', climateOnUnlock: null, autoWindowHeating: null, zones: 'both',
    })]);
});

test('settings persistence errors remain isolated per field and clearSettings explicitly repairs them', async t => {
    const f = await fixture(t, { enrollment: enrolled(), config: { allowWrites: true }, fakeController: true,
        storeWrite: async (name, value) => {
            if (name === 'settings-preference' && value.autoWindowHeating === true) throw new BridgeError('state_not_saved', 'Settings could not be saved.');
        },
    });
    await f.adapter.state('operation.lastErrorCode', 'outcome_unknown');
    await f.adapter.state('operation.lastError', 'Previous phone feedback was unclear.');
    await rejectsCode(f.adapter.stageSetting('autoWindowHeating', true), 'state_not_saved');
    await f.adapter.stageSetting('climateOnUnlock', false);
    assert.equal(f.value('operation.lastErrorCode'), 'outcome_unknown');
    assert.equal(f.value('operation.lastError'), 'Previous phone feedback was unclear.');
    assert.equal(f.value('climate.targetClimateOnUnlock'), false);
    assert.equal(f.adapter.settingsUpdateFailed.autoWindowHeating, true);
    await rejectsCode(f.adapter.command('applySettings'), 'settings_selection_failed');
    assert.equal(f.records.phones.length, 0);
    await f.adapter.clearSettings();
    assert.equal(f.value('climate.targetSettingsError'), '');
    await rejectsCode(f.adapter.command('applySettings'), 'settings_required');
    assert.equal(f.records.phones.length, 0);
    await f.adapter.stageSetting('mode', 'climate');
    await f.adapter.command('applySettings');
    assert.deepEqual(f.records.controllerCalls, [expectedCall('applySettings', null, { ...DEFAULT_TARGET_SETTINGS, mode: 'climate' })]);
});

test('repairing another saved setting does not erase a damaged mode on disk or after restart', async t => {
    const damaged = { mode: 'BROKEN', climateOnUnlock: false, autoWindowHeating: true, zones: 'frontLeft' };
    const f = await fixture(t, { memory: { 'settings-preference': damaged } });
    assert.equal(f.adapter.settingsPreferenceReady.mode, false);
    assert.equal(f.adapter.settingsPreferenceReady.climateOnUnlock, true);
    await f.adapter.stageSetting('zones', 'both');
    assert.equal(f.memory['settings-preference'].mode, 'BROKEN');
    const restarted = await fixture(t, { enrollment: enrolled(), memory: f.memory, config: { allowWrites: true }, fakeController: true });
    await rejectsCode(restarted.adapter.command('applySettings'), 'invalid_state');
    assert.equal(restarted.records.phones.length, 0);
    assert.deepEqual(restarted.adapter.states.get('climate.targetMode'), { val: null, ack: true, q: 0x82 });
    await restarted.adapter.stageSetting('mode', 'climate');
    await restarted.adapter.command('applySettings');
    assert.deepEqual(restarted.records.controllerCalls, [expectedCall('applySettings', null, { ...damaged, mode: 'climate', zones: 'both' })]);
});

test('a non-finite damaged setting cannot become a valid null through an unrelated JSON save', async t => {
    const f = await fixture(t, { memory: { 'settings-preference': { ...DEFAULT_TARGET_SETTINGS, mode: Infinity } } });
    await f.adapter.stageSetting('zones', 'both');
    const onDisk = JSON.parse(JSON.stringify(f.memory['settings-preference']));
    const restarted = await fixture(t, { memory: { 'settings-preference': onDisk } });
    assert.equal(restarted.adapter.settingsPreferenceReady.mode, false);
    assert.equal(restarted.adapter.settingsUpdateFailed.mode, true);
    assert.equal(restarted.value('climate.targetZones'), 'both');
});

test('missing settings observations are unknown and explicit observed false is never treated as missing', async t => {
    const f = await fixture(t);
    const base = { appState: 'off', appVersion: '4.8.1', observedAt: new Date().toISOString() };
    await f.adapter.observation(base);
    for (const id of Object.values(SETTING_OBSERVED)) assert.deepEqual(f.adapter.states.get(id), { val: null, ack: true, q: 0x82 });
    const observed = { mode: 'climate', climateOnUnlock: false, autoWindowHeating: true, zones: 'frontRight' };
    await f.adapter.observation({ ...base, settings: observed });
    for (const [key, value] of Object.entries(observed)) assert.deepEqual(f.adapter.states.get(SETTING_OBSERVED[key]), { val: value, ack: true });
    await f.adapter.observation({ ...base, settings: { ...observed, zones: 'none' } });
    assert.deepEqual(f.adapter.states.get('climate.zones'), { val: 'none', ack: true });
    assert.equal(f.adapter.objects.get('climate.targetZones').common.states.none, undefined);
    assert.equal(typeof f.adapter.objects.get('climate.zones').common.states.none, 'string');
    await f.adapter.observation({ ...base, settings: { mode: 'INVALID', climateOnUnlock: 'false', autoWindowHeating: false, zones: 'left' } });
    assert.deepEqual(f.adapter.states.get('climate.autoWindowHeating'), { val: false, ack: true });
    for (const id of ['climate.mode', 'climate.climateOnUnlock', 'climate.zones']) assert.deepEqual(f.adapter.states.get(id), { val: null, ack: true, q: 0x82 });
    assert.equal(f.value('climate.vehicleConfirmed'), false);
});

test('applySettings needs write permission and depends only on settings, not a pending temperature write', { timeout: 2000 }, async t => {
    const writing = deferred(); const save = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        storeWrite: async name => { if (name === 'temperature-preference') { writing.resolve(); await save.promise; } },
    });
    t.after(() => save.resolve());
    await f.adapter.stageSetting('mode', 'climate');
    await rejectsCode(f.adapter.command('applySettings'), 'writes_disabled');
    assert.equal(f.records.phones.length, 0);
    f.adapter.settings.allowWrites = true;
    const selection = f.adapter.stageTemperature(22.5); await writing.promise;
    await f.adapter.command('applySettings');
    assert.deepEqual(f.records.controllerCalls, [expectedCall('applySettings', null, { ...DEFAULT_TARGET_SETTINGS, mode: 'climate' })]);
    assert.equal(f.memory['temperature-preference'], undefined);
    save.resolve(); await selection;
});

test('temperature-only apply, status and stop do not depend on a pending settings write', { timeout: 2000 }, async t => {
    const writing = deferred(); const save = deferred();
    const f = await fixture(t, { enrollment: enrolled(), config: { allowWrites: true }, fakeController: true,
        storeWrite: async name => { if (name === 'settings-preference') { writing.resolve(); await save.promise; } },
    });
    t.after(() => save.resolve());
    await f.adapter.stageTemperature(22.5);
    const selection = f.adapter.stageSetting('mode', 'climate'); await writing.promise;
    await f.adapter.command('setTemperature'); await f.adapter.command('status'); await f.adapter.command('stop');
    assert.deepEqual(f.records.controllerCalls, [expectedCall('setTemperature', 22.5), expectedCall('status', null), expectedCall('stop', null)]);
    assert.equal(f.memory['settings-preference'], undefined);
    save.resolve(); await selection;
});

test('an explicit window-heating start ignores failed and still-pending temperature selections', { timeout: 2000 }, async t => {
    const writing = deferred(); const save = deferred();
    const f = await fixture(t, { enrollment: enrolled(), config: { allowWrites: true }, fakeController: true,
        storeWrite: async (name, value) => { if (name === 'temperature-preference' && value.targetCelsius === 23) { writing.resolve(); await save.promise; } },
    });
    t.after(() => save.resolve());
    await f.adapter.stageSetting('mode', 'windowHeating');
    await rejectsCode(f.adapter.stageTemperature(22.25), 'invalid_temperature');
    await f.adapter.command('start');
    const pending = f.adapter.stageTemperature(23); await writing.promise;
    await f.adapter.command('start');
    assert.deepEqual(f.records.controllerCalls, [expectedCall('start', null, { ...DEFAULT_TARGET_SETTINGS, mode: 'windowHeating' }),
        expectedCall('start', null, { ...DEFAULT_TARGET_SETTINGS, mode: 'windowHeating' })]);
    assert.equal(f.memory['temperature-preference'], undefined);
    save.resolve(); await pending;
});

test('a settings snapshot waits for prior saves but later field changes and failures cannot alter the accepted job', async t => {
    const writing = deferred(); const save = deferred(); const executing = deferred(); const finish = deferred();
    const f = await fixture(t, { enrollment: enrolled(), config: { allowWrites: true }, fakeController: true,
        storeWrite: async (name, value) => { if (name === 'settings-preference' && value.mode === 'climate' && value.zones === null) { writing.resolve(); await save.promise; } },
        controllerExecute: async (action, input) => {
            executing.resolve(); await finish.promise;
            return { appState: 'off', appVersion: '4.8.1', observedAt: new Date().toISOString(), settings: input.targetSettings };
        },
    });
    t.after(() => { save.resolve(); finish.resolve(); });
    const prior = f.adapter.stageSetting('mode', 'climate'); await writing.promise;
    const start = f.adapter.command('start');
    const next = f.adapter.stageSetting('zones', 'both');
    assert.equal(f.records.phones.length, 0);
    save.resolve(); await prior; await next; await executing.promise;
    await rejectsCode(f.adapter.stageSetting('climateOnUnlock', 'false'), 'invalid_settings');
    assert.equal(f.value('operation.lastResult'), 'running');
    assert.equal(f.value('operation.lastErrorCode'), '');
    assert.deepEqual(f.records.controllerCalls, [expectedCall('start', null, { ...DEFAULT_TARGET_SETTINGS, mode: 'climate' })]);
    finish.resolve(); await start;
    assert.equal(f.value('climate.targetZones'), 'both');
    assert.equal(f.value('climate.zones'), null);
    await rejectsCode(f.adapter.command('start'), 'settings_selection_failed');
});

test('unload waits for an in-flight settings save and restart restores it', async t => {
    const writing = deferred(); const save = deferred();
    const f = await fixture(t, { storeWrite: async name => {
        if (name === 'settings-preference') { writing.resolve(); await save.promise; }
    } });
    t.after(() => save.resolve());
    const selection = f.adapter.stageSetting('autoWindowHeating', false); await writing.promise;
    let unloaded = false;
    const unload = f.adapter.onUnload(() => { unloaded = true; });
    await Promise.resolve(); assert.equal(unloaded, false);
    save.resolve(); await selection; await unload;
    const restarted = await fixture(t, { memory: f.memory });
    assert.equal(restarted.value('climate.targetAutoWindowHeating'), false);
    assert.equal(unloaded, true);
});

test('charging selection metadata uses percent and kilometre units and staging never operates a phone', async t => {
    const f = await fixture(t, { runtimeMissing: true });
    const common = f.adapter.objects.get('charging.targetSoc').common;
    assert.deepEqual([common.type, common.write, common.unit, common.min, common.max, common.step],
        ['number', true, '%', MIN_TARGET_SOC, MAX_TARGET_SOC, TARGET_SOC_STEP]);
    assert.equal(f.adapter.objects.get('battery.soc').common.unit, '%');
    assert.equal(f.adapter.objects.get('battery.rangeKm').common.unit, 'km');
    for (const id of ['battery.soc', 'battery.rangeKm', ...Object.values(CHARGING_OBSERVED)]) {
        assert.deepEqual(f.adapter.states.get(id), { val: null, ack: true, q: 0x82 });
        assert.equal(f.adapter.objects.get(id).common.write, false);
    }
    const wishes = { socLimit: MAX_TARGET_SOC, reducedAcCurrent: false, autoUnlockAc: true, optimizedBatteryUse: false };
    for (const key of CHARGING_KEYS) {
        await f.adapter.onStateChange('vw-app.0.' + CHARGING_TARGETS[key], { val: wishes[key], ack: false });
        assert.deepEqual(f.adapter.states.get(CHARGING_TARGETS[key]), { val: wishes[key], ack: true });
        assert.ok(f.adapter.subscriptions.some(([kind, id]) => kind === 'own' && id === CHARGING_TARGETS[key]));
    }
    assert.deepEqual(f.memory['charging-preference'], wishes);
    assert.equal(f.value('charging.targetSettingsError'), '');
    assert.equal(f.records.phones.length, 0);
    assert.equal(f.memory['settings-preference'], undefined);
    assert.equal(f.memory['temperature-preference'], undefined);
});

test('charging writes and buttons require explicit ack=false and legacy aliases cannot apply them', async t => {
    const f = await fixture(t, { config: { legacyStatePrefix: '0_userdata.0.old_vw' } });
    const actions = [];
    f.adapter.command = async action => actions.push(action);
    for (const state of [{ val: MAX_TARGET_SOC }, { val: MAX_TARGET_SOC, ack: true }, { val: MAX_TARGET_SOC, ack: 0 }]) {
        await f.adapter.onStateChange('vw-app.0.charging.targetSoc', state);
    }
    for (const name of ['refreshCharging', 'applyChargingSettings', 'clearChargingSettings', 'synchronize']) {
        for (const state of [{ val: true }, { val: true, ack: true }, { val: true, ack: 'false' }, { val: false, ack: false }, { val: 1, ack: false }]) {
            await f.adapter.onStateChange('vw-app.0.commands.' + name, state);
        }
        await f.adapter.onStateChange('0_userdata.0.old_vw.' + name, { val: true, ack: false });
    }
    assert.deepEqual(actions, []);
    assert.equal(f.memory['charging-preference'], undefined);
});

test('charging restart restores saved wishes without resetting them and clearChargingSettings is atomic and domain-local', async t => {
    const selected = { socLimit: MIN_TARGET_SOC, reducedAcCurrent: true, autoUnlockAc: false, optimizedBatteryUse: true };
    const memory = { 'charging-preference': selected, 'temperature-preference': { targetCelsius: 22.5 },
        'settings-preference': { ...DEFAULT_TARGET_SETTINGS, mode: 'windowHeating' } };
    const f = await fixture(t, { memory });
    for (const key of CHARGING_KEYS) {
        assert.equal(f.value(CHARGING_TARGETS[key]), selected[key]);
        assert.ok(!f.adapter.writes.some(row => row.id === CHARGING_TARGETS[key] && row.value.val === null));
    }
    const before = f.records.stores[0].writes.length;
    await f.adapter.onStateChange('vw-app.0.commands.clearChargingSettings', { val: true, ack: false });
    assert.deepEqual(f.memory['charging-preference'], DEFAULT_TARGET_CHARGING);
    assert.equal(f.records.stores[0].writes.length, before + 1);
    assert.equal(f.value('climate.targetTemperature'), 22.5);
    assert.equal(f.value('climate.targetMode'), 'windowHeating');
    assert.equal(f.records.phones.length, 0);
    const restarted = await fixture(t, { memory: f.memory });
    for (const id of Object.values(CHARGING_TARGETS)) assert.equal(restarted.value(id), null);
});

test('invalid charging selection blocks immediate apply and a different successful field cannot heal its error', async t => {
    const f = await fixture(t, { enrollment: enrolled(), config: { allowWrites: true }, fakeController: true });
    await f.adapter.stageChargingSetting('socLimit', MIN_TARGET_SOC);
    const invalid = f.adapter.stageChargingSetting('socLimit', MIN_TARGET_SOC + TARGET_SOC_STEP / 2);
    const apply = f.adapter.command('applyChargingSettings');
    await rejectsCode(invalid, 'invalid_charging_settings');
    await rejectsCode(apply, 'charging_selection_failed');
    assert.equal(f.records.phones.length, 0);
    assert.equal(f.value('charging.targetSoc'), MIN_TARGET_SOC);
    await f.adapter.stageChargingSetting('autoUnlockAc', false);
    assert.ok(f.value('charging.targetSettingsError').includes('socLimit: invalid_charging_settings:'));
    await rejectsCode(f.adapter.command('applyChargingSettings'), 'charging_selection_failed');
    assert.equal(f.adapter.chargingUpdateFailed.autoUnlockAc, false);
    assert.equal(f.value('charging.targetAutoUnlockAc'), false);
    await f.adapter.stageChargingSetting('socLimit', MAX_TARGET_SOC);
    await f.adapter.command('applyChargingSettings');
    assert.equal(f.value('charging.targetSettingsError'), '');
    assert.deepEqual(f.records.controllerCalls, [expectedChargingCall('applyChargingSettings',
        { ...DEFAULT_TARGET_CHARGING, socLimit: MAX_TARGET_SOC, autoUnlockAc: false })]);
});

test('failed charging persistence blocks apply, keeps the accepted value, and explicit clear repairs it', async t => {
    let fail = false;
    const f = await fixture(t, { enrollment: enrolled(), config: { allowWrites: true }, fakeController: true,
        storeWrite: async name => { if (name === 'charging-preference' && fail) throw new Error('SECRET DISK PATH'); },
    });
    await f.adapter.stageChargingSetting('reducedAcCurrent', false);
    fail = true;
    const staging = f.adapter.stageChargingSetting('reducedAcCurrent', true);
    const apply = f.adapter.command('applyChargingSettings');
    await assert.rejects(staging);
    await rejectsCode(apply, 'charging_selection_failed');
    assert.equal(f.value('charging.targetReducedAcCurrent'), false);
    assert.equal(f.records.phones.length, 0);
    fail = false;
    await f.adapter.stageChargingSetting('autoUnlockAc', false);
    await rejectsCode(f.adapter.command('applyChargingSettings'), 'charging_selection_failed');
    await f.adapter.clearChargingSettings();
    assert.equal(f.value('charging.targetSettingsError'), '');
    await rejectsCode(f.adapter.command('applyChargingSettings'), 'charging_settings_required');
    await f.adapter.stageChargingSetting('optimizedBatteryUse', false);
    await f.adapter.command('applyChargingSettings');
    assert.ok(!JSON.stringify(f.adapter.logs).includes('SECRET'));
});

test('damaged charging fields survive unrelated saves and restart instead of silently becoming valid', async t => {
    const damaged = { ...DEFAULT_TARGET_CHARGING, socLimit: Infinity };
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, memory: { 'charging-preference': damaged } });
    assert.deepEqual(f.adapter.states.get('charging.targetSoc'), { val: null, ack: true, q: 0x82 });
    await f.adapter.stageChargingSetting('autoUnlockAc', false);
    const disk = JSON.parse(JSON.stringify(f.memory['charging-preference']));
    assert.equal(disk.socLimit, '__invalid_saved_setting__');
    const restarted = await fixture(t, { enrollment: enrolled(), fakeController: true, memory: { 'charging-preference': disk } });
    assert.equal(restarted.adapter.chargingPreferenceReady.socLimit, false);
    assert.equal(restarted.value('charging.targetAutoUnlockAc'), false);
    await rejectsCode(restarted.adapter.command('applyChargingSettings'), 'invalid_state');
    await restarted.adapter.command('status');
    await restarted.adapter.command('chargingStatus');
    assert.deepEqual(restarted.records.controllerCalls, [expectedCall('status', null), expectedChargingCall('chargingStatus')]);
    await restarted.adapter.clearChargingSettings();
    assert.equal(restarted.adapter.chargingPreferenceReady.socLimit, true);
});

test('applying charging settings requires a wish, write permission and a calibrated profile before phone access', async t => {
    const f = await fixture(t, { fakeController: true });
    await rejectsCode(f.adapter.command('applyChargingSettings'), 'charging_settings_required');
    await f.adapter.stageChargingSetting('optimizedBatteryUse', false);
    await rejectsCode(f.adapter.command('applyChargingSettings'), 'writes_disabled');
    f.adapter.settings.allowWrites = true;
    await rejectsCode(f.adapter.command('applyChargingSettings'), 'profile_required');
    f.memory.enrollment = enrolled();
    f.adapter.settings.approvedAppVersion = 'SECRET_EDIT';
    await rejectsCode(f.adapter.command('applyChargingSettings'), 'profile_mismatch');
    assert.equal(f.records.phones.length, 0);
    f.adapter.settings.approvedAppVersion = '';
    await f.adapter.command('applyChargingSettings');
    assert.deepEqual(f.records.controllerCalls, [expectedChargingCall('applyChargingSettings',
        { ...DEFAULT_TARGET_CHARGING, optimizedBatteryUse: false })]);
});

test('a charging snapshot waits for prior persistence while later selection and errors affect only the next job', async t => {
    const writing = deferred(); const save = deferred(); const executing = deferred(); const finish = deferred();
    const f = await fixture(t, { enrollment: enrolled(), config: { allowWrites: true }, fakeController: true,
        storeWrite: async (name, value) => { if (name === 'charging-preference' && value.socLimit === MIN_TARGET_SOC && value.autoUnlockAc === null) { writing.resolve(); await save.promise; } },
        controllerExecute: async (action, input) => { executing.resolve(); await finish.promise; return chargingResult(input.targetCharging); },
    });
    t.after(() => { save.resolve(); finish.resolve(); });
    const prior = f.adapter.stageChargingSetting('socLimit', MIN_TARGET_SOC); await writing.promise;
    const apply = f.adapter.command('applyChargingSettings');
    const next = f.adapter.stageChargingSetting('autoUnlockAc', false);
    assert.equal(f.records.phones.length, 0);
    save.resolve(); await prior; await next; await executing.promise;
    await rejectsCode(f.adapter.stageChargingSetting('reducedAcCurrent', 'false'), 'invalid_charging_settings');
    assert.equal(f.value('operation.lastResult'), 'running');
    assert.equal(f.value('operation.lastErrorCode'), '');
    assert.deepEqual(f.records.controllerCalls, [expectedChargingCall('applyChargingSettings', { ...DEFAULT_TARGET_CHARGING, socLimit: MIN_TARGET_SOC })]);
    finish.resolve(); await apply;
    assert.equal(f.value('charging.autoUnlockAc'), null);
    assert.equal(f.value('charging.targetAutoUnlockAc'), false);
    assert.equal(f.value('operation.lastResult'), 'succeeded');
    await rejectsCode(f.adapter.command('applyChargingSettings'), 'charging_selection_failed');
});

test('status, stop, climate writes and charging refresh do not wait for a pending charging preference save', { timeout: 2000 }, async t => {
    const writing = deferred(); const save = deferred();
    const f = await fixture(t, { enrollment: enrolled(), config: { allowWrites: true }, fakeController: true,
        storeWrite: async name => { if (name === 'charging-preference') { writing.resolve(); await save.promise; } },
    });
    t.after(() => save.resolve());
    await f.adapter.stageTemperature(22.5);
    await f.adapter.stageSetting('mode', 'climate');
    const selection = f.adapter.stageChargingSetting('socLimit', MAX_TARGET_SOC); await writing.promise;
    for (const action of ['status', 'stop', 'start', 'setTemperature', 'applySettings', 'chargingStatus']) await f.adapter.command(action);
    assert.deepEqual(f.records.controllerCalls, [expectedCall('status', null), expectedCall('stop', null),
        expectedCall('start', 22.5, { ...DEFAULT_TARGET_SETTINGS, mode: 'climate' }), expectedCall('setTemperature', 22.5),
        expectedCall('applySettings', null, { ...DEFAULT_TARGET_SETTINGS, mode: 'climate' }), expectedChargingCall('chargingStatus')]);
    assert.equal(f.memory['charging-preference'], undefined);
    const apply = f.adapter.command('applyChargingSettings');
    await Promise.resolve(); assert.equal(f.records.controllerCalls.length, 6);
    save.resolve(); await selection; await apply;
    assert.deepEqual(f.records.controllerCalls.at(-1), expectedChargingCall('applyChargingSettings', { ...DEFAULT_TARGET_CHARGING, socLimit: MAX_TARGET_SOC }));
});

test('applyChargingSettings does not wait for stuck temperature or climate-settings saves', { timeout: 2000 }, async t => {
    const temperatureWriting = deferred(); const settingsWriting = deferred(); const save = deferred();
    const f = await fixture(t, { enrollment: enrolled(), config: { allowWrites: true }, fakeController: true,
        storeWrite: async name => {
            if (name === 'temperature-preference') { temperatureWriting.resolve(); await save.promise; }
            if (name === 'settings-preference') { settingsWriting.resolve(); await save.promise; }
        },
    });
    t.after(() => save.resolve());
    await f.adapter.stageChargingSetting('reducedAcCurrent', false);
    const temperature = f.adapter.stageTemperature(22.5); const settings = f.adapter.stageSetting('mode', 'climate');
    await Promise.all([temperatureWriting.promise, settingsWriting.promise]);
    await f.adapter.command('applyChargingSettings');
    assert.deepEqual(f.records.controllerCalls, [expectedChargingCall('applyChargingSettings', { ...DEFAULT_TARGET_CHARGING, reducedAcCurrent: false })]);
    save.resolve(); await Promise.all([temperature, settings]);
});

test('charging success and failure preserve climate observations and legacy climate feedback exactly', async t => {
    let fail = false;
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { legacyStatePrefix: '0_userdata.0.vw' },
        controllerExecute: async () => { if (fail) throw new Error('SECRET PHONE DATA'); return chargingResult({ socLimit: 80, reducedAcCurrent: false, autoUnlockAc: true, optimizedBatteryUse: false }); },
    });
    f.adapter.foreignObjects.set('0_userdata.0.vw.appState', {});
    f.adapter.foreignObjects.set('0_userdata.0.vw.lastUpdated', {});
    await f.adapter.observation({ appState: 'on', appVersion: '4.8.1', temperature: 22.5, confirmationSource: 'app_overview',
        observedAt: '2026-10-24T15:00:00.000Z', settings: { mode: 'climate', climateOnUnlock: true, autoWindowHeating: true, zones: 'both' } });
    const before = new Map([...f.adapter.states].filter(([id]) => id.startsWith('climate.') || id === 'operation.lastUpdated'));
    const beforeLegacy = f.adapter.foreignWrites.filter(row => /\.(appState|lastUpdated)$/.test(row.id));
    await f.adapter.command('chargingStatus');
    assert.equal(f.value('battery.soc'), 52); assert.equal(f.value('battery.rangeKm'), 205);
    assert.equal(f.value('charging.reducedAcCurrent'), false);
    assert.equal(f.value('battery.observedAt'), '2026-10-24T16:00:00.000Z');
    const chargingBefore = new Map([...f.adapter.states].filter(([id]) => id.startsWith('battery.') || id.startsWith('charging.')));
    for (const [id, value] of before) assert.deepEqual(f.adapter.states.get(id), value, id);
    fail = true; await assert.rejects(f.adapter.command('chargingStatus'));
    assert.equal(f.value('operation.lastErrorCode'), 'internal_error');
    for (const [id, value] of before) assert.deepEqual(f.adapter.states.get(id), value, id);
    assert.deepEqual(f.adapter.foreignWrites.filter(row => /\.(appState|lastUpdated)$/.test(row.id)), beforeLegacy);
    for (const id of ['battery.soc', 'battery.rangeKm', ...Object.values(CHARGING_OBSERVED)]) {
        assert.deepEqual(f.adapter.states.get(id), { val: chargingBefore.get(id).val, ack: true, q: 0x82 });
    }
    assert.equal(f.value('battery.observedAt'), '2026-10-24T16:00:00.000Z');
    assert.ok(!JSON.stringify(f.adapter.logs).includes('SECRET'));
});

test('climate observations and failures preserve battery and charging state while malformed charging values are qualified unknown', async t => {
    const f = await fixture(t);
    await f.adapter.observation(chargingResult({ socLimit: 80, reducedAcCurrent: false, autoUnlockAc: true, optimizedBatteryUse: false }));
    const before = new Map([...f.adapter.states].filter(([id]) => id.startsWith('battery.') || id.startsWith('charging.')));
    await f.adapter.observation({ appState: 'off', appVersion: '4.8.1', observedAt: '2026-10-24T17:00:00.000Z' });
    await f.adapter.failure(new BridgeError('phone_locked', 'Unlock the phone.'));
    for (const [id, value] of before) assert.deepEqual(f.adapter.states.get(id), value, id);
    await f.adapter.observation({ domain: 'charging', battery: { soc: '52', rangeKm: -1 },
        charging: { socLimit: 101, reducedAcCurrent: 'false', autoUnlockAc: false }, observedAt: '2026-10-24T18:00:00.000Z' });
    for (const id of ['battery.soc', 'battery.rangeKm', 'charging.socLimit', 'charging.reducedAcCurrent', 'charging.optimizedBatteryUse']) {
        assert.deepEqual(f.adapter.states.get(id), { val: null, ack: true, q: 0x82 });
    }
    assert.deepEqual(f.adapter.states.get('charging.autoUnlockAc'), { val: false, ack: true });
    assert.equal(f.value('battery.observedAt'), '2026-10-24T16:00:00.000Z');
    assert.ok(f.adapter.writes.every(row => row.value.val !== undefined));
});

test('a charging command rejects an unexpected climate result without projecting it into climate states', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        controllerExecute: async () => ({ appState: 'on', appVersion: '4.8.1', observedAt: new Date().toISOString() }) });
    const before = f.adapter.states.get('climate.appState');
    await rejectsCode(f.adapter.command('chargingStatus'), 'invalid_state');
    assert.deepEqual(f.adapter.states.get('climate.appState'), before);
    assert.equal(f.value('battery.observedAt'), '');
});

test('synchronize is an explicit read request with no write permission or preference queue dependency', { timeout: 2000 }, async t => {
    const saves = deferred();
    const writing = { 'temperature-preference': deferred(), 'settings-preference': deferred(), 'charging-preference': deferred() };
    const requestedAt = '2026-10-24T18:00:00.000Z';
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        memory: { 'temperature-preference': { targetCelsius: 'INVALID' },
            'settings-preference': { ...DEFAULT_TARGET_SETTINGS, mode: 'INVALID' },
            'charging-preference': { ...DEFAULT_TARGET_CHARGING, socLimit: 'INVALID' } },
        storeWrite: async name => { if (writing[name]) { writing[name].resolve(); await saves.promise; } },
        controllerExecute: async () => ({ ...chargingResult(), syncRequestedAt: requestedAt }),
    });
    t.after(() => saves.resolve());
    const temperature = f.adapter.stageTemperature(22.5);
    const settings = f.adapter.stageSetting('mode', 'climate');
    const charging = f.adapter.stageChargingSetting('socLimit', MAX_TARGET_SOC);
    await Promise.all(Object.values(writing).map(value => value.promise));
    await f.adapter.onStateChange('vw-app.0.commands.synchronize', { val: true, ack: false });
    assert.equal(f.adapter.settings.allowWrites, false);
    assert.deepEqual(f.records.controllerCalls, [expectedChargingCall('synchronize')]);
    assert.deepEqual(f.adapter.states.get('commands.synchronize'), { val: false, ack: true });
    assert.equal(f.value('battery.lastSyncRequestAt'), requestedAt);
    assert.equal(f.value('battery.soc'), 52);
    assert.equal(f.value('climate.appState'), 'unknown');
    assert.equal(f.memory['charging-preference'].socLimit, 'INVALID');
    saves.resolve(); await Promise.all([temperature, settings, charging]);
});

test('last sync request changes only for a valid explicit result timestamp and survives reads, errors and restart', async t => {
    const requestedAt = '2026-10-24T18:00:00.000Z';
    const f = await fixture(t);
    assert.equal(f.adapter.objects.get('battery.lastSyncRequestAt').common.name,
        'Letzte an die App gesendete Synchronisationsanfrage');
    assert.equal(f.adapter.objects.get('battery.lastSyncRequestAt').common.write, false);
    assert.equal(f.value('battery.lastSyncRequestAt'), '');
    await f.adapter.observation({ ...chargingResult(), syncRequestedAt: requestedAt });
    const syncWrites = f.adapter.writes.filter(row => row.id === 'battery.lastSyncRequestAt').length;
    for (const invalid of [undefined, null, '', 0, '123', 'not a date', '2026-02-30T18:00:00.000Z', '2026-10-24T25:00:00.000Z']) {
        await f.adapter.observation({ ...chargingResult(), syncRequestedAt: invalid });
        assert.equal(f.value('battery.lastSyncRequestAt'), requestedAt);
    }
    await f.adapter.failure(new BridgeError('phone_locked', 'Unlock the phone.'), 'charging');
    assert.equal(f.value('battery.lastSyncRequestAt'), requestedAt);
    assert.equal(f.adapter.writes.filter(row => row.id === 'battery.lastSyncRequestAt').length, syncWrites);
    const restarted = await fixture(t, { initialStates: { 'battery.lastSyncRequestAt': { val: requestedAt, ack: true } } });
    assert.equal(restarted.value('battery.lastSyncRequestAt'), requestedAt);
    assert.ok(!restarted.adapter.writes.some(row => row.id === 'battery.lastSyncRequestAt' && row.value.val === ''));
    const malformed = await fixture(t, { initialStates: { 'battery.lastSyncRequestAt': { val: 'INVALID', ack: true } } });
    assert.equal(malformed.value('battery.lastSyncRequestAt'), '');
});

test('adaptive automatic reads fairly visit all three domains without synchronization and manual refresh stays climate-only', async t => {
    const disabled = await fixture(t);
    assert.equal(disabled.adapter.scheduler, undefined);
    const clock = fakeClock();
    const f = await fixture(t, { clock, enrollment: enrolled(), fakeController: true, config: { pollIntervalSeconds: 15 } });
    await clock.advance(0); await clock.advance(5000); await clock.advance(5000);
    assert.deepEqual(f.records.controllerCalls, [expectedCall('status', null), expectedChargingCall('chargingStatus'), { action: 'vehicleReportStatus', input: {} }]);
    assert.equal(f.value('battery.lastSyncRequestAt'), '');
    assert.equal(f.value('operation.lastResult'), '');
    assert.equal(f.value('operation.busy'), false);
    assert.equal(f.value('refresh.autoBusy'), false);
    await f.adapter.onStateChange('vw-app.0.commands.refresh', { val: true, ack: false });
    assert.deepEqual(f.records.controllerCalls.at(-1), expectedCall('status', null));
    assert.equal(f.records.controllerCalls.filter(row => row.action === 'chargingStatus').length, 1);
    assert.equal(f.records.controllerCalls.some(row => row.action === 'synchronize'), false);
    assert.equal(f.records.controllerCalls.filter(row => row.action === 'vehicleReportStatus').length, 1);
});

test('scheduler checks busy and a pending manual reservation, and stop removes every adapter timer', async t => {
    const clock = fakeClock();
    const f = await fixture(t, { clock, enrollment: enrolled(), fakeController: true, config: { pollIntervalSeconds: 15 } });
    f.adapter.busy = true;
    await clock.advance(0); assert.deepEqual(f.records.controllerCalls, []);
    f.adapter.busy = false; f.adapter.pendingManual = true;
    f.adapter.scheduler.notifyAvailable(); await clock.advance(0); assert.deepEqual(f.records.controllerCalls, []);
    f.adapter.pendingManual = false; f.adapter.scheduler.notifyAvailable(); await clock.advance(0);
    assert.equal(f.records.controllerCalls.length, 1);
    await f.adapter.onUnload(() => {}); await clock.advance(60000);
    assert.equal(f.records.controllerCalls.length, 1);
    assert.equal(clock.timers.size, 0);
});

test('a failed automatic climate read preserves manual outcome and other domains continue without automatic synchronization', async t => {
    const clock = fakeClock();
    const f = await fixture(t, { clock, enrollment: enrolled(), fakeController: true, config: { pollIntervalSeconds: 15 },
        controllerExecute: async action => {
            if (action === 'status') throw new BridgeError('unknown_state', 'The climate state is unclear.');
            return { ...(action === 'vehicleReportStatus' ? vehicleReportResult() : chargingResult()), observedAt: new Date(clock.now()).toISOString() };
        },
    });
    await f.adapter.state('operation.lastResult', 'failed');
    await f.adapter.state('operation.lastErrorCode', 'outcome_unknown');
    await f.adapter.state('operation.lastError', 'Earlier write was uncertain.');
    await clock.advance(0); await clock.advance(5000); await clock.advance(5000);
    assert.deepEqual(f.records.controllerCalls, [expectedCall('status', null), expectedChargingCall('chargingStatus'), { action: 'vehicleReportStatus', input: {} }]);
    assert.equal(f.value('climate.appState'), 'unknown');
    assert.equal(f.value('battery.soc'), 52);
    assert.equal(f.value('battery.lastSyncRequestAt'), '');
    assert.equal(f.value('refresh.climate.status'), 'error');
    assert.equal(f.value('refresh.charging.status'), 'fresh');
    assert.equal(f.value('operation.lastResult'), 'failed');
    assert.equal(f.value('operation.lastErrorCode'), 'outcome_unknown');
    assert.equal(f.value('operation.lastError'), 'Earlier write was uncertain.');
});

test('vehicle report data is read-only with explicit units, exact German category channels and qualified initial values', async t => {
    const f = await fixture(t);
    assert.equal(f.adapter.objects.get('vehicleReport').common.name, 'Fahrzeugzustandsbericht');
    const reportDefinitions = Object.entries(DEFINITIONS).filter(([id]) => id.startsWith('vehicleReport.'));
    assert.equal(reportDefinitions.length, 27);
    for (const [id] of reportDefinitions) assert.equal(f.adapter.objects.get(id).common.write, false, id);
    for (const [category, label] of Object.entries(REPORT_CATEGORIES)) {
        assert.equal(f.adapter.objects.get('vehicleReport.' + category).type, 'channel');
        assert.equal(f.adapter.objects.get('vehicleReport.' + category).common.name, label);
        assert.deepEqual(f.adapter.objects.get('vehicleReport.' + category + '.status').common.states,
            { no_messages: 'Keine Meldungen laut App', unknown: 'Unbekannt' });
    }
    assert.equal(f.adapter.objects.get('vehicleReport.odometerKm').common.unit, 'km');
    assert.equal(f.adapter.objects.get('vehicleReport.nextServiceKm').common.unit, 'km');
    assert.equal(f.adapter.objects.get('vehicleReport.nextServiceDays').common.unit, 'd');
    assert.equal(f.adapter.objects.get('commands.refreshVehicleReport').common.write, true);
    assertReportInvalid(f);
    assert.equal(f.records.phones.length, 0);
});

test('vehicle report refresh is own-only, strictly ack=false, and performs only the read action without write permission', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        config: { legacyStatePrefix: '0_userdata.0.old_vw' } });
    for (const state of [null, { val: true }, { val: true, ack: true }, { val: true, ack: 0 },
        { val: true, ack: 'false' }, { val: false, ack: false }, { val: 'true', ack: false }]) {
        await f.adapter.onStateChange('vw-app.0.commands.refreshVehicleReport', state);
    }
    await f.adapter.onStateChange('0_userdata.0.old_vw.refreshVehicleReport', { val: true, ack: false });
    await f.adapter.onStateChange('other.0.commands.refreshVehicleReport', { val: true, ack: false });
    assert.deepEqual(f.records.controllerCalls, []);
    await f.adapter.onStateChange('vw-app.0.commands.refreshVehicleReport', { val: true, ack: false });
    assert.deepEqual(f.adapter.states.get('commands.refreshVehicleReport'), { val: false, ack: true });
    assert.deepEqual(f.records.controllerCalls, [{ action: 'vehicleReportStatus', input: {} }]);
    assert.equal(f.adapter.settings.allowWrites, false);
    assert.deepEqual(f.records.stores[0].writes, []);
    assert.equal(f.records.stores[0].reservations, 0);
    assert.ok(f.records.phones.every(phone => phone.calls.length === 0));
    assert.equal(f.value('battery.lastSyncRequestAt'), '');
});

test('vehicle report publication contains every normalized field, JSON list and category without inventing vehicle confirmation', async t => {
    const report = vehicleReportModel();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        controllerExecute: async () => vehicleReportResult(report) });
    await f.adapter.command('vehicleReportStatus');
    for (const key of ['odometerText', 'odometerKm', 'nextServiceText', 'nextServiceDays', 'summary',
        'hasMessages', 'messageCount', 'synchronizationText', 'notice']) {
        assert.deepEqual(f.adapter.states.get('vehicleReport.' + key), { val: report[key], ack: true }, key);
    }
    assert.deepEqual(f.adapter.states.get('vehicleReport.nextServiceKm'), { val: null, ack: true, q: 0x82 });
    assert.equal(f.value('vehicleReport.observedAt'), '2026-10-24T19:00:00.000Z');
    assert.deepEqual(JSON.parse(f.value('vehicleReport.additionalTexts')), report.additionalTexts);
    assert.deepEqual(JSON.parse(f.value('vehicleReport.json')), report);
    for (const category of Object.keys(REPORT_CATEGORIES)) {
        assert.equal(f.value('vehicleReport.' + category + '.status'), 'no_messages');
        assert.deepEqual(JSON.parse(f.value('vehicleReport.' + category + '.texts')), []);
    }
    report.additionalTexts.push('Spätere Änderung');
    report.categories.engine.texts.push('Spätere Änderung');
    assert.deepEqual(JSON.parse(f.value('vehicleReport.additionalTexts')), ['Zusätzlicher sichtbarer Berichttext']);
    assert.deepEqual(JSON.parse(f.value('vehicleReport.engine.texts')), []);
    assert.equal(f.value('climate.vehicleConfirmed'), false);
    assert.equal(f.value('operation.lastResult'), 'succeeded');
});

test('unknown vehicle report values preserve source text and use null with invalid quality rather than false or zero', async t => {
    const report = vehicleReportModel();
    Object.assign(report, { odometerText: 'Nicht verfügbar', odometerKm: null,
        nextServiceText: 'Nicht verfügbar', nextServiceDays: null, nextServiceKm: null,
        summary: 'Keine Meldungen vorhanden', hasMessages: null, messageCount: null });
    for (const category of Object.keys(REPORT_CATEGORIES)) report.categories[category] = {
        label: REPORT_CATEGORIES[category], status: 'unknown', texts: ['Hinweistext aus der App'] };
    const f = await fixture(t);
    await f.adapter.observation(vehicleReportResult(report));
    for (const key of ['odometerKm', 'nextServiceDays', 'nextServiceKm', 'hasMessages', 'messageCount']) {
        assert.deepEqual(f.adapter.states.get('vehicleReport.' + key), { val: null, ack: true, q: 0x82 });
    }
    assert.equal(f.value('vehicleReport.summary'), report.summary);
    assert.deepEqual(f.adapter.states.get('vehicleReport.engine.status'), { val: 'unknown', ack: true });
    assert.deepEqual(JSON.parse(f.value('vehicleReport.engine.texts')), ['Hinweistext aus der App']);
});

test('invalid vehicle-report envelopes clear old report data without publishing any new partial report or touching other domains', async t => {
    let response = vehicleReportResult();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, controllerExecute: async () => response });
    await f.adapter.observation(chargingResult());
    await f.adapter.observation({ appState: 'on', appVersion: '4.8.1', observedAt: '2026-10-24T17:00:00.000Z', temperature: 22.5 });
    const untouched = new Map([...f.adapter.states].filter(([id]) => id.startsWith('climate.')
        || id.startsWith('battery.') || id.startsWith('charging.') || id === 'operation.lastUpdated'));
    const malformed = [null, { ...vehicleReportResult(), domain: 'charging' },
        { ...vehicleReportResult(), source: 'other' }, { ...vehicleReportResult(), vehicleConfirmed: true },
        { ...vehicleReportResult(), appVersion: undefined }, { ...vehicleReportResult(), observedAt: '123' },
        { ...vehicleReportResult(), observedAt: '2026-02-30T19:00:00.000Z' }];
    for (const bad of malformed) {
        await f.adapter.observation(vehicleReportResult());
        const reportBefore = reportStates(f);
        response = bad;
        const before = f.adapter.writes.length;
        await rejectsCode(f.adapter.command('vehicleReportStatus'), 'invalid_vehicle_report');
        assertReportInvalid(f, reportBefore);
        assert.ok(f.adapter.writes.slice(before).filter(row => row.id.startsWith('vehicleReport.'))
            .every(row => row.value.q === 0x82));
        for (const [id, value] of untouched) assert.deepEqual(f.adapter.states.get(id), value, id);
    }
});

test('the entire report model is validated before the first report write, including last category and derived values', async t => {
    let response;
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, controllerExecute: async () => response });
    const invalidDerived = vehicleReportModel(); invalidDerived.odometerKm++;
    const invalidCategory = vehicleReportModel(); invalidCategory.categories.other.texts.push('SECRET INVALID CATEGORY');
    for (const report of [invalidDerived, invalidCategory]) {
        await f.adapter.observation(vehicleReportResult());
        const reportBefore = reportStates(f);
        response = vehicleReportResult(report);
        const before = f.adapter.writes.length;
        await rejectsCode(f.adapter.command('vehicleReportStatus'), 'invalid_report');
        assertReportInvalid(f, reportBefore);
        assert.ok(f.adapter.writes.slice(before).filter(row => row.id.startsWith('vehicleReport.'))
            .every(row => row.value.q === 0x82));
    }
    assert.ok(!JSON.stringify(f.adapter.logs).includes('SECRET'));
    assert.ok(f.adapter.writes.every(row => row.value.val !== undefined));
});

test('report reads and failures are isolated from climate, charging and legacy observations in both directions', async t => {
    let fail = false;
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        config: { legacyStatePrefix: '0_userdata.0.vw' }, controllerExecute: async () => {
            if (fail) throw new Error('SECRET REPORT DUMP');
            return vehicleReportResult();
        } });
    for (const name of ['appState', 'lastUpdated']) f.adapter.foreignObjects.set('0_userdata.0.vw.' + name, {});
    await f.adapter.observation(chargingResult());
    await f.adapter.observation({ appState: 'on', appVersion: '4.8.1', observedAt: '2026-10-24T17:00:00.000Z', temperature: 22.5 });
    const untouched = new Map([...f.adapter.states].filter(([id]) => id.startsWith('climate.')
        || id.startsWith('battery.') || id.startsWith('charging.') || id === 'operation.lastUpdated'));
    const legacyBefore = f.adapter.foreignWrites.filter(row => /\.(appState|lastUpdated)$/.test(row.id));
    await f.adapter.command('vehicleReportStatus');
    for (const [id, value] of untouched) assert.deepEqual(f.adapter.states.get(id), value, id);
    const reportBefore = reportStates(f);
    await f.adapter.failure(new BridgeError('unknown_state', 'Unknown climate state.'));
    await f.adapter.failure(new BridgeError('unknown_state', 'Unknown charging state.'), 'charging');
    for (const [id, value] of reportBefore) assert.deepEqual(f.adapter.states.get(id), value, id);
    await f.adapter.observation(chargingResult());
    await f.adapter.observation({ appState: 'on', appVersion: '4.8.1', observedAt: '2026-10-24T17:00:00.000Z', temperature: 22.5 });
    const legacyRestored = f.adapter.foreignWrites.filter(row => /\.(appState|lastUpdated)$/.test(row.id));
    fail = true; await assert.rejects(f.adapter.command('vehicleReportStatus'));
    assert.equal(f.value('operation.lastErrorCode'), 'internal_error');
    assertReportInvalid(f, reportBefore);
    for (const [id, value] of untouched) assert.deepEqual(f.adapter.states.get(id), value, id);
    assert.deepEqual(f.adapter.foreignWrites.filter(row => /\.(appState|lastUpdated)$/.test(row.id)), legacyRestored);
    assert.ok(legacyBefore.length > 0);
    assert.ok(!JSON.stringify(f.adapter.logs).includes('SECRET'));
});

test('vehicle report status ignores damaged and still-saving preferences in all three independent queues', { timeout: 2000 }, async t => {
    const saves = deferred();
    const writing = { 'temperature-preference': deferred(), 'settings-preference': deferred(), 'charging-preference': deferred() };
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        memory: { 'temperature-preference': { targetCelsius: 'INVALID' },
            'settings-preference': { ...DEFAULT_TARGET_SETTINGS, mode: 'INVALID' },
            'charging-preference': { ...DEFAULT_TARGET_CHARGING, socLimit: 'INVALID' } },
        storeWrite: async name => { if (writing[name]) { writing[name].resolve(); await saves.promise; } },
    });
    t.after(() => saves.resolve());
    const pending = [f.adapter.stageTemperature(22.5), f.adapter.stageSetting('mode', 'climate'),
        f.adapter.stageChargingSetting('socLimit', MAX_TARGET_SOC)];
    await Promise.all(Object.values(writing).map(value => value.promise));
    await f.adapter.command('vehicleReportStatus');
    assert.deepEqual(f.records.controllerCalls, [{ action: 'vehicleReportStatus', input: {} }]);
    assert.equal(f.records.stores[0].writes.length, 3);
    assert.equal(f.records.stores[0].reservations, 0);
    assert.equal(f.value('vehicleReport.odometerKm'), 12345);
    saves.resolve(); await Promise.all(pending);
});

test('vehicle report requests retain profile and busy gates and are cancelled with the adapter lifecycle', async t => {
    const missing = await fixture(t, { fakeController: true });
    await rejectsCode(missing.adapter.command('vehicleReportStatus'), 'profile_required');
    assert.equal(missing.records.phones.length, 0);
    const mismatched = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { approvedAppVersion: 'OTHER' } });
    await rejectsCode(mismatched.adapter.command('vehicleReportStatus'), 'profile_mismatch');
    assert.equal(mismatched.records.phones.length, 0);
    const executing = deferred(); const finish = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, controllerExecute: async () => {
        executing.resolve(); await finish.promise; throw new BridgeError('cancelled', 'The adapter is stopping.');
    } });
    t.after(() => finish.resolve());
    const active = f.adapter.command('vehicleReportStatus');
    const rejected = rejectsCode(active, 'cancelled');
    await executing.promise;
    await rejectsCode(f.adapter.command('vehicleReportStatus'), 'busy');
    assert.equal(f.records.phones.length, 1);
    let unloaded = false; const unload = f.adapter.onUnload(() => { unloaded = true; });
    assert.equal(f.records.controllers[0].cancelled, true);
    finish.resolve(); await rejected; await unload;
    assert.equal(unloaded, true);
    assert.equal(f.records.leases[0].closed, 1);
    assert.equal(f.records.controllerCalls.length, 1);
});

test('freshness starts unknown without false climate readings and all metadata is read-only', async t => {
    const f = await fixture(t, { clock: fakeClock() });
    assert.deepEqual(f.adapter.states.get('climate.active'), { val: null, ack: true, q: 0x82 });
    for (const domain of ['climate', 'charging', 'vehicleReport']) {
        assert.equal(f.value('refresh.' + domain + '.status'), 'unknown');
        assert.equal(f.value('refresh.' + domain + '.lastReadAt'), '');
        assert.deepEqual(f.adapter.states.get('refresh.' + domain + '.ageSeconds'), { val: null, ack: true, q: 0x82 });
    }
    for (const [id] of Object.entries(DEFINITIONS).filter(([id]) => id.startsWith('refresh.'))) {
        assert.equal(f.adapter.objects.get(id).common.write, false, id);
    }
});

test('TTL keeps last values and JSON but invalidates only expired actual fields and legacy app-state quality', async t => {
    const clock = fakeClock();
    const f = await fixture(t, { clock, config: { refreshMaxAgeSeconds: 30, legacyStatePrefix: '0_userdata.0.vw' } });
    for (const name of ['appState', 'lastUpdated']) f.adapter.foreignObjects.set('0_userdata.0.vw.' + name, {});
    await f.adapter.stageTemperature(22.5); await f.adapter.stageSetting('mode', 'climate');
    await f.adapter.stageChargingSetting('socLimit', 80);
    await f.adapter.state('climate.targetTemperatureError', 'retained selection error');
    const at = new Date(clock.now()).toISOString();
    await f.adapter.observation({ appState: 'on', temperature: 22.5, appVersion: '4.8.1', observedAt: at });
    await f.adapter.observation({ ...chargingResult({ socLimit: 80, reducedAcCurrent: false, autoUnlockAc: true, optimizedBatteryUse: false }), observedAt: at, syncRequestedAt: at });
    await f.adapter.observation({ ...vehicleReportResult(), observedAt: at });
    const reportJson = f.value('vehicleReport.json');
    await clock.advance(30000); assert.equal(f.value('refresh.climate.status'), 'fresh');
    await clock.advance(1000);
    for (const domain of ['climate', 'charging', 'vehicleReport']) {
        assert.equal(f.value('refresh.' + domain + '.status'), 'stale');
        assert.equal(f.value('refresh.' + domain + '.ageSeconds'), 31);
        assert.equal(f.value('refresh.' + domain + '.lastReadAt'), at);
    }
    assert.deepEqual(f.adapter.states.get('climate.active'), { val: true, ack: true, q: 0x82 });
    assert.deepEqual(f.adapter.states.get('battery.soc'), { val: 52, ack: true, q: 0x82 });
    assert.deepEqual(f.adapter.states.get('vehicleReport.json'), { val: reportJson, ack: true, q: 0x82 });
    assert.equal(f.value('battery.observedAt'), at); assert.equal(f.value('vehicleReport.observedAt'), at);
    assert.deepEqual(f.adapter.foreignWrites.filter(row => row.id.endsWith('.appState')).at(-1).value, { val: 'on', ack: true, q: 0x82 });
    for (const id of ['climate.targetTemperature', 'climate.targetMode', 'charging.targetSoc', 'climate.targetTemperatureError', 'battery.lastSyncRequestAt']) {
        assert.equal(f.adapter.states.get(id).q, undefined, id);
    }
    assert.equal(f.value('climate.targetTemperatureError'), 'retained selection error');
    await f.adapter.observation({ appState: 'off', appVersion: '4.8.1', observedAt: new Date(clock.now()).toISOString(), temperature: null });
    assert.equal(f.value('refresh.climate.status'), 'fresh');
    assert.equal(f.value('refresh.climate.ageSeconds'), 0);
    assert.deepEqual(f.adapter.states.get('climate.active'), { val: false, ack: true });
    assert.deepEqual(f.adapter.states.get('climate.temperature'), { val: null, ack: true, q: 0x82 });
    assert.equal(f.value('refresh.charging.status'), 'stale');
    assert.equal(f.records.phones.length, 0);
});

test('refresh metadata writes only changed values while the one-second tick still updates each domain age', async t => {
    const clock = fakeClock(); const f = await fixture(t, { clock, config: { refreshMaxAgeSeconds: 30 } });
    const at = new Date(clock.now()).toISOString();
    await f.adapter.observation({ appState: 'off', appVersion: '4.8.1', observedAt: at });
    await f.adapter.observation({ ...chargingResult(), observedAt: at });
    await f.adapter.observation({ ...vehicleReportResult(), observedAt: at });
    const before = f.adapter.writes.length;
    await f.adapter.updateFreshness();
    for (const domain of ['climate', 'charging', 'vehicleReport']) await f.adapter.publishRefreshMetadata(domain);
    assert.equal(f.adapter.writes.length, before);
    await clock.advance(1000);
    assert.deepEqual(f.adapter.writes.slice(before), ['climate', 'charging', 'vehicleReport'].map(domain => ({
        id: 'refresh.' + domain + '.ageSeconds', value: { val: 1, ack: true },
    })));
    const afterAge = f.adapter.writes.length;
    await f.adapter.updateFreshness();
    assert.equal(f.adapter.writes.length, afterAge);
});

test('automatic age limit follows the estimated complete cycle while explicit limits override it', async t => {
    const clock = fakeClock();
    const f = await fixture(t, { clock, RefreshScheduler: RecordingScheduler, config: { pollIntervalSeconds: 15 } });
    assert.equal(f.value('refresh.climate.maxAgeSeconds'), 225);
    await f.adapter.scheduler.options.onUpdate({ estimatedCycleMs: 300000, runningDomain: null, domains: {} });
    assert.equal(f.value('refresh.charging.maxAgeSeconds'), 600);
    f.adapter.settings.refreshMaxAgeSeconds = 45; await f.adapter.updateFreshness();
    assert.equal(f.value('refresh.vehicleReport.maxAgeSeconds'), 45);
    assert.equal(f.records.phones.length, 0);
});

test('manual handoff cancels only the automatic controller, waits for it and preserves the accepted preference snapshot', async t => {
    const clock = fakeClock(); const entered = deferred(); const release = deferred();
    let f; let active = 0; let maximum = 0;
    f = await fixture(t, { clock, enrollment: enrolled(), fakeController: true, config: { pollIntervalSeconds: 15, allowWrites: true },
        controllerExecute: async (action, input) => {
            active++; maximum = Math.max(maximum, active);
            try {
                if (action === 'status') { entered.resolve(); await release.promise; throw new BridgeError('cancelled', 'Read handed off.'); }
                return { appState: 'on', appVersion: '4.8.1', observedAt: new Date(clock.now()).toISOString(), temperature: input.targetTemperature };
            } finally { active--; }
        },
    });
    t.after(() => release.resolve());
    await f.adapter.stageTemperature(22.5); await f.adapter.stageSetting('mode', 'climate');
    await f.adapter.observation({ appState: 'off', appVersion: '4.8.1', observedAt: new Date(clock.now()).toISOString() });
    await clock.advance(0); await entered.promise;
    const start = f.adapter.command('start');
    assert.equal(f.adapter.pendingManual, true); assert.equal(f.records.controllers[0].cancelled, true);
    assert.equal(f.adapter.abortController.signal.aborted, false);
    await rejectsCode(f.adapter.command('stop'), 'busy');
    await f.adapter.stageTemperature(23); await f.adapter.stageSetting('zones', 'both');
    assert.equal(f.records.controllerCalls.length, 1);
    assert.equal(f.value('refresh.climate.status'), 'fresh');
    release.resolve(); await start;
    assert.equal(maximum, 1);
    assert.deepEqual(f.records.controllerCalls, [expectedCall('status', null), expectedCall('start', 22.5, { ...DEFAULT_TARGET_SETTINGS, mode: 'climate' })]);
    assert.equal(f.value('refresh.climate.lastErrorCode'), '');
    assert.ok(!f.adapter.writes.some(row => row.id === 'refresh.climate.status' && row.value.val === 'error'));
    assert.ok(!f.adapter.writes.some(row => row.id === 'operation.lastResult' && row.value.val === 'failed'));
    assert.equal(f.value('operation.lastResult'), 'succeeded');
    assert.equal(f.value('climate.targetTemperature'), 23);
    assert.equal(f.value('refresh.autoBusy'), false);
    assert.equal(f.adapter.pendingManual, false);
});

test('automatic finalization retains the busy reservation until metadata and autoBusy writes finish', async t => {
    const clock = fakeClock(); const finalizing = deferred(); const release = deferred(); let block = false;
    const f = await fixture(t, { clock, enrollment: enrolled(), fakeController: true, config: { pollIntervalSeconds: 15 },
        stateWrite: async (id, value) => { if (block && id === 'refresh.autoBusy' && value.val === false) { finalizing.resolve(); await release.promise; } },
    });
    t.after(() => release.resolve()); block = true;
    await clock.advance(0); await finalizing.promise;
    const originalController = f.adapter.controller;
    assert.equal(f.adapter.busy, true);
    const manual = f.adapter.command('chargingStatus');
    assert.equal(f.adapter.pendingManual, true);
    assert.equal(f.adapter.controller, originalController);
    assert.equal(f.records.controllerCalls.length, 1);
    release.resolve(); await manual;
    assert.equal(f.records.controllerCalls.length, 2);
    assert.equal(f.adapter.currentOperation, null);
    assert.equal(f.adapter.controller, null); assert.equal(f.adapter.busy, false);
});

test('read-only follow-up after an uncertain write never repeats it or overwrites manual operation and legacy feedback', async t => {
    const clock = fakeClock();
    const f = await fixture(t, { clock, RefreshScheduler: RecordingScheduler, enrollment: enrolled(), fakeController: true,
        config: { pollIntervalSeconds: 15, allowWrites: true, legacyStatePrefix: '0_userdata.0.vw' },
        controllerExecute: async action => {
            if (action === 'start') throw new BridgeError('outcome_unknown', 'The write outcome is unclear.');
            return { appState: 'on', appVersion: '4.8.1', observedAt: new Date(clock.now()).toISOString() };
        },
    });
    for (const name of ['busy', 'lastResult', 'lastError']) f.adapter.foreignObjects.set('0_userdata.0.vw.' + name, {});
    await rejectsCode(f.adapter.command('start'), 'outcome_unknown');
    assert.deepEqual(f.adapter.scheduler.requests, [{ domain: 'climate', priority: true, delayMs: 2000 }]);
    const feedback = f.adapter.foreignWrites.filter(row => /\.(busy|lastResult|lastError)$/.test(row.id));
    await f.adapter.scheduler.options.run('climate');
    assert.deepEqual(f.records.controllerCalls, [expectedCall('start', null), expectedCall('status', null)]);
    assert.equal(f.value('operation.lastResult'), 'failed');
    assert.equal(f.value('operation.lastErrorCode'), 'outcome_unknown');
    assert.equal(f.value('refresh.climate.status'), 'fresh'); assert.equal(f.value('climate.appState'), 'on');
    assert.deepEqual(f.adapter.foreignWrites.filter(row => /\.(busy|lastResult|lastError)$/.test(row.id)), feedback);
});

test('each accepted write requests only its own read area and poll zero disables follow-ups', async t => {
    const clock = fakeClock();
    const f = await fixture(t, { clock, RefreshScheduler: RecordingScheduler, enrollment: enrolled(), fakeController: true,
        config: { pollIntervalSeconds: 15, allowWrites: true } });
    await f.adapter.stageTemperature(22.5); await f.adapter.stageSetting('mode', 'climate'); await f.adapter.stageChargingSetting('socLimit', 80);
    for (const action of ['start', 'stop', 'setTemperature', 'applySettings', 'applyChargingSettings', 'synchronize']) await f.adapter.command(action);
    assert.deepEqual(f.adapter.scheduler.requests.map(request => request.domain), ['climate', 'climate', 'climate', 'climate', 'charging', 'charging']);
    assert.ok(f.adapter.scheduler.requests.every(request => request.priority === true && request.delayMs === 2000));
    const offClock = fakeClock();
    const off = await fixture(t, { clock: offClock, RefreshScheduler: RecordingScheduler, enrollment: enrolled(), fakeController: true, config: { allowWrites: true } });
    await off.adapter.command('start'); await offClock.advance(60000);
    assert.equal(off.adapter.scheduler, undefined);
    assert.deepEqual(off.records.controllerCalls, [expectedCall('start', null)]);
});

test('legacy freshness aliases cannot publish after unload while an object lookup is pending', async t => {
    const f = await fixture(t, { config: { legacyStatePrefix: '0_userdata.0.vw' } });
    const entered = deferred(); const release = deferred();
    f.adapter.getForeignObjectAsync = async () => { entered.resolve(); await release.promise; return {}; };
    const publishing = f.adapter.legacy('appState', { val: 'on', ack: true, q: 0x82 });
    await entered.promise; await f.adapter.onUnload(() => {}); release.resolve(); await publishing;
    assert.deepEqual(f.adapter.foreignWrites, []);
});

test('installing a missing runtime starts the configured scheduler without downloading automatically', async t => {
    const clock = fakeClock();
    const f = await fixture(t, { clock, RefreshScheduler: RecordingScheduler, runtimeMissing: true, config: { pollIntervalSeconds: 15 } });
    assert.equal(f.adapter.scheduler.started, false);
    assert.deepEqual(f.records.runtime[0].calls, [['start']]);
    await f.message('installRuntime', { acceptLicense: true });
    assert.equal(f.adapter.scheduler.started, true);
    assert.equal(f.records.phones.length, 0);
});

test('unload waits for a charging save and restart restores it', async t => {
    const writing = deferred(); const save = deferred();
    const f = await fixture(t, { storeWrite: async name => { if (name === 'charging-preference') { writing.resolve(); await save.promise; } } });
    t.after(() => save.resolve());
    const staging = f.adapter.stageChargingSetting('autoUnlockAc', false); await writing.promise;
    let unloaded = false; const unload = f.adapter.onUnload(() => { unloaded = true; });
    await Promise.resolve(); assert.equal(unloaded, false);
    save.resolve(); await staging; await unload;
    const restarted = await fixture(t, { memory: f.memory });
    assert.equal(restarted.value('charging.targetAutoUnlockAc'), false);
    assert.equal(unloaded, true);
});

test('a stuck charging save cannot hold unload beyond its bounded shutdown timer', async t => {
    const writing = deferred(); const save = deferred(); const timerStarted = deferred();
    const f = await fixture(t, { storeWrite: async name => { if (name === 'charging-preference') { writing.resolve(); await save.promise; } } });
    const originalSetTimeout = global.setTimeout;
    let expire;
    const mocked = t.mock.method(global, 'setTimeout', (callback, milliseconds, ...args) => {
        if (milliseconds === 3000) { expire = callback; timerStarted.resolve(); return originalSetTimeout(() => {}, 3000); }
        return originalSetTimeout(callback, milliseconds, ...args);
    });
    const staging = f.adapter.stageChargingSetting('socLimit', MAX_TARGET_SOC); await writing.promise;
    let callbackCount = 0; const unload = f.adapter.onUnload(() => { callbackCount++; });
    await timerStarted.promise; expire(); await unload;
    assert.equal(callbackCount, 1); assert.equal(f.records.leases[0].closed, 1);
    mocked.mock.restore(); save.resolve(); await staging;
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
