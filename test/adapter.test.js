'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAdapterClass, DEFINITIONS } = require('../lib/adapter');
const { BridgeError } = require('../lib/errors');
const { withSecurityDiagnostic } = require('../lib/security-auth');
const { PACKAGE } = require('../lib/ui');
const ADMIN = require('../admin/jsonConfig.json');
const { MIN_TEMPERATURE_CELSIUS, MAX_TEMPERATURE_CELSIUS, TEMPERATURE_STEP_CELSIUS } = require('../lib/temperature');
const { DEFAULT_TARGET_SETTINGS } = require('../lib/settings');
const { DEFAULT_TARGET_CHARGING, CHARGING_KEYS, MIN_TARGET_SOC, MAX_TARGET_SOC, TARGET_SOC_STEP } = require('../lib/charging');
const { REPORT_CATEGORIES } = require('../lib/vehicle-report');
const { localKey } = require('../lib/departures-adapter');
const LEGACY_OBJECTS_0100 = require('./support/objects-0.10.0.json');
const { overviewChargingScreen, chargingSettingsScreen, POINTS: CHARGING_POINTS } = require('./support/charging-fixtures.cjs');
const { rangeModeScreen, nativeObservationFromXml } = require('./support/charging-mode-fixtures.cjs');

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
    constructor(options) { this.options = options; this.requests = []; this.available = 0; this.started = false; this.paused = false; }
    start() { this.started = true; }
    stop() { this.started = false; }
    pause() { this.paused = true; }
    resume() { this.paused = false; }
    notifyAvailable() { this.available++; }
    request(domain, options) { this.requests.push({ domain, ...options }); return this.started; }
    snapshot() { return { runningDomain: null, estimatedCycleMs: this.options.domains.length * 37500, domains: {} }; }
    setDomains(domains) { this.options.domains = [...domains]; }
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
            this.states = new Map(Object.entries(clone(options.initialStates || {})));
            this.objects = new Map(Object.entries(clone(options.initialObjects || {}))); this.writes = [];
            this.objectPatches = []; this.objectLists = 0;
            this.foreignObjects = new Map(); this.foreignWrites = []; this.subscriptions = [];
            this.logs = []; this.responses = []; this.intervals = []; this.clearedIntervals = [];
            this.log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, message => this.logs.push({ level, message })]));
        }
        async setObjectNotExistsAsync(id, value) { if (options.objectWrite) await options.objectWrite(id, value); if (!this.objects.has(id)) this.objects.set(id, clone(value)); }
        async getAdapterObjectsAsync() {
            this.objectLists++;
            if (options.objectList) return options.objectList(this);
            return Object.fromEntries([...this.objects].map(([id, object]) => [this.namespace + '.' + id,
                { ...clone(object), _id: this.namespace + '.' + id }]));
        }
        async extendObjectAsync(id, patch) {
            if (options.objectExtend) await options.objectExtend(id, patch, this);
            this.objectPatches.push({ id, patch: clone(patch) });
            const previous = this.objects.get(id);
            assert.ok(previous, id);
            this.objects.set(id, { ...previous, ...clone(patch),
                ...(patch.common ? { common: { ...clone(previous.common), ...clone(patch.common) } } : {}) });
        }
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
        async read(name, fallback) {
            if (options.storeRead) return options.storeRead(name, fallback, memory);
            return clone(memory[name] ?? fallback);
        }
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
        constructor(settings) {
            Object.assign(this, settings); records.controllers.push(this);
            if (options.cooperativeHandoff) this.requestReadHandoff = () => { this.handoffRequested = true; };
        }
        async execute(action, input) {
            records.controllerCalls.push({ action, input: clone(input) });
            if (options.controllerExecute) return options.controllerExecute(action, input, this);
            const observedAt = new Date(options.clock ? options.clock.now() : Date.now()).toISOString();
            if (action === 'applyChargingMode') return chargingModeResult(input.targetChargingMode, observedAt);
            if (['chargingStatus', 'applyChargingSettings', 'synchronize'].includes(action)) return { ...chargingResult(input.targetCharging), ...(options.clock ? { observedAt } : {}) };
            if (action === 'vehicleReportStatus') return { ...vehicleReportResult(), ...(options.clock ? { observedAt } : {}) };
            if (action === 'refreshVehicleAccess') return { ...vehicleAccessResult(), ...(options.clock ? { observedAt } : {}) };
            if (action === 'refreshVehicleInfo') return { ...vehicleInfoResult(), ...(options.clock ? { observedAt } : {}) };
            if (action === 'departuresClimateStatus' || action === 'applyDepartureClimateTimer') return departureClimateResult(observedAt);
            if (action === 'departuresLocationsStatus') return departureInventoryResult(options.departureLocations || [], observedAt);
            if (['departuresLocationStatus', 'applyDepartureLocationTimer', 'applyDepartureLocationSettings', 'applyDeparturePreferredTimes'].includes(action)) return departureLocationResult(input.location, observedAt);
            return { appState: environment.appState, appVersion: '4.8.1', vehicleConfirmed: false,
                observedAt, temperature: input.targetTemperature,
                confirmationSource: 'app_controls' };
        }
        cancel() { this.cancelled = true; if (options.controllerCancel) options.controllerCancel(this); }
    }

    const utils = { Adapter: FakeAdapter, getAbsoluteInstanceDataDir: () => root };
    const Adapter = createAdapterClass(utils, { Runtime: FakeRuntime, Phone: options.Phone || FakePhone, Store: FakeStore, Lease: FakeLease,
        ...(options.GuardianQuery ? { GuardianQuery: options.GuardianQuery } : {}),
        ...(options.GuardianAssets ? { GuardianAssets: options.GuardianAssets } : {}),
        ...(options.GuardianVmRoute ? { GuardianVmRoute: options.GuardianVmRoute } : {}),
        ...(options.GuardianBinderTest ? { GuardianBinderTest: options.GuardianBinderTest } : {}),
        ...(options.GuardianPermissionGrant ? { GuardianPermissionGrant: options.GuardianPermissionGrant } : {}),
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

test('maintenance drains the current read without cancelling and blocks new phone jobs', async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, cooperativeHandoff: true,
        RefreshScheduler: RecordingScheduler, config: { pollIntervalSeconds: 15 }, controllerExecute: async action => {
            assert.equal(action, 'refreshVehicleAccess'); entered.resolve(); await release.promise; return vehicleAccessResult();
        } });
    t.after(() => release.resolve());
    const running = f.adapter.scheduler.options.run('vehicleAccess'); await entered.promise;
    assert.equal((await f.message('maintenanceStart')).result, 'maintenance_draining');
    assert.equal(f.adapter.scheduler.paused, true);
    assert.equal(f.records.controllers[0].cancelled, undefined);
    assert.equal(f.records.controllers[0].handoffRequested, undefined);
    await rejectsCode(f.adapter.command('chargingStatus'), 'maintenance_active');
    await rejectsCode(f.adapter.scheduler.options.run('climate'), 'busy');
    assert.match((await f.message('maintenanceResume')).error, /^busy:/);
    release.resolve(); await running; await Promise.resolve();
    assert.equal((await f.message('maintenanceStatus')).result, 'maintenance_ready');
    assert.equal(f.adapter.scheduler.paused, true);
    assert.equal((await f.message('maintenanceResume')).result, 'maintenance_idle');
    assert.equal(f.adapter.scheduler.paused, false);
    assert.equal(f.records.controllerCalls.length, 1);
});

test('maintenance fails closed after an error or without a known completed phone operation', async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, RefreshScheduler: RecordingScheduler,
        config: { pollIntervalSeconds: 15 }, controllerExecute: async () => {
            entered.resolve(); await release.promise; throw new BridgeError('unsaved_settings', 'Editor uncertain.');
        } });
    t.after(() => release.resolve());
    const running = f.adapter.scheduler.options.run('vehicleAccess');
    const rejection = rejectsCode(running, 'unsaved_settings'); await entered.promise;
    assert.equal((await f.message('maintenanceStart')).result, 'maintenance_draining');
    release.resolve(); await rejection; await Promise.resolve();
    assert.equal((await f.message('maintenanceStatus')).result, 'maintenance_blocked');
    assert.equal(f.adapter.scheduler.paused, true);
    assert.equal((await f.message('maintenanceResume')).result, 'maintenance_idle');
    assert.equal((await f.message('maintenanceStart')).result, 'maintenance_blocked');
});

test('maintenance commands reject non-Admin senders and do not overtake reserved manual work', async t => {
    const f = await fixture(t, { RefreshScheduler: RecordingScheduler, config: { pollIntervalSeconds: 15 } });
    await f.adapter.onMessage({ from: 'system.adapter.other.0', command: 'maintenanceStart', message: {}, callback: { id: 8 } });
    assert.match(f.adapter.responses.at(-1).message.error, /^invalid_action:/);
    assert.equal(f.adapter.maintenanceState, 'idle');
    f.adapter.pendingManual = true;
    assert.match((await f.message('maintenanceStart')).error, /^busy:/);
    assert.equal(f.adapter.scheduler.started, true);
    f.adapter.pendingManual = false;
});

test('a phone-job finalization failure cannot make a later maintenance start ready', async t => {
    let failFinalization = false;
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, RefreshScheduler: RecordingScheduler,
        config: { pollIntervalSeconds: 15 }, stateWrite: async (id, value) => {
            if (failFinalization && id === 'refresh.autoBusy' && value?.val === false) throw new Error('synthetic finalization error');
        } });
    failFinalization = true;
    await assert.rejects(f.adapter.scheduler.options.run('vehicleAccess'));
    assert.equal(f.adapter.lastPhoneOperationOutcome, 'uncertain');
    assert.equal((await f.message('maintenanceStart')).result, 'maintenance_blocked');
});

test('connection-source diagnostics log only known fixed categories and mark a cached endpoint', async t => {
    const f = await fixture(t, { enrollment: enrolled() });
    const configuredEndpoint = HOST + ':' + PORT;
    f.adapter.verifiedPhoneEndpoint = { configuredEndpoint, endpoint: HOST + ':45678', deviceId: DEVICE };
    const phone = await f.adapter.phone();
    assert.equal(phone.settings.initialEndpointSource, 'cache');
    const before = f.adapter.logs.length;
    phone.settings.onConnectionSource('guardian');
    phone.settings.onConnectionSource('bogus user data');
    phone.settings.onConnectionSource('cache');
    assert.deepEqual(f.adapter.logs.slice(before), [{ level: 'info', message: 'Wireless debugging port discovery verified: guardian' }]);
});

test('Guardian protected-settings grant is Admin-only, consented, serialized and journalled separately', async t => {
    let calls = 0;
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { enrollment: enrolled(), GuardianPermissionGrant: async ({ phone, userConfirmed, journal, signal }) => {
        calls++; assert.equal(userConfirmed, true); assert.ok(phone); assert.equal(signal.aborted, false);
        assert.equal(await journal.read(), null); await journal.write({ status: 'attempting' });
        entered.resolve(); await release.promise; await journal.write({ status: 'confirmed' });
        return { result: 'guardian_permission_granted' };
    } });
    t.after(() => release.resolve());
    await f.adapter.onMessage({ from: 'system.adapter.other.0', command: 'guardianPermissionGrant', message: { confirm: true }, callback: { id: 1 } });
    assert.match(f.adapter.responses.at(-1).message.error, /^invalid_action:/); assert.equal(calls, 0);
    assert.match((await f.message('guardianPermissionGrant')).error, /^guardian_permission_consent_required:/);
    assert.equal(calls, 0);
    const granting = f.message('guardianPermissionGrant', { confirm: true }); await entered.promise;
    assert.deepEqual(f.memory['guardian-permission-state'], { status: 'attempting' });
    await rejectsCode(f.adapter.command('chargingStatus'), 'busy');
    release.resolve();
    assert.deepEqual(await granting, { result: 'guardian_permission_granted', native: {} });
    assert.deepEqual(f.memory['guardian-permission-state'], { status: 'confirmed' });
});

test('Guardian recovery is fail-closed until both actual instance protections are present', async t => {
    const secret = 'ab'.repeat(32); // Synthetic fixture only.
    let queries = 0;
    const f = await fixture(t, { config: { guardianPortDiscovery: true, guardianSecret: secret }, enrollment: enrolled(),
        memory: { 'guardian-pair-state': { status: 'android_verified_host_not_enabled' } },
        GuardianQuery: async (_host, options) => { queries++; assert.equal(options.getSecret(), secret); return 45678; } });
    const id = 'system.adapter.' + f.adapter.namespace;
    assert.equal(await f.adapter.guardianProtectionReady(), false);
    let phone = await f.adapter.phone();
    assert.equal(phone.settings.guardianDiscovery, null);
    f.adapter.foreignObjects.set(id, { encryptedNative: ['guardianSecret'], protectedNative: [] });
    assert.equal(await f.adapter.guardianProtectionReady(), false);
    phone = await f.adapter.phone();
    assert.equal(phone.settings.guardianDiscovery, null);
    f.adapter.foreignObjects.set(id, { encryptedNative: ['guardianSecret'], protectedNative: ['guardianSecret'] });
    assert.equal(await f.adapter.guardianProtectionReady(), true);
    phone = await f.adapter.phone();
    assert.equal(typeof phone.settings.guardianDiscovery, 'function');
    assert.equal(await phone.settings.guardianDiscovery(HOST, {}), 45678);
    assert.equal(queries, 1);
    assert.deepEqual(f.memory['guardian-pair-state'], { status: 'android_verified_host_not_enabled' });
    assert.equal(JSON.stringify(f.adapter.settings).includes(secret), false);
    assert.equal(JSON.stringify(f.adapter.logs).includes(secret), false);
    const unpinned = await f.adapter.phone({}, { allowUnpinned: true });
    assert.equal(unpinned.settings.guardianDiscovery, null);
});

test('Guardian Admin setup gates secret entry on a fresh per-instance protection check without returning native values', async t => {
    const secret = 'ab'.repeat(32); // Synthetic fixture only.
    const f = await fixture(t, { config: { guardianSecret: secret }, enrollment: enrolled() });
    const id = 'system.adapter.' + f.adapter.namespace;
    const message = () => f.message('guardianProtectionCheck');
    assert.deepEqual(await message(), { native: { _guardianProtectionVerified: false } });
    f.adapter.foreignObjects.set(id, { encryptedNative: ['guardianSecret'], protectedNative: [], native: { guardianSecret: secret } });
    assert.deepEqual(await message(), { native: { _guardianProtectionVerified: false } });
    f.adapter.foreignObjects.set(id, { encryptedNative: ['sPin', 'guardianSecret'], protectedNative: ['sPin', 'guardianSecret'], native: { guardianSecret: secret } });
    assert.deepEqual(await message(), { native: { _guardianProtectionVerified: true } });
    assert.equal(JSON.stringify(f.adapter.responses).includes(secret), false);
    assert.equal(JSON.stringify(f.adapter.logs).includes(secret), false);
    await f.adapter.onMessage({ from: 'system.adapter.example.0', command: 'guardianProtectionCheck', message: {}, callback: { id: 2 } });
    assert.deepEqual(f.adapter.responses.at(-1).message, { native: { _guardianProtectionVerified: false } });
    f.adapter.getForeignObjectAsync = async () => { throw new Error('synthetic object read failure'); };
    assert.deepEqual(await message(), { native: { _guardianProtectionVerified: false } });
    assert.equal(ADMIN.items._guardianProtectionCheck.onLoaded, true);
    assert.equal(ADMIN.items._guardianProtectionCheck.disabled, true);
    assert.equal(ADMIN.items._guardianProtectionVerified.doNotSave, true);
    assert.equal(ADMIN.items._guardianProtectionVerified.hidden, true);
    assert.equal(ADMIN.items.guardianSecret.disabled, 'data._guardianProtectionVerified !== true');
});
test('automatic Guardian pairing is Admin-only and refuses missing per-instance encryption before any phone access', async t => {
    const fakePin = '0012'; // Synthetic only; never emitted or transferred.
    const f = await fixture(t, { config: { sPin: fakePin }, enrollment: enrolled() });
    await f.adapter.onMessage({ from: 'system.adapter.example.0', command: 'guardianBinderPrepare', message: {}, callback: { id: 5 } });
    assert.match(f.adapter.responses.at(-1).message.error, /^invalid_action:/);
    assert.equal(f.records.phones.length, 0);
    const response = await f.message('guardianBinderPrepare', { sPin: 'untrusted', guardianSecret: 'untrusted' });
    assert.match(response.error, /^guardian_pair_not_empty:/);
    assert.equal(f.records.phones.length, 0);
    assert.equal(JSON.stringify(f.adapter.responses).includes(fakePin), false);
    assert.equal(JSON.stringify(f.adapter.logs).includes(fakePin), false);
    assert.equal(ADMIN.items._guardianBinderPrepare.useNative, true);
    assert.deepEqual(ADMIN.items._guardianBinderPrepare.data, {});
    assert.equal(ADMIN.items._guardianBinderPrepare.disabled, 'data._guardianProtectionVerified !== true');
});
test('Guardian verification requires its signed result and the exact pinned phone with no fallback or secret output', async t => {
    const secret = 'ab'.repeat(32); let calls = 0;
    const GuardianQuery = async (_host, options) => { calls++; assert.equal(options.getSecret(), secret); return 45678; };
    const f = await fixture(t, { config: { guardianPortDiscovery: true, guardianSecret: secret }, enrollment: enrolled(), GuardianQuery,
        memory: { 'guardian-pair-state': { status: 'android_verified_host_not_enabled' } } });
    f.adapter.foreignObjects.set('system.adapter.' + f.adapter.namespace,
        { encryptedNative: ['guardianSecret'], protectedNative: ['guardianSecret'] });
    assert.deepEqual(await f.message('guardianPairVerify'), { result: 'guardian_pair_verified', native: {} });
    assert.equal(calls, 1); assert.equal(f.records.phones.length, 1);
    assert.equal(f.records.phones[0].settings.discoverPort, false);
    assert.equal(f.records.phones[0].settings.endpoint, HOST + ':45678');
    assert.equal(JSON.stringify(f.adapter.responses).includes(secret), false);
    assert.equal(JSON.stringify(f.adapter.responses).includes('45678'), false);
    assert.equal(JSON.stringify(f.adapter.logs).includes(secret), false);
    await f.adapter.onMessage({ from: 'system.adapter.example.0', command: 'guardianPairVerify', message: {}, callback: { id: 7 } });
    assert.match(f.adapter.responses.at(-1).message.error, /^invalid_action:/);
    assert.equal(calls, 1);
    assert.equal(ADMIN.items._guardianPairVerify.useNative, true);
    assert.deepEqual(ADMIN.items._guardianPairVerify.data, {});
});
test('Guardian verification rejects missing signed response and wrong phone without app access', async t => {
    for (const options of [{ GuardianQuery: async () => null }, { GuardianQuery: async () => 45678, deviceId:'serial:OTHER' }]) {
        const f = await fixture(t, { config: { guardianPortDiscovery: true, guardianSecret: 'ab'.repeat(32) }, enrollment: enrolled(), ...options });
        f.adapter.foreignObjects.set('system.adapter.' + f.adapter.namespace,
            { encryptedNative: ['guardianSecret'], protectedNative: ['guardianSecret'] });
        const reply = await f.message('guardianPairVerify');
        assert.match(reply.error, /^(guardian_verify_failed|wifi_wrong_device):/);
        assert.equal(f.ctas().length, 0);
    }
});
test('synthetic Guardian transport test is Admin-only, pinned and never queries or stores a real Guardian key', async t => {
    let called = 0;
    const f = await fixture(t, { enrollment: enrolled(), config: { guardianPortDiscovery: true, guardianSecret:'ab'.repeat(32) },
        GuardianAssets: async () => ({ approvedApkHash:'a'.repeat(64), relayHash:'b'.repeat(64), relayFile:'synthetic' }),
        GuardianVmRoute: async () => '192.168.100.33',
        GuardianQuery: async () => { throw Error('A real Guardian key must never be queried'); },
        GuardianBinderTest: async ({ phone }) => { called++; await phone.connect(); return { result: 'guardian_binder_test_ok' }; } });
    await f.adapter.onMessage({ from: 'system.adapter.example.0', command: 'guardianBinderTest', message: {}, callback: { id: 6 } });
    assert.match(f.adapter.responses.at(-1).message.error, /^invalid_action:/);
    assert.equal(called, 0);
    assert.deepEqual(await f.message('guardianBinderTest', { guardianSecret:'untrusted' }),
        { result: 'guardian_binder_test_ok', native:{} });
    assert.equal(called, 1); assert.equal(f.records.phones.length, 1);
    assert.equal(f.records.phones[0].settings.guardianDiscovery, undefined);
    assert.equal(f.records.phones[0].settings.deviceId, DEVICE);
    assert.equal(f.records.phones[0].settings.discoverPort, true);
    assert.equal(JSON.stringify(f.adapter.responses).includes('ab'.repeat(32)), false);
    assert.equal(JSON.stringify(f.adapter.logs).includes('ab'.repeat(32)), false);
    assert.equal(ADMIN.items._guardianBinderTest.useNative, true);
    assert.deepEqual(ADMIN.items._guardianBinderTest.data, {});
});
function departureTimer(id, profileId = null) {
    return { id, enabled: false, time: '07:30', days: ['mon', 'wed'], repeat: true, date: null,
        vehicleOffset: '+02:00', isLocalVehicleTime: false, source: 'editor_initial_snapshot',
        daysSummary: 'Mo., Mi.', daysSummaryRecognized: true,
        ...(profileId === null ? {} : { climatisation: false, profileId, isPreferredTimesAvailable: true }) };
}
function departureEnvelope(domain, observedAt = '2026-10-25T10:00:00.000Z') {
    return { domain, source: 'volkswagen_android_app', vehicleConfirmed: false, appVersion: '4.8.1', observedAt };
}
function departureClimateResult(observedAt) {
    return { ...departureEnvelope('departureClimate', observedAt), timers: ['1', '2'].map(id => departureTimer(id)) };
}
function departureInventoryResult(locations = [], observedAt) {
    return { ...departureEnvelope('departureLocations', observedAt), locations: clone(locations) };
}
function departureLocationResult(location = { nativeId: '700', name: 'Synthetischer Ort A' }, observedAt) {
    return { ...departureEnvelope('departureLocation', observedAt), location: { ...location },
        timers: ['1', '2', '3'].map(id => departureTimer(id, location.nativeId)),
        settings: { name: location.name, directSoc: null, socLimit: null, reducedAcCurrent: false, autoUnlockAc: true },
        preferredTimes: { windows: ['1', '2', '3', '4'].map(id => ({ id, start: '00:00', end: '06:00', enabled: false, editable: false })), notice: null } };
}
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
function chargingModeResult(mode, observedAt = '2026-10-24T16:00:00.000Z') {
    return { ...chargingResult({ ...DEFAULT_TARGET_CHARGING, mode }), observedAt, modeObservedAt: observedAt };
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
function vehicleAccessModel() {
    return { doors: { frontLeft: true, frontRight: false, rearLeft: true, rearRight: false },
        windows: { frontLeft: false, frontRight: true, rearLeft: false, rearRight: false },
        trunkOpen: true, locked: false, synchronizationText: 'Gerade synchronisiert',
        warningText: 'Fahrzeug ist entriegelt. Etwas ist noch offen oder eingeschaltet:. Kofferraum. Tür hinten links. Tür vorne links. Fenster vorne rechts. ' };
}
function vehicleAccessResult(vehicleAccess = vehicleAccessModel()) {
    return { domain: 'vehicleAccess', source: 'volkswagen_android_app', vehicleConfirmed: false,
        appVersion: '4.8.1', observedAt: '2026-10-24T19:00:00.000Z', vehicleAccess: clone(vehicleAccess) };
}
// Deliberately synthetic identifiers, not values copied from a vehicle.
const SYNTHETIC_VIN = 'TESTCAR0000000001';
const OTHER_SYNTHETIC_VIN = 'TESTCAR0000000002';
function vehicleInfoResult(vin = SYNTHETIC_VIN) {
    return { domain: 'vehicleInfo', source: 'volkswagen_android_app', vehicleConfirmed: false,
        appVersion: '4.8.1', observedAt: '2026-10-24T19:00:00.000Z', vehicleInfo: { vin } };
}
function closedAccessResult(locked) {
    return vehicleAccessResult({ doors: Object.fromEntries(['frontLeft', 'frontRight', 'rearLeft', 'rearRight'].map(key => [key, false])),
        windows: Object.fromEntries(['frontLeft', 'frontRight', 'rearLeft', 'rearRight'].map(key => [key, false])),
        trunkOpen: false, locked, synchronizationText: 'Gerade synchronisiert', warningText: '' });
}
const syntheticSecurityPin = () => String.fromCharCode(48, 55, 50, 57);
const blockedSecurityState = reason => ({ blocked: true, reason, blockedAt: '2026-10-25T10:00:00.000Z' });
const ACCESS_POSITIONS = ['frontLeft', 'frontRight', 'rearLeft', 'rearRight'];
const ACCESS_BOOLEAN_IDS = [...['doors', 'windows'].flatMap(group => ACCESS_POSITIONS.map(position =>
    'vehicleAccess.' + group + '.' + position + 'Open')), 'vehicleAccess.trunkOpen', 'vehicleAccess.locked'];
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
        assert.equal(object.common.read, role !== 'button');
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

test('a verified changed phone port is reused only for the same configured endpoint and enrolled identity', async t => {
    const f = await fixture(t, { enrollment: enrolled() });
    const configured = `${HOST}:${PORT}`;
    const changed = `${HOST}:49876`;
    const first = await f.adapter.phone();
    assert.equal(first.settings.endpoint, configured);
    assert.equal(first.settings.discoverPort, true);
    await first.settings.onVerified(DEVICE, changed);
    const second = await f.adapter.phone();
    assert.equal(second.settings.endpoint, changed);
    assert.equal(second.settings.fallbackEndpoint, configured);
    assert.equal(f.adapter.settings.connectPort, PORT);
    assert.equal(f.memory.enrollment.deviceId, DEVICE);
    const setup = await f.adapter.phone({}, { allowUnpinned: true });
    assert.equal(setup.settings.endpoint, configured);
    assert.equal(setup.settings.discoverPort, false);
    const override = await f.adapter.phone({ hostIp: '203.0.113.81', connectPort: 40000 });
    assert.equal(override.settings.endpoint, '203.0.113.81:40000');
    f.memory.enrollment.deviceId = 'serial:DIFFERENT-TEST';
    const different = await f.adapter.phone();
    assert.equal(different.settings.endpoint, configured);
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
    const nativeTimers = require('node:timers');
    const originalSetTimeout = nativeTimers.setTimeout;
    let expire;
    const mocked = t.mock.method(nativeTimers, 'setTimeout', (callback, milliseconds, ...args) => {
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

test('adaptive automatic reads fairly visit all base domains without synchronization and manual refresh stays climate-only', async t => {
    const disabled = await fixture(t);
    assert.equal(disabled.adapter.scheduler, undefined);
    const clock = fakeClock();
    const f = await fixture(t, { clock, enrollment: enrolled(), fakeController: true, config: { pollIntervalSeconds: 15 } });
    await clock.advance(0);
    for (let index = 0; index < 4; index++) await clock.advance(5000);
    assert.deepEqual(f.records.controllerCalls, [expectedCall('status', null), expectedChargingCall('chargingStatus'),
        { action: 'vehicleReportStatus', input: {} }, { action: 'refreshVehicleAccess', input: {} },
        { action: 'refreshVehicleInfo', input: {} }]);
    assert.equal(f.value('vehicleInfo.vin'), SYNTHETIC_VIN);
    assert.equal(f.value('refresh.vehicleInfo.status'), 'fresh');
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
    assert.equal(f.value('refresh.climate.maxAgeSeconds'), 525);
    await f.adapter.scheduler.options.onUpdate({ estimatedCycleMs: 300000, runningDomain: null, domains: {} });
    assert.equal(f.value('refresh.charging.maxAgeSeconds'), 600);
    f.adapter.settings.refreshMaxAgeSeconds = 45; await f.adapter.updateFreshness();
    assert.equal(f.value('refresh.vehicleReport.maxAgeSeconds'), 45);
    assert.equal(f.records.phones.length, 0);
});

test('manual handoff falls back to cancelling an older automatic controller and preserves the accepted preference snapshot', async t => {
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

test('manual priority prefers cooperative read handoff and still waits for the automatic read to finish', async t => {
    const clock = fakeClock(); const entered = deferred(); const release = deferred();
    const f = await fixture(t, { clock, cooperativeHandoff: true, enrollment: enrolled(), fakeController: true,
        config: { pollIntervalSeconds: 15 }, controllerExecute: async action => {
            if (action === 'status') { entered.resolve(); await release.promise; throw new BridgeError('cancelled', 'Read handed off.'); }
            return { ...chargingResult(), observedAt: new Date(clock.now()).toISOString() };
        } });
    t.after(() => release.resolve());
    await clock.advance(0); await entered.promise;
    const automatic = f.records.controllers[0];
    const manual = f.adapter.command('chargingStatus');
    assert.equal(automatic.handoffRequested, true);
    assert.equal(automatic.cancelled, undefined);
    assert.equal(f.adapter.abortController.signal.aborted, false);
    assert.equal(f.records.controllerCalls.length, 1);
    release.resolve(); await manual;
    assert.deepEqual(f.records.controllerCalls, [expectedCall('status', null), expectedChargingCall('chargingStatus')]);
    assert.equal(f.value('refresh.climate.lastErrorCode'), '');
    assert.equal(f.value('refresh.charging.status'), 'fresh');
});

test('a competing command never cancels a manual write and unload keeps hard cancellation even with cooperative handoff support', async t => {
    const entered = deferred(); const release = deferred();
    const f = await fixture(t, { cooperativeHandoff: true, enrollment: enrolled(), fakeController: true,
        config: { allowWrites: true }, controllerExecute: async () => {
            entered.resolve(); await release.promise; throw new BridgeError('cancelled', 'Adapter stopped.');
        } });
    t.after(() => release.resolve());
    const active = f.adapter.command('start'); const rejected = rejectsCode(active, 'cancelled');
    await entered.promise;
    const controller = f.records.controllers[0];
    await rejectsCode(f.adapter.command('stop'), 'busy');
    assert.equal(controller.handoffRequested, undefined);
    assert.equal(controller.cancelled, undefined);
    const unload = f.adapter.onUnload(() => {});
    assert.equal(controller.cancelled, true);
    assert.equal(controller.handoffRequested, undefined);
    release.resolve(); await rejected; await unload;
    assert.deepEqual(f.records.controllerCalls, [expectedCall('start', null)]);
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
    const nativeTimers = require('node:timers');
    const originalSetTimeout = nativeTimers.setTimeout;
    let expire;
    const mocked = t.mock.method(nativeTimers, 'setTimeout', (callback, milliseconds, ...args) => {
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

test('departure timer states separate read-only initial observations from nullable staged wishes and own-only buttons', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true });
    for (const id of ['1', '2']) {
        const path = 'departures.climate.timer' + id;
        for (const field of ['enabled', 'time', 'days', 'repeat', 'date', 'vehicleOffset', 'isLocalVehicleTime', 'source', 'daysSummary', 'daysSummaryRecognized']) {
            assert.equal(f.adapter.objects.get(path + '.' + field).common.write, false);
            assert.equal(f.value(path + '.' + field), null);
            assert.equal(f.adapter.states.get(path + '.' + field).q, 0x82);
        }
        for (const field of ['targetEnabled', 'targetTime', 'targetDays', 'targetRepeat']) {
            assert.equal(f.adapter.objects.get(path + '.' + field).common.write, true);
            assert.equal(f.value(path + '.' + field), null);
        }
        assert.equal(f.adapter.objects.get(path + '.commands.apply').common.role, 'button');
    }
    await f.adapter.onStateChange('vw-app.0.commands.refreshDepartureClimate', { val: true, ack: true });
    await f.adapter.onStateChange('vw-app.0.commands.refreshDepartureClimate', { val: 'true', ack: false });
    await f.adapter.onStateChange('0_userdata.0.departures.refreshDepartureClimate', { val: true, ack: false });
    assert.equal(f.records.controllerCalls.length, 0);
    await f.adapter.onStateChange('vw-app.0.commands.refreshDepartureClimate', { val: true, ack: false });
    assert.deepEqual(f.records.controllerCalls, [{ action: 'departuresClimateStatus', input: {} }]);
    assert.equal(f.value('commands.refreshDepartureClimate'), false);
    assert.equal(f.value('departures.climate.timer1.enabled'), false);
    assert.equal(f.value('departures.climate.timer1.days'), '["mon","wed"]');
    assert.equal(f.value('refresh.departureClimate.status'), 'fresh');
    assert.equal(f.value('climate.appState'), 'unknown');
});

test('timer wishes acknowledge only saved strict fields, allow staging intermediate combinations, and never optimistically alter observations', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true } });
    const path = 'departures.climate.timer1';
    for (const [field, value] of [['targetEnabled', true], ['targetTime', '00:00'], ['targetDays', '["sun","mon"]'], ['targetRepeat', false]]) {
        await f.adapter.onStateChange('vw-app.0.' + path + '.' + field, { val: value, ack: false });
    }
    assert.equal(f.records.phones.length, 0);
    assert.equal(f.value(path + '.targetDays'), '["mon","sun"]');
    assert.equal(f.value(path + '.targetRepeat'), false);
    assert.equal(f.value(path + '.enabled'), null);
    assert.equal(f.value(path + '.targetError'), '');
    assert.ok(f.memory['departure-preference']);
    await f.adapter.onStateChange('vw-app.0.' + path + '.commands.apply', { val: true, ack: false });
    assert.deepEqual(f.records.controllerCalls, [{ action: 'applyDepartureClimateTimer', input: {
        timerId: '1', targetTimer: { enabled: true, time: '00:00', days: ['mon', 'sun'], repeat: false } } }]);
    assert.equal(f.value(path + '.enabled'), false);
    assert.equal(f.value(path + '.time'), '07:30');
    assert.equal(f.value(path + '.targetTime'), '00:00');
    await f.adapter.onStateChange('vw-app.0.' + path + '.commands.clear', { val: true, ack: false });
    for (const field of ['targetEnabled', 'targetTime', 'targetDays', 'targetRepeat']) assert.equal(f.value(path + '.' + field), null);
    assert.equal(f.records.controllerCalls.length, 1);
});

test('timer selection errors remain field-local and a later different successful field cannot silently repair them', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true } });
    const group = f.adapter.departures.groups.get('departures.climate.timer1');
    await f.adapter.departures.stage(group, { time: '07:30' });
    await rejectsCode(f.adapter.departures.stage(group, { repeat: 'false' }), 'invalid_departure_timer');
    await f.adapter.departures.stage(group, { enabled: false });
    assert.match(f.value(group.id + '.targetError'), /repeat/);
    await rejectsCode(f.adapter.command('applyDepartureClimateTimer', { timerId: '1' }), 'departure_selection_failed');
    assert.equal(f.records.phones.length, 0);
    await f.adapter.departures.stage(group, { repeat: false });
    await f.adapter.command('applyDepartureClimateTimer', { timerId: '1' });
    assert.equal(f.records.controllerCalls.length, 1);
    assert.equal(f.value(group.id + '.targetError'), '');
});

test('a pending failed timer save blocks its immediate apply without overriding the saved target or unrelated manual feedback', async t => {
    let fail = false;
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true },
        storeWrite: async name => { if (name === 'departure-preference' && fail) throw new BridgeError('state_not_saved', 'Private value was not saved.'); } });
    const group = f.adapter.departures.groups.get('departures.climate.timer1');
    await f.adapter.departures.stage(group, { time: '07:30' });
    fail = true;
    const selected = f.adapter.departures.stage(group, { time: '08:30' });
    const apply = f.adapter.command('applyDepartureClimateTimer', { timerId: '1' });
    await rejectsCode(selected, 'state_not_saved');
    await rejectsCode(apply, 'departure_selection_failed');
    assert.equal(f.value(group.id + '.targetTime'), '07:30');
    assert.equal(f.records.phones.length, 0);
    fail = false;
    await f.adapter.departures.stage(group, { time: '08:30' });
    await f.adapter.command('applyDepartureClimateTimer', { timerId: '1' });
    assert.equal(f.records.controllerCalls[0].input.targetTimer.time, '08:30');
});

test('accepted timer snapshots wait for earlier persistence and later changes affect only the following command', async t => {
    const writing = deferred(), save = deferred(), executing = deferred(), finish = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true },
        storeWrite: async (name, value) => {
            if (name === 'departure-preference' && value.groups['departures.climate.timer1']?.time?.value === '08:30'
                && value.groups['departures.climate.timer1']?.enabled?.value === null) { writing.resolve(); await save.promise; }
        }, controllerExecute: async () => { executing.resolve(); await finish.promise; return departureClimateResult(); } });
    t.after(() => { save.resolve(); finish.resolve(); });
    const group = f.adapter.departures.groups.get('departures.climate.timer1');
    const prior = f.adapter.departures.stage(group, { time: '08:30' }); await writing.promise;
    const apply = f.adapter.command('applyDepartureClimateTimer', { timerId: '1' });
    const later = f.adapter.departures.stage(group, { enabled: true });
    assert.equal(f.records.phones.length, 0);
    save.resolve(); await prior; await later; await executing.promise;
    assert.deepEqual(f.records.controllerCalls[0].input.targetTimer, { enabled: null, time: '08:30', days: null, repeat: null });
    finish.resolve(); await apply;
    assert.equal(f.value(group.id + '.targetEnabled'), true);
});

test('stuck departure persistence never blocks status, stop, or any departure read while its own apply keeps waiting', { timeout: 3000 }, async t => {
    const writing = deferred(), save = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true },
        storeWrite: async name => { if (name === 'departure-preference') { writing.resolve(); await save.promise; } } });
    t.after(() => save.resolve());
    const group = f.adapter.departures.groups.get('departures.climate.timer1');
    const selection = f.adapter.departures.stage(group, { enabled: false }); await writing.promise;
    for (const action of ['status', 'stop', 'departuresClimateStatus', 'departuresLocationsStatus']) await f.adapter.command(action);
    assert.deepEqual(f.records.controllerCalls.map(call => call.action), ['status', 'stop', 'departuresClimateStatus', 'departuresLocationsStatus']);
    const apply = f.adapter.command('applyDepartureClimateTimer', { timerId: '1' });
    await Promise.resolve(); assert.equal(f.records.controllerCalls.length, 4);
    save.resolve(); await selection; await apply;
    assert.equal(f.records.controllerCalls.length, 5);
});

test('new observations are fully validated before publication and errors keep only the affected domain historical and invalid', async t => {
    let malformed = false;
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, controllerExecute: async action => {
        if (action !== 'departuresClimateStatus') return chargingResult();
        const result = departureClimateResult();
        if (malformed) { result.timers[0].time = '08:30'; result.timers[1].time = 'WRONG'; }
        return result;
    } });
    await f.adapter.command('chargingStatus');
    const charging = new Map([...f.adapter.states].filter(([id]) => id.startsWith('battery.') || id.startsWith('charging.')));
    await f.adapter.command('departuresClimateStatus');
    const timestamp = f.value('departures.climate.observedAt');
    const writes = f.adapter.writes.length;
    malformed = true;
    await rejectsCode(f.adapter.command('departuresClimateStatus'), 'invalid_departures_result');
    assert.equal(f.value('departures.climate.timer1.time'), '07:30');
    assert.equal(f.value('departures.climate.observedAt'), timestamp);
    assert.equal(f.value('refresh.departureClimate.lastReadAt'), timestamp);
    assert.equal(f.value('refresh.departureClimate.status'), 'error');
    assert.equal(f.adapter.states.get('departures.climate.timer1.enabled').q, 0x82);
    assert.equal(f.adapter.writes.slice(writes).some(row => row.id === 'departures.climate.timer1.time' && row.value.val === '08:30'), false);
    for (const [id, value] of charging) assert.deepEqual(f.adapter.states.get(id), value);
});

test('complete inventory discovers only real locations, keeps keys across reorder and does not rewrite unchanged private bindings', async t => {
    let rows = [{ nativeId: '700', name: 'Synthetischer Ort A', activeCount: 0 }, { nativeId: '701', name: 'Synthetischer Ort B', activeCount: 1 }];
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { pollIntervalSeconds: 15 }, RefreshScheduler: RecordingScheduler,
        controllerExecute: async () => departureInventoryResult(rows) });
    assert.deepEqual(f.adapter.scheduler.options.domains, ['climate', 'charging', 'vehicleReport', 'vehicleAccess', 'vehicleInfo', 'departureClimate', 'departureLocations']);
    await f.adapter.command('departuresLocationsStatus');
    const keys = rows.map(row => localKey(VEHICLE, row.nativeId));
    assert.equal(f.value('chargingLocations.count'), 2);
    assert.equal(f.adapter.scheduler.options.domains.length, 9);
    for (const key of keys) assert.ok(f.adapter.scheduler.options.domains.includes('departureLocation_' + key));
    const writes = f.records.stores[0].writes.filter(write => write.name === 'departure-location-bindings').length;
    rows = [...rows].reverse(); await f.adapter.command('departuresLocationsStatus');
    assert.equal(f.records.stores[0].writes.filter(write => write.name === 'departure-location-bindings').length, writes);
    assert.equal(f.value('chargingLocations.' + keys[0] + '.name'), 'Synthetischer Ort A');
    assert.equal(f.adapter.scheduler.options.domains.filter(domain => domain.startsWith('departureLocation_')).length, 2);
    rows = [...rows, { ...rows[0] }];
    await rejectsCode(f.adapter.command('departuresLocationsStatus'), 'invalid_departures_result');
    assert.equal(f.value('chargingLocations.count'), 2);
    assert.equal(f.adapter.states.get('chargingLocations.count').q, 0x82);
});

test('location observations expose all three timers and four fixed windows without fake SOC values or writable time limits', async t => {
    const rows = [{ nativeId: '700', name: 'Synthetischer Ort A', activeCount: 0 }];
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, departureLocations: rows });
    await f.adapter.command('departuresLocationsStatus');
    const key = localKey(VEHICLE, '700'), path = 'chargingLocations.' + key;
    await f.adapter.departureCommand('departuresLocationStatus', { locationKey: key });
    assert.deepEqual(f.records.controllerCalls.at(-1), { action: 'departuresLocationStatus', input: { location: { nativeId: '700', name: rows[0].name } } });
    for (const id of ['1', '2', '3']) {
        assert.equal(f.value(path + '.timer' + id + '.profileId'), '700');
        assert.equal(f.adapter.objects.get(path + '.timer' + id + '.climatisation').common.write, false);
    }
    for (const field of ['directSoc', 'socLimit']) {
        assert.equal(f.value(path + '.settings.' + field), null);
        assert.equal(f.adapter.states.get(path + '.settings.' + field).q, 0x82);
        assert.equal(f.adapter.objects.get(path + '.settings.' + field).common.write, false);
    }
    assert.equal(f.value(path + '.settings.socReadCapability'), 'not_exposed_by_app');
    assert.equal(f.adapter.objects.has(path + '.settings.targetSoc'), false);
    for (const id of ['1', '2', '3', '4']) {
        assert.equal(f.value(path + '.preferredTimes.window' + id + '.enabled'), false);
        assert.equal(f.adapter.objects.get(path + '.preferredTimes.window' + id + '.start').common.write, false);
        assert.equal(f.adapter.objects.get(path + '.preferredTimes.window' + id + '.end').common.write, false);
        assert.equal(f.adapter.objects.get(path + '.preferredTimes.window' + id + '.targetEnabled').common.write, true);
    }
});

test('external location rename preserves staged values but requires each affected wish to be reselected or cleared', async t => {
    let name = 'Synthetischer Ort A';
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true },
        controllerExecute: async (action, options) => action === 'departuresLocationsStatus'
            ? departureInventoryResult([{ nativeId: '700', name, activeCount: 0 }]) : departureLocationResult(options.location) });
    await f.adapter.command('departuresLocationsStatus');
    const key = localKey(VEHICLE, '700'), group = f.adapter.departures.groups.get('chargingLocations.' + key + '.timer1');
    await f.adapter.departureCommand('departuresLocationStatus', { locationKey: key });
    const observedAt = f.value('chargingLocations.' + key + '.observedAt');
    await f.adapter.departures.stage(group, { time: '08:30', enabled: false });
    name = 'Synthetischer Ort Neu'; await f.adapter.command('departuresLocationsStatus');
    assert.equal(f.value(group.id + '.targetTime'), '08:30');
    assert.match(f.value(group.id + '.targetError'), /departure_binding_changed/);
    assert.equal(f.value('refresh.departureLocation_' + key + '.status'), 'stale');
    assert.equal(f.adapter.states.get(group.id + '.time').q, 0x82);
    assert.equal(f.value('chargingLocations.' + key + '.settings.name'), 'Synthetischer Ort A');
    assert.equal(f.adapter.states.get('chargingLocations.' + key + '.settings.name').q, 0x82);
    assert.equal(f.value('chargingLocations.' + key + '.observedAt'), observedAt);
    const before = f.records.phones.length;
    await rejectsCode(f.adapter.departureCommand('applyDepartureLocationTimer', { locationKey: key, timerId: '1' }), 'departure_binding_changed');
    assert.equal(f.records.phones.length, before);
    await f.adapter.departures.stage(group, { time: '08:30' });
    await rejectsCode(f.adapter.departureCommand('applyDepartureLocationTimer', { locationKey: key, timerId: '1' }), 'departure_binding_changed');
    await f.adapter.departures.stage(group, { enabled: false });
    await f.adapter.departureCommand('applyDepartureLocationTimer', { locationKey: key, timerId: '1' });
    assert.equal(f.records.controllerCalls.at(-1).input.location.name, name);
    assert.equal(f.value(group.id + '.targetError'), '');
});

test('removed locations lose their automatic jobs and reappearing identities cannot revive old wishes', async t => {
    let rows = [{ nativeId: '700', name: 'Synthetischer Ort A', activeCount: 0 }];
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true, pollIntervalSeconds: 15 }, RefreshScheduler: RecordingScheduler,
        controllerExecute: async (action, options) => action === 'departuresLocationsStatus' ? departureInventoryResult(rows) : departureLocationResult(options.location) });
    await f.adapter.command('departuresLocationsStatus');
    const key = localKey(VEHICLE, '700'), domain = 'departureLocation_' + key, path = 'chargingLocations.' + key;
    await f.adapter.departureCommand('departuresLocationStatus', { locationKey: key });
    const readAt = f.value(path + '.observedAt');
    await f.adapter.departures.stage(f.adapter.departures.groups.get(path + '.timer1'), { time: '08:30' });
    rows = []; await f.adapter.command('departuresLocationsStatus');
    assert.equal(f.adapter.scheduler.options.domains.includes(domain), false);
    assert.equal(f.value(path + '.present'), false);
    assert.equal(f.value(path + '.timer1.time'), '07:30');
    assert.equal(f.adapter.states.get(path + '.timer1.time').q, 0x82);
    assert.equal(f.value(path + '.observedAt'), readAt);
    rows = [{ nativeId: '700', name: 'Synthetischer Ort A', activeCount: 0 }]; await f.adapter.command('departuresLocationsStatus');
    assert.equal(f.adapter.scheduler.options.domains.includes(domain), true);
    assert.equal(f.value('refresh.' + domain + '.status'), 'stale');
    assert.equal(f.adapter.states.get(path + '.timer1.time').q, 0x82);
    await rejectsCode(f.adapter.departureCommand('applyDepartureLocationTimer', { locationKey: key, timerId: '1' }), 'departure_binding_changed');
});

test('restart restores location wishes privately and schedules no phantom places before a new verified inventory', async t => {
    const rows = [{ nativeId: '700', name: 'Synthetischer Ort A', activeCount: 0 }];
    const first = await fixture(t, { enrollment: enrolled(), fakeController: true, departureLocations: rows });
    await first.adapter.command('departuresLocationsStatus');
    const key = localKey(VEHICLE, '700'), path = 'chargingLocations.' + key + '.timer1';
    await first.adapter.departures.stage(first.adapter.departures.groups.get(path), { time: '08:30', enabled: false });
    const restarted = await fixture(t, { memory: first.memory, fakeController: true, config: { allowWrites: true, pollIntervalSeconds: 15 },
        RefreshScheduler: RecordingScheduler, departureLocations: rows });
    assert.equal(restarted.value(path + '.targetTime'), '08:30');
    assert.equal(restarted.value(path + '.targetEnabled'), false);
    assert.equal(restarted.adapter.scheduler.options.domains.some(domain => domain.startsWith('departureLocation_')), false);
    await rejectsCode(restarted.adapter.departureCommand('applyDepartureLocationTimer', { locationKey: key, timerId: '1' }), 'departure_binding_changed');
    await restarted.adapter.command('departuresLocationsStatus');
    await restarted.adapter.departureCommand('applyDepartureLocationTimer', { locationKey: key, timerId: '1' });
    assert.equal(restarted.records.controllerCalls.at(-1).input.targetTimer.time, '08:30');
    const missingBindings = clone(first.memory); delete missingBindings['departure-location-bindings'];
    const unbound = await fixture(t, { memory: missingBindings, fakeController: true, config: { allowWrites: true }, departureLocations: rows });
    await unbound.adapter.command('departuresLocationsStatus');
    await rejectsCode(unbound.adapter.departureCommand('applyDepartureLocationTimer', { locationKey: key, timerId: '1' }), 'departure_binding_changed');
});

test('gear and preferred-window snapshots apply only their selected group and readonly times remain unchanged', async t => {
    const rows = [{ nativeId: '700', name: 'Synthetischer Ort A', activeCount: 0 }];
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true }, departureLocations: rows });
    await f.adapter.command('departuresLocationsStatus');
    const key = localKey(VEHICLE, '700'), path = 'chargingLocations.' + key;
    const settings = f.adapter.departures.groups.get(path + '.settings'), preferred = f.adapter.departures.groups.get(path + '.preferredTimes');
    await f.adapter.departures.stage(settings, { reducedAcCurrent: true, autoUnlockAc: false });
    await f.adapter.departures.stage(preferred, { '2': true });
    await f.adapter.departureCommand('applyDepartureLocationSettings', { locationKey: key });
    assert.deepEqual(f.records.controllerCalls.at(-1).input.targetSettings, { name: null, reducedAcCurrent: true, autoUnlockAc: false });
    assert.equal(Object.hasOwn(f.records.controllerCalls.at(-1).input, 'targetPreferredTimes'), false);
    await f.adapter.departureCommand('applyDeparturePreferredTimes', { locationKey: key });
    assert.deepEqual(f.records.controllerCalls.at(-1).input.targetPreferredTimes,
        ['1', '2', '3', '4'].map(id => ({ id, enabled: id === '2' ? true : null })));
    assert.equal(f.value(path + '.preferredTimes.window2.enabled'), false);
    assert.equal(f.value(path + '.preferredTimes.window2.targetEnabled'), true);
    assert.equal(f.value(path + '.preferredTimes.window2.start'), '00:00');
});

test('departure TTL preserves all successful values and timestamps but not stale quality, then a new read restores only known fields', async t => {
    const clock = fakeClock();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, clock, config: { refreshMaxAgeSeconds: 30 } });
    await f.adapter.command('departuresClimateStatus');
    const readAt = f.value('departures.climate.observedAt');
    await clock.advance(31000);
    assert.equal(f.value('refresh.departureClimate.status'), 'stale');
    assert.equal(f.value('departures.climate.timer1.time'), '07:30');
    assert.equal(f.adapter.states.get('departures.climate.timer1.time').q, 0x82);
    assert.equal(f.value('departures.climate.observedAt'), readAt);
    await f.adapter.command('departuresClimateStatus');
    assert.equal(f.value('refresh.departureClimate.status'), 'fresh');
    assert.equal(f.adapter.states.get('departures.climate.timer1.time').q, undefined);
    assert.equal(f.adapter.states.get('departures.climate.timer1.date').q, 0x82);
});

test('automatic rotation fairly reads all five actual locations plus old and new areas without applying persisted wishes or syncing', async t => {
    const clock = fakeClock();
    const locations = Array.from({ length: 5 }, (_, index) => ({ nativeId: String(700 + index), name: 'Synthetischer Ort ' + index, activeCount: 0 }));
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, clock, departureLocations: locations,
        config: { pollIntervalSeconds: 15 } });
    await f.adapter.departures.stage(f.adapter.departures.groups.get('departures.climate.timer1'), { enabled: true });
    await f.adapter.command('status');
    const manual = { result: f.value('operation.lastResult'), error: f.value('operation.lastError'), code: f.value('operation.lastErrorCode') };
    await clock.advance(180000);
    const calls = f.records.controllerCalls;
    for (const action of ['status', 'chargingStatus', 'vehicleReportStatus', 'refreshVehicleAccess', 'refreshVehicleInfo', 'departuresClimateStatus', 'departuresLocationsStatus']) {
        assert.ok(calls.filter(call => call.action === action).length >= 2, action);
    }
    for (const location of locations) assert.ok(calls.filter(call => call.action === 'departuresLocationStatus'
        && call.input.location.nativeId === location.nativeId).length >= 2, location.nativeId);
    assert.equal(f.adapter.activeReadDomains.length, 12);
    assert.equal(calls.some(call => /apply|start|stop|synchronize/i.test(call.action)), false);
    assert.equal(f.value('departures.climate.timer1.targetEnabled'), true);
    assert.equal(f.value('operation.lastResult'), manual.result);
    assert.equal(f.value('operation.lastError'), manual.error);
    assert.equal(f.value('operation.lastErrorCode'), manual.code);
    for (const domain of f.adapter.activeReadDomains) assert.equal(f.value('refresh.' + domain + '.status'), 'fresh', domain);
});

test('a new-domain automatic read cooperatively yields to one manual stop without changing its historical quality or manual feedback', async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, cooperativeHandoff: true,
        config: { allowWrites: true, pollIntervalSeconds: 15 }, RefreshScheduler: RecordingScheduler,
        controllerExecute: async action => {
            if (action === 'departuresClimateStatus') { entered.resolve(); await release.promise; throw new BridgeError('cancelled', 'Intentional handoff.'); }
            return { appState: 'off', appVersion: '4.8.1', observedAt: new Date().toISOString(), temperature: null };
        } });
    t.after(() => release.resolve());
    const running = f.adapter.scheduler.options.run('departureClimate'); await entered.promise;
    const automatic = f.records.controllers[0];
    const stop = f.adapter.command('stop');
    assert.equal(automatic.handoffRequested, true);
    assert.equal(automatic.cancelled, undefined);
    assert.equal(f.adapter.pendingManual, true);
    await rejectsCode(f.adapter.command('departuresLocationsStatus'), 'busy');
    assert.equal(f.records.controllerCalls.length, 1);
    release.resolve(); await running; await stop;
    assert.deepEqual(f.records.controllerCalls.map(call => call.action), ['departuresClimateStatus', 'stop']);
    assert.equal(f.value('refresh.departureClimate.status'), 'unknown');
    assert.equal(f.value('refresh.departureClimate.lastErrorCode'), '');
    assert.equal(f.value('operation.lastResult'), 'succeeded');
    assert.equal(f.adapter.busy, false); assert.equal(f.adapter.pendingManual, false);
});

test('uncertain departure writes schedule only the affected read area and preserve the failed operation after background recovery', async t => {
    let failWrite = true;
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        config: { allowWrites: true, pollIntervalSeconds: 15 }, RefreshScheduler: RecordingScheduler,
        controllerExecute: async action => {
            if (action === 'applyDepartureClimateTimer' && failWrite) throw new BridgeError('outcome_unknown', 'App confirmation is missing.');
            return departureClimateResult();
        } });
    await f.adapter.departures.stage(f.adapter.departures.groups.get('departures.climate.timer1'), { time: '08:30' });
    await rejectsCode(f.adapter.command('applyDepartureClimateTimer', { timerId: '1' }), 'outcome_unknown');
    assert.deepEqual(f.adapter.scheduler.requests, [{ domain: 'departureClimate', priority: true, delayMs: 2000 }]);
    failWrite = false;
    await f.adapter.scheduler.options.run('departureClimate');
    assert.deepEqual(f.records.controllerCalls.map(call => call.action), ['applyDepartureClimateTimer', 'departuresClimateStatus']);
    assert.equal(f.value('operation.lastResult'), 'failed');
    assert.equal(f.value('operation.lastErrorCode'), 'outcome_unknown');
    assert.equal(f.value('refresh.departureClimate.status'), 'fresh');
});

test('a verified own location rename changes its private generation and requests inventory without applying other old wishes', async t => {
    const oldName = 'Synthetischer Ort A', newName = 'Synthetischer Ort Neu';
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        config: { allowWrites: true, pollIntervalSeconds: 15 }, RefreshScheduler: RecordingScheduler,
        controllerExecute: async (action, options) => {
            if (action === 'departuresLocationsStatus') return departureInventoryResult([{ nativeId: '700', name: oldName, activeCount: 0 }]);
            const result = departureLocationResult({ ...options.location, name: newName });
            return { ...result, changed: true, renamedFrom: oldName };
        } });
    await f.adapter.command('departuresLocationsStatus');
    const key = localKey(VEHICLE, '700'), path = 'chargingLocations.' + key;
    await f.adapter.departures.stage(f.adapter.departures.groups.get(path + '.timer1'), { enabled: true });
    await f.adapter.departures.stage(f.adapter.departures.groups.get(path + '.settings'), { name: newName });
    await f.adapter.departureCommand('applyDepartureLocationSettings', { locationKey: key });
    assert.equal(f.value(path + '.settings.name'), newName);
    assert.equal(f.adapter.departures.bindings[key].name, newName);
    assert.equal(f.adapter.departures.bindings[key].generation, 2);
    assert.equal(f.value('refresh.departureLocations.status'), 'stale');
    assert.equal(f.adapter.states.get('chargingLocations.json').q, 0x82);
    assert.equal(f.adapter.states.get(path + '.name').q, 0x82);
    assert.equal(f.value(path + '.name'), oldName);
    assert.equal(f.value('refresh.departureLocation_' + key + '.status'), 'fresh');
    assert.equal(f.value(path + '.timer1.targetEnabled'), true);
    assert.match(f.value(path + '.timer1.targetError'), /departure_binding_changed/);
    assert.deepEqual(f.adapter.scheduler.requests, [{ domain: 'departureLocations', priority: true, delayMs: 2000 },
        { domain: 'departureLocation_' + key, priority: true, delayMs: 2000 }]);
    assert.deepEqual(f.records.controllerCalls.map(call => call.action), ['departuresLocationsStatus', 'applyDepartureLocationSettings']);
});

test('damaged saved timer fields survive unrelated repairs and restart until each is explicitly selected or cleared', async t => {
    const path = 'departures.climate.timer1';
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, memory: { 'departure-preference': {
        version: 1, groups: { [path]: { enabled: { value: false, token: null }, time: { value: Infinity, token: null },
            days: { value: null, token: null }, repeat: { value: null, token: null } } } } } });
    await f.adapter.departures.stage(f.adapter.departures.groups.get(path), { enabled: false });
    const restarted = await fixture(t, { memory: f.memory, fakeController: true, config: { allowWrites: true } });
    assert.equal(restarted.value(path + '.targetEnabled'), false);
    assert.match(restarted.value(path + '.targetError'), /time/);
    await rejectsCode(restarted.adapter.command('applyDepartureClimateTimer', { timerId: '1' }), 'departure_selection_failed');
    await restarted.adapter.departures.stage(restarted.adapter.departures.groups.get(path), { time: '08:30' });
    await restarted.adapter.command('applyDepartureClimateTimer', { timerId: '1' });
    assert.equal(restarted.records.controllerCalls.length, 1);
});

test('unload waits for an accepted departure preference write so restart restores it', async t => {
    const writing = deferred(), save = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        storeWrite: async name => { if (name === 'departure-preference') { writing.resolve(); await save.promise; } } });
    t.after(() => save.resolve());
    const path = 'departures.climate.timer1';
    const selection = f.adapter.departures.stage(f.adapter.departures.groups.get(path), { enabled: false }); await writing.promise;
    let unloaded = false; const unload = f.adapter.onUnload(() => { unloaded = true; });
    await Promise.resolve(); assert.equal(unloaded, false);
    save.resolve(); await selection; await unload;
    const restarted = await fixture(t, { memory: f.memory, fakeController: true });
    assert.equal(restarted.value(path + '.targetEnabled'), false);
});

for (const targetPatch of [{ enabled: true }, { time: '08:30' }]) {
test('a location timer attempt invalidates its inventory count after uncertain ' + Object.keys(targetPatch)[0] + ' input', async t => {
    let fail = false;
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        config: { allowWrites: true, pollIntervalSeconds: 15 }, RefreshScheduler: RecordingScheduler,
        controllerExecute: async (action, options) => {
            if (action === 'departuresLocationsStatus') return departureInventoryResult([{ nativeId: '700', name: 'Synthetischer Ort A', activeCount: 0 }]);
            if (fail) throw new BridgeError('outcome_unknown', 'No reliable confirmation.');
            return departureLocationResult(options.location);
        } });
    await f.adapter.command('departuresLocationsStatus');
    const key = localKey(VEHICLE, '700'), path = 'chargingLocations.' + key;
    await f.adapter.departures.stage(f.adapter.departures.groups.get(path + '.timer1'), targetPatch);
    fail = true;
    await rejectsCode(f.adapter.departureCommand('applyDepartureLocationTimer', { locationKey: key, timerId: '1' }), 'outcome_unknown');
    assert.equal(f.value('refresh.departureLocations.status'), 'stale');
    assert.equal(f.value(path + '.activeTimerCount'), 0);
    assert.equal(f.adapter.states.get(path + '.activeTimerCount').q, 0x82);
    assert.deepEqual(f.adapter.scheduler.requests, [{ domain: 'departureLocations', priority: true, delayMs: 2000 },
        { domain: 'departureLocation_' + key, priority: true, delayMs: 2000 }]);
});
}

test('later invalid staging cannot poison an already accepted snapshot waiting for an earlier valid save', async t => {
    const writing = deferred(), release = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true },
        storeWrite: async name => { if (name === 'departure-preference') { writing.resolve(); await release.promise; } } });
    t.after(() => release.resolve());
    const group = f.adapter.departures.groups.get('departures.climate.timer1');
    const prior = f.adapter.departures.stage(group, { time: '07:30' }); await writing.promise;
    const accepted = f.adapter.command('applyDepartureClimateTimer', { timerId: '1' });
    const later = f.adapter.departures.stage(group, { time: 'invalid' });
    release.resolve(); await prior;
    await rejectsCode(later, 'invalid_departure_timer');
    await accepted;
    assert.equal(f.records.controllerCalls.length, 1);
    assert.equal(f.records.controllerCalls[0].input.targetTimer.time, '07:30');
    assert.equal(group.failed.time, true);
    assert.match(f.value(group.id + '.targetError'), /time/);
    assert.equal(f.value('operation.lastResult'), 'succeeded');
    await rejectsCode(f.adapter.command('applyDepartureClimateTimer', { timerId: '1' }), 'departure_selection_failed');
});

for (const failurePoint of ['refreshMetadata', 'lateGroupTarget']) {
    test('a transient database definition failure is repaired by the next complete inventory: ' + failurePoint, async t => {
        let failed = false;
        const key = localKey(VEHICLE, '700'), path = 'chargingLocations.' + key, domain = 'departureLocation_' + key;
        const failingId = failurePoint === 'refreshMetadata' ? 'refresh.' + domain + '.lastErrorCode' : path + '.settings.targetName';
        const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
            config: { allowWrites: true, pollIntervalSeconds: 15 }, RefreshScheduler: RecordingScheduler,
            departureLocations: [{ nativeId: '700', name: 'Synthetischer Ort A', activeCount: 0 }],
            objectWrite: async id => { if (!failed && id === failingId) { failed = true; throw new Error('PRIVATE DATABASE ERROR'); } } });
        await rejectsCode(f.adapter.command('departuresLocationsStatus'), 'invalid_departures_result');
        assert.equal(failed, true);
        assert.equal(f.adapter.objects.has(failingId), false);
        assert.equal(f.adapter.activeReadDomains.includes(domain), false);
        const before = f.adapter.writes.length;
        await f.adapter.updateFreshness();
        if (failurePoint === 'refreshMetadata') assert.equal(f.adapter.writes.slice(before).some(row => row.id.startsWith('refresh.' + domain + '.')), false);
        await f.adapter.command('departuresLocationsStatus');
        for (const field of ['status', 'lastReadAt', 'ageSeconds', 'lastErrorCode', 'lastDurationSeconds', 'maxAgeSeconds']) {
            assert.equal(f.adapter.objects.get('refresh.' + domain + '.' + field).common.write, false);
        }
        assert.equal(f.adapter.objects.get(path + '.settings.targetName').common.write, true);
        assert.equal(f.adapter.objects.get(path + '.preferredTimes.window4.targetEnabled').common.write, true);
        assert.equal(f.adapter.activeReadDomains.includes(domain), true);
        await f.adapter.onStateChange('vw-app.0.' + path + '.settings.targetReducedAcCurrent', { val: true, ack: false });
        assert.equal(f.value(path + '.settings.targetReducedAcCurrent'), true);
        await f.adapter.onStateChange('vw-app.0.' + path + '.settings.commands.apply', { val: true, ack: false });
        assert.equal(f.records.controllerCalls.at(-1).action, 'applyDepartureLocationSettings');
        assert.equal(f.records.controllerCalls.at(-1).input.targetSettings.reducedAcCurrent, true);
        assert.equal(f.value('refresh.departureLocations.status'), 'fresh');
    });
}

test('vehicle access creates ten read-only nullable indicators, named channels and a separate read command', async t => {
    const f = await fixture(t);
    assert.equal(f.adapter.objects.get('vehicleAccess').common.name, 'Türen, Fenster und Verriegelung');
    assert.equal(f.adapter.objects.get('vehicleAccess.doors').common.name, 'Türen');
    assert.equal(f.adapter.objects.get('vehicleAccess.windows').common.name, 'Fenster');
    assert.equal(ACCESS_BOOLEAN_IDS.length, 10);
    for (const id of ACCESS_BOOLEAN_IDS) {
        const common = f.adapter.objects.get(id).common;
        assert.equal(common.type, 'boolean', id);
        assert.equal(common.read, true, id);
        assert.equal(common.write, false, id);
        assert.match(common.name, /laut App$/);
        assert.equal(common.role, id.endsWith('.locked') ? 'sensor'
            : id.startsWith('vehicleAccess.windows.') ? 'sensor.window' : 'sensor.door');
        assert.deepEqual(f.adapter.states.get(id), { val: null, ack: true, q: 0x82 }, id);
    }
    for (const id of ['vehicleAccess.synchronizationText', 'vehicleAccess.warningText', 'vehicleAccess.observedAt']) {
        assert.equal(f.adapter.objects.get(id).common.write, false);
        assert.deepEqual(f.adapter.states.get(id), { val: '', ack: true, q: 0x82 });
    }
    assert.equal(f.adapter.objects.get('commands.refreshVehicleAccess').common.role, 'button');
    assert.equal(f.adapter.objects.get('commands.refreshVehicleAccess').common.write, true);
    assert.equal(f.value('refresh.vehicleAccess.status'), 'unknown');
    assert.equal(f.value('refresh.vehicleAccess.lastReadAt'), '');
    assert.equal(f.value('refresh.vehicleAccess.ageSeconds'), null);
});

test('vehicle access refresh is own-only and read-only without write permission or applying staged wishes', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        config: { legacyStatePrefix: '0_userdata.0.old_vw' }, memory: {
            'temperature-preference': { targetCelsius: 23.5 },
            'settings-preference': { mode: 'windowHeating', climateOnUnlock: true },
            'charging-preference': { socLimit: 80 },
        } });
    for (const state of [null, { val: true }, { val: true, ack: true }, { val: 'true', ack: false },
        { val: false, ack: false }, { val: true, ack: 'false' }]) {
        await f.adapter.onStateChange('vw-app.0.commands.refreshVehicleAccess', state);
    }
    await f.adapter.onStateChange('0_userdata.0.old_vw.refreshVehicleAccess', { val: true, ack: false });
    await f.adapter.onStateChange('other.0.commands.refreshVehicleAccess', { val: true, ack: false });
    await f.adapter.onStateChange('vw-app.0.vehicleAccess.locked', { val: true, ack: false });
    assert.deepEqual(f.records.controllerCalls, []);
    const wishes = clone(f.memory);
    await f.adapter.onStateChange('vw-app.0.commands.refreshVehicleAccess', { val: true, ack: false });
    assert.deepEqual(f.records.controllerCalls, [{ action: 'refreshVehicleAccess', input: {} }]);
    assert.deepEqual(f.adapter.states.get('commands.refreshVehicleAccess'), { val: false, ack: true });
    assert.deepEqual(f.memory, wishes);
    assert.deepEqual(f.records.stores[0].writes, []);
    assert.equal(f.records.stores[0].reservations, 0);
    assert.equal(f.adapter.settings.allowWrites, false);
    assert.equal(f.value('battery.lastSyncRequestAt'), '');
    assert.equal(f.value('climate.appState'), 'unknown');
});

test('vehicle access projects each component with true meaning open and true locked meaning locked', async t => {
    const f = await fixture(t);
    const access = vehicleAccessModel();
    await f.adapter.observation(vehicleAccessResult(access));
    for (const group of ['doors', 'windows']) for (const position of ACCESS_POSITIONS) {
        assert.deepEqual(f.adapter.states.get('vehicleAccess.' + group + '.' + position + 'Open'),
            { val: access[group][position], ack: true });
    }
    for (const key of ['trunkOpen', 'locked', 'synchronizationText', 'warningText']) {
        assert.deepEqual(f.adapter.states.get('vehicleAccess.' + key), { val: access[key], ack: true });
    }
    assert.equal(f.value('vehicleAccess.observedAt'), '2026-10-24T19:00:00.000Z');
    assert.equal(f.value('refresh.vehicleAccess.lastReadAt'), f.value('vehicleAccess.observedAt'));
    assert.equal(f.value('refresh.vehicleAccess.status'), 'fresh');
    assert.equal(f.value('climate.vehicleConfirmed'), false);
    const closed = vehicleAccessModel();
    closed.doors = Object.fromEntries(ACCESS_POSITIONS.map(key => [key, false]));
    closed.windows = { ...closed.doors }; closed.trunkOpen = false; closed.locked = true; closed.warningText = '';
    await f.adapter.observation(vehicleAccessResult(closed));
    for (const id of ACCESS_BOOLEAN_IDS) assert.equal(f.value(id), id.endsWith('.locked'), id);
});

test('partial unknown access values publish null with invalid quality while known components stay valid', async t => {
    const f = await fixture(t);
    const access = vehicleAccessModel();
    access.doors.frontRight = null; access.windows.rearRight = null; access.locked = null;
    await f.adapter.observation(vehicleAccessResult(access));
    for (const id of ['vehicleAccess.doors.frontRightOpen', 'vehicleAccess.windows.rearRightOpen', 'vehicleAccess.locked']) {
        assert.deepEqual(f.adapter.states.get(id), { val: null, ack: true, q: 0x82 });
    }
    assert.deepEqual(f.adapter.states.get('vehicleAccess.doors.frontLeftOpen'), { val: true, ack: true });
    assert.equal(f.value('refresh.vehicleAccess.status'), 'fresh');
    assert.equal(f.value('vehicleAccess.warningText'), access.warningText);
});

test('malformed access envelopes and models cannot partially overwrite a prior observation', async t => {
    let response = vehicleAccessResult();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, controllerExecute: async () => response });
    await f.adapter.observation(chargingResult());
    const untouched = clone(f.adapter.states.get('battery.soc'));
    const badModel = vehicleAccessModel(); badModel.windows.rearRight = 'false';
    const bad = [null, { ...vehicleAccessResult(), domain: 'charging' },
        { ...vehicleAccessResult(), source: 'other' }, { ...vehicleAccessResult(), vehicleConfirmed: true },
        { ...vehicleAccessResult(), appVersion: undefined }, { ...vehicleAccessResult(), observedAt: '2026-02-30T00:00:00.000Z' },
        vehicleAccessResult(badModel)];
    for (const invalid of bad) {
        await f.adapter.observation(vehicleAccessResult());
        const prior = new Map([...f.adapter.states].filter(([id]) => id.startsWith('vehicleAccess.')));
        response = invalid; const before = f.adapter.writes.length;
        await assert.rejects(f.adapter.command('refreshVehicleAccess'), error => error instanceof BridgeError && /^invalid_/.test(error.code));
        for (const [id, value] of prior) assert.equal(f.value(id), value.val, id);
        assert.ok(f.adapter.writes.slice(before).filter(row => row.id.startsWith('vehicleAccess.')).every(row => row.value.q === 0x82));
        assert.equal(f.value('refresh.vehicleAccess.lastReadAt'), '2026-10-24T19:00:00.000Z');
        assert.equal(f.value('refresh.vehicleAccess.status'), 'error');
        assert.deepEqual(f.adapter.states.get('battery.soc'), untouched);
    }
});

test('automatic access reads renew quality and timestamps without replacing manual feedback or wishes', async t => {
    const clock = fakeClock(); let response;
    const f = await fixture(t, { clock, enrollment: enrolled(), fakeController: true, RefreshScheduler: RecordingScheduler,
        config: { pollIntervalSeconds: 15, refreshMaxAgeSeconds: 30 }, controllerExecute: async action => {
            assert.equal(action, 'refreshVehicleAccess');
            if (response instanceof Error) throw response;
            return { ...vehicleAccessResult(response), observedAt: new Date(clock.now()).toISOString() };
        } });
    response = vehicleAccessModel();
    await f.adapter.stageTemperature(24); await f.adapter.stageChargingSetting('socLimit', 80);
    await f.adapter.state('operation.lastResult', 'prior_manual_result');
    await f.adapter.state('operation.lastErrorCode', 'prior_manual_code');
    const memory = clone(f.memory);
    assert.ok(f.adapter.scheduler.options.domains.includes('vehicleAccess'));
    await f.adapter.scheduler.options.run('vehicleAccess');
    const first = f.value('vehicleAccess.observedAt');
    await clock.advance(31000);
    assert.equal(f.value('refresh.vehicleAccess.status'), 'stale');
    for (const id of ACCESS_BOOLEAN_IDS) assert.equal(f.adapter.states.get(id).q, 0x82, id);
    assert.equal(f.value('vehicleAccess.observedAt'), first);
    response = new BridgeError('wifi_unavailable', 'Phone not reachable.');
    await rejectsCode(f.adapter.scheduler.options.run('vehicleAccess'), 'wifi_unavailable');
    assert.equal(f.value('refresh.vehicleAccess.status'), 'error');
    assert.equal(f.value('refresh.vehicleAccess.lastErrorCode'), 'wifi_unavailable');
    assert.equal(f.value('refresh.vehicleAccess.lastReadAt'), first);
    assert.equal(f.value('vehicleAccess.doors.frontLeftOpen'), true);
    response = vehicleAccessModel(); response.doors.frontLeft = false;
    await f.adapter.scheduler.options.run('vehicleAccess');
    assert.equal(f.value('vehicleAccess.doors.frontLeftOpen'), false);
    assert.equal(f.adapter.states.get('vehicleAccess.doors.frontLeftOpen').q, undefined);
    assert.equal(f.value('refresh.vehicleAccess.status'), 'fresh');
    assert.equal(f.value('refresh.vehicleAccess.lastErrorCode'), '');
    assert.notEqual(f.value('vehicleAccess.observedAt'), first);
    assert.equal(f.value('operation.lastResult'), 'prior_manual_result');
    assert.equal(f.value('operation.lastErrorCode'), 'prior_manual_code');
    assert.equal(f.value('refresh.autoBusy'), false);
    assert.deepEqual(f.memory, memory);
    assert.equal(f.value('battery.lastSyncRequestAt'), '');
});

test('access history survives restart with invalid quality until a new app read succeeds', async t => {
    const first = await fixture(t);
    await first.adapter.observation(vehicleAccessResult());
    const initialStates = Object.fromEntries([...first.adapter.states].filter(([id]) => id.startsWith('vehicleAccess.') || id.startsWith('refresh.vehicleAccess.')));
    const restarted = await fixture(t, { initialStates });
    assert.equal(restarted.value('vehicleAccess.doors.frontLeftOpen'), true);
    assert.equal(restarted.value('vehicleAccess.doors.frontRightOpen'), false);
    assert.equal(restarted.value('vehicleAccess.observedAt'), '2026-10-24T19:00:00.000Z');
    assert.deepEqual(restarted.adapter.states.get('vehicleAccess.observedAt'),
        { val: '2026-10-24T19:00:00.000Z', ack: true });
    assert.equal(restarted.value('refresh.vehicleAccess.lastReadAt'), '2026-10-24T19:00:00.000Z');
    assert.equal(restarted.value('refresh.vehicleAccess.status'), 'stale');
    for (const id of ACCESS_BOOLEAN_IDS) assert.equal(restarted.adapter.states.get(id).q, 0x82);
    await restarted.adapter.observation(vehicleAccessResult());
    assert.deepEqual(restarted.adapter.states.get('vehicleAccess.locked'), { val: false, ack: true });
    assert.equal(restarted.value('refresh.vehicleAccess.status'), 'fresh');
});

test('restart preserves historical climate, charging, report and departure observations but marks them stale', async t => {
    const first = await fixture(t, { enrollment: enrolled(), fakeController: true,
        departureLocations: [{ nativeId: '700', name: 'Synthetischer Ort A', activeCount: 0 }] });
    await first.adapter.command('status');
    await first.adapter.command('chargingStatus');
    await first.adapter.command('vehicleReportStatus');
    await first.adapter.command('departuresClimateStatus');
    await first.adapter.command('departuresLocationsStatus');
    const key = localKey(VEHICLE, '700');
    await first.adapter.departureCommand('departuresLocationStatus', { locationKey: key });
    const states = Object.fromEntries(first.adapter.states);
    const ids = ['climate.appState', 'battery.soc', 'vehicleReport.odometerText',
        'departures.climate.timer1.enabled', 'chargingLocations.' + key + '.timer1.enabled'];
    const domains = ['climate', 'charging', 'vehicleReport', 'departureClimate', 'departureLocations', 'departureLocation_' + key];
    const restarted = await fixture(t, { enrollment: enrolled(), fakeController: true,
        memory: first.memory, initialStates: states });
    for (const id of ids) {
        assert.equal(restarted.value(id), states[id].val, id);
        assert.equal(restarted.adapter.states.get(id).q, 0x82, id);
    }
    for (const domain of domains) {
        const prefix = 'refresh.' + domain;
        assert.equal(restarted.value(prefix + '.lastReadAt'), states[prefix + '.lastReadAt'].val, domain);
        assert.equal(restarted.value(prefix + '.status'), 'stale', domain);
    }
    assert.equal(restarted.records.controllerCalls.length, 0);
});

test('restart rejects malformed historical values and never presents a saved timestamp as fresh', async t => {
    const initialStates = {
        'climate.temperature': { val: 'not a number', ack: true },
        'battery.soc': { val: 87, ack: false },
        'refresh.climate.lastReadAt': { val: 'not a date', ack: true },
        'refresh.charging.lastReadAt': { val: '2026-10-24T19:00:00.000Z', ack: true },
        'refresh.charging.status': { val: 'fresh', ack: true },
        'refresh.vehicleReport.lastReadAt': { val: '2026-10-24T19:00:00.000Z', ack: true, q: 0x82 },
        'charging.modeObservedAt': { val: '2026-10-24T19:00:00.000Z', ack: true, q: 0x82 },
        'climate.vehicleConfirmed': { val: true, ack: true },
        'departures.climate.timer1.enabled': { val: true, ack: false },
    };
    const restarted = await fixture(t, { initialStates });
    assert.equal(restarted.value('climate.temperature'), null);
    assert.equal(restarted.value('battery.soc'), null);
    assert.equal(restarted.value('departures.climate.timer1.enabled'), null);
    assert.equal(restarted.value('climate.vehicleConfirmed'), false);
    assert.equal(restarted.value('refresh.climate.lastReadAt'), '');
    assert.equal(restarted.value('refresh.climate.status'), 'unknown');
    assert.equal(restarted.value('refresh.charging.lastReadAt'), '2026-10-24T19:00:00.000Z');
    assert.equal(restarted.value('refresh.charging.status'), 'stale');
    assert.equal(restarted.value('refresh.vehicleReport.status'), 'unknown');
    assert.equal(restarted.value('refresh.vehicleReport.lastReadAt'), '');
    assert.equal(restarted.value('charging.modeObservedAt'), '2026-10-24T19:00:00.000Z');
    assert.equal(restarted.adapter.states.get('charging.modeObservedAt').q, 0x82);
});

test('restart keeps last fully published access read time and rejects unacknowledged values', async t => {
    const initialStates = {
        'refresh.vehicleAccess.lastReadAt': { val: '2026-10-24T19:00:00.000Z', ack: true },
        'vehicleAccess.observedAt': { val: '2026-10-24T20:00:00.000Z', ack: true },
        'vehicleAccess.locked': { val: false, ack: false },
        'vehicleInfo.observedAt': { val: '2026-10-24T20:00:00.000Z', ack: false },
        'vehicleInfo.vin': { val: 'SYNTHETICVIN12345', ack: false },
        'charging.mode': { val: 'immediate', ack: false },
        'refresh.departureClimate.lastReadAt': { val: '2026-10-24T19:00:00.000Z', ack: true },
        'departures.climate.observedAt': { val: '2026-10-24T20:00:00.000Z', ack: true },
    };
    const restarted = await fixture(t, { initialStates });
    assert.equal(restarted.value('refresh.vehicleAccess.lastReadAt'), '2026-10-24T19:00:00.000Z');
    assert.equal(restarted.value('vehicleAccess.observedAt'), '2026-10-24T20:00:00.000Z');
    assert.equal(restarted.adapter.states.get('vehicleAccess.observedAt').q, 0x82);
    assert.equal(restarted.value('vehicleAccess.locked'), null);
    assert.equal(restarted.value('vehicleInfo.observedAt'), '');
    assert.equal(restarted.value('vehicleInfo.vin'), '');
    assert.equal(restarted.value('charging.mode'), null);
    assert.equal(restarted.value('departures.climate.observedAt'), '2026-10-24T20:00:00.000Z');
    assert.equal(restarted.adapter.states.get('departures.climate.observedAt').q, 0x82);
    assert.equal(restarted.value('refresh.departureClimate.lastReadAt'), '2026-10-24T19:00:00.000Z');
});

test('restart invalidates orphaned location observations without touching wishes or custom objects', async t => {
    const key = 'loc_' + 'a'.repeat(24), base = 'chargingLocations.' + key;
    const refresh = 'refresh.departureLocation_' + key;
    const secondRefresh = 'refresh.departureLocation_loc_' + 'b'.repeat(24);
    const object = (type, write) => ({ type: 'state', common: { type, write }, native: {} });
    const initialObjects = {
        [base + '.timer1.enabled']: object('boolean', false),
        [base + '.observedAt']: object('string', false),
        [base + '.timer1.targetEnabled']: object('boolean', true),
        [base + '.custom']: object('string', false),
        [refresh + '.status']: object('string', false),
        [refresh + '.lastReadAt']: object('string', false),
        [refresh + '.ageSeconds']: object('number', false),
        [secondRefresh + '.status']: object('string', false),
    };
    const initialStates = {
        [base + '.timer1.enabled']: { val: true, ack: false, q: 1 },
        [base + '.observedAt']: { val: '2026-10-24T19:00:00.000Z', ack: true },
        [base + '.timer1.targetEnabled']: { val: true, ack: true },
        [base + '.custom']: { val: 'custom', ack: true },
        [refresh + '.status']: { val: 'fresh', ack: true },
        [refresh + '.lastReadAt']: { val: '2026-10-24T19:00:00.000Z', ack: true },
        [refresh + '.ageSeconds']: { val: 14, ack: true },
        [secondRefresh + '.status']: { val: 'fresh', ack: false, q: 1 },
    };
    const restarted = await fixture(t, { initialObjects, initialStates });
    assert.deepEqual(restarted.adapter.states.get(base + '.timer1.enabled'), { val: true, ack: false, q: 0x83 });
    assert.deepEqual(restarted.adapter.states.get(base + '.observedAt'), { val: '2026-10-24T19:00:00.000Z', ack: true, q: 0x82 });
    assert.deepEqual(restarted.adapter.states.get(base + '.timer1.targetEnabled'), initialStates[base + '.timer1.targetEnabled']);
    assert.deepEqual(restarted.adapter.states.get(base + '.custom'), initialStates[base + '.custom']);
    assert.equal(restarted.value(refresh + '.status'), 'stale');
    assert.deepEqual(restarted.adapter.states.get(refresh + '.lastReadAt'), initialStates[refresh + '.lastReadAt']);
    assert.deepEqual(restarted.adapter.states.get(refresh + '.ageSeconds'), { val: 14, ack: true, q: 0x82 });
    assert.deepEqual(restarted.adapter.states.get(secondRefresh + '.status'), { val: 'fresh', ack: false, q: 0x83 });
});

test('a manual command takes a safe handoff from an automatic access read without publishing its cancelled result', async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, cooperativeHandoff: true,
        RefreshScheduler: RecordingScheduler, config: { pollIntervalSeconds: 15 }, controllerExecute: async action => {
            if (action === 'refreshVehicleAccess') { entered.resolve(); await release.promise; return vehicleAccessResult(); }
            return chargingResult();
        } });
    t.after(() => release.resolve());
    await f.adapter.observation(vehicleAccessResult());
    const before = new Map([...f.adapter.states].filter(([id]) => id.startsWith('vehicleAccess.') || id.startsWith('refresh.vehicleAccess.')));
    const automatic = f.adapter.scheduler.options.run('vehicleAccess'); await entered.promise;
    const controller = f.records.controllers[0];
    const manual = f.adapter.command('chargingStatus');
    assert.equal(controller.handoffRequested, true);
    assert.equal(controller.cancelled, undefined);
    assert.equal(f.records.controllerCalls.length, 1);
    release.resolve(); await automatic; await manual;
    assert.deepEqual(f.records.controllerCalls, [{ action: 'refreshVehicleAccess', input: {} }, expectedChargingCall('chargingStatus')]);
    for (const [id, value] of before) assert.deepEqual(f.adapter.states.get(id), value, id);
    assert.equal(f.value('operation.lastResult'), 'succeeded');
    assert.equal(f.value('refresh.autoBusy'), false);
    assert.equal(f.value('refresh.charging.status'), 'fresh');
});

test('vehicle information creates read-only FIN history and its own refresh command and validity area', async t => {
    const f = await fixture(t);
    assert.equal(f.adapter.objects.get('vehicleInfo').common.name, 'Fahrzeugidentifikation');
    assert.equal(f.adapter.objects.get('refresh.vehicleInfo').common.name, 'Fahrzeugidentifikation');
    for (const [id, role] of [['vehicleInfo.vin', 'text'], ['vehicleInfo.observedAt', 'date']]) {
        const common = f.adapter.objects.get(id).common;
        assert.equal(common.type, 'string'); assert.equal(common.role, role);
        assert.equal(common.read, true); assert.equal(common.write, false);
        assert.match(common.name, /FIN/);
        assert.deepEqual(f.adapter.states.get(id), { val: '', ack: true, q: 0x82 });
    }
    assert.equal(f.adapter.objects.get('commands.refreshVehicleInfo').common.role, 'button');
    assert.equal(f.adapter.objects.get('commands.refreshVehicleInfo').common.write, true);
    assert.equal(f.value('refresh.vehicleInfo.status'), 'unknown');
    assert.equal(f.value('refresh.vehicleInfo.lastReadAt'), '');
    assert.equal(f.value('refresh.vehicleInfo.ageSeconds'), null);
});

test('FIN refresh is own-only and reads without applying wishes, write permission or security PIN access', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        config: { legacyStatePrefix: '0_userdata.0.old_vw' }, memory: {
            'temperature-preference': { targetCelsius: 23.5 },
            'settings-preference': { mode: 'windowHeating', climateOnUnlock: true },
            'charging-preference': { socLimit: 80 },
        } });
    Object.defineProperty(f.adapter.config, 'sPin', { get() { throw new Error('SECRET PIN MUST NOT BE READ'); } });
    for (const state of [null, { val: true }, { val: true, ack: true }, { val: 'true', ack: false },
        { val: false, ack: false }, { val: true, ack: 'false' }]) {
        await f.adapter.onStateChange('vw-app.0.commands.refreshVehicleInfo', state);
    }
    await f.adapter.onStateChange('0_userdata.0.old_vw.refreshVehicleInfo', { val: true, ack: false });
    await f.adapter.onStateChange('other.0.commands.refreshVehicleInfo', { val: true, ack: false });
    await f.adapter.onStateChange('vw-app.0.vehicleInfo.vin', { val: OTHER_SYNTHETIC_VIN, ack: false });
    assert.deepEqual(f.records.controllerCalls, []);
    const wishes = clone(f.memory);
    await f.adapter.onStateChange('vw-app.0.commands.refreshVehicleInfo', { val: true, ack: false });
    assert.deepEqual(f.records.controllerCalls, [{ action: 'refreshVehicleInfo', input: {} }]);
    assert.deepEqual(f.adapter.states.get('commands.refreshVehicleInfo'), { val: false, ack: true });
    assert.deepEqual(f.adapter.states.get('vehicleInfo.vin'), { val: SYNTHETIC_VIN, ack: true });
    assert.equal(f.value('vehicleInfo.observedAt'), '2026-10-24T19:00:00.000Z');
    assert.equal(f.value('refresh.vehicleInfo.lastReadAt'), f.value('vehicleInfo.observedAt'));
    assert.equal(f.value('refresh.vehicleInfo.status'), 'fresh');
    assert.deepEqual(f.memory, wishes); assert.deepEqual(f.records.stores[0].writes, []);
    assert.equal(f.records.stores[0].reservations, 0);
    assert.equal(f.adapter.settings.allowWrites, false);
    assert.equal(f.value('battery.lastSyncRequestAt'), '');
    assert.equal(f.value('climate.appState'), 'unknown');
});

test('malformed FIN envelopes cannot replace history, publish partly or expose untrusted identifiers', async t => {
    let response = vehicleInfoResult(); let getterReads = 0;
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, controllerExecute: async () => response });
    await f.adapter.observation(chargingResult());
    const batteryBefore = clone(f.adapter.states.get('battery.soc'));
    const accessorEnvelope = vehicleInfoResult();
    Object.defineProperty(accessorEnvelope, 'vehicleInfo', { enumerable: true,
        get() { getterReads++; throw new BridgeError('invalid_vehicle_info', 'SECRET IDENTIFIER IN GETTER'); } });
    const accessorModel = { ...vehicleInfoResult(), vehicleInfo: Object.defineProperty({}, 'vin', { enumerable: true,
        get() { getterReads++; throw new BridgeError('invalid_vehicle_info', 'SECRET IDENTIFIER IN MODEL'); } }) };
    const bad = [null, [], { ...vehicleInfoResult(), domain: 'charging' },
        { ...vehicleInfoResult(), source: 'other' }, { ...vehicleInfoResult(), vehicleConfirmed: true },
        { ...vehicleInfoResult(), appVersion: undefined }, { ...vehicleInfoResult(), appVersion: '4.8.1\nSECRET' },
        { ...vehicleInfoResult(), observedAt: '2026-02-30T00:00:00.000Z' },
        { ...vehicleInfoResult(), additional: 'SECRET IDENTIFIER' },
        vehicleInfoResult('SECRET'), vehicleInfoResult('TESTCAR000000000I'), vehicleInfoResult(null),
        { ...vehicleInfoResult(), vehicleInfo: { vin: SYNTHETIC_VIN, extra: true } },
        accessorEnvelope, accessorModel, Object.create(vehicleInfoResult())];
    for (const invalid of bad) {
        await f.adapter.observation(vehicleInfoResult());
        const observedAt = clone(f.adapter.states.get('vehicleInfo.observedAt'));
        response = invalid; const before = f.adapter.writes.length;
        await assert.rejects(f.adapter.command('refreshVehicleInfo'), error =>
            error instanceof BridgeError && error.code === 'invalid_vehicle_info' && !error.message.includes('SECRET'));
        assert.deepEqual(f.adapter.states.get('vehicleInfo.vin'), { val: SYNTHETIC_VIN, ack: true, q: 0x82 });
        assert.deepEqual(f.adapter.states.get('vehicleInfo.observedAt'), observedAt);
        assert.ok(f.adapter.writes.slice(before).filter(row => row.id.startsWith('vehicleInfo.'))
            .every(row => row.id === 'vehicleInfo.vin' && row.value.q === 0x82));
        assert.equal(f.value('refresh.vehicleInfo.status'), 'error');
        assert.equal(f.value('refresh.vehicleInfo.lastReadAt'), '2026-10-24T19:00:00.000Z');
        assert.deepEqual(f.adapter.states.get('battery.soc'), batteryBefore);
    }
    assert.equal(getterReads, 0);
    assert.ok(f.adapter.logs.every(row => !row.message.includes('SECRET')));
});

test('automatic FIN reads renew validity while stale or failed reads preserve history and manual feedback', async t => {
    const clock = fakeClock(); let response = SYNTHETIC_VIN;
    const f = await fixture(t, { clock, enrollment: enrolled(), fakeController: true, RefreshScheduler: RecordingScheduler,
        config: { pollIntervalSeconds: 15, refreshMaxAgeSeconds: 30 }, controllerExecute: async action => {
            assert.equal(action, 'refreshVehicleInfo');
            if (response instanceof Error) throw response;
            return { ...vehicleInfoResult(response), observedAt: new Date(clock.now()).toISOString() };
        } });
    await f.adapter.stageTemperature(24); await f.adapter.stageChargingSetting('socLimit', 80);
    await f.adapter.state('operation.lastResult', 'prior_manual_result');
    await f.adapter.state('operation.lastErrorCode', 'prior_manual_code');
    const wishes = clone(f.memory);
    assert.ok(f.adapter.scheduler.options.domains.includes('vehicleInfo'));
    await f.adapter.scheduler.options.run('vehicleInfo');
    const first = f.value('vehicleInfo.observedAt');
    await clock.advance(31000);
    assert.equal(f.value('refresh.vehicleInfo.status'), 'stale');
    assert.deepEqual(f.adapter.states.get('vehicleInfo.vin'), { val: SYNTHETIC_VIN, ack: true, q: 0x82 });
    assert.equal(f.value('vehicleInfo.observedAt'), first);
    response = new BridgeError('wifi_unavailable', 'Phone not reachable.');
    await rejectsCode(f.adapter.scheduler.options.run('vehicleInfo'), 'wifi_unavailable');
    assert.equal(f.value('refresh.vehicleInfo.status'), 'error');
    assert.equal(f.value('refresh.vehicleInfo.lastErrorCode'), 'wifi_unavailable');
    assert.equal(f.value('refresh.vehicleInfo.lastReadAt'), first);
    assert.equal(f.value('vehicleInfo.vin'), SYNTHETIC_VIN);
    response = OTHER_SYNTHETIC_VIN;
    await f.adapter.scheduler.options.run('vehicleInfo');
    assert.deepEqual(f.adapter.states.get('vehicleInfo.vin'), { val: OTHER_SYNTHETIC_VIN, ack: true });
    assert.equal(f.value('refresh.vehicleInfo.status'), 'fresh');
    assert.equal(f.value('refresh.vehicleInfo.lastErrorCode'), '');
    assert.notEqual(f.value('vehicleInfo.observedAt'), first);
    assert.equal(f.value('operation.lastResult'), 'prior_manual_result');
    assert.equal(f.value('operation.lastErrorCode'), 'prior_manual_code');
    assert.equal(f.value('refresh.autoBusy'), false);
    assert.deepEqual(f.memory, wishes); assert.equal(f.value('battery.lastSyncRequestAt'), '');
});

test('FIN success history survives restart as invalid until the next successful observation', async t => {
    const first = await fixture(t);
    await first.adapter.observation(vehicleInfoResult());
    const initialStates = Object.fromEntries([...first.adapter.states].filter(([id]) => id.startsWith('vehicleInfo.') || id.startsWith('refresh.vehicleInfo.')));
    const restarted = await fixture(t, { initialStates });
    assert.deepEqual(restarted.adapter.states.get('vehicleInfo.vin'), { val: SYNTHETIC_VIN, ack: true, q: 0x82 });
    assert.deepEqual(restarted.adapter.states.get('vehicleInfo.observedAt'),
        { val: '2026-10-24T19:00:00.000Z', ack: true });
    assert.equal(restarted.value('refresh.vehicleInfo.lastReadAt'), '2026-10-24T19:00:00.000Z');
    assert.equal(restarted.value('refresh.vehicleInfo.status'), 'stale');
    await restarted.adapter.observation(vehicleInfoResult(OTHER_SYNTHETIC_VIN));
    assert.deepEqual(restarted.adapter.states.get('vehicleInfo.vin'), { val: OTHER_SYNTHETIC_VIN, ack: true });
    assert.equal(restarted.value('refresh.vehicleInfo.status'), 'fresh');
});

test('invalid saved FIN or success time is not restored as usable vehicle information', async t => {
    const f = await fixture(t, { initialStates: {
        'vehicleInfo.vin': { val: 'not a FIN', ack: true },
        'vehicleInfo.observedAt': { val: '2026-02-30T00:00:00.000Z', ack: true },
    } });
    for (const id of ['vehicleInfo.vin', 'vehicleInfo.observedAt']) {
        assert.deepEqual(f.adapter.states.get(id), { val: '', ack: true, q: 0x82 });
    }
    assert.equal(f.value('refresh.vehicleInfo.status'), 'unknown');
    assert.equal(f.value('refresh.vehicleInfo.lastReadAt'), '');
});

test('a manual command safely takes priority over an automatic FIN read without publishing its cancelled result', async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, cooperativeHandoff: true,
        RefreshScheduler: RecordingScheduler, config: { pollIntervalSeconds: 15 }, controllerExecute: async action => {
            if (action === 'refreshVehicleInfo') { entered.resolve(); await release.promise; return vehicleInfoResult(OTHER_SYNTHETIC_VIN); }
            return chargingResult();
        } });
    t.after(() => release.resolve());
    await f.adapter.observation(vehicleInfoResult());
    const before = new Map([...f.adapter.states].filter(([id]) => id.startsWith('vehicleInfo.') || id.startsWith('refresh.vehicleInfo.')));
    const automatic = f.adapter.scheduler.options.run('vehicleInfo'); await entered.promise;
    const controller = f.records.controllers[0];
    const manual = f.adapter.command('chargingStatus');
    assert.equal(controller.handoffRequested, true); assert.equal(controller.cancelled, undefined);
    assert.equal(f.records.controllerCalls.length, 1);
    release.resolve(); await automatic; await manual;
    assert.deepEqual(f.records.controllerCalls, [{ action: 'refreshVehicleInfo', input: {} }, expectedChargingCall('chargingStatus')]);
    for (const [id, value] of before) assert.deepEqual(f.adapter.states.get(id), value, id);
    assert.equal(f.value('operation.lastResult'), 'succeeded');
    assert.equal(f.value('refresh.autoBusy'), false); assert.equal(f.value('refresh.charging.status'), 'fresh');
});

test('lock commands are manual-only buttons, with local read-only security diagnostics and no PIN data point', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        RefreshScheduler: RecordingScheduler, config: { pollIntervalSeconds: 15 } });
    for (const action of ['lockVehicle', 'unlockVehicle']) {
        assert.deepEqual(DEFINITIONS['commands.' + action], ['boolean', 'button', false, true]);
        await rejectsCode(f.adapter.command(action, { automatic: true }), 'invalid_action');
    }
    assert.equal(f.records.controllerCalls.length, 0);
    assert.equal(f.value('security.blocked'), false);
    assert.equal(f.value('security.reason'), '');
    for (const id of ['security.blocked', 'security.reason']) {
        assert.equal(f.adapter.objects.get(id).common.write, false);
        assert.equal(f.adapter.objects.get(id).common.read, true);
    }
    assert.equal([...f.adapter.objects.keys()].some(id => /sPin|targetLocked|resetSecurityBlock/.test(id)), false);
    assert.equal(f.adapter.scheduler.options.domains.includes('security'), false);
    await rejectsCode(f.adapter.runAutomaticRead('lockVehicle'), 'invalid_action');
});

test('normal and automatic reads never receive or read the S-PIN provider', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        RefreshScheduler: RecordingScheduler, config: { pollIntervalSeconds: 15 } });
    let pinReads = 0;
    Object.defineProperty(f.config, 'sPin', { enumerable: true, get() { pinReads++; throw new Error('SYNTHETIC SECRET ACCESS'); } });
    await f.adapter.command('status');
    await f.adapter.command('refreshVehicleAccess');
    await f.adapter.scheduler.options.run('vehicleAccess');
    await f.adapter.command('refreshVehicleInfo');
    await f.adapter.scheduler.options.run('vehicleInfo');
    assert.equal(pinReads, 0);
    assert.ok(f.records.controllers.every(controller => !Object.hasOwn(controller, 'getSecurityPin')));
    assert.equal(f.value('security.blocked'), false);
});

test('explicit lock and unlock use a narrow provider independently of climate permission or wishes', async t => {
    const pin = syntheticSecurityPin(); let pinReads = 0;
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        RefreshScheduler: RecordingScheduler, config: { pollIntervalSeconds: 15, allowWrites: false, allowVehicleLocking: true, sPin: pin },
        controllerExecute: async (action, input, controller) => {
            assert.ok(['lockVehicle', 'unlockVehicle'].includes(action));
            assert.deepEqual(input, {});
            assert.equal(controller.config.allowWrites, false);
            assert.equal(controller.config.allowVehicleLocking, true);
            assert.equal(Object.hasOwn(controller.config, 'sPin'), false);
            assert.equal(controller.getSecurityPin(), pin); pinReads++;
            return { ...closedAccessResult(action === 'lockVehicle'), ignoredSecretProperty: pin };
        } });
    const temperature = deferred(), settings = deferred(), charging = deferred();
    f.adapter.temperatureUpdates = temperature.promise; f.adapter.settingsUpdates = settings.promise; f.adapter.chargingUpdates = charging.promise;
    const beforeMemory = clone(f.memory);
    try {
        for (const action of ['lockVehicle', 'unlockVehicle']) {
            const result = await f.adapter.command(action);
            assert.equal(result.vehicleAccess.locked, action === 'lockVehicle');
            assert.equal(Object.hasOwn(result, 'ignoredSecretProperty'), false);
            assert.equal(f.value('vehicleAccess.locked'), action === 'lockVehicle');
            assert.equal(f.value('refresh.vehicleAccess.status'), 'fresh');
        }
    } finally { temperature.resolve(); settings.resolve(); charging.resolve(); }
    assert.equal(pinReads, 2);
    assert.deepEqual(f.memory, beforeMemory);
    assert.deepEqual(f.records.controllerCalls, [{ action: 'lockVehicle', input: {} }, { action: 'unlockVehicle', input: {} }]);
    assert.deepEqual(f.adapter.scheduler.requests, [
        { domain: 'vehicleAccess', priority: true, delayMs: 2000 }, { domain: 'vehicleAccess', priority: true, delayMs: 2000 }]);
    const publicData = { settings: f.adapter.settings, options: f.records.controllerCalls,
        states: [...f.adapter.states], logs: f.adapter.logs, responses: f.adapter.responses, memory: f.memory };
    assert.equal(JSON.stringify(publicData).includes(pin), false);
});

test('lock and unlock data-point writes require ack=false true and never accept a legacy prefix', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        config: { allowVehicleLocking: true, legacyStatePrefix: '0_userdata.0.oldVw' },
        controllerExecute: async action => closedAccessResult(action === 'lockVehicle') });
    for (const state of [{ val: true, ack: true }, { val: false, ack: false }, { val: 'true', ack: false }]) {
        await f.adapter.onStateChange('vw-app.0.commands.unlockVehicle', state);
    }
    await f.adapter.onStateChange('0_userdata.0.oldVw.unlockVehicle', { val: true, ack: false });
    assert.equal(f.records.controllerCalls.length, 0);
    await f.adapter.onStateChange('vw-app.0.commands.lockVehicle', { val: true, ack: false });
    await f.adapter.onStateChange('vw-app.0.commands.unlockVehicle', { val: true, ack: false });
    assert.deepEqual(f.records.controllerCalls.map(call => call.action), ['lockVehicle', 'unlockVehicle']);
    assert.deepEqual(f.adapter.states.get('commands.lockVehicle'), { val: false, ack: true });
    assert.deepEqual(f.adapter.states.get('commands.unlockVehicle'), { val: false, ack: true });
});

test('an already-desired read can succeed without a PIN provider access and cannot clear an existing block', async t => {
    const blocked = blockedSecurityState('pin_rejected');
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        memory: { 'security-auth-state': blocked }, controllerExecute: async () => closedAccessResult(true) });
    Object.defineProperty(f.config, 'sPin', { get() { throw new Error('No-op must not access a secret.'); } });
    const result = await f.adapter.command('lockVehicle');
    assert.equal(result.vehicleAccess.locked, true);
    assert.deepEqual(f.memory['security-auth-state'], blocked);
    assert.equal(f.value('security.blocked'), true);
    assert.equal(f.value('security.reason'), 'pin_rejected');
});

test('credential errors are sanitized before feedback, retain the block across restart, and only schedule a read', async t => {
    const pin = syntheticSecurityPin();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        RefreshScheduler: RecordingScheduler, config: { pollIntervalSeconds: 15, allowVehicleLocking: true, sPin: pin },
        controllerExecute: async (_action, _input, controller) => {
            assert.equal(controller.getSecurityPin(), pin);
            await controller.store.write('security-auth-state', blockedSecurityState('pin_rejected'));
            throw new BridgeError('security_pin_rejected', 'Synthetic secret message: ' + pin);
        } });
    await rejectsCode(f.adapter.command('unlockVehicle'), 'security_pin_rejected');
    assert.equal(f.value('operation.lastResult'), 'failed');
    assert.equal(f.value('security.blocked'), true);
    assert.equal(f.value('security.reason'), 'pin_rejected');
    assert.equal(f.value('operation.lastErrorCode'), 'security_pin_rejected');
    assert.equal(JSON.stringify({ states: [...f.adapter.states], logs: f.adapter.logs, memory: f.memory }).includes(pin), false);
    assert.deepEqual(f.adapter.scheduler.requests, [{ domain: 'vehicleAccess', priority: true, delayMs: 2000 }]);
    assert.equal(f.records.controllerCalls.length, 1);
    const restarted = await fixture(t, { memory: f.memory });
    assert.equal(restarted.value('security.blocked'), true);
    assert.equal(restarted.value('security.reason'), 'pin_rejected');
    assert.deepEqual(restarted.memory['security-auth-state'], blockedSecurityState('pin_rejected'));
});

test('missing and invalid PIN errors affect only an actuating lock flow and never echo secret data', async t => {
    for (const [sPin, expected] of [['', 'security_pin_required'], ['SYNTHETIC INVALID SECRET', 'security_pin_invalid']]) {
        const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
            config: { allowVehicleLocking: true, sPin }, controllerExecute: async (action, _input, controller) => {
                if (action === 'unlockVehicle') controller.getSecurityPin();
                return action === 'status' ? { appState: 'off', appVersion: '4.8.1', vehicleConfirmed: false,
                    observedAt: '2026-10-25T10:00:00.000Z', temperature: null, confirmationSource: 'app_controls' }
                    : closedAccessResult(true);
            } });
        await rejectsCode(f.adapter.command('unlockVehicle'), expected);
        assert.equal(f.value('security.blocked'), false);
        await f.adapter.command('status');
        assert.equal(f.value('operation.lastResult'), 'succeeded');
        assert.equal(JSON.stringify({ states: [...f.adapter.states], logs: f.adapter.logs }).includes('SYNTHETIC INVALID SECRET'), false);
    }
});

test('malformed or unreadable auth state fails closed while other read operations remain available', async t => {
    const malformed = await fixture(t, { enrollment: enrolled(), fakeController: true,
        memory: { 'security-auth-state': { blocked: false, reason: 'pin_rejected', blockedAt: null } } });
    assert.equal(malformed.value('security.blocked'), true);
    assert.equal(malformed.value('security.reason'), 'security_auth_invalid');
    await malformed.adapter.command('refreshVehicleAccess');
    assert.equal(malformed.value('refresh.vehicleAccess.status'), 'fresh');
    const unreadable = await fixture(t, { storeRead: async (name, fallback, memory) => {
        if (name === 'security-auth-state') throw new Error('SYNTHETIC AUTH FILE SECRET');
        return clone(memory[name] ?? fallback);
    } });
    assert.equal(unreadable.value('security.blocked'), true);
    assert.equal(unreadable.value('security.reason'), 'security_auth_unavailable');
    assert.equal(JSON.stringify(unreadable.adapter.logs).includes('SYNTHETIC AUTH FILE SECRET'), false);
});

test('only Admin can explicitly reset a block and the reset has no phone or native-config response', async t => {
    const f = await fixture(t, { config: { sPin: syntheticSecurityPin() },
        memory: { 'security-auth-state': blockedSecurityState('outcome_unknown') } });
    for (const from of ['system.adapter.javascript.0', 'system.adapter.admin.0.extra', 'admin.0', 'system.adapter.cloud.0']) {
        await f.adapter.onMessage({ from, command: 'resetSecurityBlock', message: {}, callback: { id: 2 } });
        assert.match(f.adapter.responses.at(-1).message.error, /^invalid_action:/);
        assert.equal(f.value('security.blocked'), true);
    }
    const writes = f.records.stores[0].writes.length;
    const result = await f.message('resetSecurityBlock', { ignoredSecret: 'NEVER ECHO' });
    assert.deepEqual(result, { result: 'security_block_reset' });
    assert.equal(Object.hasOwn(result, 'native'), false);
    assert.deepEqual(f.memory['security-auth-state'], { blocked: false, reason: null, blockedAt: null });
    assert.equal(f.value('security.blocked'), false);
    assert.equal(f.value('security.reason'), '');
    assert.deepEqual(f.records.stores[0].writes.slice(writes), [{ name: 'security-auth-state', value: { blocked: false, reason: null, blockedAt: null } }]);
    assert.equal(f.records.phones.length, 0);
    assert.equal(f.records.controllerCalls.length, 0);
    assert.equal(ADMIN.items._resetSecurityBlock.useNative, undefined);
    assert.deepEqual(ADMIN.items._resetSecurityBlock.data, {});
    assert.equal(JSON.stringify(f.adapter.responses).includes('NEVER ECHO'), false);
});

test('a reset requires a valid currently saved PIN and a failed reset never silently clears a block', async t => {
    const blocked = blockedSecurityState('pin_locked');
    const missing = await fixture(t, { memory: { 'security-auth-state': blocked } });
    assert.match((await missing.message('resetSecurityBlock')).error, /^security_pin_required:/);
    assert.deepEqual(missing.memory['security-auth-state'], blocked);
    assert.equal(missing.value('security.blocked'), true);
    const failed = await fixture(t, { config: { sPin: syntheticSecurityPin() }, memory: { 'security-auth-state': blocked },
        storeWrite: async name => { if (name === 'security-auth-state') throw new BridgeError('synthetic', 'SYNTHETIC AUTH WRITE SECRET'); } });
    assert.match((await failed.message('resetSecurityBlock')).error, /^security_auth_not_saved:/);
    assert.deepEqual(failed.memory['security-auth-state'], blocked);
    assert.equal(failed.value('security.blocked'), true);
    assert.equal(failed.records.phones.length, 0);
    assert.equal(JSON.stringify({ responses: failed.adapter.responses, logs: failed.adapter.logs }).includes('SYNTHETIC AUTH WRITE SECRET'), false);
});

test('a busy lock command cannot queue a second unlock or read a secret before ownership is available', async t => {
    const entered = deferred(), release = deferred(); let pinReads = 0;
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowVehicleLocking: true },
        controllerExecute: async () => { entered.resolve(); await release.promise; return closedAccessResult(true); } });
    Object.defineProperty(f.config, 'sPin', { get() { pinReads++; return syntheticSecurityPin(); } });
    const first = f.adapter.command('lockVehicle'); await entered.promise;
    await rejectsCode(f.adapter.command('unlockVehicle'), 'busy');
    assert.equal(f.records.controllerCalls.length, 1);
    assert.equal(pinReads, 0);
    release.resolve(); await first;
    assert.equal(f.records.controllerCalls.length, 1);
});

test('Admin reset safely waits for a running automatic read without making another phone request', async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, cooperativeHandoff: true,
        RefreshScheduler: RecordingScheduler, config: { pollIntervalSeconds: 15, sPin: syntheticSecurityPin() },
        memory: { 'security-auth-state': blockedSecurityState('attempt_pending') },
        controllerExecute: async action => { assert.equal(action, 'refreshVehicleAccess'); entered.resolve(); await release.promise; return closedAccessResult(true); } });
    const reading = f.adapter.scheduler.options.run('vehicleAccess'); await entered.promise;
    const resetting = f.message('resetSecurityBlock');
    assert.equal(f.records.controllers[0].handoffRequested, true);
    assert.equal(f.value('security.blocked'), true);
    release.resolve(); await reading;
    assert.deepEqual(await resetting, { result: 'security_block_reset' });
    assert.equal(f.value('security.blocked'), false);
    assert.equal(f.records.controllerCalls.length, 1);
    assert.equal(f.records.phones.length, 1);
    assert.deepEqual(f.adapter.scheduler.requests, []);
});

test('an explicit unlock cooperatively takes over an automatic read and never repeats the write', async t => {
    const entered = deferred(), release = deferred(); let pinReads = 0;
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, cooperativeHandoff: true,
        RefreshScheduler: RecordingScheduler, config: { pollIntervalSeconds: 15, allowVehicleLocking: true, sPin: syntheticSecurityPin() },
        controllerExecute: async (action, _input, controller) => {
            if (action === 'refreshVehicleAccess') { entered.resolve(); await release.promise; return closedAccessResult(true); }
            assert.equal(action, 'unlockVehicle');
            assert.equal(controller.getSecurityPin(), syntheticSecurityPin()); pinReads++;
            return closedAccessResult(false);
        } });
    const automatic = f.adapter.scheduler.options.run('vehicleAccess'); await entered.promise;
    const unlocking = f.adapter.command('unlockVehicle');
    assert.equal(f.records.controllers[0].handoffRequested, true);
    assert.equal(f.records.controllerCalls.length, 1);
    assert.equal(pinReads, 0);
    release.resolve(); await automatic; await unlocking;
    assert.deepEqual(f.records.controllerCalls.map(call => call.action), ['refreshVehicleAccess', 'unlockVehicle']);
    assert.equal(f.value('vehicleAccess.locked'), false);
    assert.equal(f.value('refresh.autoBusy'), false);
    assert.equal(f.value('operation.lastResult'), 'succeeded');
    assert.equal(pinReads, 1);
    assert.deepEqual(f.adapter.scheduler.requests, [{ domain: 'vehicleAccess', priority: true, delayMs: 2000 }]);
});

test('a secret getter throwing a foreign BridgeError is redacted before locking feedback or logs', async t => {
    const canary = 'SYNTHETIC SECRET GETTER MESSAGE';
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        config: { allowVehicleLocking: true }, controllerExecute: async (_action, _input, controller) => {
            controller.getSecurityPin();
            assert.fail('A failed credential getter cannot produce a lock result.');
        } });
    Object.defineProperty(f.config, 'sPin', { get() { throw new BridgeError('security_pin_invalid', canary); } });
    await rejectsCode(f.adapter.command('lockVehicle'), 'security_pin_invalid');
    assert.equal(f.value('operation.lastResult'), 'failed');
    assert.equal(f.value('operation.lastErrorCode'), 'security_pin_invalid');
    assert.equal(JSON.stringify({ states: [...f.adapter.states], logs: f.adapter.logs, memory: f.memory }).includes(canary), false);
});

test('one locking warning retains only internally branded stage/cause and keeps public outcome feedback unchanged', async t => {
    const canary = 'SYNTHETIC PRIVATE SECURITY ERROR';
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        controllerExecute: async () => {
            throw withSecurityDiagnostic(new BridgeError('outcome_unknown', canary), 'pin_entry', 'security_entry_uncertain');
        } });
    const before = f.adapter.logs.length;
    await rejectsCode(f.adapter.command('unlockVehicle'), 'outcome_unknown');
    const warnings = f.adapter.logs.slice(before).filter(row => row.level === 'warn');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /\[security stage=pin_entry; cause=security_entry_uncertain\]$/u);
    assert.equal(f.value('operation.lastErrorCode'), 'outcome_unknown');
    assert.equal(f.value('operation.lastError').includes('stage='), false);
    assert.equal(JSON.stringify({ states: [...f.adapter.states], logs: f.adapter.logs, memory: f.memory }).includes(canary), false);
});

test('foreign BridgeError detail/secret fields cannot create diagnostic log suffixes or run accessors', async t => {
    const canary = 'SYNTHETIC FOREIGN DETAIL SECRET'; let reads = 0;
    const foreign = new BridgeError('outcome_unknown', canary);
    foreign.details = { stage: canary, cause: canary, pin: canary };
    for (const key of ['stage', 'cause', 'diagnostic']) Object.defineProperty(foreign, key, {
        enumerable: true, get() { reads++; throw new Error(canary); },
    });
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, controllerExecute: async () => { throw foreign; } });
    const before = f.adapter.logs.length;
    await rejectsCode(f.adapter.command('unlockVehicle'), 'outcome_unknown');
    const warnings = f.adapter.logs.slice(before).filter(row => row.level === 'warn');
    assert.equal(warnings.length, 1); assert.equal(warnings[0].message.includes('security stage='), false);
    assert.equal(reads, 0);
    assert.equal(JSON.stringify({ states: [...f.adapter.states], logs: f.adapter.logs, memory: f.memory }).includes(canary), false);
});

test('reset never accepts an object that merely coerces into an Admin sender string', async t => {
    const f = await fixture(t, { config: { sPin: syntheticSecurityPin() },
        memory: { 'security-auth-state': blockedSecurityState('pin_rejected') } });
    await f.adapter.onMessage({ from: { toString: () => 'system.adapter.admin.0' }, command: 'resetSecurityBlock', message: {}, callback: { id: 3 } });
    assert.match(f.adapter.responses.at(-1).message.error, /^invalid_action:/);
    assert.equal(f.value('security.blocked'), true);
    assert.deepEqual(f.memory['security-auth-state'], blockedSecurityState('pin_rejected'));
});

function legacyObjectMetadata() {
    // The privacy-reviewed real 0.10.0 export contains definitions only: 340
    // objects, one pseudonymous location, no values/configuration/credentials.
    return Object.fromEntries(Object.entries(LEGACY_OBJECTS_0100)
        .map(([id, object]) => [id.slice('vw-app.0.'.length), clone(object)]));
}

function correctedLegacyMetadata(id, object) {
    const result = clone(object);
    if (result.common.role === 'button') result.common.read = false;
    if (id.startsWith('vehicleAccess.windows.') && result.common.role === 'indicator.open') result.common.role = 'sensor.window';
    if ((id.startsWith('vehicleAccess.doors.') || id === 'vehicleAccess.trunkOpen')
        && result.common.role === 'indicator.open') result.common.role = 'sensor.door';
    if (id === 'vehicleAccess.locked' && result.common.role === 'indicator.locked') result.common.role = 'sensor';
    return result;
}

test('new static and dynamically discovered controls are write-only buttons with access sensor roles that preserve Boolean meaning', async t => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ nativeId: String(700 + index), name: 'Synthetischer Ort ' + index, activeCount: 0 }));
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, departureLocations: rows });
    await f.adapter.command('departuresLocationsStatus');
    const buttons = [...f.adapter.objects].filter(([, object]) => object.common.role === 'button');
    assert.equal(buttons.length, 24 + 5 * 11, 'includes the separate charging-mode apply and clear controls');
    for (const [id, object] of buttons) {
        assert.equal(object.common.type, 'boolean', id);
        assert.equal(object.common.read, false, id);
        assert.equal(object.common.write, true, id);
    }
    assert.equal(f.adapter.objectPatches.length, 0, 'new definitions need no corrective patches');
    for (const id of ACCESS_BOOLEAN_IDS) assert.equal(f.adapter.objects.get(id).common.role,
        id === 'vehicleAccess.locked' ? 'sensor' : id.startsWith('vehicleAccess.windows.') ? 'sensor.window' : 'sensor.door', id);
    await f.adapter.command('refreshVehicleAccess');
    const access = vehicleAccessResult().vehicleAccess;
    assert.equal(f.value('vehicleAccess.locked'), access.locked, 'sensor.lock would reverse this existing meaning');
    assert.equal(f.value('vehicleAccess.trunkOpen'), access.trunkOpen);
    for (const group of ['doors', 'windows']) for (const position of ACCESS_POSITIONS) {
        assert.equal(f.value('vehicleAccess.' + group + '.' + position + 'Open'), access[group][position]);
    }
});

test('normal startup upgrades all 43 errors in the real 0.10.0 metadata including unbound historical location buttons', async t => {
    const previous = legacyObjectMetadata();
    assert.equal(Object.keys(previous).length, 340);
    assert.equal(Object.values(previous).filter(object => object.type === 'state').length, 289);
    assert.equal(Object.values(previous).filter(object => object.common.role === 'button' && object.common.read).length, 33);
    assert.equal(Object.values(previous).filter(object => ['indicator.open', 'indicator.locked'].includes(object.common.role)).length, 10);
    for (const [id, object] of Object.entries(previous)) {
        object.common.name = { de: 'Eigener Name: ' + id, en: 'Custom label: ' + id };
        object.common.custom = { 'synthetic-history.0': { enabled: true } };
        object.native = { syntheticMetadata: 'keep unchanged' };
        object.acl = { object: 0x640, state: 0x620, owner: 'system.user.synthetic', ownerGroup: 'system.group.synthetic' };
    }
    const observedAt = '2026-10-24T18:00:00.000Z';
    const initialStates = Object.fromEntries(ACCESS_BOOLEAN_IDS.map((id, index) => [id, { val: index % 2 === 0, ack: true, q: 0 }]));
    initialStates['vehicleAccess.observedAt'] = { val: observedAt, ack: true };
    const f = await fixture(t, { initialObjects: previous, initialStates });
    assert.equal(f.adapter.objects.size, 346, 'the six new charging-mode objects supplement the preserved 0.10.0 metadata');
    assert.equal(f.adapter.objectPatches.length, 43);
    assert.equal(f.adapter.objectPatches.filter(row => Object.hasOwn(row.patch.common, 'read')).length, 33);
    assert.equal(f.adapter.objectPatches.filter(row => Object.hasOwn(row.patch.common, 'role')).length, 10);
    for (const [id, object] of Object.entries(previous)) assert.deepEqual(f.adapter.objects.get(id), correctedLegacyMetadata(id, object), id);
    for (const { patch } of f.adapter.objectPatches) {
        assert.deepEqual(Object.keys(patch), ['common']);
        assert.equal(Object.keys(patch.common).length, 1);
    }
    assert.equal(f.adapter.departures.locationDefinitions.size, 0, 'no saved binding is needed to migrate old location metadata');
    for (const [id, state] of Object.entries(initialStates)) assert.equal(f.value(id), state.val, id);
    assert.equal(f.records.phones.length, 0);
    assert.equal(f.records.controllerCalls.length, 0);
    await f.adapter.migrateObjectMetadata();
    assert.equal(f.adapter.objectPatches.length, 43, 'the migration is idempotent');
});

test('metadata migration alone cannot write values, apply wishes, inspect PIN/configuration or modify foreign and custom controls', async t => {
    let secretReads = 0;
    const f = await fixture(t);
    f.adapter.objects = new Map(Object.entries(legacyObjectMetadata()));
    const custom = { type: 'state', common: { name: 'User-defined control', type: 'boolean', role: 'button', read: true, write: true }, native: {} };
    f.adapter.objects.set('custom.commands.start', clone(custom));
    f.adapter.objects.set('chargingLocations.loc_' + 'f'.repeat(24) + '.timer4.commands.apply', clone(custom));
    const foreign = {};
    Object.defineProperty(foreign, 'common', { get() { secretReads++; throw new Error('SYNTHETIC FOREIGN CONFIG'); } });
    f.adapter.getAdapterObjectsAsync = async () => ({ ...Object.fromEntries([...f.adapter.objects]
        .map(([id, object]) => ['vw-app.0.' + id, clone(object)])),
    'system.adapter.vw-app.0': foreign, 'vw-app.1.commands.start': foreign, 'vw-app.00.commands.start': foreign });
    Object.defineProperty(f.config, 'sPin', { get() { secretReads++; throw new Error('SYNTHETIC PIN PROVIDER'); } });
    f.adapter.states.set('commands.start', { val: true, ack: false });
    f.adapter.states.set('vehicleAccess.locked', { val: true, ack: true, q: 0 });
    const states = clone([...f.adapter.states]), memory = clone(f.memory), writes = f.adapter.writes.length;
    const storeWrites = clone(f.records.stores[0].writes);
    await f.adapter.migrateObjectMetadata();
    assert.deepEqual([...f.adapter.states], states);
    assert.equal(f.adapter.writes.length, writes);
    assert.deepEqual(f.memory, memory);
    assert.deepEqual(f.records.stores[0].writes, storeWrites);
    assert.equal(secretReads, 0);
    assert.equal(f.records.phones.length, 0);
    assert.equal(f.records.controllerCalls.length, 0);
    assert.equal(f.adapter.objectPatches.length, 43);
    assert.deepEqual(f.adapter.objects.get('custom.commands.start'), custom);
    assert.deepEqual(f.adapter.objects.get('chargingLocations.loc_' + 'f'.repeat(24) + '.timer4.commands.apply'), custom);
});

test('a failed metadata patch is sanitized on startup and the next normal startup completes only remaining legacy repairs', async t => {
    let failed = false;
    const previous = legacyObjectMetadata();
    const first = await fixture(t, { initialObjects: previous, objectExtend: async id => {
        if (!failed && id === 'commands.start') { failed = true; throw new Error('SYNTHETIC PRIVATE DATABASE ERROR'); }
    } });
    assert.equal(failed, true);
    assert.equal(first.records.phones.length, 0);
    assert.equal(first.records.controllerCalls.length, 0);
    assert.equal(JSON.stringify(first.adapter.logs).includes('SYNTHETIC PRIVATE'), false);
    const second = await fixture(t, { initialObjects: Object.fromEntries(first.adapter.objects) });
    assert.equal(first.adapter.objectPatches.length + second.adapter.objectPatches.length, 43);
    for (const [id, object] of Object.entries(previous)) assert.deepEqual(second.adapter.objects.get(id), correctedLegacyMetadata(id, object), id);
    assert.equal(second.records.phones.length, 0);
    assert.equal(second.records.controllerCalls.length, 0);
});

test('charging mode wishes have independent metadata, persistence and local clear without a phone action', async t => {
    const f = await fixture(t, { memory: { 'charging-preference': { ...DEFAULT_TARGET_CHARGING, socLimit: 80 } } });
    assert.deepEqual(f.adapter.states.get('charging.mode'), { val: null, ack: true, q: 0x82 });
    assert.equal(f.value('charging.modeObservedAt'), '');
    assert.equal(f.value('charging.targetMode'), null);
    for (const id of ['commands.applyChargingMode', 'commands.clearChargingMode']) {
        assert.equal(f.adapter.objects.get(id).common.read, false);
        assert.equal(f.adapter.objects.get(id).common.write, true);
    }
    assert.deepEqual(Object.keys(f.adapter.objects.get('charging.mode').common.states), ['immediate', 'departure', 'departureClimate']);
    const feedback = f.adapter.states.get('operation.lastResult');
    await f.adapter.onStateChange('vw-app.0.charging.targetMode', { val: 'departure', ack: false });
    assert.deepEqual(f.adapter.states.get('charging.targetMode'), { val: 'departure', ack: true });
    assert.deepEqual(f.memory['charging-mode-preference'], { mode: 'departure' });
    assert.equal(f.memory['charging-preference'].socLimit, 80);
    const restarted = await fixture(t, { memory: clone(f.memory) });
    assert.equal(restarted.value('charging.targetMode'), 'departure');
    await restarted.adapter.onStateChange('vw-app.0.commands.clearChargingMode', { val: true, ack: false });
    assert.deepEqual(restarted.memory['charging-mode-preference'], { mode: null });
    assert.equal(restarted.value('charging.targetMode'), null);
    assert.equal(restarted.value('charging.targetSoc'), 80);
    assert.deepEqual(f.adapter.states.get('operation.lastResult'), feedback);
    assert.equal(f.records.phones.length + restarted.records.phones.length, 0);
    assert.equal(f.records.controllerCalls.length + restarted.records.controllerCalls.length, 0);
});

test('invalid charging mode selection blocks only mode apply until explicit reselect or clear', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true } });
    await f.adapter.stageChargingMode('departure');
    await rejectsCode(f.adapter.stageChargingMode('SYNTHETIC PRIVATE MODE'), 'invalid_charging_mode');
    assert.equal(f.value('charging.targetMode'), 'departure');
    await rejectsCode(f.adapter.command('applyChargingMode'), 'charging_mode_selection_failed');
    await f.adapter.stageChargingSetting('socLimit', 80);
    await f.adapter.command('applyChargingSettings');
    await f.adapter.command('chargingStatus');
    await rejectsCode(f.adapter.command('applyChargingMode'), 'charging_mode_selection_failed');
    assert.equal(f.memory['charging-mode-preference'].mode, 'departure');
    assert.equal(JSON.stringify(f.adapter.logs).includes('SYNTHETIC PRIVATE MODE'), false);
    await f.adapter.stageChargingMode(null);
    assert.equal(f.value('charging.targetModeError'), '');
    await rejectsCode(f.adapter.command('applyChargingMode'), 'charging_mode_required');
    await f.adapter.stageChargingMode('departureClimate');
    await f.adapter.command('applyChargingMode');
    assert.deepEqual(f.records.controllerCalls.at(-1), { action: 'applyChargingMode', input: { targetChargingMode: 'departureClimate' } });
    assert.equal(f.value('charging.mode'), 'departureClimate');
});

test('damaged charging mode storage remains blocked across restart without disabling ordinary reads or charging settings', async t => {
    for (const saved of [{ mode: 'BAD' }, {}, { mode: null, unexpected: true }, [], null]) {
        const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
            memory: { 'charging-mode-preference': saved === null ? { mode: { private: 'SECRET' } } : saved }, config: { allowWrites: true } });
        assert.deepEqual(f.adapter.states.get('charging.targetMode'), { val: null, ack: true, q: 0x82 });
        await rejectsCode(f.adapter.command('applyChargingMode'), 'invalid_state');
        await f.adapter.command('chargingStatus');
        await f.adapter.stageChargingSetting('autoUnlockAc', false);
        await f.adapter.command('applyChargingSettings');
        const again = await fixture(t, { enrollment: enrolled(), fakeController: true, memory: clone(f.memory) });
        await rejectsCode(again.adapter.command('applyChargingMode'), 'invalid_state');
        assert.equal(JSON.stringify(f.adapter.logs).includes('SECRET'), false);
        await f.adapter.stageChargingMode(null);
        assert.equal(f.value('charging.targetModeError'), '');
    }
});

test('charging mode save failure uses fixed errors and requires reselect without overwriting the last saved mode', async t => {
    let failed = false;
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true },
        storeWrite: async name => { if (name === 'charging-mode-preference' && failed) throw new BridgeError('foreign_private', 'SYNTHETIC PRIVATE STORAGE'); } });
    await f.adapter.stageChargingMode('immediate');
    failed = true;
    await rejectsCode(f.adapter.stageChargingMode('departure'), 'state_not_saved');
    assert.equal(f.value('charging.targetMode'), 'immediate');
    assert.equal(f.memory['charging-mode-preference'].mode, 'immediate');
    await rejectsCode(f.adapter.command('applyChargingMode'), 'charging_mode_selection_failed');
    assert.equal(JSON.stringify([...f.adapter.states, f.adapter.logs]).includes('SYNTHETIC PRIVATE'), false);
    failed = false;
    await f.adapter.stageChargingMode('departure');
    await f.adapter.command('applyChargingMode');
    assert.equal(f.value('charging.mode'), 'departure');
});

test('charging mode apply requires an explicit wish and valid profile and cannot run automatically', async t => {
    const f = await fixture(t, { fakeController: true });
    await rejectsCode(f.adapter.command('applyChargingMode'), 'charging_mode_required');
    await f.adapter.stageChargingMode('immediate');
    await rejectsCode(f.adapter.command('applyChargingMode'), 'profile_required');
    f.memory.enrollment = enrolled(); f.adapter.settings.approvedAppVersion = 'different';
    await rejectsCode(f.adapter.command('applyChargingMode'), 'profile_mismatch');
    f.adapter.settings.approvedAppVersion = '';
    await rejectsCode(f.adapter.command('applyChargingMode', { automatic: true }), 'invalid_action');
    assert.equal(f.records.phones.length, 0);
    f.adapter.settings.allowWrites = true;
    await f.adapter.command('applyChargingMode');
    assert.deepEqual(f.records.controllerCalls, [{ action: 'applyChargingMode', input: { targetChargingMode: 'immediate' } }]);
});

test('disabled writes allow only a freshly fulfilled mode through the real adapter and controller', async t => {
    for (const currentMode of ['departure', 'departureClimate']) {
        const phones = [];
        class ReadOnlyChargingPhone {
            constructor(settings) { this.settings = settings; this.page = 'overview'; this.lower = false; this.calls = []; phones.push(this); }
            async connect() { await this.settings.onVerified(DEVICE); return { deviceId: DEVICE }; }
            async version() { return '4.8.1'; }
            async launch() {}
            async dump() {
                if (this.page === 'overview') return overviewChargingScreen({ lower: this.lower }).replace('Ihr Fahrzeug: Testwagen. ', VEHICLE);
                if (this.page === 'vehicleSettings') return chargingSettingsScreen({ socLimit: 100, reducedAcCurrent: true,
                    autoUnlockAc: false, optimizedBatteryUse: true, vehicleName: 'Testwagen', dirty: false });
                if (this.page === 'range') return rangeModeScreen({ mode: currentMode });
                assert.fail('No mode picker may be opened with writes disabled.');
            }
            async departureView() {
                this.snapshot = nativeObservationFromXml(await this.dump());
                return { observation: this.snapshot };
            }
            async departureAction(request) {
                assert.equal(request.snapshot, this.snapshot);
                assert.equal(request.action, 'scrollBackward');
                assert.equal(this.page, 'overview');
                this.lower = false;
                return { beforeMatched: true, actionAttempted: true, actionAccepted: true, success: true,
                    errorCode: null, postRead: { observation: nativeObservationFromXml(await this.dump()) } };
            }
            async swipe(gesture) { assert.equal(this.page, 'overview'); this.lower = gesture.y2 < gesture.y1; }
            async tap(x, y) {
                this.calls.push({ page: this.page, x, y });
                if (this.page === 'overview' && x === CHARGING_POINTS.vehicleSettings.x && y === CHARGING_POINTS.vehicleSettings.y && this.lower) { this.page = 'vehicleSettings'; return; }
                if (this.page === 'vehicleSettings' && x === CHARGING_POINTS.vehicleSettingsBack.x && y === CHARGING_POINTS.vehicleSettingsBack.y) { this.page = 'overview'; return; }
                if (this.page === 'overview' && x === CHARGING_POINTS.range.x && y === CHARGING_POINTS.range.y) { this.page = 'range'; return; }
                if (this.page === 'range' && x === CHARGING_POINTS.back.x && y === CHARGING_POINTS.back.y) { this.page = 'overview'; return; }
                assert.fail('No mode selection, start, synchronization or setting may be tapped.');
            }
        }
        const f = await fixture(t, { enrollment: enrolled(), Phone: ReadOnlyChargingPhone, config: { allowWrites: false } });
        await f.adapter.stageChargingMode('departure');
        const command = f.adapter.command('applyChargingMode');
        if (currentMode === 'departure') {
            const result = await command;
            assert.equal(result.changed, false);
            assert.equal(result.charging.mode, 'departure');
            assert.equal(f.value('operation.lastResult'), 'succeeded');
            assert.equal(f.value('charging.mode'), 'departure');
            assert.equal(typeof f.value('charging.modeObservedAt'), 'string');
            assert.equal(phones[0].page, 'overview');
        } else {
            await rejectsCode(command, 'writes_disabled');
            assert.equal(f.value('operation.lastErrorCode'), 'writes_disabled');
        }
        assert.equal(phones.length, 1);
        const phone = phones[0];
        assert.equal(f.records.stores[0].reservations, 0);
        assert.ok(phone.calls.every(call => call.page !== 'chargingMode'));
        assert.ok(!phone.calls.some(call => call.page === 'range' && call.x !== CHARGING_POINTS.back.x));
        assert.equal(f.adapter.settings.allowWrites, false);
        const readsBefore = phone.calls.length;
        await f.adapter.stageChargingSetting('socLimit', 80);
        await rejectsCode(f.adapter.command('applyChargingSettings'), 'writes_disabled');
        await f.adapter.stageSetting('mode', 'climate');
        await rejectsCode(f.adapter.command('applySettings'), 'writes_disabled');
        await f.adapter.stageTemperature(22);
        await rejectsCode(f.adapter.command('setTemperature'), 'writes_disabled');
        assert.equal(phone.calls.length, readsBefore);
        assert.equal(f.records.stores[0].reservations, 0);
    }
});

test('charging mode snapshot waits for its own preceding save while later selection affects only a later command', async t => {
    const saving = deferred(), releaseSave = deferred(), executing = deferred(), finish = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true },
        storeWrite: async (name, value) => { if (name === 'charging-mode-preference' && value.mode === 'departure') { saving.resolve(); await releaseSave.promise; } },
        controllerExecute: async (_action, input) => { executing.resolve(); await finish.promise; return chargingModeResult(input.targetChargingMode); } });
    t.after(() => { releaseSave.resolve(); finish.resolve(); });
    const stage = f.adapter.stageChargingMode('departure'); await saving.promise;
    const apply = f.adapter.command('applyChargingMode');
    const later = f.adapter.stageChargingMode(null);
    await Promise.resolve(); assert.equal(f.records.controllerCalls.length, 0);
    releaseSave.resolve(); await stage; await executing.promise; await later;
    assert.equal(f.value('charging.targetMode'), null);
    assert.deepEqual(f.records.controllerCalls[0], { action: 'applyChargingMode', input: { targetChargingMode: 'departure' } });
    finish.resolve(); await apply;
    assert.equal(f.value('charging.mode'), 'departure');
    await rejectsCode(f.adapter.command('applyChargingMode'), 'charging_mode_required');
});

test('ordinary reads and charging-setting writes do not depend on a pending mode save or apply its wish', { timeout: 2000 }, async t => {
    const saving = deferred(), release = deferred();
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true },
        storeWrite: async name => { if (name === 'charging-mode-preference') { saving.resolve(); await release.promise; } } });
    t.after(() => release.resolve());
    await f.adapter.stageChargingSetting('socLimit', 80);
    const stage = f.adapter.stageChargingMode('immediate'); await saving.promise;
    await f.adapter.command('chargingStatus'); await f.adapter.command('applyChargingSettings');
    assert.deepEqual(f.records.controllerCalls.map(row => row.action), ['chargingStatus', 'applyChargingSettings']);
    assert.ok(f.records.controllerCalls.every(row => !Object.hasOwn(row.input, 'targetChargingMode')));
    release.resolve(); await stage;
    await f.adapter.onStateChange('vw-app.0.commands.clearChargingSettings', { val: true, ack: false });
    assert.equal(f.value('charging.targetMode'), 'immediate');
});

test('an unreadable charging mode preserves historical mode and time while battery readings can remain fresh', async t => {
    const clock = fakeClock();
    const f = await fixture(t, { clock, config: { refreshMaxAgeSeconds: 30 } });
    const first = new Date(clock.now()).toISOString();
    await f.adapter.observation(chargingModeResult('departure', first));
    await f.adapter.stageChargingMode('immediate');
    await clock.advance(1000);
    await f.adapter.observation({ ...chargingResult(), observedAt: new Date(clock.now()).toISOString() });
    assert.deepEqual(f.adapter.states.get('charging.mode'), { val: 'departure', ack: true, q: 0x82 });
    assert.equal(f.value('charging.modeObservedAt'), first);
    assert.equal(f.value('refresh.charging.status'), 'fresh');
    assert.deepEqual(f.adapter.states.get('battery.soc'), { val: 52, ack: true });
    assert.equal(f.value('charging.targetMode'), 'immediate');
    await f.adapter.observation(chargingModeResult('departureClimate', new Date(clock.now()).toISOString()));
    assert.deepEqual(f.adapter.states.get('charging.mode'), { val: 'departureClimate', ack: true });
    const at = f.value('charging.modeObservedAt');
    await clock.advance(31000);
    assert.equal(f.value('refresh.charging.status'), 'stale');
    assert.deepEqual(f.adapter.states.get('charging.mode'), { val: 'departureClimate', ack: true, q: 0x82 });
    assert.equal(f.value('charging.modeObservedAt'), at);
    await f.adapter.failure(new BridgeError('phone_timeout', 'Synthetic timeout.'), 'charging');
    assert.equal(f.value('charging.modeObservedAt'), at);
    const restarted = await fixture(t, { initialStates: Object.fromEntries(f.adapter.states), memory: clone(f.memory) });
    assert.deepEqual(restarted.adapter.states.get('charging.mode'), { val: 'departureClimate', ack: true, q: 0x82 });
    assert.equal(restarted.value('charging.modeObservedAt'), at);
    assert.equal(restarted.value('charging.targetMode'), 'immediate');
    assert.equal(restarted.records.phones.length, 0);
});

test('regular charging reads observe the mode without applying staged wishes or changing manual feedback', async t => {
    const clock = fakeClock();
    const f = await fixture(t, { clock, enrollment: enrolled(), fakeController: true, RefreshScheduler: RecordingScheduler,
        config: { pollIntervalSeconds: 15 }, controllerExecute: async () => chargingModeResult('departureClimate', new Date(clock.now()).toISOString()) });
    await f.adapter.stageChargingMode('immediate');
    await f.adapter.feedback('lastResult', 'retained manual result');
    await f.adapter.runAutomaticRead('charging');
    assert.equal(f.value('charging.mode'), 'departureClimate');
    assert.equal(f.value('charging.targetMode'), 'immediate');
    assert.equal(f.value('operation.lastResult'), 'retained manual result');
    assert.equal(f.value('refresh.charging.status'), 'fresh');
    assert.deepEqual(f.records.controllerCalls, [expectedChargingCall('chargingStatus')]);
    f.adapter.settings.allowWrites = true;
    await f.adapter.command('applyChargingMode');
    assert.deepEqual(f.adapter.scheduler.requests.at(-1), { domain: 'charging', priority: true, delayMs: 2000 });
});

test('mode freshness uses its own successful snapshot time and missing timestamps cannot replace its history', async t => {
    const clock = fakeClock();
    const f = await fixture(t, { clock, config: { refreshMaxAgeSeconds: 30 } });
    const modeAt = new Date(clock.now()).toISOString();
    await clock.advance(5000);
    const completedAt = new Date(clock.now()).toISOString();
    await f.adapter.observation({ ...chargingModeResult('departure', completedAt), modeObservedAt: modeAt });
    assert.equal(f.value('charging.modeObservedAt'), modeAt);
    await clock.advance(26000);
    assert.equal(f.value('refresh.charging.status'), 'fresh');
    assert.deepEqual(f.adapter.states.get('charging.mode'), { val: 'departure', ack: true, q: 0x82 });
    for (const value of [null, undefined, '', 'invalid', 123]) {
        await f.adapter.observation({ ...chargingModeResult('immediate', new Date(clock.now()).toISOString()), modeObservedAt: value });
        assert.equal(f.value('charging.mode'), 'departure');
        assert.equal(f.value('charging.modeObservedAt'), modeAt);
        assert.equal(f.adapter.states.get('charging.mode').q, 0x82);
        assert.equal(f.adapter.states.get('battery.soc').q, undefined);
    }
});

test('mode apply is independent of pending old charging, climate and temperature saves', { timeout: 2000 }, async t => {
    const release = deferred();
    const waiting = { 'temperature-preference': deferred(), 'settings-preference': deferred(), 'charging-preference': deferred() };
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true },
        storeWrite: async name => { if (waiting[name]) { waiting[name].resolve(); await release.promise; } } });
    t.after(() => release.resolve());
    await f.adapter.stageChargingMode('departureClimate');
    const stages = [f.adapter.stageTemperature(22.5), f.adapter.stageSetting('mode', 'climate'), f.adapter.stageChargingSetting('socLimit', 80)];
    await Promise.all(Object.values(waiting).map(value => value.promise));
    await f.adapter.command('applyChargingMode');
    assert.deepEqual(f.records.controllerCalls, [{ action: 'applyChargingMode', input: { targetChargingMode: 'departureClimate' } }]);
    release.resolve(); await Promise.all(stages);
});

test('charging mode controls accept only own explicit requests and clear never changes the observed mode', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true,
        config: { allowWrites: true, legacyStatePrefix: '0_userdata.0.vw' } });
    await f.adapter.onStateChange('vw-app.0.charging.targetMode', { val: 'immediate', ack: true });
    assert.equal(f.value('charging.targetMode'), null);
    await f.adapter.stageChargingMode('departure');
    for (const name of ['applyChargingMode', 'clearChargingMode']) {
        for (const state of [{ val: true, ack: true }, { val: false, ack: false }, { val: 'true', ack: false }, { val: 1, ack: false }]) {
            await f.adapter.onStateChange('vw-app.0.commands.' + name, state);
        }
        for (const prefix of ['0_userdata.0.vw.', 'vw-app.1.commands.']) await f.adapter.onStateChange(prefix + name, { val: true, ack: false });
    }
    assert.equal(f.records.controllerCalls.length, 0);
    assert.equal(f.value('charging.targetMode'), 'departure');
    await f.adapter.onStateChange('vw-app.0.commands.applyChargingMode', { val: true, ack: false });
    assert.equal(f.records.controllerCalls.length, 1);
    assert.equal(f.value('charging.mode'), 'departure');
    const at = f.value('charging.modeObservedAt');
    await f.adapter.onStateChange('vw-app.0.commands.clearChargingMode', { val: true, ack: false });
    assert.equal(f.records.controllerCalls.length, 1);
    assert.equal(f.value('charging.targetMode'), null);
    assert.equal(f.value('charging.mode'), 'departure');
    assert.equal(f.value('charging.modeObservedAt'), at);
});

test('location timer editing remains available in immediate mode and never applies a staged mode wish', async t => {
    const f = await fixture(t, { enrollment: enrolled(), fakeController: true, config: { allowWrites: true },
        departureLocations: [{ nativeId: '700', name: 'Synthetischer Ort A', activeCount: 0 }] });
    await f.adapter.observation(chargingModeResult('immediate'));
    await f.adapter.stageChargingMode('departureClimate');
    await f.adapter.command('departuresLocationsStatus');
    const key = Object.keys(f.adapter.departures.bindings)[0];
    await f.adapter.onStateChange('vw-app.0.chargingLocations.' + key + '.timer1.targetEnabled', { val: true, ack: false });
    await f.adapter.onStateChange('vw-app.0.chargingLocations.' + key + '.timer1.commands.apply', { val: true, ack: false });
    assert.deepEqual(f.records.controllerCalls.map(row => row.action), ['departuresLocationsStatus', 'applyDepartureLocationTimer']);
    assert.equal(f.value('charging.mode'), 'immediate');
    assert.equal(f.value('charging.targetMode'), 'departureClimate');
    assert.deepEqual(f.memory['charging-mode-preference'], { mode: 'departureClimate' });
});
