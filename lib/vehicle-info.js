'use strict';

const { BridgeError } = require('./errors');
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

function isVin(value) {
    return typeof value === 'string' && VIN.exec(value)?.[0] === value;
}

function validateVehicleInfo(value) {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
        const keys = Reflect.ownKeys(value);
        if (keys.length !== 1 || keys[0] !== 'vin') throw new Error();
        const descriptor = Object.getOwnPropertyDescriptor(value, 'vin');
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !isVin(descriptor.value)) throw new Error();
        return { vin: descriptor.value };
    } catch (_) {
        throw new BridgeError('invalid_state', 'Die FIN des ausgewählten Fahrzeugs ist nicht eindeutig lesbar.');
    }
}

module.exports = { isVin, validateVehicleInfo };
