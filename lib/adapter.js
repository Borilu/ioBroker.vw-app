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
const { SETTINGS_KEYS, DEFAULT_TARGET_SETTINGS, isObservedSettingValue, validateSetting } = require('./settings');
const { CHARGING_KEYS, DEFAULT_TARGET_CHARGING, MIN_TARGET_SOC, MAX_TARGET_SOC, TARGET_SOC_STEP,
    validateChargingSetting, isObservedChargingValue, isBatterySoc, isRangeKm } = require('./charging');

const TARGET_SETTING_STATES = {
    mode: 'climate.targetMode', climateOnUnlock: 'climate.targetClimateOnUnlock',
    autoWindowHeating: 'climate.targetAutoWindowHeating', zones: 'climate.targetZones',
};
const OBSERVED_SETTING_STATES = {
    mode: 'climate.mode', climateOnUnlock: 'climate.climateOnUnlock',
    autoWindowHeating: 'climate.autoWindowHeating', zones: 'climate.zones',
};
const TARGET_CHARGING_STATES = {
    socLimit: 'charging.targetSoc', reducedAcCurrent: 'charging.targetReducedAcCurrent',
    autoUnlockAc: 'charging.targetAutoUnlockAc', optimizedBatteryUse: 'charging.targetOptimizedBatteryUse',
};
const OBSERVED_CHARGING_STATES = {
    socLimit: 'charging.socLimit', reducedAcCurrent: 'charging.reducedAcCurrent',
    autoUnlockAc: 'charging.autoUnlockAc', optimizedBatteryUse: 'charging.optimizedBatteryUse',
};

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
    'commands.applySettings': ['boolean', 'button', false, true],
    'commands.clearSettings': ['boolean', 'button', false, true],
    'commands.refreshCharging': ['boolean', 'button', false, true],
    'commands.synchronize': ['boolean', 'button', false, true],
    'commands.applyChargingSettings': ['boolean', 'button', false, true],
    'commands.clearChargingSettings': ['boolean', 'button', false, true],
    'battery.soc': ['number', 'value.battery', null, false],
    'battery.rangeKm': ['number', 'value.distance', null, false],
    'battery.observedAt': ['string', 'date', '', false],
    'battery.lastSyncRequestAt': ['string', 'date', '', false],
    'charging.socLimit': ['number', 'value.battery', null, false],
    'charging.reducedAcCurrent': ['boolean', 'indicator', null, false],
    'charging.autoUnlockAc': ['boolean', 'indicator', null, false],
    'charging.optimizedBatteryUse': ['boolean', 'indicator', null, false],
    'charging.targetSoc': ['number', 'level', null, true],
    'charging.targetReducedAcCurrent': ['boolean', 'switch', null, true],
    'charging.targetAutoUnlockAc': ['boolean', 'switch', null, true],
    'charging.targetOptimizedBatteryUse': ['boolean', 'switch', null, true],
    'charging.targetSettingsError': ['string', 'text', '', false],
    'climate.appState': ['string', 'text', 'unknown', false],
    'climate.targetTemperature': ['number', 'level.temperature', null, true],
    'climate.targetTemperatureError': ['string', 'text', '', false],
    'climate.temperature': ['number', 'value.temperature', null, false],
    'climate.targetMode': ['string', 'text', null, true],
    'climate.targetClimateOnUnlock': ['boolean', 'switch', null, true],
    'climate.targetAutoWindowHeating': ['boolean', 'switch', null, true],
    'climate.targetZones': ['string', 'text', null, true],
    'climate.targetSettingsError': ['string', 'text', '', false],
    'climate.mode': ['string', 'text', null, false],
    'climate.climateOnUnlock': ['boolean', 'indicator', null, false],
    'climate.autoWindowHeating': ['boolean', 'indicator', null, false],
    'climate.zones': ['string', 'text', null, false],
    'climate.confirmationSource': ['string', 'text', 'none', false],
    'climate.active': ['boolean', 'indicator', false, false],
    'climate.vehicleConfirmed': ['boolean', 'indicator', false, false],
    'operation.busy': ['boolean', 'indicator', false, false],
    'operation.lastResult': ['string', 'text', '', false],
    'operation.lastError': ['string', 'text', '', false],
    'operation.lastErrorCode': ['string', 'text', '', false],
    'operation.lastUpdated': ['string', 'date', '', false],
};

function isIsoTimestamp(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

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
            this.targetSettings = { ...DEFAULT_TARGET_SETTINGS };
            this.settingsStoredValues = {};
            this.settingsPreferenceReady = Object.fromEntries(SETTINGS_KEYS.map(key => [key, false]));
            this.settingsUpdateFailed = Object.fromEntries(SETTINGS_KEYS.map(key => [key, false]));
            this.settingsFieldErrors = {};
            this.settingsUpdates = Promise.resolve();
            this.targetCharging = { ...DEFAULT_TARGET_CHARGING };
            this.chargingStoredValues = {};
            this.chargingPreferenceReady = Object.fromEntries(CHARGING_KEYS.map(key => [key, false]));
            this.chargingUpdateFailed = Object.fromEntries(CHARGING_KEYS.map(key => [key, false]));
            this.chargingFieldErrors = {};
            this.chargingUpdates = Promise.resolve();
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
                    if (id === 'commands.applySettings') common.name = 'Klimaeinstellungen übernehmen';
                    if (id === 'commands.clearSettings') common.name = 'Zusätzliche App-Einstellungen beibehalten';
                    if (['climate.targetMode', 'climate.mode'].includes(id)) common.states = { climate: 'Klimatisierung', windowHeating: 'Scheibenheizung' };
                    if (['climate.targetZones', 'climate.zones'].includes(id)) common.states = { frontLeft: 'Vorne links', frontRight: 'Vorne rechts', both: 'Beide vorderen Zonen' };
                    if (id === 'climate.zones') common.states.none = 'Keine vordere Zone';
                    if (['battery.soc', 'charging.socLimit', 'charging.targetSoc'].includes(id)) {
                        common.unit = '%'; common.min = id === 'charging.targetSoc' ? MIN_TARGET_SOC : 0;
                        common.max = id === 'charging.targetSoc' ? MAX_TARGET_SOC : 100;
                        if (id === 'charging.targetSoc') common.step = TARGET_SOC_STEP;
                    }
                    if (id === 'battery.rangeKm') { common.unit = 'km'; common.min = 0; }
                    if (id === 'charging.targetSoc') common.name = 'Gewünschte Ladegrenze';
                    if (id === 'commands.refreshCharging') common.name = 'Batterie und Ladeeinstellungen lesen';
                    if (id === 'commands.synchronize') common.name = 'Synchronisation mit dem Fahrzeug in der App anfordern';
                    if (id === 'battery.lastSyncRequestAt') common.name = 'Letzte an die App gesendete Synchronisationsanfrage';
                    if (id === 'commands.applyChargingSettings') common.name = 'Ladeeinstellungen übernehmen';
                    if (id === 'commands.clearChargingSettings') common.name = 'App-Ladeeinstellungen beibehalten';
                    await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
                    if (id === 'battery.lastSyncRequestAt') {
                        const previous = await this.getStateAsync(id);
                        await this.state(id, isIsoTimestamp(previous?.val) ? previous.val : '');
                        continue;
                    }
                    if (id === 'climate.targetTemperature' || Object.values(TARGET_SETTING_STATES).includes(id)
                        || Object.values(TARGET_CHARGING_STATES).includes(id)) continue;
                    await this.state(id, id === 'climate.temperature' || Object.values(OBSERVED_SETTING_STATES).includes(id)
                        || ['battery.soc', 'battery.rangeKm'].includes(id) || Object.values(OBSERVED_CHARGING_STATES).includes(id)
                        ? { val: null, ack: true, q: 0x82 } : initial);
                }
                let preferenceError;
                try { await this.restoreTemperaturePreference(); } catch (error) { preferenceError = error; }
                try { await this.restoreSettingsPreference(); } catch (error) { preferenceError ||= error; }
                try { await this.restoreChargingPreference(); } catch (error) { preferenceError ||= error; }
                await this.subscribeStatesAsync('commands.*');
                await this.subscribeStatesAsync('climate.targetTemperature');
                for (const id of Object.values(TARGET_SETTING_STATES)) await this.subscribeStatesAsync(id);
                for (const id of Object.values(TARGET_CHARGING_STATES)) await this.subscribeStatesAsync(id);
                if (this.settings.legacyStatePrefix) for (const name of ['start', 'stop', 'refresh']) await this.subscribeForeignStatesAsync(this.settings.legacyStatePrefix + '.' + name);
                await this.ensureRuntime();
                if (preferenceError) throw preferenceError;
                await this.state('info.status', 'ready_for_setup');
                if (this.settings.pollIntervalSeconds) {
                    this.pollTimer = this.setInterval(async () => {
                        if (this.busy || this.stopping) return;
                        await this.command('status').catch(() => {});
                        if (!this.busy && !this.stopping) await this.command('chargingStatus').catch(() => {});
                    }, this.settings.pollIntervalSeconds * 1000);
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
        async publishSettingSelection(key) {
            await this.state(TARGET_SETTING_STATES[key], this.settingsPreferenceReady[key]
                ? this.targetSettings[key] : { val: null, ack: true, q: 0x82 });
        }
        async publishSettingsError() {
            await this.state('climate.targetSettingsError', SETTINGS_KEYS
                .filter(key => this.settingsFieldErrors[key])
                .map(key => key + ': ' + this.settingsFieldErrors[key]).join('; '));
        }
        async restoreSettingsPreference() {
            let saved;
            try { saved = await this.store.read('settings-preference', { ...DEFAULT_TARGET_SETTINGS }); }
            catch (_) { saved = {}; }
            if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
            this.settingsStoredValues = Object.fromEntries(SETTINGS_KEYS
                .filter(key => Object.prototype.hasOwnProperty.call(saved, key))
                .map(key => [key, typeof saved[key] === 'number' && !Number.isFinite(saved[key])
                    ? '__invalid_saved_setting__' : saved[key]]));
            for (const key of SETTINGS_KEYS) {
                try {
                    this.targetSettings[key] = validateSetting(key, saved[key]);
                    this.settingsPreferenceReady[key] = true;
                    this.settingsUpdateFailed[key] = false;
                    delete this.settingsFieldErrors[key];
                } catch (_) {
                    this.targetSettings[key] = null;
                    this.settingsPreferenceReady[key] = false;
                    this.settingsUpdateFailed[key] = true;
                    this.settingsFieldErrors[key] = 'invalid_state: The saved value is invalid. Select this setting again or clear all desired settings.';
                }
                await this.publishSettingSelection(key);
            }
            await this.publishSettingsError();
            if (SETTINGS_KEYS.some(key => !this.settingsPreferenceReady[key])) {
                throw new BridgeError('invalid_state', 'Saved climate settings are incomplete or invalid. Select the affected settings again or keep the app settings.');
            }
        }
        stageSetting(key, value) {
            if (!SETTINGS_KEYS.includes(key)) return Promise.reject(new BridgeError('invalid_settings', 'Unknown climate setting.'));
            return this.stageSettingsPatch({ [key]: value });
        }
        clearSettings() { return this.stageSettingsPatch({ ...DEFAULT_TARGET_SETTINGS }); }
        stageSettingsPatch(patch) {
            const keys = Object.keys(patch);
            const update = this.settingsUpdates.then(async () => {
                try {
                    const validated = Object.fromEntries(keys.map(key => [key, validateSetting(key, patch[key])]));
                    const stored = { ...this.settingsStoredValues, ...validated };
                    await this.store.write('settings-preference', stored);
                    this.settingsStoredValues = stored;
                    for (const key of keys) {
                        this.targetSettings[key] = validated[key];
                        this.settingsPreferenceReady[key] = true;
                        this.settingsUpdateFailed[key] = false;
                        delete this.settingsFieldErrors[key];
                        await this.publishSettingSelection(key);
                    }
                    await this.publishSettingsError();
                } catch (error) {
                    const safe = publicError(error);
                    for (const key of keys) {
                        this.settingsUpdateFailed[key] = true;
                        this.settingsFieldErrors[key] = safe.code + ': ' + safe.message;
                        await this.publishSettingSelection(key);
                    }
                    await this.publishSettingsError();
                    this.log.warn(safe.code + ': ' + safe.message);
                    throw error;
                }
            });
            this.settingsUpdates = update.catch(() => {});
            return update;
        }
        async publishChargingSelection(key) {
            await this.state(TARGET_CHARGING_STATES[key], this.chargingPreferenceReady[key]
                ? this.targetCharging[key] : { val: null, ack: true, q: 0x82 });
        }
        async publishChargingError() {
            await this.state('charging.targetSettingsError', CHARGING_KEYS
                .filter(key => this.chargingFieldErrors[key])
                .map(key => key + ': ' + this.chargingFieldErrors[key]).join('; '));
        }
        async restoreChargingPreference() {
            let saved;
            try { saved = await this.store.read('charging-preference', { ...DEFAULT_TARGET_CHARGING }); }
            catch (_) { saved = {}; }
            if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
            this.chargingStoredValues = Object.fromEntries(CHARGING_KEYS
                .filter(key => Object.prototype.hasOwnProperty.call(saved, key))
                .map(key => [key, typeof saved[key] === 'number' && !Number.isFinite(saved[key])
                    ? '__invalid_saved_setting__' : saved[key]]));
            for (const key of CHARGING_KEYS) {
                try {
                    this.targetCharging[key] = validateChargingSetting(key, saved[key]);
                    this.chargingPreferenceReady[key] = true;
                    this.chargingUpdateFailed[key] = false;
                    delete this.chargingFieldErrors[key];
                } catch (_) {
                    this.targetCharging[key] = null;
                    this.chargingPreferenceReady[key] = false;
                    this.chargingUpdateFailed[key] = true;
                    this.chargingFieldErrors[key] = 'invalid_state: The saved value is invalid. Select this charging setting again or clear all desired charging settings.';
                }
                await this.publishChargingSelection(key);
            }
            await this.publishChargingError();
            if (CHARGING_KEYS.some(key => !this.chargingPreferenceReady[key])) {
                throw new BridgeError('invalid_state', 'Saved charging settings are incomplete or invalid. Select the affected settings again or keep the app settings.');
            }
        }
        stageChargingSetting(key, value) {
            if (!CHARGING_KEYS.includes(key)) return Promise.reject(new BridgeError('invalid_charging_settings', 'Unknown charging setting.'));
            return this.stageChargingPatch({ [key]: value });
        }
        clearChargingSettings() { return this.stageChargingPatch({ ...DEFAULT_TARGET_CHARGING }); }
        stageChargingPatch(patch) {
            const keys = Object.keys(patch);
            const update = this.chargingUpdates.then(async () => {
                try {
                    const validated = Object.fromEntries(keys.map(key => [key, validateChargingSetting(key, patch[key])]));
                    const stored = { ...this.chargingStoredValues, ...validated };
                    await this.store.write('charging-preference', stored);
                    this.chargingStoredValues = stored;
                    for (const key of keys) {
                        this.targetCharging[key] = validated[key];
                        this.chargingPreferenceReady[key] = true;
                        this.chargingUpdateFailed[key] = false;
                        delete this.chargingFieldErrors[key];
                        await this.publishChargingSelection(key);
                    }
                    await this.publishChargingError();
                } catch (error) {
                    const safe = publicError(error);
                    for (const key of keys) {
                        this.chargingUpdateFailed[key] = true;
                        this.chargingFieldErrors[key] = safe.code + ': ' + safe.message;
                        await this.publishChargingSelection(key);
                    }
                    await this.publishChargingError();
                    this.log.warn(safe.code + ': ' + safe.message);
                    throw error;
                }
            });
            this.chargingUpdates = update.catch(() => {});
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
        async exclusive(label, operation, domain = 'climate') {
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
                } catch (error) { await this.failure(error, domain); throw error; }
                finally {
                    this.controller = null; this.busy = false;
                    await this.feedback('busy', false);
                }
            };
            this.currentOperation = execute();
            try { return await this.currentOperation; }
            finally { this.currentOperation = null; }
        }
        async failure(error, domain = 'climate') {
            const safe = publicError(error);
            await this.state('info.connection', false);
            await this.state('info.status', safe.code);
            await this.state('operation.lastErrorCode', safe.code);
            await this.feedback('lastError', safe.code + ': ' + safe.message);
            await this.feedback('lastResult', 'failed');
            if (domain === 'charging') {
                for (const id of ['battery.soc', 'battery.rangeKm', ...Object.values(OBSERVED_CHARGING_STATES)]) {
                    await this.state(id, { val: null, ack: true, q: 0x82 });
                }
                await this.state('battery.observedAt', '');
                this.log.warn(safe.code + ': ' + safe.message);
                return;
            }
            await this.feedback('appState', 'unknown');
            await this.state('climate.confirmationSource', 'none');
            await this.state('climate.temperature', { val: null, ack: true, q: 0x82 });
            for (const id of Object.values(OBSERVED_SETTING_STATES)) await this.state(id, { val: null, ack: true, q: 0x82 });
            await this.state('climate.active', { val: false, ack: true, q: 0x82 });
            await this.feedback('lastUpdated', '');
            this.log.warn(safe.code + ': ' + safe.message);
        }
        async observation(result) {
            if (result.domain === 'charging') return this.chargingObservation(result);
            await this.state('info.connection', true);
            await this.state('info.appVersion', result.appVersion);
            await this.feedback('appState', result.appState);
            await this.state('climate.confirmationSource', result.confirmationSource || 'app_controls');
            await this.state('climate.active', result.appState === 'on');
            await this.state('climate.vehicleConfirmed', false);
            await this.state('climate.temperature', isTemperature(result.temperature)
                ? { val: result.temperature, ack: true }
                : { val: null, ack: true, q: 0x82 });
            for (const key of SETTINGS_KEYS) {
                const value = result.settings?.[key];
                await this.state(OBSERVED_SETTING_STATES[key], value !== null && isObservedSettingValue(key, value)
                    ? { val: value, ack: true } : { val: null, ack: true, q: 0x82 });
            }
            await this.feedback('lastUpdated', result.observedAt);
        }
        async chargingObservation(result) {
            await this.state('info.connection', true);
            await this.state('info.appVersion', typeof result.appVersion === 'string' ? result.appVersion : '');
            const soc = result.battery?.soc;
            const range = result.battery?.rangeKm;
            await this.state('battery.soc', isBatterySoc(soc) ? { val: soc, ack: true } : { val: null, ack: true, q: 0x82 });
            await this.state('battery.rangeKm', isRangeKm(range) ? { val: range, ack: true } : { val: null, ack: true, q: 0x82 });
            for (const key of CHARGING_KEYS) {
                const value = result.charging?.[key];
                await this.state(OBSERVED_CHARGING_STATES[key], value !== null && isObservedChargingValue(key, value)
                    ? { val: value, ack: true } : { val: null, ack: true, q: 0x82 });
            }
            const observedAt = typeof result.observedAt === 'string' && Number.isFinite(Date.parse(result.observedAt))
                ? result.observedAt : '';
            await this.state('battery.observedAt', isBatterySoc(soc) || isRangeKm(range) ? observedAt : '');
            if (isIsoTimestamp(result.syncRequestedAt)) await this.state('battery.lastSyncRequestAt', result.syncRequestedAt);
        }
        async command(action) {
            const chargingAction = ['chargingStatus', 'applyChargingSettings', 'synchronize'].includes(action);
            // Register the snapshot now, before a later staged selection can
            // change the target of an already accepted phone operation.
            const selectedTarget = ['start', 'setTemperature'].includes(action) ? this.temperatureUpdates.then(() => ({
                value: this.targetTemperature, ready: this.temperaturePreferenceReady, failed: this.temperatureUpdateFailed,
            })) : Promise.resolve({ value: null, ready: true, failed: false });
            const selectedSettings = ['start', 'applySettings'].includes(action) ? this.settingsUpdates.then(() => ({
                values: { ...this.targetSettings }, ready: { ...this.settingsPreferenceReady }, failed: { ...this.settingsUpdateFailed },
            })) : Promise.resolve({ values: { ...DEFAULT_TARGET_SETTINGS }, ready: {}, failed: {} });
            const selectedCharging = action === 'applyChargingSettings' ? this.chargingUpdates.then(() => ({
                values: { ...this.targetCharging }, ready: { ...this.chargingPreferenceReady }, failed: { ...this.chargingUpdateFailed },
            })) : Promise.resolve({ values: { ...DEFAULT_TARGET_CHARGING }, ready: {}, failed: {} });
            return this.exclusive(action, async () => {
                const settingsSelection = await selectedSettings;
                const usesTemperature = action === 'setTemperature' || action === 'start' && settingsSelection.values.mode !== 'windowHeating';
                const selection = usesTemperature ? await selectedTarget : { value: null, ready: true, failed: false };
                if (['start', 'applySettings'].includes(action)) {
                    if (SETTINGS_KEYS.some(key => !settingsSelection.ready[key])) {
                        throw new BridgeError('invalid_state', 'Read or select valid saved climate settings before applying or starting.');
                    }
                    if (SETTINGS_KEYS.some(key => settingsSelection.failed[key])) {
                        throw new BridgeError('settings_selection_failed', 'A climate selection failed. Select the affected setting again or keep the app settings.');
                    }
                }
                if (usesTemperature && !selection.ready) {
                    throw new BridgeError('invalid_state', 'Read or select a valid saved target temperature before changing the app settings.');
                }
                if (usesTemperature && selection.failed) {
                    throw new BridgeError('temperature_selection_failed', 'The last temperature selection failed. Select a valid value again or choose Keep the app temperature before starting or applying it.');
                }
                if (action === 'setTemperature') {
                    if (selection.value === null) throw new BridgeError('invalid_temperature', 'Select a target temperature before applying it.');
                    if (!this.settings.allowWrites) throw new BridgeError('writes_disabled', 'Changing the app temperature is disabled. Check and enable the write permission first.');
                }
                if (action === 'applySettings') {
                    if (Object.values(settingsSelection.values).every(value => value === null)) {
                        throw new BridgeError('settings_required', 'Select at least one desired climate setting before applying it.');
                    }
                    if (!this.settings.allowWrites) throw new BridgeError('writes_disabled', 'Changing climate settings is disabled. Check and enable the write permission first.');
                }
                const chargingSelection = await selectedCharging;
                if (action === 'applyChargingSettings') {
                    if (CHARGING_KEYS.some(key => !chargingSelection.ready[key])) {
                        throw new BridgeError('invalid_state', 'Read or select valid saved charging settings before applying them.');
                    }
                    if (CHARGING_KEYS.some(key => chargingSelection.failed[key])) {
                        throw new BridgeError('charging_selection_failed', 'A charging selection failed. Select the affected setting again or keep the app settings.');
                    }
                    if (Object.values(chargingSelection.values).every(value => value === null)) {
                        throw new BridgeError('charging_settings_required', 'Select at least one desired charging setting before applying it.');
                    }
                    if (!this.settings.allowWrites) throw new BridgeError('writes_disabled', 'Changing charging settings is disabled. Check and enable the write permission first.');
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
                const targetTemperature = usesTemperature ? selection.value : null;
                const options = chargingAction ? { targetCharging: chargingSelection.values } : { targetTemperature };
                if (['start', 'applySettings'].includes(action)) options.targetSettings = settingsSelection.values;
                const result = await this.controller.execute(action, options);
                if (chargingAction && result?.domain !== 'charging') throw new BridgeError('invalid_state', 'The charging observation is invalid. Refresh the charging page again.');
                await this.observation(result);
                return result;
            }, chargingAction ? 'charging' : 'climate');
        }
        async onStateChange(id, state) {
            if (!state || state.ack !== false || this.stopping) return;
            if (id === this.namespace + '.climate.targetTemperature') {
                await this.stageTemperature(state.val).catch(() => {});
                return;
            }
            const setting = SETTINGS_KEYS.find(key => id === this.namespace + '.' + TARGET_SETTING_STATES[key]);
            if (setting) { await this.stageSetting(setting, state.val).catch(() => {}); return; }
            const charging = CHARGING_KEYS.find(key => id === this.namespace + '.' + TARGET_CHARGING_STATES[key]);
            if (charging) { await this.stageChargingSetting(charging, state.val).catch(() => {}); return; }
            if (state.val !== true) return;
            const own = this.namespace + '.commands.';
            const legacy = this.settings?.legacyStatePrefix && this.settings.legacyStatePrefix + '.';
            const name = id.startsWith(own) ? id.slice(own.length) : legacy && id.startsWith(legacy) ? id.slice(legacy.length) : '';
            if (!['start', 'stop', 'refresh', 'setTemperature', 'clearTemperature', 'applySettings', 'clearSettings',
                'refreshCharging', 'applyChargingSettings', 'clearChargingSettings', 'synchronize'].includes(name)
                || !['start', 'stop', 'refresh'].includes(name) && !id.startsWith(own)) return;
            if (id.startsWith(own)) await this.state('commands.' + name, false);
            else await this.legacy(name, false);
            if (name === 'clearTemperature') { await this.stageTemperature(null).catch(() => {}); return; }
            if (name === 'clearSettings') { await this.clearSettings().catch(() => {}); return; }
            if (name === 'clearChargingSettings') { await this.clearChargingSettings().catch(() => {}); return; }
            await this.command(name === 'refresh' ? 'status' : name === 'refreshCharging' ? 'chargingStatus' : name).catch(() => {});
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
                        Promise.allSettled([this.currentOperation, this.temperatureUpdates, this.settingsUpdates, this.chargingUpdates]),
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
