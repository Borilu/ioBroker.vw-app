'use strict';
const net = require('node:net');
const { BridgeError } = require('./errors');

function integer(value, min, max, code = 'invalid_config') {
    if (typeof value === 'string' && /^[0-9]+$/.exec(value)?.[0] === value) value = Number(value);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new BridgeError(code, 'A numeric setting is outside its allowed range.');
    return value;
}

function validateHost(value) {
    if (typeof value !== 'string' || value.includes('%') || !net.isIP(value) || value === '0.0.0.0' || value === '::'
        || net.isIP(value) === 4 && Number(value.split('.')[0]) >= 224
        || net.isIP(value) === 6 && (/^ff/i.test(value) || new URL(`http://[${value}]/`).hostname === '[::]')) {
        throw new BridgeError('invalid_wifi_endpoint', 'Enter the phone IP address, without a hostname, spaces or port.');
    }
    return value;
}

function endpoint(hostIp, port) {
    validateHost(hostIp);
    port = integer(port, 1, 65535, 'invalid_wifi_endpoint');
    return net.isIP(hostIp) === 6 ? `[${hostIp}]:${port}` : `${hostIp}:${port}`;
}

function validateEndpoint(value) {
    if (typeof value !== 'string') throw new BridgeError('invalid_wifi_endpoint', 'Invalid phone endpoint.');
    const m = /^(?:\[([0-9a-fA-F:]+)\]|([0-9.]+)):([0-9]{1,5})$/.exec(value);
    if (!m || endpoint(m[1] || m[2], m[3]) !== value) throw new BridgeError('invalid_wifi_endpoint', 'Use a numeric IP address and connection port.');
    return value;
}

function normalizeConfig(native = {}) {
    for (const key of ['allowWrites', 'useBundledAdb', 'stayAwakeOnCharge']) {
        if (native[key] !== undefined && typeof native[key] !== 'boolean') throw new BridgeError('invalid_config', `Invalid ${key} setting.`);
    }
    const cfg = {
        hostIp: native.hostIp || '', connectPort: native.connectPort ?? 0,
        approvedAppVersion: native.approvedAppVersion || '', vehicleMarker: native.vehicleMarker || '',
        modeTitles: native.modeTitles || 'Klimatisierung|Air conditioning',
        allowWrites: native.allowWrites === true, useBundledAdb: native.useBundledAdb !== false,
        adbPath: native.adbPath || '', commandTimeoutSeconds: native.commandTimeoutSeconds ?? 300,
        outcomeTimeoutSeconds: native.outcomeTimeoutSeconds ?? 120,
        cooldownSeconds: native.cooldownSeconds ?? 60, pollIntervalSeconds: native.pollIntervalSeconds ?? 0,
        refreshMaxAgeSeconds: native.refreshMaxAgeSeconds ?? 0,
        stayAwakeOnCharge: native.stayAwakeOnCharge === true, legacyStatePrefix: native.legacyStatePrefix || '',
    };
    for (const key of ['hostIp', 'approvedAppVersion', 'vehicleMarker', 'modeTitles', 'adbPath', 'legacyStatePrefix']) {
        if (typeof cfg[key] !== 'string' || cfg[key].length > 512 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(cfg[key])) throw new BridgeError('invalid_config', 'Invalid configuration text.');
    }
    if (cfg.hostIp) validateHost(cfg.hostIp);
    cfg.connectPort = integer(cfg.connectPort, 0, 65535);
    cfg.commandTimeoutSeconds = integer(cfg.commandTimeoutSeconds, 30, 360);
    cfg.outcomeTimeoutSeconds = integer(cfg.outcomeTimeoutSeconds, 30, 150);
    cfg.cooldownSeconds = integer(cfg.cooldownSeconds, 60, 3600);
    cfg.pollIntervalSeconds = integer(cfg.pollIntervalSeconds, 0, 86400);
    if (cfg.pollIntervalSeconds && cfg.pollIntervalSeconds < 15) throw new BridgeError('invalid_config', 'Automatic app reads need at least 15 seconds between completion and the next due time for each area.');
    cfg.refreshMaxAgeSeconds = integer(cfg.refreshMaxAgeSeconds, 0, 86400);
    if (cfg.refreshMaxAgeSeconds && cfg.refreshMaxAgeSeconds < 30) throw new BridgeError('invalid_config', 'The app-read age limit must be automatic (0), or at least 30 seconds.');
    if (cfg.legacyStatePrefix && !/^0_userdata\.0\.[A-Za-z0-9_.-]{1,100}$/.test(cfg.legacyStatePrefix)) throw new BridgeError('invalid_config', 'Compatibility data points must be under 0_userdata.0.');
    cfg.modeTitles = cfg.modeTitles.split('|').map(s => s.trim()).filter(Boolean);
    if (!cfg.modeTitles.length) throw new BridgeError('invalid_config', 'At least one air-conditioning mode title is required.');
    return cfg;
}

module.exports = { integer, validateHost, endpoint, validateEndpoint, normalizeConfig };
