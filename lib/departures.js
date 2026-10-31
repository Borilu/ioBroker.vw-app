'use strict';

const { BridgeError } = require('./errors');

const TIMER_KEYS = Object.freeze(['enabled', 'time', 'days', 'repeat']);
const TIMER_DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const DEFAULT_TARGET_TIMER = Object.freeze({ enabled: null, time: null, days: null, repeat: null });
const OBSERVED_KEYS = ['id', ...TIMER_KEYS, 'date', 'vehicleOffset', 'isLocalVehicleTime', 'source'];

function invalidTimer() {
    return new BridgeError('invalid_departure_timer', 'Die Abfahrtszeit enthält ungültige oder nicht unterstützte Werte.');
}

function requireValue(condition) { if (!condition) throw invalidTimer(); }

function guarded(operation) {
    try { return operation(); }
    catch (_) { throw invalidTimer(); }
}

function record(value, allowed, required = []) {
    requireValue(value !== null && typeof value === 'object'
        && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key];
        requireValue(typeof key === 'string' && allowed.includes(key)
            && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
        result[key] = descriptor.value;
    }
    requireValue(required.every(key => Object.hasOwn(result, key)));
    return result;
}

function dayValues(value) {
    requireValue(Array.isArray(value) && [Array.prototype, null].includes(Object.getPrototypeOf(value)));
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    requireValue(Number.isInteger(length) && length >= 1 && length <= TIMER_DAYS.length
        && Reflect.ownKeys(descriptors).length === length + 1);
    const days = [];
    for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        requireValue(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
        const day = descriptor.value;
        requireValue(TIMER_DAYS.includes(day) && !days.includes(day));
        days.push(day);
    }
    return TIMER_DAYS.filter(day => days.includes(day));
}

function timeValue(value) {
    requireValue(typeof value === 'string'
        && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.exec(value)?.[0] === value);
    return value;
}

function validateTimerField(key, value) {
    return guarded(() => {
        requireValue(TIMER_KEYS.includes(key));
        if (value === null) return null;
        if (key === 'time') return timeValue(value);
        if (key === 'days') return dayValues(value);
        requireValue(typeof value === 'boolean');
        return value;
    });
}

function validateTimerTargets(value = {}) {
    return guarded(() => {
        const input = record(value, TIMER_KEYS);
        const target = { ...DEFAULT_TARGET_TIMER };
        for (const key of TIMER_KEYS) {
            if (Object.hasOwn(input, key)) target[key] = validateTimerField(key, input[key]);
        }
        // Cross-field decisions require a fresh app observation. In particular,
        // staging repeat=false must not silently alter days, date or enabled.
        return target;
    });
}

function parseTimerDaysState(value) {
    return guarded(() => {
        if (typeof value === 'string') {
            requireValue(value.length <= 256);
            value = JSON.parse(value);
        }
        return validateTimerField('days', value);
    });
}

function serializeTimerDaysState(value) {
    const days = validateTimerField('days', value);
    return days === null ? null : JSON.stringify(days);
}

function dateParts(value) {
    requireValue(typeof value === 'string');
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    requireValue(match && match[0] === value);
    const [year, month, day] = match.slice(1).map(Number);
    requireValue(year >= 1 && month >= 1 && month <= 12);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    requireValue(day >= 1 && day <= lengths[month - 1]);
    return { year, month, day };
}

function weekday(value) {
    // Keep vehicle-local calendar dates independent of the adapter host's
    // current date, time zone and daylight-saving transitions.
    let { year, month, day } = dateParts(value);
    if (month < 3) year--;
    const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    const sundayIndex = (year + Math.floor(year / 4) - Math.floor(year / 100)
        + Math.floor(year / 400) + offsets[month - 1] + day) % 7;
    return TIMER_DAYS[(sundayIndex + 6) % 7];
}

function vehicleOffset(value) {
    requireValue(typeof value === 'string');
    if (value === 'Z') return value;
    const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
    requireValue(match && match[0] === value && Number(match[2]) <= 18 && Number(match[3]) <= 59
        && (Number(match[2]) < 18 || Number(match[3]) === 0));
    return value;
}

function normalizeObservedTimer(value) {
    return guarded(() => {
        // Native parsers may supply their timer kind for their own identity
        // check. It is not a writable setting or a vehicle confirmation.
        const input = record(value, [...OBSERVED_KEYS, 'kind'], OBSERVED_KEYS);
        requireValue(['1', '2', '3'].includes(input.id)
            && (!Object.hasOwn(input, 'kind') || ['climate', 'charging'].includes(input.kind))
            && typeof input.enabled === 'boolean' && typeof input.repeat === 'boolean'
            && typeof input.isLocalVehicleTime === 'boolean' && input.source === 'editor_initial_snapshot');
        const time = timeValue(input.time);
        const days = dayValues(input.days);
        if (input.repeat) requireValue(input.date === null);
        else requireValue(days.length === 1 && days[0] === weekday(input.date));
        return { id: input.id, enabled: input.enabled, time, days, repeat: input.repeat, date: input.date,
            vehicleOffset: vehicleOffset(input.vehicleOffset), isLocalVehicleTime: input.isLocalVehicleTime,
            source: 'editor_initial_snapshot' };
    });
}

module.exports = { TIMER_KEYS, TIMER_DAYS, DEFAULT_TARGET_TIMER, validateTimerField, validateTimerTargets,
    parseTimerDaysState, serializeTimerDaysState, normalizeObservedTimer };
