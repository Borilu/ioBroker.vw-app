'use strict';

// One persistent, non-sensitive marker per runtime instance. It contains no
// command, device identity, endpoint, input or output. Recovery must verify
// host AND Android-side quiescence before removing it; this module deliberately
// provides no automatic recovery or reset.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { BridgeError } = require('./errors');

function blocked() {
    return new BridgeError('adb_execution_fenced',
        'An Android command may still be active. Further phone work is blocked pending explicit recovery.');
}
async function syncDirectory(directory) {
    const handle = await fs.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
}
class ExecutionFence {
    constructor(dataDir) { this.dataDir = dataDir; this.file = path.join(dataDir, 'adb-execution-fence.json'); }
    async assertClear() {
        try { await fs.lstat(this.file); throw blocked(); }
        catch (err) { if (err?.code !== 'ENOENT') throw blocked(); }
    }
    async acquire() {
        try {
            await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
            const token = crypto.randomBytes(16).toString('hex');
            const handle = await fs.open(this.file, 'wx', 0o600);
            try { await handle.writeFile(JSON.stringify({ version: 1, token }), 'utf8'); await handle.sync(); }
            finally { await handle.close(); }
            await syncDirectory(this.dataDir);
            return token;
        } catch (_) { throw blocked(); }
    }
    async release(token) {
        try {
            if (!/^[a-f0-9]{32}$/.test(token || '')) throw blocked();
            const stat = await fs.lstat(this.file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) throw blocked();
            const record = JSON.parse(await fs.readFile(this.file, 'utf8'));
            if (record?.version !== 1 || record.token !== token) throw blocked();
            await fs.unlink(this.file);
            await syncDirectory(this.dataDir);
        } catch (_) { throw blocked(); }
    }
}
module.exports = { ExecutionFence, blocked };
