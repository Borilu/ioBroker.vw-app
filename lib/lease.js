'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const lockfile = require('proper-lockfile');
const { BridgeError } = require('./errors');

class DeviceLease {
    constructor(onCompromised = () => {}) { this.release = null; this.deviceId = null; this.onCompromised = onCompromised; }
    async acquire(deviceId) {
        if (this.deviceId === deviceId && this.release) return;
        if (this.release) throw new BridgeError('wrong_device', 'Stop this instance before selecting another phone.');
        const parent = path.join(os.tmpdir(), 'iobroker-vw-app-' + (process.getuid?.() ?? 'user'));
        await fs.mkdir(parent, { recursive: true, mode: 0o700 });
        const file = path.join(parent, crypto.createHash('sha256').update(deviceId).digest('hex'));
        try {
            this.release = await lockfile.lock(file, {
                realpath: false, retries: 0, stale: 30000, update: 10000,
                onCompromised: () => { this.release = null; this.deviceId = null; this.onCompromised(); },
            });
            this.deviceId = deviceId;
        } catch (_) { throw new BridgeError('device_busy', 'Another adapter instance controls this phone. Stop it first.'); }
    }
    async close() {
        const release = this.release; this.release = null; this.deviceId = null;
        if (release) await release().catch(() => {});
    }
}

module.exports = { DeviceLease };
