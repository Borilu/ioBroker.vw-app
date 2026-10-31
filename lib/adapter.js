'use strict';
// The bounded unload fallback must survive adapter timer cleanup; it is cleared in finally.
const nodeTimers = require('node:timers');
const fs = require('node:fs/promises');
const { BridgeError, publicError } = require('./errors');
const { normalizeConfig, endpoint, integer, validateHost, validateSecurityPin } = require('./config');
const { StateStore } = require('./store');
const { DeviceLease } = require('./lease');
const { AdbRuntime } = require('./runtime');
const { Phone } = require('./phone');
const { discoverGuardianPort } = require('./guardian-port');
const { resolveVmIp } = require('./guardian-pair-utils');
const { prepareHost, transferAndVerify, approveRecovery, pairingStatus, testTransport, APPROVED_APK_SHA256 } = require('./guardian-binder-pair');
const { grantGuardianPermission } = require('./guardian-permission');
const { Screen } = require('./ui');
const { Controller } = require('./controller');
const { MIN_TEMPERATURE_CELSIUS, MAX_TEMPERATURE_CELSIUS, TEMPERATURE_STEP_CELSIUS,
    isTemperature, validateTargetTemperature } = require('./temperature');
const { SETTINGS_KEYS, DEFAULT_TARGET_SETTINGS, isObservedSettingValue, validateSetting } = require('./settings');
const { CHARGING_KEYS, DEFAULT_TARGET_CHARGING, MIN_TARGET_SOC, MAX_TARGET_SOC, TARGET_SOC_STEP,
    validateChargingSetting, isObservedChargingValue, isBatterySoc, isRangeKm,
    isChargingMode, validateTargetChargingMode } = require('./charging');
const { REPORT_CATEGORIES, validateVehicleReport } = require('./vehicle-report');
const { validateVehicleAccess } = require('./vehicle-access');
const { validateVehicleInfo, isVin } = require('./vehicle-info');
const { readSecurityAuth, clearSecurityAuth, fixedSecurityError, sanitizeSecurityError, securityErrorDiagnostic } = require('./security-auth');
const { RefreshScheduler, DOMAINS } = require('./refresh-scheduler');
const { DeparturesAdapter, READ_ACTIONS: DEPARTURE_READ_ACTIONS, WRITE_ACTIONS: DEPARTURE_WRITE_ACTIONS,
    isDepartureButton } = require('./departures-adapter');

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
const ACCESS_POSITIONS = Object.freeze({ frontLeft: 'vorne links', frontRight: 'vorne rechts',
    rearLeft: 'hinten links', rearRight: 'hinten rechts' });
const VEHICLE_ACCESS_BOOLEAN_STATES = Object.freeze([
    ...['doors', 'windows'].flatMap(group => Object.keys(ACCESS_POSITIONS).map(position =>
        'vehicleAccess.' + group + '.' + position + 'Open')),
    'vehicleAccess.trunkOpen', 'vehicleAccess.locked',
]);
const LOCK_ACTIONS = Object.freeze(['lockVehicle', 'unlockVehicle']);

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
    'commands.applyChargingMode': ['boolean', 'button', false, true],
    'commands.clearChargingMode': ['boolean', 'button', false, true],
    'commands.refreshVehicleReport': ['boolean', 'button', false, true],
    'commands.refreshVehicleAccess': ['boolean', 'button', false, true],
    'commands.refreshVehicleInfo': ['boolean', 'button', false, true],
    'commands.lockVehicle': ['boolean', 'button', false, true],
    'commands.unlockVehicle': ['boolean', 'button', false, true],
    'security.blocked': ['boolean', 'indicator', true, false],
    'security.reason': ['string', 'text', 'security_auth_unavailable', false],
    ...Object.fromEntries(VEHICLE_ACCESS_BOOLEAN_STATES.map(id => [id, ['boolean',
        id === 'vehicleAccess.locked' ? 'sensor' : id.startsWith('vehicleAccess.windows.') ? 'sensor.window' : 'sensor.door', null, false]])),
    'vehicleAccess.synchronizationText': ['string', 'text', '', false],
    'vehicleAccess.warningText': ['string', 'text', '', false],
    'vehicleAccess.observedAt': ['string', 'date', '', false],
    'vehicleInfo.vin': ['string', 'text', '', false],
    'vehicleInfo.observedAt': ['string', 'date', '', false],
    'vehicleReport.odometerText': ['string', 'text', '', false],
    'vehicleReport.odometerKm': ['number', 'value.distance', null, false],
    'vehicleReport.nextServiceText': ['string', 'text', '', false],
    'vehicleReport.nextServiceDays': ['number', 'value', null, false],
    'vehicleReport.nextServiceKm': ['number', 'value.distance', null, false],
    'vehicleReport.summary': ['string', 'text', '', false],
    'vehicleReport.hasMessages': ['boolean', 'indicator', null, false],
    'vehicleReport.messageCount': ['number', 'value', null, false],
    'vehicleReport.synchronizationText': ['string', 'text', '', false],
    'vehicleReport.notice': ['string', 'text', '', false],
    'vehicleReport.additionalTexts': ['string', 'json', '[]', false],
    'vehicleReport.json': ['string', 'json', '', false],
    'vehicleReport.observedAt': ['string', 'date', '', false],
    ...Object.fromEntries(Object.keys(REPORT_CATEGORIES).flatMap(category => [
        ['vehicleReport.' + category + '.status', ['string', 'text', 'unknown', false]],
        ['vehicleReport.' + category + '.texts', ['string', 'json', '[]', false]],
    ])),
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
    'charging.mode': ['string', 'text', null, false],
    'charging.modeObservedAt': ['string', 'date', '', false],
    'charging.targetMode': ['string', 'text', null, true],
    'charging.targetModeError': ['string', 'text', '', false],
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
    'climate.active': ['boolean', 'indicator', null, false],
    'climate.vehicleConfirmed': ['boolean', 'indicator', false, false],
    'operation.busy': ['boolean', 'indicator', false, false],
    'operation.lastResult': ['string', 'text', '', false],
    'operation.lastError': ['string', 'text', '', false],
    'operation.lastErrorCode': ['string', 'text', '', false],
    'operation.lastUpdated': ['string', 'date', '', false],
    'refresh.autoBusy': ['boolean', 'indicator', false, false],
    ...Object.fromEntries(DOMAINS.flatMap(domain => [
        ['refresh.' + domain + '.status', ['string', 'text', 'unknown', false]],
        ['refresh.' + domain + '.lastReadAt', ['string', 'date', '', false]],
        ['refresh.' + domain + '.ageSeconds', ['number', 'value', null, false]],
        ['refresh.' + domain + '.lastErrorCode', ['string', 'text', '', false]],
        ['refresh.' + domain + '.lastDurationSeconds', ['number', 'value', 0, false]],
        ['refresh.' + domain + '.maxAgeSeconds', ['number', 'value', 0, false]],
    ])),
};
const VEHICLE_REPORT_STATES = Object.keys(DEFINITIONS).filter(id => id.startsWith('vehicleReport.'));
const DOMAIN_STATES = {
    climate: ['climate.appState', 'climate.confirmationSource', 'climate.temperature', 'climate.active',
        'climate.vehicleConfirmed', ...Object.values(OBSERVED_SETTING_STATES)],
    charging: ['battery.soc', 'battery.rangeKm', ...Object.values(OBSERVED_CHARGING_STATES), 'charging.mode'],
    vehicleReport: VEHICLE_REPORT_STATES.filter(id => id !== 'vehicleReport.observedAt'),
    vehicleAccess: Object.keys(DEFINITIONS).filter(id => id.startsWith('vehicleAccess.') && id !== 'vehicleAccess.observedAt'),
    vehicleInfo: ['vehicleInfo.vin'],
};
const READ_ACTIONS = { climate: 'status', charging: 'chargingStatus', vehicleReport: 'vehicleReportStatus',
    vehicleAccess: 'refreshVehicleAccess', vehicleInfo: 'refreshVehicleInfo' };

function isIsoTimestamp(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function historicalStateValue(previous, type, initial) {
    if (!previous || previous.ack !== true) return initial;
    const value = previous.val;
    if (value === null || typeof value === type && (type !== 'number' || Number.isFinite(value))) return value;
    return initial;
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
    const GuardianQuery = dependencies.GuardianQuery || discoverGuardianPort;
    const GuardianVmRoute = dependencies.GuardianVmRoute || resolveVmIp;
    const GuardianBinderTest = dependencies.GuardianBinderTest || testTransport;
    const GuardianPermissionGrant = dependencies.GuardianPermissionGrant || grantGuardianPermission;
    const ControllerClass = dependencies.Controller || Controller;
    const SchedulerClass = dependencies.RefreshScheduler || RefreshScheduler;
    return class VwApp extends utils.Adapter {
        constructor(options = {}) {
            super({ ...options, name: 'vw-app' });
            this.stopping = false; this.busy = false; this.currentOperation = null;
            this.abortController = new AbortController();
            this.now = dependencies.now || (() => Date.now());
            this.cachedStates = new Map();
            this.pendingManual = false; this.autoJob = null;
            this.runtimePhoneBlocked = false;
            // Volatile maintenance state never authorizes app navigation after a restart.
            this.maintenanceState = 'idle'; this.maintenanceGeneration = 0;
            this.lastPhoneOperationOutcome = 'unknown';
            this.stateDefinitions = { ...DEFINITIONS };
            this.domainStates = Object.fromEntries(Object.entries(DOMAIN_STATES).map(([domain, states]) => [domain, [...states]]));
            this.readActions = { ...READ_ACTIONS };
            this.activeReadDomains = [...DOMAINS];
            this.readDomainDefinitions = new Map();
            this.completedReadDomains = new Set(DOMAINS);
            this.domainPublications = Object.fromEntries(DOMAINS.map(domain => [domain, Promise.resolve()]));
            this.readFreshness = Object.fromEntries(DOMAINS.map(domain => [domain,
                { status: 'unknown', lastReadAt: '', lastErrorCode: '', lastDurationSeconds: 0 }]));
            this.schedulerSnapshot = { estimatedCycleMs: DOMAINS.length * 37500 };
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
            this.targetChargingMode = null;
            this.chargingModePreferenceReady = false;
            this.chargingModeUpdateFailed = false;
            this.chargingModeUpdates = Promise.resolve();
            this.departures = new DeparturesAdapter(this);
            this.on('ready', () => this.onReady());
            this.on('stateChange', (id, state) => this.onStateChange(id, state));
            this.on('message', obj => this.onMessage(obj));
            this.on('unload', callback => this.onUnload(callback));
        }
        async state(id, value) {
            if (!this.stopping) {
                const wrapped = value && typeof value === 'object' && 'val' in value ? value : { val: value, ack: true };
                await this.setStateAsync(id, wrapped);
                this.cachedStates.set(id, { ...wrapped });
            }
        }
        async legacy(name, value) {
            if (!this.stopping && this.settings?.legacyStatePrefix) {
                const id = this.settings.legacyStatePrefix + '.' + name;
                const object = await this.getForeignObjectAsync(id);
                if (object && !this.stopping) await this.setForeignStateAsync(id,
                    value && typeof value === 'object' && 'val' in value ? value : { val: value, ack: true });
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
                // A previous successful app read is historical evidence, not a
                // fresh observation after a restart. Keep its timestamp while
                // invalidating component values until a new read succeeds.
                for (const domain of DOMAINS) {
                    const previous = await this.getStateAsync('refresh.' + domain + '.lastReadAt');
                    if (previous?.ack === true && (previous.q ?? 0) === 0 && isIsoTimestamp(previous.val)) {
                        this.readFreshness[domain].lastReadAt = previous.val;
                        this.readFreshness[domain].status = 'stale';
                    }
                }
                for (const [id, [type, role, initial, write]] of Object.entries(DEFINITIONS)) {
                    const parent = id.split('.')[0];
                    await this.setObjectNotExistsAsync(parent, { type: 'channel', common: {
                        name: parent === 'vehicleReport' ? 'Fahrzeugzustandsbericht'
                            : parent === 'vehicleAccess' ? 'Türen, Fenster und Verriegelung'
                                : parent === 'vehicleInfo' ? 'Fahrzeugidentifikation'
                                : parent === 'security' ? 'Lokale Sicherheitssperre' : parent }, native: {} });
                    const common = { name: id, type, role, read: role !== 'button', write };
                    if (parent === 'refresh' && id !== 'refresh.autoBusy') {
                        const domain = id.split('.')[1];
                        await this.setObjectNotExistsAsync('refresh.' + domain, { type: 'channel', common: { name:
                            { climate: 'Klima', charging: 'Batterie und Laden', vehicleReport: 'Fahrzeugzustandsbericht',
                                vehicleAccess: 'Türen, Fenster und Verriegelung', vehicleInfo: 'Fahrzeugidentifikation' }[domain] }, native: {} });
                        if (id.endsWith('.status')) common.states = { unknown: 'Noch nicht gelesen', fresh: 'Aktuell aus der App gelesen', stale: 'App-Auslesezeit überschritten', error: 'Lesefehler' };
                        if (/\.(ageSeconds|lastDurationSeconds|maxAgeSeconds)$/.test(id)) { common.unit = 's'; common.min = 0; }
                    }
                    if (parent === 'vehicleReport') {
                        const category = id.split('.')[1];
                        if (Object.hasOwn(REPORT_CATEGORIES, category)) {
                            await this.setObjectNotExistsAsync('vehicleReport.' + category, { type: 'channel',
                                common: { name: REPORT_CATEGORIES[category] }, native: {} });
                            if (id.endsWith('.status')) common.states = { no_messages: 'Keine Meldungen laut App', unknown: 'Unbekannt' };
                        }
                        if (['vehicleReport.odometerKm', 'vehicleReport.nextServiceKm'].includes(id)) common.unit = 'km';
                        if (id === 'vehicleReport.nextServiceDays') common.unit = 'd';
                        if (id === 'vehicleReport.odometerKm' || id === 'vehicleReport.messageCount') common.min = 0;
                        if (id === 'vehicleReport.observedAt') common.name = 'Fahrzeugzustandsbericht aus der App gelesen am';
                    }
                    if (parent === 'vehicleAccess') {
                        const group = id.split('.')[1];
                        if (['doors', 'windows'].includes(group)) {
                            await this.setObjectNotExistsAsync('vehicleAccess.' + group, { type: 'channel',
                                common: { name: group === 'doors' ? 'Türen' : 'Fenster' }, native: {} });
                            const position = id.split('.')[2].replace(/Open$/, '');
                            common.name = (group === 'doors' ? 'Tür ' : 'Fenster ') + ACCESS_POSITIONS[position] + ' offen laut App';
                        }
                        if (id === 'vehicleAccess.trunkOpen') common.name = 'Kofferraum offen laut App';
                        if (id === 'vehicleAccess.locked') common.name = 'Fahrzeug verriegelt laut App';
                        if (id === 'vehicleAccess.warningText') common.name = 'Hinweis zu offenen Komponenten aus der App';
                        if (id === 'vehicleAccess.synchronizationText') common.name = 'Synchronisationshinweis der App';
                        if (id === 'vehicleAccess.observedAt') common.name = 'Türen und Fenster aus der App gelesen am';
                    }
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
                    if (id === 'commands.refreshVehicleReport') common.name = 'Fahrzeugzustandsbericht lesen';
                    if (id === 'commands.refreshVehicleAccess') common.name = 'Türen, Fenster und Verriegelung lesen';
                    if (id === 'commands.refreshVehicleInfo') common.name = 'FIN aus der Fahrzeugverwaltung lesen';
                    if (id === 'vehicleInfo.vin') common.name = 'FIN (Fahrzeug-Identifizierungsnummer) laut App';
                    if (id === 'vehicleInfo.observedAt') common.name = 'FIN aus der App gelesen am';
                    if (id === 'commands.lockVehicle') common.name = 'Fahrzeug ausdrücklich verriegeln';
                    if (id === 'commands.unlockVehicle') common.name = 'Fahrzeug ausdrücklich entriegeln';
                    if (id === 'security.blocked') common.name = 'S-PIN-Übermittlung durch Sicherheitssperre blockiert';
                    if (id === 'security.reason') common.name = 'Grund der lokalen Sicherheitssperre';
                    if (id === 'commands.synchronize') common.name = 'Synchronisation mit dem Fahrzeug in der App anfordern';
                    if (id === 'battery.lastSyncRequestAt') common.name = 'Letzte an die App gesendete Synchronisationsanfrage';
                    if (id === 'commands.applyChargingSettings') common.name = 'Ladeeinstellungen übernehmen';
                    if (id === 'commands.clearChargingSettings') common.name = 'App-Ladeeinstellungen beibehalten';
                    if (['charging.mode', 'charging.targetMode'].includes(id)) common.states = {
                        immediate: 'Sofortladen', departure: 'Laden zur Abfahrtszeit', departureClimate: 'Laden und Klima zur Abfahrtszeit',
                    };
                    if (id === 'charging.mode') common.name = 'Lademodus laut App';
                    if (id === 'charging.modeObservedAt') common.name = 'Lademodus erfolgreich aus der App gelesen am';
                    if (id === 'charging.targetMode') common.name = 'Gewünschter Lademodus für ausdrückliches Übernehmen';
                    if (id === 'charging.targetModeError') common.name = 'Auswahlfehler beim gewünschten Lademodus';
                    if (id === 'commands.applyChargingMode') common.name = 'Lademodus übernehmen; kann Laden auslösen';
                    if (id === 'commands.clearChargingMode') common.name = 'App-Lademodus beibehalten';
                    await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
                    if (parent === 'refresh' && id !== 'refresh.autoBusy') {
                        const [, domain, key] = id.split('.');
                        if (key === 'lastReadAt' || key === 'status') {
                            await this.state(id, this.readFreshness[domain][key]);
                            continue;
                        }
                    }
                    if (id === 'charging.mode' || id === 'charging.modeObservedAt') {
                        const previous = await this.getStateAsync(id);
                        const timestamp = id === 'charging.modeObservedAt';
                        const keep = previous?.ack === true && (timestamp ? isIsoTimestamp(previous.val) : isChargingMode(previous.val));
                        await this.state(id, timestamp && keep && (previous.q ?? 0) === 0 ? { val: previous.val, ack: true }
                            : { val: keep ? previous.val : initial, ack: true, q: 0x82 });
                        continue;
                    }
                    if (parent === 'vehicleInfo') {
                        const previous = await this.getStateAsync(id);
                        const observedAt = id === 'vehicleInfo.observedAt';
                        const keep = previous?.ack === true && (observedAt ? isIsoTimestamp(previous.val) : isVin(previous.val));
                        const value = keep ? previous.val : initial;
                        // A previous FIN is history until this profile is read
                        // again. Failed reads never replace its success time.
                        await this.state(id, observedAt && keep && (previous.q ?? 0) === 0 && value === this.readFreshness.vehicleInfo.lastReadAt
                            ? { val: value, ack: true } : { val: value, ack: true, q: 0x82 });
                        continue;
                    }
                    if (parent === 'vehicleAccess') {
                        const previous = await this.getStateAsync(id);
                        const keep = previous?.ack === true && (initial === null ? previous.val === null || typeof previous.val === 'boolean'
                            : id === 'vehicleAccess.observedAt' ? isIsoTimestamp(previous?.val)
                                : typeof previous?.val === 'string' && previous.val.length <= (id.endsWith('.warningText') ? 4096 : 512));
                        const value = keep ? previous.val : initial;
                        // A known successful read time remains valid history;
                        // its age marks the component values stale separately.
                        await this.state(id, id === 'vehicleAccess.observedAt' && (previous?.q ?? 0) === 0 && isIsoTimestamp(value) && value === this.readFreshness.vehicleAccess.lastReadAt
                            ? { val: value, ack: true } : { val: value, ack: true, q: 0x82 });
                        continue;
                    }
                    if (parent === 'vehicleReport') {
                        const previous = await this.getStateAsync(id);
                        const value = historicalStateValue(previous, type, initial);
                        await this.state(id, id === 'vehicleReport.observedAt' && (previous?.q ?? 0) === 0 && isIsoTimestamp(value) && value === this.readFreshness.vehicleReport.lastReadAt
                            ? { val: value, ack: true } : { val: value, ack: true, q: 0x82 });
                        continue;
                    }
                    if (id === 'battery.lastSyncRequestAt') {
                        const previous = await this.getStateAsync(id);
                        await this.state(id, isIsoTimestamp(previous?.val) ? previous.val : '');
                        continue;
                    }
                    if (id === 'climate.targetTemperature' || id === 'charging.targetMode' || Object.values(TARGET_SETTING_STATES).includes(id)
                        || Object.values(TARGET_CHARGING_STATES).includes(id)) continue;
                    if (Object.values(DOMAIN_STATES).some(ids => ids.includes(id))) {
                        const previous = await this.getStateAsync(id);
                        await this.state(id, { val: id === 'climate.vehicleConfirmed' ? false : historicalStateValue(previous, type, initial), ack: true, q: 0x82 });
                    } else if (id === 'battery.observedAt' || id === 'operation.lastUpdated') {
                        const previous = await this.getStateAsync(id);
                        const value = previous?.ack === true && isIsoTimestamp(previous.val) ? previous.val : initial;
                        const domain = id === 'battery.observedAt' ? 'charging' : 'climate';
                        await this.state(id, value && (previous?.q ?? 0) === 0 && value === this.readFreshness[domain].lastReadAt
                            ? { val: value, ack: true } : { val: value, ack: true, q: 0x82 });
                    } else await this.state(id, initial);
                }
                await this.publishSecurityAuth();
                let preferenceError;
                try { await this.restoreTemperaturePreference(); } catch (error) { preferenceError = error; }
                try { await this.restoreSettingsPreference(); } catch (error) { preferenceError ||= error; }
                try { await this.restoreChargingPreference(); } catch (error) { preferenceError ||= error; }
                try { await this.restoreChargingModePreference(); } catch (error) { preferenceError ||= error; }
                await this.departures.init();
                await this.invalidateOrphanLocationHistory();
                await this.migrateObjectMetadata();
                this.syncReadDomains();
                await this.subscribeStatesAsync('commands.*');
                await this.subscribeStatesAsync('climate.targetTemperature');
                for (const id of Object.values(TARGET_SETTING_STATES)) await this.subscribeStatesAsync(id);
                for (const id of Object.values(TARGET_CHARGING_STATES)) await this.subscribeStatesAsync(id);
                await this.subscribeStatesAsync('charging.targetMode');
                if (this.settings.legacyStatePrefix) for (const name of ['start', 'stop', 'refresh']) await this.subscribeForeignStatesAsync(this.settings.legacyStatePrefix + '.' + name);
                if (this.settings.pollIntervalSeconds) {
                    this.scheduler = new SchedulerClass({ domains: [...this.activeReadDomains], run: domain => this.runAutomaticRead(domain),
                        canRun: () => !this.busy && !this.pendingManual && !this.stopping && !this.runtimePhoneBlocked && this.maintenanceState === 'idle',
                        intervalMs: this.settings.pollIntervalSeconds * 1000, gapMs: 5000, now: this.now,
                        setTimer: (fn, ms) => this.setTimeout(fn, ms), clearTimer: timer => this.clearTimeout(timer),
                        onUpdate: snapshot => { this.schedulerSnapshot = snapshot; return this.updateFreshness(); } });
                }
                await this.updateFreshness(); this.scheduleFreshnessCheck();
                await this.ensureRuntime();
                this.scheduler?.start();
                if (preferenceError) throw preferenceError;
                await this.state('info.status', 'ready_for_setup');
            } catch (error) { await this.failure(error, null); }
        }
        async migrateObjectMetadata() {
            // Read only our namespace definitions. Historical charging-location
            // objects may have no current binding, so the live groups alone are
            // insufficient. Narrow common patches preserve names, ACL and native.
            const prefix = this.namespace + '.';
            const objects = await this.getAdapterObjectsAsync();
            for (const [fullId, object] of Object.entries(objects)) {
                if (!fullId.startsWith(prefix) || object?.type !== 'state' || !object.common) continue;
                const id = fullId.slice(prefix.length), patch = {};
                const definition = DEFINITIONS[id];
                if ((definition?.[1] === 'button' || isDepartureButton(id))
                    && object.common.role === 'button' && object.common.read !== false) patch.read = false;
                if (VEHICLE_ACCESS_BOOLEAN_STATES.includes(id)
                    && object.common.role === (id === 'vehicleAccess.locked' ? 'indicator.locked' : 'indicator.open')) {
                    patch.role = definition[1];
                }
                if (Object.keys(patch).length) await this.extendObjectAsync(id, { common: patch });
            }
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
        async publishChargingModeSelection() {
            await this.state('charging.targetMode', this.chargingModePreferenceReady
                ? this.targetChargingMode : { val: null, ack: true, q: 0x82 });
        }
        async restoreChargingModePreference() {
            try {
                const saved = await this.store.read('charging-mode-preference', { mode: null });
                if (!saved || typeof saved !== 'object' || Array.isArray(saved)
                    || Object.keys(saved).length !== 1 || !Object.hasOwn(saved, 'mode')) throw new Error('Invalid mode preference');
                this.targetChargingMode = validateTargetChargingMode(saved.mode);
                this.chargingModePreferenceReady = true;
                this.chargingModeUpdateFailed = false;
                await this.publishChargingModeSelection();
                await this.state('charging.targetModeError', '');
            } catch (_) {
                this.targetChargingMode = null;
                this.chargingModePreferenceReady = false;
                this.chargingModeUpdateFailed = true;
                await this.publishChargingModeSelection();
                const error = new BridgeError('invalid_state', 'The saved charging mode is invalid. Select a supported charging mode again or clear the mode wish.');
                await this.state('charging.targetModeError', error.code + ': ' + error.message);
                throw error;
            }
        }
        stageChargingMode(value) {
            const update = this.chargingModeUpdates.then(async () => {
                let saving = false;
                try {
                    const mode = validateTargetChargingMode(value);
                    saving = true;
                    await this.store.write('charging-mode-preference', { mode });
                    this.targetChargingMode = mode;
                    this.chargingModePreferenceReady = true;
                    this.chargingModeUpdateFailed = false;
                    await this.publishChargingModeSelection();
                    await this.state('charging.targetModeError', '');
                } catch (_) {
                    this.chargingModeUpdateFailed = true;
                    await this.publishChargingModeSelection();
                    const error = saving
                        ? new BridgeError('state_not_saved', 'The desired charging mode could not be saved. Select it again or clear the mode wish before applying it.')
                        : new BridgeError('invalid_charging_mode', 'Select immediate, departure or departureClimate, or null to keep the app charging mode.');
                    await this.state('charging.targetModeError', error.code + ': ' + error.message);
                    this.log.warn(error.code + ': ' + error.message);
                    throw error;
                }
            });
            this.chargingModeUpdates = update.catch(() => {});
            return update;
        }
        async ensureRuntime() {
            if (this.stopping) throw new BridgeError('cancelled', 'The adapter is stopping.');
            await this.runtime.start();
            await this.state('info.runtimeReady', true);
        }
        async invalidateOrphanLocationHistory() {
            const objects = await this.getAdapterObjectsAsync();
            const prefix = this.namespace + '.';
            const observed = /^chargingLocations\.(loc_[a-f0-9]{24})\.(?:name|present|activeTimerCount|bindingStatus|observedAt|timer[123]\.(?:enabled|time|days|repeat|date|vehicleOffset|isLocalVehicleTime|source|daysSummary|daysSummaryRecognized|climatisation|profileId|isPreferredTimesAvailable)|settings\.(?:name|directSoc|socLimit|reducedAcCurrent|autoUnlockAc|socReadCapability)|preferredTimes\.(?:window[1234]\.(?:start|end|enabled|editable)|notice))$/;
            const status = /^refresh\.departureLocation_(loc_[a-f0-9]{24})\.status$/;
            const age = /^refresh\.departureLocation_(loc_[a-f0-9]{24})\.ageSeconds$/;
            for (const [foreignId, object] of Object.entries(objects)) {
                if (!foreignId.startsWith(prefix) || object?.type !== 'state' || object.common?.write !== false) continue;
                const id = foreignId.slice(prefix.length);
                const match = observed.exec(id) || status.exec(id) || age.exec(id);
                if (!match || this.departures.completedLocations.has(match[1])) continue;
                const previous = await this.getStateAsync(id);
                if (!previous || !['boolean', 'number', 'string'].includes(object.common.type) ||
                    !(previous.val === null || typeof previous.val === object.common.type &&
                        (object.common.type !== 'number' || Number.isFinite(previous.val)))) continue;
                if (status.test(id)) {
                    if (object.common.type !== 'string') continue;
                    if (previous.ack !== true) {
                        await this.state(id, { val: previous.val, ack: false,
                            q: (Number.isInteger(previous.q) ? previous.q : 0) | 0x82 });
                    } else {
                        const last = await this.getStateAsync(id.replace(/\.status$/, '.lastReadAt'));
                        await this.state(id, last?.ack === true && (last.q ?? 0) === 0 && isIsoTimestamp(last.val) ? 'stale' : 'unknown');
                    }
                } else {
                    await this.state(id, { val: previous.val, ack: previous.ack === true,
                        q: (Number.isInteger(previous.q) ? previous.q : 0) | 0x82 });
                }
            }
        }
        async ensureReadDomain(domain, action) {
            this.readActions[domain] = action;
            if (this.readDomainDefinitions.has(domain)) return this.readDomainDefinitions.get(domain);
            const initialize = async () => {
                if (!this.readFreshness[domain]) {
                    this.domainStates[domain] = [];
                    this.domainPublications[domain] = Promise.resolve();
                    this.readFreshness[domain] = { status: 'unknown', lastReadAt: '', lastErrorCode: '', lastDurationSeconds: 0 };
                }
                const previous = await this.getStateAsync('refresh.' + domain + '.lastReadAt');
                if (previous?.ack === true && (previous.q ?? 0) === 0 && isIsoTimestamp(previous.val)) {
                    this.readFreshness[domain].lastReadAt = previous.val;
                    this.readFreshness[domain].status = 'stale';
                }
                await this.setObjectNotExistsAsync('refresh.' + domain, { type: 'channel', common: { name: domain }, native: {} });
                for (const [key, type, role, value] of [['status', 'string', 'text', 'unknown'], ['lastReadAt', 'string', 'date', ''],
                    ['ageSeconds', 'number', 'value', null], ['lastErrorCode', 'string', 'text', ''],
                    ['lastDurationSeconds', 'number', 'value', 0], ['maxAgeSeconds', 'number', 'value', 0]]) {
                    const id = 'refresh.' + domain + '.' + key;
                    await this.setObjectNotExistsAsync(id, { type: 'state', common: { name: id, type, role, read: true, write: false,
                        ...(type === 'number' ? { unit: 's', min: 0 } : {}),
                        ...(key === 'status' ? { states: { unknown: 'Noch nicht gelesen', fresh: 'Aktuell aus der App gelesen', stale: 'App-Auslesezeit überschritten', error: 'Lesefehler' } } : {}) }, native: {} });
                    this.stateDefinitions[id] = [type, role, value, false];
                    if (!this.cachedStates.has(id)) {
                        const restored = key === 'status' || key === 'lastReadAt' ? this.readFreshness[domain][key] : value;
                        await this.state(id, restored === null ? { val: null, ack: true, q: 0x82 } : restored);
                    }
                }
                this.completedReadDomains.add(domain);
                if (!this.scheduler) this.schedulerSnapshot = { estimatedCycleMs: this.completedReadDomains.size * 37500 };
            };
            const pending = initialize(); this.readDomainDefinitions.set(domain, pending);
            try { await pending; }
            catch (error) {
                if (this.readDomainDefinitions.get(domain) === pending) this.readDomainDefinitions.delete(domain);
                throw error;
            }
        }
        syncReadDomains() {
            this.activeReadDomains = [...DOMAINS, ...this.departures.domains()];
            this.scheduler?.setDomains?.([...this.activeReadDomains]);
        }
        async markReadDomainStale(domain, code) {
            if (!this.readFreshness[domain]) return;
            await this.publishDomain(domain, async () => {
                const meta = this.readFreshness[domain];
                meta.status = meta.lastReadAt ? 'stale' : 'unknown'; meta.lastErrorCode = code;
                await this.invalidateDomainValues(domain); await this.publishRefreshMetadata(domain);
            });
        }
        publishDomain(domain, operation) {
            const pending = this.domainPublications[domain].then(operation);
            this.domainPublications[domain] = pending.catch(() => {});
            return pending;
        }
        maxReadAge() {
            return this.settings?.refreshMaxAgeSeconds || Math.max(90, Math.ceil(2 * Math.max(
                this.settings?.pollIntervalSeconds || 0, (this.schedulerSnapshot?.estimatedCycleMs || DOMAINS.length * 37500) / 1000)));
        }
        async publishRefreshMetadata(domain) {
            const meta = this.readFreshness[domain];
            const age = meta.lastReadAt ? Math.max(0, Math.floor((this.now() - Date.parse(meta.lastReadAt)) / 1000)) : null;
            const values = { status: meta.status, lastReadAt: meta.lastReadAt, ageSeconds: age,
                lastErrorCode: meta.lastErrorCode, lastDurationSeconds: meta.lastDurationSeconds, maxAgeSeconds: this.maxReadAge() };
            for (const [key, value] of Object.entries(values)) {
                const id = 'refresh.' + domain + '.' + key;
                const wrapped = value === null ? { val: null, ack: true, q: 0x82 } : { val: value, ack: true };
                const previous = this.cachedStates.get(id);
                if (previous && Object.is(previous.val, wrapped.val) && previous.ack === wrapped.ack && previous.q === wrapped.q) continue;
                await this.state(id, wrapped);
            }
        }
        async invalidateDomainValues(domain) {
            for (const id of this.domainStates[domain]) {
                const previous = this.cachedStates.get(id) || { val: this.stateDefinitions[id][2] };
                const invalid = { val: previous.val, ack: true, q: (previous.q || 0) | 0x82 };
                await this.state(id, invalid);
                if (id === 'climate.appState') await this.legacy('appState', invalid);
            }
        }
        updateFreshness() {
            if (this.stopping) return Promise.resolve();
            if (this.freshnessUpdate) return this.freshnessUpdate;
            const update = async () => {
                for (const domain of Object.keys(this.readFreshness).filter(domain => this.completedReadDomains.has(domain))) await this.publishDomain(domain, async () => {
                    const meta = this.readFreshness[domain];
                    if (meta.status === 'fresh' && this.now() - Date.parse(meta.lastReadAt) > this.maxReadAge() * 1000) {
                        meta.status = 'stale'; await this.invalidateDomainValues(domain);
                    }
                    if (domain === 'charging') {
                        const mode = this.cachedStates.get('charging.mode');
                        const observedAt = this.cachedStates.get('charging.modeObservedAt')?.val;
                        if (isChargingMode(mode?.val) && isIsoTimestamp(observedAt)
                            && this.now() - Date.parse(observedAt) > this.maxReadAge() * 1000 && !((mode.q || 0) & 0x82)) {
                            await this.state('charging.mode', { val: mode.val, ack: true, q: (mode.q || 0) | 0x82 });
                        }
                    }
                    await this.publishRefreshMetadata(domain);
                });
            };
            this.freshnessUpdate = update().finally(() => { this.freshnessUpdate = null; });
            return this.freshnessUpdate;
        }
        scheduleFreshnessCheck() {
            if (this.stopping) return;
            this.freshnessTimer = this.setTimeout(async () => {
                this.freshnessTimer = null;
                try { await this.updateFreshness(); }
                catch (_) { this.log.warn('App-read freshness metadata could not be updated.'); }
                if (!this.stopping) this.scheduleFreshnessCheck();
            }, 1000);
        }
        async publishObservation(domain, values, result) {
            if (!isIsoTimestamp(result.observedAt)) throw new BridgeError('invalid_state', 'The app-read timestamp is invalid.');
            await this.publishDomain(domain, async () => {
                await this.state('info.connection', true);
                await this.state('info.appVersion', typeof result.appVersion === 'string' ? result.appVersion : '');
                for (const [id, value] of Object.entries(values)) {
                    const wrapped = value && typeof value === 'object' && 'val' in value ? value
                        : value === null ? { val: null, ack: true, q: 0x82 } : { val: value, ack: true };
                    await this.state(id, wrapped);
                    if (id === 'climate.appState') await this.legacy('appState', wrapped);
                    if (id === 'operation.lastUpdated') await this.legacy('lastUpdated', wrapped);
                }
                const meta = this.readFreshness[domain];
                meta.status = 'fresh'; meta.lastReadAt = result.observedAt; meta.lastErrorCode = '';
                await this.publishRefreshMetadata(domain);
            });
        }
        async runAutomaticRead(domain) {
            if (!this.activeReadDomains.includes(domain)) throw new BridgeError('invalid_action', 'Unknown refresh area.');
            if (domain.startsWith('departureLocation_')) return this.departureCommand('departuresLocationStatus', { locationKey: domain.slice('departureLocation_'.length) }, { automatic: true });
            return this.command(this.readActions[domain], { automatic: true });
        }
        async manualExclusive(label, operation, domain = null) {
            if (this.stopping) throw new BridgeError('cancelled', 'The adapter is stopping.');
            if (this.maintenanceState !== 'idle') throw new BridgeError('maintenance_active', 'Phone operations are paused for maintenance.');
            if (this.pendingManual || this.busy && !this.autoJob) throw new BridgeError('busy', 'Another phone operation is running.');
            this.pendingManual = true;
            try {
                const automatic = this.autoJob;
                if (automatic) {
                    automatic.cancelRequested = true;
                    try {
                        if (typeof this.controller?.requestReadHandoff === 'function') this.controller.requestReadHandoff();
                        else this.controller?.cancel();
                    }
                    catch (_) { this.log.warn('Automatic read cancellation failed; waiting for its current operation.'); }
                    await automatic.promise;
                }
                return await this.exclusive(label, operation, domain);
            } finally {
                this.pendingManual = false;
                if (!this.stopping) this.scheduler?.notifyAvailable();
            }
        }
        startMaintenance() {
            if (this.stopping) throw new BridgeError('cancelled', 'The adapter is stopping.');
            if (this.maintenanceState !== 'idle') return this.maintenanceState;
            // A reserved manual operation must not be overtaken or cancelled.
            if (this.pendingManual || this.busy && !this.autoJob) throw new BridgeError('busy', 'Wait for the manual phone operation to finish.');
            const generation = ++this.maintenanceGeneration;
            this.maintenanceState = 'draining';
            this.scheduler?.pause();
            const job = this.autoJob;
            const finish = success => {
                if (this.stopping || generation !== this.maintenanceGeneration || this.maintenanceState !== 'draining') return;
                // No UI input is performed here. An error, interruption, or
                // lack of a successful phone operation is not a safe handoff.
                this.maintenanceState = success && !this.runtimePhoneBlocked && !this.busy && !this.pendingManual && !this.autoJob
                    && this.lastPhoneOperationOutcome === 'completed' ? 'ready' : 'blocked';
            };
            if (job) Promise.resolve(job.promise).then(() => finish(true), () => finish(false));
            else finish(true);
            return this.maintenanceState;
        }
        resumeMaintenance() {
            if (this.stopping) throw new BridgeError('cancelled', 'The adapter is stopping.');
            if (this.maintenanceState === 'draining') throw new BridgeError('busy', 'Wait for the running phone operation to finish.');
            ++this.maintenanceGeneration;
            this.maintenanceState = 'idle';
            if (!this.runtimePhoneBlocked) this.scheduler?.resume();
            return this.maintenanceState;
        }
        async enrollment() {
            const saved = await this.store.read('enrollment', {});
            if (saved.deviceId && !/^(?:serial:[A-Za-z0-9_.-]{1,100}|android_id:[0-9a-fA-F]{16})$/.test(saved.deviceId)) throw new BridgeError('invalid_state', 'Saved device identity is invalid.');
            return saved;
        }
        async guardianProtectionReady() {
            // Instance metadata may lag the package metadata on upgrades. Do
            // not use the helper if both protections are not demonstrably set.
            try {
                const object = await this.getForeignObjectAsync('system.adapter.' + this.namespace);
                return Array.isArray(object?.encryptedNative) && object.encryptedNative.includes('guardianSecret')
                    && Array.isArray(object?.protectedNative) && object.protectedNative.includes('guardianSecret');
            } catch (_) { return false; }
        }
        async phone(overrides = {}, { allowUnpinned = false } = {}) {
            await this.ensureRuntime();
            const hostIp = overrides.hostIp || this.settings.hostIp;
            const connectPort = overrides.connectPort || this.settings.connectPort;
            const saved = await this.enrollment();
            if (!allowUnpinned && !saved.deviceId) throw new BridgeError('wifi_identity_required', 'Run the phone check in adapter settings first.');
            const configuredEndpoint = endpoint(hostIp, connectPort);
            const cached = this.verifiedPhoneEndpoint;
            const initialEndpoint = !allowUnpinned && cached?.configuredEndpoint === configuredEndpoint && cached.deviceId === saved.deviceId
                ? cached.endpoint : configuredEndpoint;
            const guardianEnabled = !allowUnpinned && this.settings.guardianPortDiscovery && await this.guardianProtectionReady();
            return new PhoneClass({
                runtime: this.runtime, endpoint: initialEndpoint, fallbackEndpoint: initialEndpoint !== configuredEndpoint ? configuredEndpoint : '',
                deviceId: saved.deviceId || '', discoverPort: !allowUnpinned,
                initialEndpointSource: initialEndpoint !== configuredEndpoint ? 'cache' : 'configured',
                onConnectionSource: source => {
                    if (['guardian', 'adb_mdns', 'mdns_unicast', 'mdns_multicast'].includes(source)) {
                        this.log.info('Wireless debugging port discovery verified: ' + source);
                    }
                },
                signal: this.abortController.signal,
                // Read the protected value only for an explicitly enabled,
                // identity-pinned recovery request; never copy it into settings.
                guardianDiscovery: guardianEnabled
                    ? (host, options) => GuardianQuery(host, { ...options, port: this.settings.guardianPort,
                        getSecret: () => this.config.guardianSecret }) : null,
                onVerified: async (deviceId, verifiedEndpoint) => {
                    await this.lease.acquire(deviceId);
                    if (!allowUnpinned && verifiedEndpoint) this.verifiedPhoneEndpoint = { configuredEndpoint, endpoint: verifiedEndpoint, deviceId };
                },
            });
        }
        async exclusive(label, operation, domain = null, automatic = null) {
            if (this.stopping) throw new BridgeError('cancelled', 'The adapter is stopping.');
            if (this.busy) throw new BridgeError('busy', 'Another phone operation is running.');
            this.busy = true;
            const execute = async () => {
                const startedAt = this.now();
                let fenced = false;
                try {
                    if (automatic) await this.state('refresh.autoBusy', true);
                    else {
                        await this.feedback('busy', true);
                        await this.feedback('lastResult', 'running');
                        await this.feedback('lastError', '');
                        await this.state('operation.lastErrorCode', '');
                        await this.state('info.status', label);
                    }
                    if (automatic?.cancelRequested) throw new BridgeError('cancelled', 'Automatic read handed over to a manual command.');
                    // Cover every phone operation with a durable marker before
                    // its first Android command. The few listed operations are
                    // local only but must not bypass an existing marker.
                    const localOnly = ['installRuntime', 'guardianBinderPrepare', 'guardianBinderRecover', 'resetSecurityBlock'].includes(label);
                    if (localOnly) await this.runtime.assertJobClear();
                    else await this.runtime.beginJob();
                    let result;
                    try {
                        if (this.stopping || automatic?.cancelRequested) throw new BridgeError('cancelled', 'Phone operation cancelled before it started.');
                        result = await operation();
                    } finally {
                        if (!localOnly) await this.runtime.endJob();
                    }
                    if (domain || label === 'calibrate' || label === 'probe') this.lastPhoneOperationOutcome = 'completed';
                    if (!automatic) { await this.feedback('lastResult', 'succeeded'); await this.state('info.status', 'ready'); }
                    return result;
                } catch (error) {
                    fenced = error?.code === 'adb_execution_fenced';
                    if (fenced) { this.runtimePhoneBlocked = true; this.scheduler?.pause(); }
                    if (domain || label === 'calibrate' || label === 'probe') this.lastPhoneOperationOutcome = 'uncertain';
                    if (!automatic?.cancelRequested || fenced) await this.failure(error, domain, Boolean(automatic));
                    throw error;
                }
                finally {
                    let finalized = false;
                    try {
                        if (domain && (!automatic?.cancelRequested || fenced)) {
                            this.readFreshness[domain].lastDurationSeconds = Math.max(0, this.now() - startedAt) / 1000;
                            await this.publishDomain(domain, () => this.publishRefreshMetadata(domain));
                        }
                        if (automatic) await this.state('refresh.autoBusy', false);
                        else await this.feedback('busy', false);
                        finalized = true;
                    } finally {
                        if (!finalized && (domain || label === 'calibrate' || label === 'probe')) this.lastPhoneOperationOutcome = 'uncertain';
                        this.controller = null; this.busy = false;
                    }
                }
            };
            const running = execute(); this.currentOperation = running;
            try { return await running; }
            finally { if (this.currentOperation === running) this.currentOperation = null; }
        }
        async failure(error, domain = 'climate', automatic = false) {
            const safe = publicError(error);
            await this.state('info.connection', false);
            if (automatic && safe.code === 'adb_execution_fenced') {
                await this.state('info.status', safe.code);
                await this.state('operation.lastErrorCode', safe.code);
            }
            if (!automatic) {
                await this.state('info.status', safe.code);
                await this.state('operation.lastErrorCode', safe.code);
                await this.feedback('lastError', safe.code + ': ' + safe.message);
                await this.feedback('lastResult', 'failed');
            }
            if (domain) await this.publishDomain(domain, async () => {
                this.readFreshness[domain].status = 'error';
                this.readFreshness[domain].lastErrorCode = safe.code;
                await this.invalidateDomainValues(domain); await this.publishRefreshMetadata(domain);
            });
            const diagnostic = securityErrorDiagnostic(error);
            const detail = diagnostic ? ' [security stage=' + diagnostic.stage + '; cause=' + diagnostic.cause + ']' : '';
            this.log.warn(safe.code + ': ' + safe.message + detail);
        }
        async publishSecurityAuth() {
            let auth;
            try { auth = await readSecurityAuth(this.store); }
            catch (error) { auth = { blocked: true, reason: sanitizeSecurityError(error).code }; }
            try {
                await this.state('security.blocked', auth.blocked);
                await this.state('security.reason', auth.reason || '');
            } catch (error) { throw sanitizeSecurityError(error); }
            return auth;
        }
        async observation(result) {
            if (result?.domain === 'vehicleInfo') return this.vehicleInfoObservation(result);
            if (result?.domain === 'vehicleAccess') return this.vehicleAccessObservation(result);
            if (result?.domain === 'vehicleReport') return this.vehicleReportObservation(result);
            if (result.domain === 'charging') return this.chargingObservation(result);
            if (!['on', 'off'].includes(result.appState)) throw new BridgeError('invalid_state', 'The climate observation is invalid.');
            const values = { 'climate.appState': result.appState,
                'climate.confirmationSource': result.confirmationSource || 'app_controls',
                'climate.active': result.appState === 'on', 'climate.vehicleConfirmed': false,
                'climate.temperature': isTemperature(result.temperature) ? result.temperature : null,
                'operation.lastUpdated': result.observedAt };
            for (const key of SETTINGS_KEYS) {
                const value = result.settings?.[key];
                values[OBSERVED_SETTING_STATES[key]] = value !== null && isObservedSettingValue(key, value) ? value : null;
            }
            await this.publishObservation('climate', values, result);
        }
        async chargingObservation(result) {
            const soc = result.battery?.soc;
            const range = result.battery?.rangeKm;
            const values = { 'battery.soc': isBatterySoc(soc) ? soc : null,
                'battery.rangeKm': isRangeKm(range) ? range : null };
            if (isBatterySoc(soc) || isRangeKm(range)) values['battery.observedAt'] = result.observedAt;
            for (const key of CHARGING_KEYS) {
                const value = result.charging?.[key];
                values[OBSERVED_CHARGING_STATES[key]] = value !== null && isObservedChargingValue(key, value) ? value : null;
            }
            const mode = result.charging?.mode;
            if (isChargingMode(mode) && isIsoTimestamp(result.modeObservedAt)) {
                values['charging.mode'] = mode;
                values['charging.modeObservedAt'] = result.modeObservedAt;
            } else {
                const previous = this.cachedStates.get('charging.mode');
                values['charging.mode'] = { val: isChargingMode(previous?.val) ? previous.val : null, ack: true, q: 0x82 };
            }
            if (isIsoTimestamp(result.syncRequestedAt)) values['battery.lastSyncRequestAt'] = result.syncRequestedAt;
            await this.publishObservation('charging', values, result);
        }
        async vehicleReportObservation(result) {
            // Validate and serialize the entire result before publishing any
            // report field, so malformed results cannot mix old and new data.
            if (!result || typeof result !== 'object' || Array.isArray(result)
                || result.domain !== 'vehicleReport' || result.source !== 'volkswagen_android_app'
                || result.vehicleConfirmed !== false || typeof result.appVersion !== 'string'
                || !/^[A-Za-z0-9._-]{1,64}$/.test(result.appVersion) || !isIsoTimestamp(result.observedAt)) {
                throw new BridgeError('invalid_vehicle_report', 'The vehicle report result is invalid. Read the report again.');
            }
            const report = validateVehicleReport(result.vehicleReport);
            const values = Object.fromEntries(['odometerText', 'odometerKm', 'nextServiceText', 'nextServiceDays',
                'nextServiceKm', 'summary', 'hasMessages', 'messageCount', 'synchronizationText', 'notice']
                .map(key => ['vehicleReport.' + key, report[key]]));
            values['vehicleReport.additionalTexts'] = JSON.stringify(report.additionalTexts);
            values['vehicleReport.json'] = JSON.stringify(report);
            values['vehicleReport.observedAt'] = result.observedAt;
            for (const category of Object.keys(REPORT_CATEGORIES)) {
                values['vehicleReport.' + category + '.status'] = report.categories[category].status;
                values['vehicleReport.' + category + '.texts'] = JSON.stringify(report.categories[category].texts);
            }
            await this.publishObservation('vehicleReport', values, result);
        }
        async vehicleInfoObservation(result) {
            let envelope, values;
            try {
                if (!result || typeof result !== 'object' || Array.isArray(result)
                    || ![Object.prototype, null].includes(Object.getPrototypeOf(result))) throw new Error();
                const keys = ['domain', 'source', 'vehicleConfirmed', 'appVersion', 'vehicleInfo', 'observedAt'];
                const descriptors = Object.getOwnPropertyDescriptors(result);
                if (Reflect.ownKeys(descriptors).length !== keys.length) throw new Error();
                envelope = {};
                for (const key of keys) {
                    const descriptor = descriptors[key];
                    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
                    envelope[key] = descriptor.value;
                }
                if (envelope.domain !== 'vehicleInfo' || envelope.source !== 'volkswagen_android_app'
                    || envelope.vehicleConfirmed !== false || typeof envelope.appVersion !== 'string'
                    || !/^[A-Za-z0-9._-]{1,64}$/.test(envelope.appVersion) || !isIsoTimestamp(envelope.observedAt)) throw new Error();
                const info = validateVehicleInfo(envelope.vehicleInfo);
                values = { 'vehicleInfo.vin': info.vin, 'vehicleInfo.observedAt': envelope.observedAt };
            } catch (_) {
                // Never publish raw parser exceptions or personal identifiers.
                throw new BridgeError('invalid_vehicle_info', 'Die FIN-Beobachtung ist unvollständig oder ungültig. Die Fahrzeugverwaltung erneut lesen.');
            }
            await this.publishObservation('vehicleInfo', values, envelope);
        }
        async vehicleAccessObservation(result) {
            if (!result || typeof result !== 'object' || Array.isArray(result)
                || result.domain !== 'vehicleAccess' || result.source !== 'volkswagen_android_app'
                || result.vehicleConfirmed !== false || typeof result.appVersion !== 'string'
                || !/^[A-Za-z0-9._-]{1,64}$/.test(result.appVersion) || !isIsoTimestamp(result.observedAt)) {
                throw new BridgeError('invalid_vehicle_access', 'The vehicle access observation is invalid. Read the overview again.');
            }
            // Validate all ten components and source labels before publishing
            // any field. Unknown values remain null with unavailable quality.
            const access = validateVehicleAccess(result.vehicleAccess);
            const values = { 'vehicleAccess.trunkOpen': access.trunkOpen, 'vehicleAccess.locked': access.locked,
                'vehicleAccess.synchronizationText': access.synchronizationText,
                'vehicleAccess.warningText': access.warningText, 'vehicleAccess.observedAt': result.observedAt };
            for (const group of ['doors', 'windows']) for (const position of Object.keys(ACCESS_POSITIONS)) {
                values['vehicleAccess.' + group + '.' + position + 'Open'] = access[group][position];
            }
            await this.publishObservation('vehicleAccess', values, result);
        }
        async departureCommand(action, input = {}, { automatic = false } = {}) {
            let plan;
            try { plan = this.departures.plan(action, input); }
            catch (error) {
                if (automatic) throw error;
                return this.manualExclusive(action, async () => { throw error; });
            }
            if (automatic && DEPARTURE_WRITE_ACTIONS.includes(action)) throw new BridgeError('invalid_action', 'Automatic work may only read app values.');
            const operation = async () => {
                const saved = await this.enrollment();
                if (!saved.profile?.appVersion || !saved.profile.vehicleMarker) throw new BridgeError('profile_required', 'Calibrate the selected vehicle in adapter settings first.');
                if ((this.settings.approvedAppVersion && this.settings.approvedAppVersion !== saved.profile.appVersion)
                    || (this.settings.vehicleMarker && this.settings.vehicleMarker !== saved.profile.vehicleMarker)) throw new BridgeError('profile_mismatch', 'The edited profile differs from the last calibration. Calibrate again.');
                const options = await plan.prepare(saved);
                plan.options = options;
                const phone = await this.phone();
                this.controller = new ControllerClass({ config: { ...this.settings, approvedAppVersion: saved.profile.appVersion,
                    vehicleMarker: { contentDescPrefix: saved.profile.vehicleMarker } }, phone, store: this.store });
                if (automatic && this.autoJob?.cancelRequested) this.controller.cancel();
                let result;
                try { result = await this.controller.execute(action, options); }
                finally {
                    if (action === 'applyDepartureLocationTimer'
                        || action === 'applyDepartureLocationSettings' && options.targetSettings.name !== null) {
                        await this.markReadDomainStale('departureLocations', 'departure_inventory_changed');
                        if (!this.stopping) this.scheduler?.request('departureLocations', { priority: true, delayMs: 2000 });
                    }
                }
                if (automatic && this.autoJob?.cancelRequested) throw new BridgeError('cancelled', 'Automatic read handed over to a manual command.');
                await this.departures.observe(result, plan);
                return result;
            };
            if (automatic) {
                if (this.busy || this.pendingManual || this.stopping || this.maintenanceState !== 'idle') throw new BridgeError('busy', 'Another phone operation is running.');
                const job = { cancelRequested: false, promise: null }; this.autoJob = job;
                const running = this.exclusive(action, operation, plan.domain, job);
                job.promise = (async () => {
                    try { return await running; }
                    catch (error) { if (!job.cancelRequested || error?.code === 'adb_execution_fenced') throw error; }
                    finally { if (this.autoJob === job) this.autoJob = null; }
                })();
                return job.promise;
            }
            let accepted = false;
            try { return await this.manualExclusive(action, async () => { accepted = true; return operation(); }, plan.domain); }
            finally {
                if (accepted && !this.stopping && DEPARTURE_WRITE_ACTIONS.includes(action)) this.scheduler?.request(plan.domain, { priority: true, delayMs: 2000 });
            }
        }
        async lockingCommand(action, { automatic = false } = {}) {
            if (automatic || !LOCK_ACTIONS.includes(action)) throw fixedSecurityError('invalid_action');
            const operation = async () => {
                try {
                    await this.publishSecurityAuth();
                    const saved = await this.enrollment();
                    if (!saved.profile?.appVersion || !saved.profile.vehicleMarker) throw fixedSecurityError('profile_required');
                    if ((this.settings.approvedAppVersion && this.settings.approvedAppVersion !== saved.profile.appVersion)
                        || (this.settings.vehicleMarker && this.settings.vehicleMarker !== saved.profile.vehicleMarker)) {
                        throw fixedSecurityError('wrong_vehicle');
                    }
                    const phone = await this.phone();
                    this.controller = new ControllerClass({
                        config: { ...this.settings, approvedAppVersion: saved.profile.appVersion,
                            vehicleMarker: { contentDescPrefix: saved.profile.vehicleMarker } },
                        phone, store: this.store,
                        // ioBroker already decrypted this field at startup. It
                        // never enters normalized config, options or states.
                        getSecurityPin: () => validateSecurityPin(this.config.sPin),
                    });
                    const result = await this.controller.execute(action, {});
                    await this.vehicleAccessObservation(result);
                    // Only the validated observation envelope leaves this
                    // command. Additional controller properties are not public.
                    return { domain: 'vehicleAccess', source: 'volkswagen_android_app', vehicleConfirmed: false,
                        appVersion: result.appVersion, observedAt: result.observedAt,
                        vehicleAccess: validateVehicleAccess(result.vehicleAccess) };
                } catch (error) { throw sanitizeSecurityError(error); }
                finally { await this.publishSecurityAuth(); }
            };
            let accepted = false;
            try {
                return await this.manualExclusive(action, async () => { accepted = true; return operation(); }, 'vehicleAccess');
            } catch (error) { throw sanitizeSecurityError(error); }
            finally {
                if (accepted && !this.stopping) this.scheduler?.request('vehicleAccess', { priority: true, delayMs: 2000 });
            }
        }
        async command(action, { automatic = false, ...input } = {}) {
            if (LOCK_ACTIONS.includes(action)) return this.lockingCommand(action, { automatic });
            if (Object.values(DEPARTURE_READ_ACTIONS).includes(action) || action === 'departuresLocationStatus' || DEPARTURE_WRITE_ACTIONS.includes(action)) {
                return this.departureCommand(action, input, { automatic });
            }
            const chargingAction = ['chargingStatus', 'applyChargingSettings', 'applyChargingMode', 'synchronize'].includes(action);
            const reportAction = action === 'vehicleReportStatus';
            const accessAction = action === 'refreshVehicleAccess';
            const infoAction = action === 'refreshVehicleInfo';
            const domain = infoAction ? 'vehicleInfo' : accessAction ? 'vehicleAccess' : reportAction ? 'vehicleReport' : chargingAction ? 'charging' : 'climate';
            if (automatic && !Object.values(READ_ACTIONS).includes(action)) throw new BridgeError('invalid_action', 'Automatic work may only read app values.');
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
            const selectedChargingMode = action === 'applyChargingMode' ? this.chargingModeUpdates.then(() => ({
                value: this.targetChargingMode, ready: this.chargingModePreferenceReady, failed: this.chargingModeUpdateFailed,
            })) : Promise.resolve({ value: null, ready: true, failed: false });
            const operation = async () => {
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
                const chargingModeSelection = await selectedChargingMode;
                if (action === 'applyChargingMode') {
                    if (!chargingModeSelection.ready) throw new BridgeError('invalid_state', 'Select a valid saved charging mode before applying it.');
                    if (chargingModeSelection.failed) throw new BridgeError('charging_mode_selection_failed', 'A charging mode selection failed. Select it again or clear the mode wish.');
                    if (chargingModeSelection.value === null) throw new BridgeError('charging_mode_required', 'Select a charging mode before applying it.');
                    // Only the controller's fresh app observation can establish
                    // that this wish is already fulfilled. It blocks an actual
                    // change before opening the picker when writes are disabled.
                }
                const saved = await this.enrollment();
                if (!saved.profile?.appVersion || !saved.profile.vehicleMarker) throw new BridgeError('profile_required', 'Calibrate the selected vehicle in adapter settings first.');
                if ((this.settings.approvedAppVersion && this.settings.approvedAppVersion !== saved.profile.appVersion)
                    || (this.settings.vehicleMarker && this.settings.vehicleMarker !== saved.profile.vehicleMarker)) {
                    throw new BridgeError('profile_mismatch', 'The edited profile differs from the last calibration. Calibrate again.');
                }
                const phone = await this.phone();
                this.controller = new ControllerClass({
                    config: { ...this.settings, approvedAppVersion: saved.profile.appVersion, vehicleMarker: { contentDescPrefix: saved.profile.vehicleMarker } },
                    phone, store: this.store,
                });
                if (automatic && this.autoJob?.cancelRequested) this.controller.cancel();
                const targetTemperature = usesTemperature ? selection.value : null;
                const options = action === 'applyChargingMode' ? { targetChargingMode: chargingModeSelection.value }
                    : reportAction || accessAction || infoAction ? {} : chargingAction ? { targetCharging: chargingSelection.values } : { targetTemperature };
                if (['start', 'applySettings'].includes(action)) options.targetSettings = settingsSelection.values;
                const result = await this.controller.execute(action, options);
                if (automatic && this.autoJob?.cancelRequested) throw new BridgeError('cancelled', 'Automatic read handed over to a manual command.');
                if (chargingAction && result?.domain !== 'charging') throw new BridgeError('invalid_state', 'The charging observation is invalid. Refresh the charging page again.');
                if (infoAction) await this.vehicleInfoObservation(result);
                else if (accessAction) await this.vehicleAccessObservation(result);
                else if (reportAction) await this.vehicleReportObservation(result);
                else await this.observation(result);
                return result;
            };
            if (automatic) {
                if (this.busy || this.pendingManual || this.stopping || this.maintenanceState !== 'idle') throw new BridgeError('busy', 'Another phone operation is running.');
                const job = { cancelRequested: false, promise: null }; this.autoJob = job;
                const running = this.exclusive(action, operation, domain, job);
                job.promise = (async () => {
                    try { return await running; }
                    catch (error) { if (!job.cancelRequested || error?.code === 'adb_execution_fenced') throw error; }
                    finally { if (this.autoJob === job) this.autoJob = null; }
                })();
                return job.promise;
            }
            let accepted = false;
            try { return await this.manualExclusive(action, async () => { accepted = true; return operation(); }, domain); }
            finally {
                if (accepted && !this.stopping && ['start', 'stop', 'setTemperature', 'applySettings', 'applyChargingSettings', 'applyChargingMode', 'synchronize'].includes(action)) {
                    this.scheduler?.request(domain, { priority: true, delayMs: 2000 });
                }
            }
        }
        async onStateChange(id, state) {
            if (!state || state.ack !== false || this.stopping) return;
            if (await this.departures.stateChange(id, state)) return;
            if (id === this.namespace + '.charging.targetMode') {
                await this.stageChargingMode(state.val).catch(() => {});
                return;
            }
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
                'refreshCharging', 'applyChargingSettings', 'clearChargingSettings', 'applyChargingMode', 'clearChargingMode', 'synchronize', 'refreshVehicleReport', 'refreshVehicleAccess', 'refreshVehicleInfo',
                'lockVehicle', 'unlockVehicle'].includes(name)
                || !['start', 'stop', 'refresh'].includes(name) && !id.startsWith(own)) return;
            if (id.startsWith(own)) await this.state('commands.' + name, false);
            else await this.legacy(name, false);
            if (name === 'clearTemperature') { await this.stageTemperature(null).catch(() => {}); return; }
            if (name === 'clearSettings') { await this.clearSettings().catch(() => {}); return; }
            if (name === 'clearChargingSettings') { await this.clearChargingSettings().catch(() => {}); return; }
            if (name === 'clearChargingMode') { await this.stageChargingMode(null).catch(() => {}); return; }
            await this.command(name === 'refresh' ? 'status' : name === 'refreshCharging' ? 'chargingStatus'
                : name === 'refreshVehicleReport' ? 'vehicleReportStatus' : name).catch(() => {});
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
            await this.departures.setVehicleMarker(vehicleMarker);
            await this.observation({ appState, appVersion: version, temperature: screen.climateTemperature(), observedAt: new Date().toISOString() });
            return { result: 'calibration_success', native: { approvedAppVersion: version, vehicleMarker }, saveConfig: true };
        }
        async onMessage(obj) {
            if (!obj?.callback || !obj.from || this.stopping) return;
            if (['maintenanceStart', 'maintenanceStatus', 'maintenanceResume'].includes(obj.command)) {
                let response;
                try {
                    if (typeof obj.from !== 'string' || !/^system\.adapter\.admin\.\d+$/.test(obj.from)) {
                        throw new BridgeError('invalid_action', 'Maintenance is available only from ioBroker Admin.');
                    }
                    const state = obj.command === 'maintenanceStart' ? this.startMaintenance()
                        : obj.command === 'maintenanceResume' ? this.resumeMaintenance() : this.maintenanceState;
                    response = { result: 'maintenance_' + state, native: {} };
                } catch (error) {
                    const safe = publicError(error); response = { error: safe.code + ': ' + safe.message };
                }
                this.sendTo(obj.from, obj.command, response, obj.callback);
                return;
            }
            if (obj.command === 'guardianProtectionCheck') {
                // A read-only check on the current instance, not a phone job.
                // The transient UI marker is never persisted and no native
                // values or secrets are returned to the Admin client.
                const admin = typeof obj.from === 'string' && /^system\.adapter\.admin\.\d+$/.test(obj.from);
                const verified = admin && await this.guardianProtectionReady();
                this.sendTo(obj.from, obj.command, { native: { _guardianProtectionVerified: verified } }, obj.callback);
                return;
            }
            const message = obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message) ? obj.message : {};
            const allowed = ['installRuntime', 'pair', 'probe', 'calibrate', 'keepAwake', 'resetSecurityBlock',
                'guardianBinderTest', 'guardianBinderPrepare', 'guardianBinderTransfer', 'guardianBinderStatus', 'guardianBinderRecover', 'guardianPairVerify', 'guardianPermissionGrant'];
            let response;
            try {
                if (!allowed.includes(obj.command)) throw new BridgeError('invalid_action', 'Unknown setup action.');
                if (obj.command === 'resetSecurityBlock' && (typeof obj.from !== 'string' || !/^system\.adapter\.admin\.\d+$/.test(obj.from))) {
                    throw fixedSecurityError('invalid_action');
                }
                if (['guardianBinderTest', 'guardianBinderPrepare', 'guardianBinderTransfer', 'guardianBinderStatus', 'guardianBinderRecover', 'guardianPairVerify', 'guardianPermissionGrant'].includes(obj.command)
                    && (typeof obj.from !== 'string' || !/^system\.adapter\.admin\.\d+$/.test(obj.from))) {
                    throw new BridgeError('invalid_action', 'Guardian pairing is available only from ioBroker Admin.');
                }
                response = await this.manualExclusive(obj.command, async () => {
                    try { switch (obj.command) {
                        case 'resetSecurityBlock': {
                            validateSecurityPin(this.config.sPin);
                            await clearSecurityAuth(this.store);
                            await this.publishSecurityAuth();
                            return { result: 'security_block_reset' };
                        }
                        case 'installRuntime':
                            await this.runtime.install({ acceptLicense: message.acceptLicense === true });
                            await this.ensureRuntime(); this.scheduler?.start();
                            return { result: 'runtime_installed', native: {} };
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
                        case 'guardianBinderTest': {
                            const saved = await this.enrollment();
                            if (!saved.deviceId) throw new BridgeError('wifi_identity_required', 'Run the phone check in adapter settings first.');
                            await this.ensureRuntime();
                            // The synthetic test must not use an existing Guardian key.
                            const phone = new PhoneClass({ runtime: this.runtime,
                                endpoint: endpoint(this.settings.hostIp, this.settings.connectPort), deviceId: saved.deviceId,
                                discoverPort: true, signal: this.abortController.signal,
                                onVerified: async deviceId => this.lease.acquire(deviceId) });
                            return { ...(await GuardianBinderTest({ adapter: this, phone, approvedApkHash: APPROVED_APK_SHA256 })), native: {} };
                        }
                        case 'guardianPermissionGrant': {
                            if (message.confirm !== true) throw new BridgeError('guardian_permission_consent_required', 'Confirm the Android permission explicitly first.');
                            const phone = await this.phone();
                            const journal = { read: () => this.store.read('guardian-permission-state', null),
                                write: value => this.store.write('guardian-permission-state', value) };
                            return { ...(await GuardianPermissionGrant({ phone, userConfirmed: true, journal,
                                signal: this.abortController.signal })), native: {} };
                        }
                        case 'guardianBinderPrepare':
                            return { ...(await prepareHost({ adapter: this })), native: {} };
                        case 'guardianBinderStatus':
                            return { result: await pairingStatus(this), native: {} };
                        case 'guardianBinderTransfer': {
                            const vmIp = await GuardianVmRoute(this.settings.hostIp);
                            const phone = await this.phone();
                            const saved = await this.enrollment();
                            if (!saved.deviceId) throw new BridgeError('wifi_identity_required', 'Run the phone check in adapter settings first.');
                            const host = validateHost(this.settings.hostIp);
                            return { ...(await transferAndVerify({ adapter: this, phone, vmIp,
                                approvedApkHash: APPROVED_APK_SHA256, guardianQuery: GuardianQuery,
                                verifyEndpoint: async port => {
                                    const verifiedEndpoint = endpoint(host, port);
                                    const verified = new PhoneClass({ runtime: this.runtime, endpoint: verifiedEndpoint,
                                        deviceId: saved.deviceId, discoverPort: false, signal: this.abortController.signal,
                                        onVerified: async deviceId => this.lease.acquire(deviceId) });
                                    await verified.connect();
                                } })), native: {} };
                        }
                        case 'guardianBinderRecover': {
                            const phone = await this.phone();
                            return { ...(await approveRecovery({ adapter: this, phone,
                                approvedApkHash: APPROVED_APK_SHA256, userConfirmed: message.confirm === true })), native: {} };
                        }
                        case 'guardianPairVerify': {
                            // No mDNS or configured-port fallback is allowed here:
                            // success must prove the signed Guardian response itself.
                            if (!this.settings.guardianPortDiscovery || !(await this.guardianProtectionReady())) {
                                throw new BridgeError('guardian_protection_missing', 'Guardian pairing or secret protection is not configured.');
                            }
                            const saved = await this.enrollment();
                            if (!saved.deviceId) throw new BridgeError('wifi_identity_required', 'Run the phone check in adapter settings first.');
                            await this.ensureRuntime();
                            const host = validateHost(this.settings.hostIp);
                            const port = await GuardianQuery(host, { port: this.settings.guardianPort,
                                getSecret: () => this.config.guardianSecret, timeoutMs: 17000, signal: this.abortController.signal });
                            if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BridgeError('guardian_verify_failed', 'Guardian did not provide an authenticated connection.');
                            const verifiedEndpoint = endpoint(host, port);
                            const phone = new PhoneClass({ runtime: this.runtime, endpoint: verifiedEndpoint,
                                deviceId: saved.deviceId, discoverPort: false, signal: this.abortController.signal,
                                onVerified: async deviceId => {
                                    await this.lease.acquire(deviceId);
                                    this.verifiedPhoneEndpoint = { configuredEndpoint: endpoint(host, this.settings.connectPort), endpoint: verifiedEndpoint, deviceId };
                                } });
                            await phone.connect();
                            return { result: 'guardian_pair_verified', native: {} };
                        }
                    } } catch (error) {
                        if (obj.command === 'resetSecurityBlock') throw sanitizeSecurityError(error);
                        throw error;
                    }
                });
            } catch (error) {
                const safe = obj.command === 'resetSecurityBlock' ? publicError(sanitizeSecurityError(error)) : publicError(error);
                response = { error: safe.code + ': ' + safe.message };
            }
            // Responses never echo pairing codes, keys, raw dumps or internal exceptions.
            this.sendTo(obj.from, obj.command, response, obj.callback);
        }
        async onUnload(callback) {
            this.stopping = true;
            try {
                this.abortController.abort();
                try { this.controller?.cancel(); } catch (_) { this.log.warn('Controller cancellation failed.'); }
                this.scheduler?.stop();
                if (this.freshnessTimer !== null && this.freshnessTimer !== undefined) this.clearTimeout(this.freshnessTimer);
                try { await this.runtime?.stop(); } catch (_) { this.log.warn('Android runtime cleanup failed.'); }
                let timer;
                try {
                    await Promise.race([
                        Promise.allSettled([this.currentOperation, this.autoJob?.promise, this.temperatureUpdates,
                            this.settingsUpdates, this.chargingUpdates, this.chargingModeUpdates, this.departures.preferenceWrites,
                            this.departures.bindingWrites, ...Object.values(this.domainPublications)]),
                        new Promise(resolve => { timer = nodeTimers.setTimeout(resolve, 3000); }),
                    ]);
                } finally { nodeTimers.clearTimeout(timer); }
            } finally {
                // The normal helper is gated once stopping is true. Write the
                // final availability directly, even when another cleanup failed.
                await Promise.allSettled(['info.connection', 'info.runtimeReady', 'refresh.autoBusy'].map(id =>
                    Promise.resolve().then(() => this.setStateAsync(id, { val: false, ack: true }))));
                try { await this.lease?.close(); } catch (_) { this.log.warn('Device lease cleanup failed.'); }
                finally { callback(); }
            }
        }
    };
}

module.exports = { createAdapterClass, markerFromScreen, DEFINITIONS };
