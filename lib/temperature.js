'use strict';

const { BridgeError } = require('./errors');

// Verified numeric picker range; the adjacent LO and HI modes are not supported.
const MIN_TEMPERATURE_CELSIUS = 16;
const MAX_TEMPERATURE_CELSIUS = 29.5;
const TEMPERATURE_STEP_CELSIUS = 0.5;

function isTemperature(value) {
    return typeof value === 'number' && Number.isFinite(value)
        && value >= MIN_TEMPERATURE_CELSIUS && value <= MAX_TEMPERATURE_CELSIUS
        && Number.isInteger((value - MIN_TEMPERATURE_CELSIUS) / TEMPERATURE_STEP_CELSIUS);
}

function validateTargetTemperature(value) {
    if (value === null || isTemperature(value)) return value;
    throw new BridgeError('invalid_temperature', 'Select a supported numeric temperature in 0.5 °C steps, or null to keep the app setting.');
}

module.exports = { MIN_TEMPERATURE_CELSIUS, MAX_TEMPERATURE_CELSIUS,
    TEMPERATURE_STEP_CELSIUS, isTemperature, validateTargetTemperature };
