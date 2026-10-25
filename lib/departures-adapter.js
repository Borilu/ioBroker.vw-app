'use strict';

const crypto = require('node:crypto');
const { BridgeError, publicError } = require('./errors');
const { TIMER_KEYS, validateTimerField, validateTimerTargets,
    parseTimerDaysState, serializeTimerDaysState, normalizeObservedTimer } = require('./departures');

const LOCATION_KEYS = Object.freeze(['name', 'reducedAcCurrent', 'autoUnlockAc']);
const DEFAULT_TARGET_LOCATION = Object.freeze({ name: null, reducedAcCurrent: null, autoUnlockAc: null });
const READ_ACTIONS = Object.freeze({ departureClimate: 'departuresClimateStatus', departureLocations: 'departuresLocationsStatus' });
const WRITE_ACTIONS = Object.freeze(['applyDepartureClimateTimer', 'applyDepartureLocationTimer',
    'applyDepartureLocationSettings', 'applyDeparturePreferredTimes']);
const PREF_FILE = 'departure-preference';
const BINDING_FILE = 'departure-location-bindings';

function fail(code = 'invalid_departures_request') {
    const messages = {
        invalid_departures_request: 'Die Abfahrtszeit-Angaben sind ungÃ¼ltig.',
        invalid_departures_result: 'Die Abfahrtszeit-Beobachtung ist unvollstÃ¤ndig oder ungÃ¼ltig.',
        departure_binding_changed: 'Die Orts- oder Fahrzeugbindung hat sich geÃ¤ndert. GewÃ¼nschte Werte ausdrÃ¼cklich neu auswÃ¤hlen oder lÃ¶schen.',
        departure_selection_failed: 'Mindestens ein gewÃ¼nschter Wert ist ungÃ¼ltig oder wurde nicht gespeichert. Diesen Wert neu auswÃ¤hlen oder lÃ¶schen.',
        departure_settings_required: 'Zuerst mindestens einen gewÃ¼nschten Wert auswÃ¤hlen.',
    };
    return new BridgeError(code, messages[code] || messages.invalid_departures_request);
}
function check(condition, code) { if (!condition) throw fail(code); }
function plain(value) { check(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))); return value; }
function record(value, keys) {
    plain(value);
    const descriptors = Object.getOwnPropertyDescriptors(value), result = {};
    for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key];
        check(typeof key === 'string' && keys.includes(key) && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
        result[key] = descriptor.value;
    }
    return result;
}
function boolean(value, nullable = true) { check(typeof value === 'boolean' || nullable && value === null); return value; }
function nameValue(value) {
    check(typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value
        && !/[\x00-\x1f\x7f\ufffe\uffff]/.test(value) && !/[\ud800-\udfff]/u.test(value));
    return value;
}
function nativeId(value) { check(typeof value === 'string' && /^(?:0|[1-9][0-9]{0,31})$/.exec(value)?.[0] === value); return value; }
function iso(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function localKey(marker, id) { return 'loc_' + hash(JSON.stringify([marker, id])).slice(0, 24); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function validateLocationTargets(value = {}) {
    try {
        const input = record(value, LOCATION_KEYS), result = { ...DEFAULT_TARGET_LOCATION };
        for (const key of LOCATION_KEYS) if (Object.hasOwn(input, key)) result[key] = key === 'name'
            ? input[key] === null ? null : nameValue(input[key]) : boolean(input[key]);
        return result;
    } catch (_) { throw fail(); }
}
function validatePreferredTargets(value) {
    try {
        check(Array.isArray(value) && value.length === 4);
        const result = [];
        for (const entry of value) {
            const input = record(entry, ['id', 'enabled']);
            check(Object.keys(input).length === 2 && ['1', '2', '3', '4'].includes(input.id) && !result.some(item => item.id === input.id));
            result.push({ id: input.id, enabled: boolean(input.enabled) });
        }
        return ['1', '2', '3', '4'].map(id => result.find(entry => entry.id === id));
    } catch (_) { throw fail(); }
}

const TARGET_NAMES = { enabled: 'targetEnabled', time: 'targetTime', days: 'targetDays', repeat: 'targetRepeat',
    name: 'targetName', reducedAcCurrent: 'targetReducedAcCurrent', autoUnlockAc: 'targetAutoUnlockAc' };

class DeparturesAdapter {
    constructor(adapter) {
        this.adapter = adapter;
        this.groups = new Map(); this.routes = new Map(); this.bindings = {};
        this.groupDefinitions = new Map(); this.locationDefinitions = new Map();
        this.completedLocations = new Set();
        this.savedPreferences = {}; this.preferenceWrites = Promise.resolve(); this.bindingWrites = Promise.resolve();
        this.vehicleMarker = ''; this.bindingReady = false;
    }

    async define(id, type, role, initial, write = false, observedDomain = null, extra = {}) {
        const a = this.adapter;
        const segments = id.split('.');
        for (let length = 1; length < segments.length; length++) {
            const channel = segments.slice(0, length).join('.');
            await a.setObjectNotExistsAsync(channel, { type: 'channel', common: { name: channel }, native: {} });
        }
        await a.setObjectNotExistsAsync(id, { type: 'state', common: { name: id, type, role, read: true, write, ...extra }, native: {} });
        a.stateDefinitions[id] = [type, role, initial, write];
        if (observedDomain) {
            a.domainStates[observedDomain] ||= [];
            if (!a.domainStates[observedDomain].includes(id)) a.domainStates[observedDomain].push(id);
        }
        if (!a.cachedStates.has(id)) await a.state(id, observedDomain || initial === null ? { val: initial, ack: true, q: 0x82 } : initial);
    }

    async group(id, kind, scope, keys) {
        if (this.groups.has(id)) return this.groups.get(id);
        if (this.groupDefinitions.has(id)) return this.groupDefinitions.get(id);
        const pending = this.defineGroup(id, kind, scope, keys); this.groupDefinitions.set(id, pending);
        try { return await pending; }
        catch (error) {
            if (this.groupDefinitions.get(id) === pending) this.groupDefinitions.delete(id);
            throw error;
        }
    }
    async defineGroup(id, kind, scope, keys) {
        const group = { id, kind, scope, keys, values: Object.fromEntries(keys.map(key => [key, null])),
            ready: Object.fromEntries(keys.map(key => [key, true])), failed: {}, tokens: {}, errors: {}, queue: Promise.resolve() };
        const routes = [];
        for (const key of keys) {
            const type = key === 'time' || key === 'days' || key === 'name' ? 'string' : 'boolean';
            const suffix = kind === 'preferred' ? 'targetEnabled' : TARGET_NAMES[key];
            const path = kind === 'preferred' ? id + '.window' + key + '.' + suffix : id + '.' + suffix;
            group.paths ||= {}; group.paths[key] = path;
            await this.define(path, type, key === 'days' ? 'json' : key === 'name' || key === 'time' ? 'text' : 'switch', null, true);
            routes.push([path, { group, key }]);
        }
        await this.define(id + '.targetError', 'string', 'text', '');
        for (const command of ['apply', 'clear']) {
            const path = id + '.commands.' + command;
            await this.define(path, 'boolean', 'button', false, true);
            routes.push([path, { group, command }]);
        }
        this.restoreGroup(group);
        await this.publishGroup(group);
        this.groups.set(id, group);
        for (const [path, route] of routes) this.routes.set(path, route);
        return group;
    }

    restoreGroup(group) {
        const saved = this.savedPreferences[group.id];
        if (saved === undefined) return;
        try {
            const input = record(saved, group.keys);
            for (const key of group.keys) {
                try {
                    const entry = record(input[key], ['value', 'token']);
                    check(Object.keys(entry).length === 2 && (entry.token === null || typeof entry.token === 'string' && /^[a-f0-9]{64}(?::[0-9]+)?$/.test(entry.token)));
                    group.values[key] = this.validateField(group, key, entry.value);
                    group.tokens[key] = entry.token;
                } catch (_) { this.damage(group, key); }
            }
        } catch (_) { for (const key of group.keys) this.damage(group, key); }
    }
    damage(group, key) {
        group.ready[key] = false; group.failed[key] = true; group.errors[key] = 'departure_selection_failed';
        if (!this.savedPreferences[group.id] || typeof this.savedPreferences[group.id] !== 'object' || Array.isArray(this.savedPreferences[group.id])) this.savedPreferences[group.id] = {};
        this.savedPreferences[group.id][key] = { invalid: true };
    }
    validateField(group, key, value) {
        if (group.kind === 'timer') return key === 'days' ? parseTimerDaysState(value) : validateTimerField(key, value);
        if (group.kind === 'settings') return validateLocationTargets({ [key]: value })[key];
        return boolean(value);
    }
    token(scope) {
        if (scope === 'climate') return this.vehicleMarker ? hash(this.vehicleMarker) : null;
        const binding = this.bindings[scope];
        return binding?.present && binding.verified && this.bindingReady ? hash(JSON.stringify([binding.vehicleHash, binding.nativeId, binding.epoch])) + ':' + binding.generation : null;
    }
    async publishGroup(group) {
        const token = this.token(group.scope);
        const errors = [];
        for (const key of group.keys) {
            const changed = group.values[key] !== null && (token === null || group.tokens[key] !== token);
            if (changed) errors.push(key + ': departure_binding_changed');
            if (group.errors[key]) errors.push(key + ': ' + group.errors[key]);
            const value = key === 'days' ? serializeTimerDaysState(group.values[key]) : group.values[key];
            await this.adapter.state(group.paths[key], !group.ready[key] || changed ? { val: value, ack: true, q: 0x82 } : value);
        }
        await this.adapter.state(group.id + '.targetError', errors.join('; '));
    }

    stage(group, patch) {
        const keys = Object.keys(patch), token = this.token(group.scope);
        const update = this.preferenceWrites.then(async () => {
            try {
                const values = Object.fromEntries(keys.map(key => { check(group.keys.includes(key)); return [key, this.validateField(group, key, patch[key])]; }));
                const saved = clone(this.savedPreferences), entry = { ...(saved[group.id] || {}) };
                for (const key of group.keys) if (!Object.hasOwn(entry, key)) entry[key] = group.ready[key] ? { value: null, token: null } : { invalid: true };
                for (const key of keys) entry[key] = { value: values[key], token: values[key] === null ? null : token };
                saved[group.id] = entry;
                check(Buffer.byteLength(JSON.stringify({ version: 1, groups: saved }, null, 2)) <= 65536);
                await this.adapter.store.write(PREF_FILE, { version: 1, groups: saved });
                this.savedPreferences = saved;
                for (const key of keys) {
                    group.values[key] = values[key]; group.tokens[key] = values[key] === null ? null : token;
                    group.ready[key] = true; group.failed[key] = false; delete group.errors[key];
                }
                await this.publishGroup(group);
            } catch (error) {
                const safe = publicError(error);
                for (const key of keys) { group.failed[key] = true; group.errors[key] = safe.code; }
                await this.publishGroup(group);
                throw error;
            }
        });
        const barrier = update.catch(() => {});
        this.preferenceWrites = barrier; group.queue = barrier;
        return update;
    }
    snapshot(group) {
        return group.queue.then(() => ({ values: clone(group.values), ready: { ...group.ready }, failed: { ...group.failed }, tokens: { ...group.tokens } }));
    }

    async init() {
        const a = this.adapter;
        this.vehicleMarker = (await a.enrollment()).profile?.vehicleMarker || '';
        try {
            const preferences = await a.store.read(PREF_FILE, { version: 1, groups: {} });
            check(preferences.version === 1); plain(preferences.groups);
            check(Object.keys(preferences.groups).length <= 322);
            this.savedPreferences = preferences.groups;
        } catch (_) { this.preferenceDamaged = true; }
        try {
            const saved = await a.store.read(BINDING_FILE, { version: 1, locations: {} });
            check(saved.version === 1); plain(saved.locations); check(Object.keys(saved.locations).length <= 64);
            for (const [key, item] of Object.entries(saved.locations)) {
                const binding = record(item, ['nativeId', 'name', 'vehicleHash', 'epoch', 'generation', 'present']);
                check(/^loc_[a-f0-9]{24}$/.test(key) && typeof binding.vehicleHash === 'string' && /^[a-f0-9]{64}$/.test(binding.vehicleHash)
                    && typeof binding.epoch === 'string' && /^[a-f0-9]{64}$/.test(binding.epoch)
                    && Number.isSafeInteger(binding.generation) && binding.generation >= 1 && typeof binding.present === 'boolean');
                nativeId(binding.nativeId); nameValue(binding.name);
                this.bindings[key] = { ...binding, verified: false };
            }
            this.bindingReady = true;
        } catch (_) { this.bindings = {}; this.bindingReady = false; }
        for (const [domain, action] of Object.entries(READ_ACTIONS)) await a.ensureReadDomain(domain, action);
        for (const [name, action] of [['refreshDepartureClimate', READ_ACTIONS.departureClimate], ['refreshDepartureLocations', READ_ACTIONS.departureLocations]]) {
            const path = 'commands.' + name;
            await this.define(path, 'boolean', 'button', false, true); this.routes.set(path, { action });
        }
        await this.define('departures.climate.observedAt', 'string', 'date', '');
        for (const id of ['1', '2']) await this.timer('departures.climate.timer' + id, 'climate', 'departureClimate', false);
        await this.define('chargingLocations.count', 'number', 'value', null, false, 'departureLocations');
        await this.define('chargingLocations.json', 'string', 'json', '', false, 'departureLocations');
        await this.define('chargingLocations.observedAt', 'string', 'date', '');
        for (const [key, binding] of Object.entries(this.bindings)) if (binding.vehicleHash === hash(this.vehicleMarker)) await this.location(key);
        if (this.preferenceDamaged) for (const group of this.groups.values()) {
            for (const key of group.keys) this.damage(group, key);
            await this.publishGroup(group);
        }
        await a.subscribeStatesAsync('departures.*'); await a.subscribeStatesAsync('chargingLocations.*');
    }

    async timer(path, scope, domain, charging) {
        const fields = { enabled: ['boolean', 'indicator'], time: ['string', 'text'], days: ['string', 'json'], repeat: ['boolean', 'indicator'],
            date: ['string', 'date'], vehicleOffset: ['string', 'text'], isLocalVehicleTime: ['boolean', 'indicator'],
            source: ['string', 'text'], daysSummary: ['string', 'text'], daysSummaryRecognized: ['boolean', 'indicator'] };
        if (charging) Object.assign(fields, { climatisation: ['boolean', 'indicator'], profileId: ['string', 'text'], isPreferredTimesAvailable: ['boolean', 'indicator'] });
        for (const [key, [type, role]] of Object.entries(fields)) await this.define(path + '.' + key, type, role, null, false, domain);
        await this.group(path, 'timer', scope, TIMER_KEYS);
    }
    async location(key) {
        if (this.locationDefinitions.has(key)) return this.locationDefinitions.get(key);
        const pending = this.defineLocation(key); this.locationDefinitions.set(key, pending);
        try { return await pending; }
        catch (error) {
            if (this.locationDefinitions.get(key) === pending) this.locationDefinitions.delete(key);
            throw error;
        }
    }
    async defineLocation(key) {
        const a = this.adapter, path = 'chargingLocations.' + key, domain = 'departureLocation_' + key;
        await a.ensureReadDomain(domain, 'departuresLocationStatus');
        for (const [field, type, initial] of [['name', 'string', null], ['present', 'boolean', null], ['activeTimerCount', 'number', null]]) {
            await this.define(path + '.' + field, type, type === 'string' ? 'text' : type === 'boolean' ? 'indicator' : 'value', initial, false, 'departureLocations');
        }
        await this.define(path + '.bindingStatus', 'string', 'text', 'unknown');
        await this.define(path + '.observedAt', 'string', 'date', '');
        await this.define(path + '.commands.refresh', 'boolean', 'button', false, true);
        this.routes.set(path + '.commands.refresh', { action: 'departuresLocationStatus', locationKey: key });
        for (const id of ['1', '2', '3']) await this.timer(path + '.timer' + id, key, domain, true);
        for (const [field, type] of [['name', 'string'], ['directSoc', 'number'], ['socLimit', 'number'], ['reducedAcCurrent', 'boolean'], ['autoUnlockAc', 'boolean']]) {
            await this.define(path + '.settings.' + field, type, type === 'number' ? 'value.battery' : type === 'boolean' ? 'indicator' : 'text', null, false, domain,
                type === 'number' ? { unit: '%', min: 0, max: 100 } : {});
        }
        await this.define(path + '.settings.socReadCapability', 'string', 'text', null, false, domain);
        await this.group(path + '.settings', 'settings', key, LOCATION_KEYS);
        await this.group(path + '.preferredTimes', 'preferred', key, ['1', '2', '3', '4']);
        for (const id of ['1', '2', '3', '4']) for (const [field, type] of [['start', 'string'], ['end', 'string'], ['enabled', 'boolean'], ['editable', 'boolean']]) {
            await this.define(path + '.preferredTimes.window' + id + '.' + field, type, type === 'boolean' ? 'indicator' : 'text', null, false, domain);
        }
        await this.define(path + '.preferredTimes.notice', 'string', 'text', null, false, domain);
        this.completedLocations.add(key);
    }

    domains() {
        return [...Object.keys(READ_ACTIONS), ...Object.entries(this.bindings)
            .filter(([key, binding]) => this.completedLocations.has(key) && binding.present && binding.verified && binding.vehicleHash === hash(this.vehicleMarker))
            .map(([key]) => 'departureLocation_' + key)];
    }
    async setVehicleMarker(marker) {
        if (marker === this.vehicleMarker) return;
        this.vehicleMarker = marker;
        for (const binding of Object.values(this.bindings)) binding.verified = false;
        for (const domain of Object.keys(this.adapter.readFreshness).filter(domain => domain.startsWith('departure'))) {
            await this.adapter.markReadDomainStale(domain, 'departure_binding_changed');
        }
        for (const group of this.groups.values()) await this.publishGroup(group);
        this.adapter.syncReadDomains();
    }
    async bindingsSave(next) {
        const locations = Object.fromEntries(Object.entries(next).map(([key, { verified, ...value }]) => [key, value]));
        const previous = Object.fromEntries(Object.entries(this.bindings).map(([key, { verified, ...value }]) => [key, value]));
        const update = this.bindingWrites.then(() => this.bindingReady && JSON.stringify(locations) === JSON.stringify(previous)
            ? undefined : this.adapter.store.write(BINDING_FILE, { version: 1, locations }));
        this.bindingWrites = update.catch(() => {}); await update;
        this.bindings = next; this.bindingReady = true;
    }
    async inventory(result) {
        check(Array.isArray(result.locations) && result.locations.length <= 5, 'invalid_departures_result');
        const rows = [], ids = new Set(), names = new Set();
        for (const item of result.locations) {
            const row = record(item, ['nativeId', 'name', 'activeCount']);
            nativeId(row.nativeId); nameValue(row.name);
            check(Number.isSafeInteger(row.activeCount) && row.activeCount >= 0 && row.activeCount <= 3
                && !ids.has(row.nativeId) && !names.has(row.name), 'invalid_departures_result');
            ids.add(row.nativeId); names.add(row.name); rows.push(row);
        }
        const next = clone(this.bindings), vehicleHash = hash(this.vehicleMarker), values = {}, changedKeys = new Set();
        for (const binding of Object.values(next)) binding.verified = false;
        for (const row of rows) {
            const key = localKey(this.vehicleMarker, row.nativeId), prior = next[key];
            const changed = prior && (!prior.present || prior.name !== row.name);
            if (changed) changedKeys.add(key);
            next[key] = { nativeId: row.nativeId, name: row.name, vehicleHash, epoch: prior?.epoch || crypto.randomBytes(32).toString('hex'), generation: prior ? prior.generation + (changed ? 1 : 0) : 1,
                present: true, verified: true };
        }
        check(Object.keys(next).length <= 64, 'invalid_departures_result');
        for (const binding of Object.values(next)) {
            if (binding.vehicleHash !== vehicleHash) continue;
            if (!ids.has(binding.nativeId)) {
                if (binding.present) binding.generation++;
                binding.present = false;
            }
        }
        await this.bindingsSave(next);
        for (const [key, binding] of Object.entries(next)) {
            if (binding.vehicleHash !== vehicleHash) continue;
            await this.location(key);
            const path = 'chargingLocations.' + key, row = rows.find(item => item.nativeId === binding.nativeId);
            values[path + '.name'] = binding.present ? binding.name : { val: binding.name, ack: true, q: 0x82 }; values[path + '.present'] = binding.present;
            values[path + '.activeTimerCount'] = row?.activeCount ?? null;
            await this.adapter.state(path + '.bindingStatus', binding.present ? 'bound' : 'removed');
            for (const group of this.groups.values()) if (group.scope === key) await this.publishGroup(group);
            if (!binding.present) await this.adapter.markReadDomainStale('departureLocation_' + key, 'departure_location_removed');
            else if (changedKeys.has(key)) await this.adapter.markReadDomainStale('departureLocation_' + key, 'departure_binding_changed');
        }
        values['chargingLocations.count'] = rows.length;
        values['chargingLocations.json'] = JSON.stringify(rows.map(row => ({ localKey: localKey(this.vehicleMarker, row.nativeId), name: row.name, activeCount: row.activeCount })));
        values['chargingLocations.observedAt'] = result.observedAt;
        await this.adapter.publishObservation('departureLocations', values, result);
        this.adapter.syncReadDomains();
    }

    timerValues(timer, path, charging) {
        const extras = ['daysSummary', 'daysSummaryRecognized', ...(charging ? ['climatisation', 'profileId', 'isPreferredTimesAvailable'] : [])];
        const core = Object.fromEntries(Object.entries(timer).filter(([key]) => !extras.includes(key)));
        const normalized = normalizeObservedTimer(core);
        check(typeof timer.daysSummary === 'string' && timer.daysSummary.length <= 200 && typeof timer.daysSummaryRecognized === 'boolean', 'invalid_departures_result');
        const values = Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== 'id').map(([key, value]) => [path + '.' + key, key === 'days' ? JSON.stringify(value) : value]));
        values[path + '.daysSummary'] = timer.daysSummary; values[path + '.daysSummaryRecognized'] = timer.daysSummaryRecognized;
        if (charging) {
            boolean(timer.climatisation, false); boolean(timer.isPreferredTimesAvailable, false); nativeId(timer.profileId);
            for (const key of ['climatisation', 'profileId', 'isPreferredTimesAvailable']) values[path + '.' + key] = timer[key];
        }
        return values;
    }
    async observe(result, plan) {
        try {
            check(result && typeof result === 'object' && !Array.isArray(result) && result.source === 'volkswagen_android_app'
                && result.vehicleConfirmed === false && typeof result.appVersion === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(result.appVersion)
                && iso(result.observedAt), 'invalid_departures_result');
            if (plan.domain === 'departureLocations') { check(result.domain === 'departureLocations', 'invalid_departures_result'); return await this.inventory(result); }
            const charging = plan.domain.startsWith('departureLocation_');
            check(result.domain === (charging ? 'departureLocation' : 'departureClimate')
                && Array.isArray(result.timers) && result.timers.length === (charging ? 3 : 2), 'invalid_departures_result');
            const base = charging ? 'chargingLocations.' + plan.locationKey : 'departures.climate', values = {};
            const ids = new Set();
            for (const timer of result.timers) {
                check(timer && typeof timer === 'object' && ['1', '2', ...(charging ? ['3'] : [])].includes(timer.id) && !ids.has(timer.id), 'invalid_departures_result');
                ids.add(timer.id); Object.assign(values, this.timerValues(timer, base + '.timer' + timer.id, charging));
            }
            if (charging) {
                check(result.location?.nativeId === plan.location.nativeId, 'invalid_departures_result');
                const name = nameValue(result.location.name);
                check(name === plan.location.name || plan.action === 'applyDepartureLocationSettings' && plan.options?.targetSettings?.name === name, 'invalid_departures_result');
                if (name !== plan.location.name) check(result.renamedFrom === plan.location.name, 'invalid_departures_result');
                const settings = record(result.settings, ['name', 'directSoc', 'socLimit', 'reducedAcCurrent', 'autoUnlockAc']);
                check(settings.name === name && settings.directSoc === null && settings.socLimit === null, 'invalid_departures_result');
                boolean(settings.reducedAcCurrent, false); boolean(settings.autoUnlockAc, false);
                for (const [key, value] of Object.entries(settings)) values[base + '.settings.' + key] = value;
                values[base + '.settings.socReadCapability'] = 'not_exposed_by_app';
                const preferred = record(result.preferredTimes, ['windows', 'notice']);
                check(Array.isArray(preferred.windows) && preferred.windows.length === 4 && (preferred.notice === null || typeof preferred.notice === 'string' && preferred.notice.length <= 1000), 'invalid_departures_result');
                const windows = new Set();
                for (const window of preferred.windows) {
                    const item = record(window, ['id', 'start', 'end', 'enabled', 'editable']);
                    check(['1', '2', '3', '4'].includes(item.id) && !windows.has(item.id) && item.editable === false, 'invalid_departures_result');
                    windows.add(item.id); validateTimerField('time', item.start); validateTimerField('time', item.end); boolean(item.enabled, false);
                    for (const key of ['start', 'end', 'enabled', 'editable']) values[base + '.preferredTimes.window' + item.id + '.' + key] = item[key];
                }
                values[base + '.preferredTimes.notice'] = preferred.notice;
                for (const timer of result.timers) check(timer.profileId === plan.location.nativeId, 'invalid_departures_result');
                if (name !== this.bindings[plan.locationKey]?.name) {
                    const next = clone(this.bindings), binding = next[plan.locationKey];
                    check(binding && binding.name === plan.location.name, 'departure_binding_changed');
                    binding.name = name; binding.generation++; await this.bindingsSave(next);
                    await this.adapter.markReadDomainStale('departureLocations', 'departure_binding_changed');
                    for (const group of this.groups.values()) if (group.scope === plan.locationKey) await this.publishGroup(group);
                }
            }
            values[base + '.observedAt'] = result.observedAt;
            await this.adapter.publishObservation(plan.domain, values, result);
        } catch (error) {
            if (error instanceof BridgeError && ['state_not_saved', 'departure_binding_changed'].includes(error.code)) throw error;
            throw fail('invalid_departures_result');
        }
    }

    plan(action, input = {}) {
        const isLocation = ['departuresLocationStatus', 'applyDepartureLocationTimer', 'applyDepartureLocationSettings', 'applyDeparturePreferredTimes'].includes(action);
        const locationKey = isLocation ? input.locationKey : null, binding = isLocation ? this.bindings[locationKey] : null;
        const domain = isLocation ? 'departureLocation_' + locationKey : action === 'departuresLocationsStatus' ? 'departureLocations' : 'departureClimate';
        check(Object.values(READ_ACTIONS).includes(action) || action === 'departuresLocationStatus' || WRITE_ACTIONS.includes(action));
        if (isLocation) check(binding && binding.present && binding.verified && binding.vehicleHash === hash(this.vehicleMarker), 'departure_binding_changed');
        const base = isLocation ? 'chargingLocations.' + locationKey : 'departures.climate';
        let group;
        if (action.endsWith('Timer')) {
            check((isLocation ? ['1', '2', '3'] : ['1', '2']).includes(input.timerId));
            group = this.groups.get(base + '.timer' + input.timerId);
        } else if (action === 'applyDepartureLocationSettings') group = this.groups.get(base + '.settings');
        else if (action === 'applyDeparturePreferredTimes') group = this.groups.get(base + '.preferredTimes');
        const selected = group ? this.snapshot(group) : Promise.resolve(null);
        return { action, domain, locationKey, location: binding ? { nativeId: binding.nativeId, name: binding.name } : null,
            token: group ? this.token(group.scope) : null,
            prepare: async saved => {
                check(saved.profile?.vehicleMarker === this.vehicleMarker, 'departure_binding_changed');
                const current = binding ? this.bindings[locationKey] : null;
                if (binding) check(current?.present && current.verified && current.name === binding.name && current.generation === binding.generation, 'departure_binding_changed');
                const options = binding ? { location: { nativeId: binding.nativeId, name: binding.name } } : {};
                const snapshot = await selected;
                if (group) {
                    check(group.keys.every(key => snapshot.ready[key] && !snapshot.failed[key]), 'departure_selection_failed');
                    check(group.keys.some(key => snapshot.values[key] !== null), 'departure_settings_required');
                    check(this.token(group.scope) !== null && this.token(group.scope) === (binding ? hash(JSON.stringify([binding.vehicleHash, binding.nativeId, binding.epoch])) + ':' + binding.generation : hash(this.vehicleMarker))
                        && group.keys.every(key => snapshot.values[key] === null || snapshot.tokens[key] === this.token(group.scope)), 'departure_binding_changed');
                    if (!this.adapter.settings.allowWrites) throw new BridgeError('writes_disabled', 'Das Ã„ndern der Fahrzeugeinstellungen ist ausgeschaltet.');
                    if (group.kind === 'timer') Object.assign(options, { timerId: input.timerId, targetTimer: validateTimerTargets(snapshot.values) });
                    if (group.kind === 'settings') options.targetSettings = validateLocationTargets(snapshot.values);
                    if (group.kind === 'preferred') options.targetPreferredTimes = validatePreferredTargets(group.keys.map(id => ({ id, enabled: snapshot.values[id] })));
                }
                return options;
            } };
    }

    async stateChange(id, state) {
        const prefix = this.adapter.namespace + '.';
        if (!id.startsWith(prefix)) return false;
        const route = this.routes.get(id.slice(prefix.length));
        if (!route) return false;
        if (route.key) { await this.stage(route.group, { [route.key]: state.val }).catch(() => {}); return true; }
        if (state.val !== true) return true;
        await this.adapter.state(id.slice(prefix.length), false);
        if (route.action) await this.adapter.departureCommand(route.action, { locationKey: route.locationKey }).catch(() => {});
        else if (route.command === 'clear') await this.stage(route.group, Object.fromEntries(route.group.keys.map(key => [key, null]))).catch(() => {});
        else {
            const group = route.group, isLocation = group.scope !== 'climate';
            const action = group.kind === 'timer' ? isLocation ? 'applyDepartureLocationTimer' : 'applyDepartureClimateTimer'
                : group.kind === 'settings' ? 'applyDepartureLocationSettings' : 'applyDeparturePreferredTimes';
            await this.adapter.departureCommand(action, { locationKey: isLocation ? group.scope : undefined,
                ...(group.kind === 'timer' ? { timerId: group.id.match(/timer([123])$/)[1] } : {}) }).catch(() => {});
        }
        return true;
    }
}

module.exports = { DeparturesAdapter, READ_ACTIONS, WRITE_ACTIONS, TIMER_KEYS, LOCATION_KEYS, DEFAULT_TARGET_LOCATION,
    validateLocationTargets, validatePreferredTargets, localKey };
