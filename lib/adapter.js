'use strict';
const fs = require('node:fs/promises');
const { BridgeError, publicError } = require('./errors');
const { normalizeConfig, endpoint, integer, validateHost } = require('./config');
const { StateStore } = require('./store');
const { DeviceLease } = require('./lease');
const { AdbRuntime } = require('./runtime');
const { Phone } = require('./phone');
const { Screen } = require('./ui');
const { Controller } = require('./controller');
const { MIN_TEMPERATURE_CELSIUS, MAX_TEMPERATURE_CELSIUS, TEMPERATURE_STEP_CELSIUS,
    isTemperature, validateTargetTemperature } = require('./temperature');

const DEFINITIONS = {
    'info.connection': ['boolean', 'indicator.connected', false, false],
    'info.runtimeReady': ['boolean', 'indicator', false, false],
    'info.appVersion': ['string', 'text', '', false],
    'info.status': ['string', 'text', 'setup_required', false],
    'commands.start': ['boolean', 'button', false, true],
    'commands.stop': ['boolean', 'button', false, true],
    'commands.refresh': ['boolean', 'button', false, true],
    'commands.setTemperature': ['boolean', 'button', false, true],
    'commands.clearTemperature': ['boolean', 'button', false, true],
    'climate.appState': ['string', 'text', 'unknown', false],
    'climate.targetTemperature': ['number', 'level.temperature', null, true],
    'climate.targetTemperatureError': ['string', 'text', '', false],
    'climate.temperature': ['number', 'value.temperature', null, false],
    'climate.confirmationSource': ['string', 'text', 'none', false],
    'climate.active': ['boolean', 'indicator', false, false],
    'climate.vehicleConfirmed': ['boolean', 'indicator', false, false],
    'operation.busy': ['boolean', 'indicator', false, false],
    'operation.lastResult': ['string', 'text', '', false],
    'operation.lastError': ['string', 'text', '', false],
    'operation.lastErrorCode': ['string', 'text', '', false],
    'operation.lastUpdated': ['string', 'date', '', false],
};

function markerFromScreen(screen) {
    const matches = [];
    for (const row of screen.summary()) {
        const value = row.contentDesc || '';
        const match = /^(Ihr Fahrzeug: .+\. )(?=Synchronisiert\b|Gerade synchronisiert\b)/.exec(value)
            || /^(Your vehicle: .+\. )(?=Synchronised\b|Synchronized\b|Just synchroni[sz]ed\b)/.exec(value);
        if (match) matches.push(match[1]);
    }
    if (matches.length !== 1) throw new BridgeError('vehicle_marker_missing', 'The selected vehicle name is missing or ambiguous. Open its overview in the VW app.');
    screen.requireVehicle({ contentDescPrefix: matches[0] });
    return matches[0];
}

function createAdapterClass(utils, dependencies = {}) {
    const Runtime = dependencies.Runtime || AdbRuntime;
    const PhoneClass = dependencies.Phone || Phone;
    const Store = dependencies.Store || StateStore;
    const Lease = dependencies.Lease || DeviceLease;
    const ControllerClass = dependencies.Controller || Controller;
    return class VwApp extends utils.Adapter {
        constructor(options = {}) {
            super({ ...options, name: 'vw-app' });
            this.stopping = false; this.busy = false; this.currentOperation = null;
            this.abortController = new AbortController();
            this.targetTemperature = null;
            this.temperaturePreferenceReady = false;
            this.temperatureUpdateFailed = false;
            this.temperatureUpdates = Promise.resolve();
            this.on('ready', () => this.onReady());
            this.on('stateChange', (id, state) => this.onStateChange(id, state));
            this.on('message', obj => this.onMessage(obj));
            this.on('unload', callback => this.onUnload(callback));
        }
        async state(id, value) {
            if (!this.stopping) await this.setStateAsync(id, value && typeof value === 'object' && 'val' in value ? value : { val: value, ack: true });
        }
        async legacy(name, value) {
            if (!this.stopping && this.settings?.legacyStatePrefix) {
                const id = this.settings.legacyStatePrefix + '.' + name;
                if (await this.getForeignObjectAsync(id)) await this.setForeignStateAsync(id, { val: value, ack: true });
            }
        }
        async feedback(name, value) {
            const map = { busy: 'operation.busy', lastResult: 'operation.lastResult', lastError: 'operation.lastError', lastUpdated: 'operation.lastUpdated', appState: 'climate.appState' };
            await this.state(map[name], value); await this.legacy(name, value);
        }
        async onReady() {
            try {
                this.settings = normalizeConfig(this.config);
                this.dataDir = utils.getAbsoluteInstanceDataDir(this);
                await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
                await fs.chmod(this.dataDir, 0o700);
                this.store = new Store(this.dataDir);
                this.lease = new Lease(() => { this.abortController.abort(); this.controller?.cancel(); });
                this.runtime = new Runtime({ dataDir: this.dataDir, adbPath: this.settings.adbPath, useBundledAdb: this.settings.useBundledAdb });
                for (const [id, [type, role, initial, write]] of Object.entries(DEFINITIONS)) {
                    const parent = id.split('.')[0];
                    await this.setObjectNotExistsAsync(parent, { type: 'channel', common: { name: parent }, native: {} });
                    const common = { name: id, type, role, read: true, write };
                    if (['climate.targetTemperature', 'climate.temperature'].includes(id)) {
                        common.unit = '°C';
                        common.min = MIN_TEMPERATURE_CELSIUS; common.max = MAX_TEMPERATURE_CELSIUS;
                        common.step = TEMPERATURE_STEP_CELSIUS;
                    }
                    if (id === 'climate.targetTemperature') common.name = 'Gewünschte Temperatur für nächsten Start';
                    if (id === 'commands.clearTemperature') common.name = 'App-Temperatur beibehalten';
                    await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
                    if (id === 'climate.targetTemperature') continue;
                    await this.state(id, id === 'climate.temperature' ? { val: null, ack: true, q: 0x82 } : initial);
                }
                let preferenceError;
                try { await this.restoreTemperaturePreference(); } catch (error) { preferenceError = error; }
                await this.subscribeStatesAsync('commands.*');
                await this.subscribeStatesAsync('climate.targetTemperature');
                if (this.settings.legacyStatePrefix) for (const name of ['start', 'stop', 'refresh']) await this.subscribeForeignStatesAsync(this.settings.legacyStatePrefix + '.' + name);
                await this.ensureRuntime();
                if (preferenceError) throw preferenceError;
                await this.state('info.status', 'ready_for_setup');
                if (this.settings.pollIntervalSeconds) {
                    this.pollTimer = this.setInterval(() => { if (!this.busy && !this.stopping) void this.command('status').catch(() => {}); }, this.settings.pollIntervalSeconds * 1000);
                }
            } catch (error) { await this.failure(error); }
        }
        async restoreTemperaturePreference() {
            try {
                const saved = await this.store.read('temperature-preference', { targetCelsius: null });
                this.targetTemperature = validateTargetTemperature(saved.targetCelsius);
                this.temperaturePreferenceReady = true;
                this.temperatureUpdateFailed = false;
                await this.state('climate.targetTemperature', this.targetTemperature);
                await this.state('climate.targetTemperatureError', '');
            } catch (_) {
                this.targetTemperature = null;
                this.temperatureUpdateFailed = true;
                await this.state('climate.targetTemperature', null);
                await this.state('climate.targetTemperatureError', 'invalid_state: The saved temperature preference is invalid. Select a supported value again.');
                throw new BridgeError('invalid_state', 'The saved temperature preference is invalid. Select and save a supported target temperature again.');
            }
        }
        stageTemperature(value) {
            const update = this.temperatureUpdates.then(async () => {
                try {
                    const targetCelsius = validateTargetTemperature(value);
                    await this.store.write('temperature-preference', { targetCelsius });
                    this.targetTemperature = targetCelsius;
                    this.temperaturePreferenceReady = true;
                    this.temperatureUpdateFailed = false;
                    await this.state('climate.targetTemperature', targetCelsius);
                    await this.state('climate.targetTemperatureError', '');
                } catch (error) {
                    this.temperatureUpdateFailed = true;
                    await this.state('climate.targetTemperature', this.targetTemperature);
                    const safe = publicError(error);
                    await this.state('climate.targetTemperatureError', safe.code + ': ' + safe.message);
                    this.log.warn(safe.code + ': ' + safe.message);
                    throw error;
                }
            });
            this.temperatureUpdates = update.catch(() => {});
            return update;
        }
        async ensureRuntime() {
            if (this.stopping) throw new BridgeError('cancelled', 'The adapter is stopping.');
            await this.runtime.start();
            await this.state('info.runtimeReady', true);
        }
        async enrollment() {
            const saved = await this.store.read('enrollment', {});
            if (saved.deviceId && !/^(?:serial:[A-Za-z0-9_.-]{1,100}|android_id:[0-9a-fA-F]{16})$/.test(saved.deviceId)) throw new BridgeError('invalid_state', 'Saved device identity is invalid.');
            return saved;
        }
        async phone(overrides = {}, { allowUnpinned = false } = {}) {
            await this.ensureRuntime();
            const hostIp = overrides.hostIp || this.settings.hostIp;
            const connectPort = overrides.connectPort || this.settings.connectPort;
            const saved = await this.enrollment();
            if (!allowUnpinned && !saved.deviceId) throw new BridgeError('wifi_identity_required', 'Run the phone check in adapter settings first.');
            return new PhoneClass({
                runtime: this.runtime, endpoint: endpoint(hostIp, connectPort), deviceId: saved.deviceId || '',
                signal: this.abortController.signal,
                onVerified: async deviceId => { await this.lease.acquire(deviceId); },
            });
        }
        async exclusive(label, operation) {
            if (this.stopping) throw new BridgeError('cancelled', 'The adapter is stopping.');
            if (this.busy) throw new BridgeError('busy', 'Another phone operation is running.');
            this.busy = true;
            const execute = async () => {
                try {
                    await this.feedback('busy', true);
                    await this.feedback('lastResult', 'running');
                    await this.feedback('lastError', '');
                    await this.state('operation.lastErrorCode', '');
                    await this.state('info.status', label);
                    const result = await operation();
                    await this.feedback('lastResult', 'succeeded');
                    await this.state('info.status', 'ready');
                    return result;
                } catch (error) { await this.failure(error); throw error; }
                finally {
                    this.controller = null; this.busy = false;
                    await this.feedback('busy', false);
                }
            };
            this.currentOperation = execute();
            try { return await this.currentOperation; }
            finally { this.currentOperation = null; }
        }
        async failure(error) {
            const safe = publicError(error);
            await this.state('info.connection', false);
            await this.state('info.status', safe.code);
            await this.state('operation.lastErrorCode', safe.code);
            await this.feedback('lastError', safe.code + ': ' + safe.message);
            await this.feedback('lastResult', 'failed');
            await this.feedback('appState', 'unknown');
            await this.state('climate.confirmationSource', 'none');
            await this.state('climate.temperature', { val: null, ack: true, q: 0x82 });
            await this.state('climate.active', { val: false, ack: true, q: 0x82 });
            await this.feedback('lastUpdated', '');
            this.log.warn(safe.code + ': ' + safe.message);
        }
        async observation(result) {
            await this.state('info.connection', true);
            await this.state('info.appVersion', result.appVersion);
            await this.feedback('appState', result.appState);
            await this.state('climate.confirmationSource', result.confirmationSource || 'app_controls');
            await this.state('climate.active', result.appState === 'on');
            await this.state('climate.vehicleConfirmed', false);
            await this.state('climate.temperature', isTemperature(result.temperature)
                ? { val: result.temperature, ack: true }
                : { val: null, ack: true, q: 0x82 });
            await this.feedback('lastUpdated', result.observedAt);
        }
        async command(action) {
            // Register the snapshot now, before a later staged selection can
            // change the target of an already accepted phone operation.
            const selectedTarget = this.temperatureUpdates.then(() => ({
                value: this.targetTemperature, ready: this.temperaturePreferenceReady, failed: this.temperatureUpdateFailed,
            }));
            return this.exclusive(action, async () => {
                const selection = await selectedTarget;
                if (['start', 'setTemperature'].includes(action) && !selection.ready) {
                    throw new BridgeError('invalid_state', 'Read or select a valid saved target temperature before changing the app settings.');
                }
                if (['start', 'setTemperature'].includes(action) && selection.failed) {
                    throw new BridgeError('temperature_selection_failed', 'The last temperature selection failed. Select a valid value again or choose Keep the app temperature before starting or applying it.');
                }
                if (action === 'setTemperature') {
                    if (selection.value === null) throw new BridgeError('invalid_temperature', 'Select a target temperature before applying it.');
                    if (!this.settings.allowWrites) throw new BridgeError('writes_disabled', 'Changing the app temperature is disabled. Check and enable the write permission first.');
                }
                const saved = await this.enrollment();
                if (!saved.profile?.appVersion || !saved.profile.vehicleMarker) throw new BridgeError('profile_required', 'Calibrate the selected vehicle in adapter settings first.');
                if ((this.settings.approvedAppVersion && this.settings.approvedAppVersion !== saved.profile.appVersion)
                    || (this.settings.vehicleMarker && this.settings.vehicleMarker !== saved.profile.vehicleMarker)) {
                    throw new BridgeError('profile_mismatch', 'The edited profile differs from the last calibration. Calibrate again.');
                }
                const phone = await this.phone();
                if (this.settings.stayAwakeOnCharge) { await phone.connect(); await phone.keepAwake(); }
                this.controller = new ControllerClass({
                    config: { ...this.settings, approvedAppVersion: saved.profile.appVersion, vehicleMarker: { contentDescPrefix: saved.profile.vehicleMarker } },
                    phone, store: this.store,
                });
                const targetTemperature = ['start', 'setTemperature'].includes(action) ? selection.value : null;
                const result = await this.controller.execute(action, { targetTemperature });
                await this.observation(result);
                return result;
            });
        }
        async onStateChange(id, state) {
            if (!state || state.ack !== false || this.stopping) return;
            if (id === this.namespace + '.climate.targetTemperature') {
                await this.stageTemperature(state.val).catch(() => {});
                return;
            }
            if (state.val !== true) return;
            const own = this.namespace + '.commands.';
            const legacy = this.settings?.legacyStatePrefix && this.settings.legacyStatePrefix + '.';
            const name = id.startsWith(own) ? id.slice(own.length) : legacy && id.startsWith(legacy) ? id.slice(legacy.length) : '';
            if (!['start', 'stop', 'refresh', 'setTemperature', 'clearTemperature'].includes(name)
                || ['setTemperature', 'clearTemperature'].includes(name) && !id.startsWith(own)) return;
            if (id.startsWith(own)) await this.state('commands.' + name, false);
            else await this.legacy(name, false);
            if (name === 'clearTemperature') { await this.stageTemperature(null).catch(() => {}); return; }
            await this.command(name === 'refresh' ? 'status' : name).catch(() => {});
        }
        async probe(message) {
            const phone = await this.phone(message, { allowUnpinned: true });
            const identity = await phone.connect({ allowUnpinned: true });
            const version = await phone.version();
            const saved = await this.enrollment();
            await this.store.write('enrollment', { ...saved, deviceId: identity.deviceId });
            await this.state('info.connection', true); await this.state('info.appVersion', version);
            return { result: 'probe_success', actualAppVersion: version, native: { hostIp: message.hostIp || this.settings.hostIp, connectPort: Number(message.connectPort || this.settings.connectPort) } };
        }
        async calibrate(message) {
            const phone = await this.phone(message);
            phone.deadline = Date.now() + this.settings.commandTimeoutSeconds * 1000;
            await phone.connect(); const version = await phone.version();
            if (!/^[A-Za-z0-9._-]{1,64}$/.test(version)) throw new BridgeError('app_missing', 'Invalid app version.');
            await phone.launch();
            const read = async () => { const screen = new Screen(await phone.dump()); screen.checkClear(); return screen; };
            let screen = await read();
            if (screen.kind() === 'climate') { await phone.back(); screen = await read(); }
            if (screen.kind() !== 'overview') throw new BridgeError('unexpected_screen', 'Open the vehicle overview in the Volkswagen app.');
            const vehicleMarker = markerFromScreen(screen);
            const tile = screen.target('climateTile', { navigation: true });
            await phone.tap(tile.x, tile.y);
            screen = await read();
            if (screen.kind() !== 'climate') throw new BridgeError('unexpected_screen', 'Climate controls were not found.');
            const appState = screen.climateState();
            screen.requireAcMode(this.settings.modeTitles);
            screen.target(appState === 'on' ? 'cta_stop' : 'cta_start');
            if (await phone.version() !== version) throw new BridgeError('version_not_approved', 'The app changed during calibration. Repeat the check.');
            const saved = await this.enrollment();
            await this.store.write('enrollment', { ...saved, profile: { appVersion: version, vehicleMarker } });
            await this.observation({ appState, appVersion: version, temperature: screen.climateTemperature(), observedAt: new Date().toISOString() });
            return { result: 'calibration_success', native: { approvedAppVersion: version, vehicleMarker }, saveConfig: true };
        }
        async onMessage(obj) {
            if (!obj?.callback || !obj.from || this.stopping) return;
            const message = obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message) ? obj.message : {};
            const allowed = ['installRuntime', 'pair', 'probe', 'calibrate', 'keepAwake'];
            let response;
            try {
                if (!allowed.includes(obj.command)) throw new BridgeError('invalid_action', 'Unknown setup action.');
                response = await this.exclusive(obj.command, async () => {
                    switch (obj.command) {
                        case 'installRuntime':
                            await this.runtime.install({ acceptLicense: message.acceptLicense === true });
                            await this.ensureRuntime(); return { result: 'runtime_installed', native: {} };
                        case 'pair': {
                            await this.ensureRuntime();
                            const target = endpoint(validateHost(message.hostIp), integer(message.pairPort, 1, 65535, 'invalid_wifi_endpoint'));
                            if (typeof message.code !== 'string' || /^[0-9]{6}$/.exec(message.code)?.[0] !== message.code) throw new BridgeError('invalid_pairing_code', 'Enter the six-digit pairing code from the phone.');
                            await this.runtime.pair(target, message.code); return { result: 'pair_success', native: {} };
                        }
                        case 'probe': return this.probe(message);
                        case 'calibrate': return this.calibrate(message);
                        case 'keepAwake': {
                            const phone = await this.phone(message); await phone.connect();
                            if (!(await phone.keepAwake()).active) throw new BridgeError('phone_setting_failed', 'The keep-awake setting was not confirmed.');
                            return { result: 'keep_awake_applied', native: {} };
                        }
                    }
                });
            } catch (error) { const safe = publicError(error); response = { error: safe.code + ': ' + safe.message }; }
            // Responses never echo pairing codes, keys, raw dumps or internal exceptions.
            this.sendTo(obj.from, obj.command, response, obj.callback);
        }
        async onUnload(callback) {
            this.stopping = true;
            try {
                this.abortController.abort();
                try { this.controller?.cancel(); } catch (_) { this.log.warn('Controller cancellation failed.'); }
                if (this.pollTimer) this.clearInterval(this.pollTimer);
                try { await this.runtime?.stop(); } catch (_) { this.log.warn('Android runtime cleanup failed.'); }
                let timer;
                try {
                    await Promise.race([
                        Promise.allSettled([this.currentOperation, this.temperatureUpdates]),
                        new Promise(resolve => { timer = setTimeout(resolve, 3000); }),
                    ]);
                } finally { clearTimeout(timer); }
            } finally {
                // The normal helper is gated once stopping is true. Write the
                // final availability directly, even when another cleanup failed.
                await Promise.allSettled(['info.connection', 'info.runtimeReady'].map(id =>
                    Promise.resolve().then(() => this.setStateAsync(id, { val: false, ack: true }))));
                try { await this.lease?.close(); } catch (_) { this.log.warn('Device lease cleanup failed.'); }
                finally { callback(); }
            }
        }
    };
}

module.exports = { createAdapterClass, markerFromScreen, DEFINITIONS };
