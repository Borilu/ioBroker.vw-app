'use strict';

const { BridgeError } = require('./errors');

const CHARGING_KEYS = Object.freeze(['socLimit', 'reducedAcCurrent', 'autoUnlockAc', 'optimizedBatteryUse']);
const DEFAULT_TARGET_CHARGING = Object.freeze({ socLimit: null, reducedAcCurrent: null, autoUnlockAc: null, optimizedBatteryUse: null });
const MIN_TARGET_SOC = 50;
const MAX_TARGET_SOC = 100;
// Verified native slider positions: 50, 60, 70, 80, 90 and 100 percent.
const TARGET_SOC_STEP = 10;
const CHARGING_MODES = Object.freeze(['immediate', 'departure', 'departureClimate']);

function isChargingMode(value) {
    return typeof value === 'string' && CHARGING_MODES.includes(value);
}

function validateTargetChargingMode(value) {
    if (value === null || isChargingMode(value)) return value;
    throw new BridgeError('invalid_charging_mode', 'Select immediate, departure or departureClimate, or null to keep the app charging mode.');
}

function isBatterySoc(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isRangeKm(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isChargingValue(key, value) {
    if (!CHARGING_KEYS.includes(key)) return false;
    if (value === null) return true;
    if (key === 'socLimit') return typeof value === 'number' && Number.isFinite(value)
        && Number.isInteger(value) && value >= MIN_TARGET_SOC && value <= MAX_TARGET_SOC
        && Number.isInteger((value - MIN_TARGET_SOC) / TARGET_SOC_STEP);
    return typeof value === 'boolean';
}

function isObservedChargingValue(key, value) {
    return key === 'socLimit' ? isBatterySoc(value) : isChargingValue(key, value);
}

function validateChargingSetting(key, value) {
    if (isChargingValue(key, value)) return value;
    throw new BridgeError('invalid_charging_settings', 'Select a supported numeric charge limit or Boolean charging option, or null to keep the app setting.');
}

function validateTargetCharging(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !CHARGING_KEYS.includes(key))) {
        throw new BridgeError('invalid_charging_settings', 'The desired charging settings are invalid.');
    }
    const target = { ...DEFAULT_TARGET_CHARGING };
    for (const key of CHARGING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(value, key)) target[key] = validateChargingSetting(key, value[key]);
    }
    return target;
}

module.exports = { CHARGING_KEYS, DEFAULT_TARGET_CHARGING, MIN_TARGET_SOC, MAX_TARGET_SOC,
    CHARGING_MODES, isChargingMode, validateTargetChargingMode,
    TARGET_SOC_STEP, isChargingValue, validateChargingSetting, validateTargetCharging,
    isObservedChargingValue, isBatterySoc, isRangeKm };
