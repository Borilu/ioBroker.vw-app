'use strict';

const { BridgeError } = require('./errors');

const SETTINGS_KEYS = Object.freeze(['mode', 'climateOnUnlock', 'autoWindowHeating', 'zones']);
const DEFAULT_TARGET_SETTINGS = Object.freeze({ mode: null, climateOnUnlock: null, autoWindowHeating: null, zones: null });
const MODES = Object.freeze(['climate', 'windowHeating']);
const ZONES = Object.freeze(['frontLeft', 'frontRight', 'both']);

function isSettingValue(key, value) {
    if (!SETTINGS_KEYS.includes(key)) return false;
    if (value === null) return true;
    if (key === 'mode') return MODES.includes(value);
    if (key === 'zones') return ZONES.includes(value);
    return typeof value === 'boolean';
}

function validateSetting(key, value) {
    if (isSettingValue(key, value)) return value;
    throw new BridgeError('invalid_settings', 'Select a supported climate setting, or null to keep the app setting.');
}

function isObservedSettingValue(key, value) {
    return key === 'zones' && value === 'none' || isSettingValue(key, value);
}

function validateTargetSettings(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !SETTINGS_KEYS.includes(key))) {
        throw new BridgeError('invalid_settings', 'The desired climate settings are invalid.');
    }
    const selected = { ...DEFAULT_TARGET_SETTINGS };
    for (const key of SETTINGS_KEYS) {
        if (Object.prototype.hasOwnProperty.call(value, key)) selected[key] = validateSetting(key, value[key]);
    }
    return selected;
}

module.exports = { SETTINGS_KEYS, DEFAULT_TARGET_SETTINGS, MODES, ZONES, isSettingValue, isObservedSettingValue, validateSetting, validateTargetSettings };
