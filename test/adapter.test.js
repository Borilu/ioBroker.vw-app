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
        commandTimeoutSeconds: 180, outcomeTimeoutSeconds: 120, cooldownSeconds: 60, pollIntervalSeconds: 0,
        stayAwakeOnCharge: false, ...options.config };
    const memory = clone(options.enrollment ? { enrollment: options.enrollment } : {});
    const records = { runtime: [], phones: [], stores: [], leases: [], events: [] };
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
        async write(name, value) { this.writes.push({ name, value: clone(value) }); memory[name] = clone(value); }
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

    const utils = { Adapter: FakeAdapter, getAbsoluteInstanceDataDir: () => root };
    const Adapter = createAdapterClass(utils, { Runtime: FakeRuntime, Phone: FakePhone, Store: FakeStore, Lease: FakeLease });
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
        assert.equal(typeof f.value(id), type);
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
    for (const name of ['start', 'stop', 'refresh']) {
        await f.adapter.onStateChange('vw-app.0.commands.' + name, { val: true, ack: false });
        assert.deepEqual(f.adapter.states.get('commands.' + name), { val: false, ack: true });
    }
    assert.deepEqual(actions, ['start', 'stop', 'status']);
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
    assert.equal(f.adapter.controller.config.commandTimeoutSeconds, 180);
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
