'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { BridgeError } = require('./errors');

class StateStore {
    constructor(dataDir) { this.dataDir = dataDir; }
    file(name) {
        if (!['enrollment', 'command-journal', 'temperature-preference', 'settings-preference', 'charging-preference',
            'departure-preference', 'departure-location-bindings', 'security-auth-state'].includes(name)) throw new BridgeError('invalid_state', 'Unknown data file.');
        return path.join(this.dataDir, name + '.json');
    }
    async read(name, fallback = null) {
        try {
            const file = this.file(name);
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid data file');
            const value = JSON.parse(await fs.readFile(file, 'utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid data');
            return value;
        } catch (error) {
            if (error.code === 'ENOENT') return fallback;
            throw new BridgeError('invalid_state', 'A private adapter data file is invalid. Inspect it before sending commands.');
        }
    }
    async write(name, value) {
        const file = this.file(name);
        const temporary = file + '.' + crypto.randomUUID() + '.tmp';
        try {
            await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
            const handle = await fs.open(temporary, 'wx', 0o600);
            try { await handle.writeFile(JSON.stringify(value, null, 2), 'utf8'); await handle.sync(); }
            finally { await handle.close(); }
            await fs.rename(temporary, file);
        } catch (_) {
            await fs.unlink(temporary).catch(() => {});
            throw new BridgeError('state_not_saved', 'Private adapter data could not be saved. No command was sent.');
        }
    }
    async reserveCommand(cooldownSeconds) {
        const previous = await this.read('command-journal', { lastAttempt: 0 });
        if (typeof previous.lastAttempt !== 'number' || !Number.isFinite(previous.lastAttempt) || previous.lastAttempt < 0) throw new BridgeError('invalid_state', 'The command journal is invalid.');
        const now = Date.now();
        if (now - previous.lastAttempt < cooldownSeconds * 1000) throw new BridgeError('cooldown', 'Wait at least 60 seconds between switching attempts.');
        await this.write('command-journal', { lastAttempt: now });
    }
}

module.exports = { StateStore };
