'use strict';
// Native process/download deadlines are owned and cleared by this runtime, including during unload.
const nodeTimers = require('node:timers');

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const yauzl = require('yauzl');
const { BridgeError } = require('./errors');
const { validateEndpoint } = require('./network');

const PLATFORM_TOOLS = Object.freeze({
    version: '37.0.1', platform: 'linux', arch: 'x64',
    url: 'https://dl.google.com/android/repository/platform-tools_r37.0.1-linux.zip',
    size: 9054187,
    // Pinned against the official download; Google publishes SHA-1 in repository2-3.xml.
    sha256: 'd230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1',
    licenseUrl: 'https://developer.android.com/tools/releases/platform-tools',
});
const MAX_DOWNLOAD = 50 * 1024 * 1024;
const MAX_EXTRACTED = 200 * 1024 * 1024;
const DEFAULT_OUTPUT = 2 * 1024 * 1024;
const error = (code, message) => new BridgeError(code, message);

function officialUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw error('runtime_download_failed', 'The Android runtime download URL is invalid.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'dl.google.com' || url.port || url.username || url.password) {
        throw error('runtime_download_failed', 'The Android runtime must come from the official HTTPS download host.');
    }
    return url;
}

function downloadBuffer(url, { maxBytes = MAX_DOWNLOAD, timeoutMs = 45000, requestImpl = https.get } = {}) {
    const target = officialUrl(url);
    return new Promise((resolve, reject) => {
        let settled = false;
        let response;
        let request;
        const timer = nodeTimers.setTimeout(() => fail(error('runtime_download_timeout', 'The Android runtime download timed out.')), timeoutMs);
        const finish = (err, value) => {
            if (settled) return;
            settled = true;
            nodeTimers.clearTimeout(timer);
            if (err) reject(err); else resolve(value);
        };
        const fail = err => {
            finish(err);
            response?.destroy();
            request?.destroy();
        };
        try {
            request = requestImpl(target, { headers: { 'User-Agent': 'ioBroker.vw-app', 'Accept-Encoding': 'identity' } }, res => {
                response = res;
                if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
                    return fail(error('runtime_download_failed', 'The Android runtime download was not successful.'));
                }
                const advertised = Number(res.headers['content-length']);
                if (Number.isFinite(advertised) && advertised > maxBytes) {
                    return fail(error('runtime_download_too_large', 'The Android runtime download exceeds its size limit.'));
                }
                let size = 0;
                const chunks = [];
                res.on('data', chunk => {
                    if (settled) return;
                    const bytes = Buffer.from(chunk);
                    size += bytes.length;
                    if (size > maxBytes) return fail(error('runtime_download_too_large', 'The Android runtime download exceeds its size limit.'));
                    chunks.push(bytes);
                });
                res.once('end', () => finish(null, Buffer.concat(chunks, size)));
                res.once('error', () => fail(error('runtime_download_failed', 'The Android runtime download was interrupted.')));
                res.once('aborted', () => fail(error('runtime_download_failed', 'The Android runtime download was interrupted.')));
            });
            request.once('error', () => fail(error('runtime_download_failed', 'The Android runtime could not be downloaded.')));
        } catch { fail(error('runtime_download_failed', 'The Android runtime could not be downloaded.')); }
    });
}

function archivePath(name) {
    if (typeof name !== 'string' || name.length > 512 || name.includes('\\') || name.includes('\0') || name.includes(':')) {
        throw error('runtime_archive_invalid', 'The Android runtime archive contains an unsafe path.');
    }
    const directory = name.endsWith('/');
    const parts = (directory ? name.slice(0, -1) : name).split('/');
    if (parts[0] !== 'platform-tools' || parts.some(part => !part || part === '.' || part === '..')) {
        throw error('runtime_archive_invalid', 'The Android runtime archive contains an unsafe path.');
    }
    return { parts, directory };
}

async function extractArchive(buffer, destination) {
    if (!Buffer.isBuffer(buffer) || buffer.length > MAX_DOWNLOAD) {
        throw error('runtime_archive_invalid', 'The Android runtime archive is invalid.');
    }
    await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
        let zip;
        let failed = false;
        let entries = 0;
        let declared = 0;
        let actual = 0;
        const seen = new Set();
        const fail = () => {
            if (failed) return;
            failed = true;
            zip?.close();
            reject(error('runtime_archive_invalid', 'The Android runtime archive could not be safely extracted.'));
        };
        yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (openError, opened) => {
            if (openError) return fail();
            zip = opened;
            zip.once('error', fail);
            zip.once('end', () => { if (!failed) resolve(); });
            zip.on('entry', entry => {
                (async () => {
                    if (++entries > 5000) throw new Error('entry limit');
                    const { parts, directory } = archivePath(entry.fileName);
                    const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
                    if ((entry.generalPurposeBitFlag & 1) || (kind && kind !== 0x8000 && kind !== 0x4000) ||
                        (kind === 0x4000 && !directory) || (kind === 0x8000 && directory)) throw new Error('entry type');
                    declared += entry.uncompressedSize;
                    if (declared > MAX_EXTRACTED || !Number.isSafeInteger(entry.uncompressedSize)) throw new Error('size limit');
                    const relative = parts.join('/');
                    if (seen.has(relative)) throw new Error('duplicate entry');
                    seen.add(relative);
                    const filename = path.join(destination, ...parts);
                    if (directory) {
                        if (entry.uncompressedSize !== 0) throw new Error('directory contents');
                        await fsp.mkdir(filename, { recursive: true, mode: 0o700 });
                    } else {
                        await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
                        const stream = await new Promise((yes, no) => zip.openReadStream(entry, (err, value) => err ? no(err) : yes(value)));
                        const limiter = new Transform({ transform(chunk, encoding, callback) {
                            actual += chunk.length;
                            callback(actual > MAX_EXTRACTED ? new Error('size limit') : null, chunk);
                        } });
                        await pipeline(stream, limiter, fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
                    }
                    if (!failed) zip.readEntry();
                })().catch(fail);
            });
            zip.readEntry();
        });
    });
}

async function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', () => reject(error('adb_start_failed', 'A private Android connection could not be opened.')));
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(err => err ? reject(error('adb_start_failed', 'A private Android connection could not be opened.')) : resolve(port));
        });
    });
}

function terminate(child) {
    if (!child || child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve();
    return new Promise(resolve => {
        let force;
        let limit;
        const done = () => {
            nodeTimers.clearTimeout(force); nodeTimers.clearTimeout(limit);
            child.removeListener('close', done);
            resolve();
        };
        child.once('close', done);
        force = nodeTimers.setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Already ended. */ } }, 250);
        limit = nodeTimers.setTimeout(done, 750);
        try { child.kill('SIGTERM'); } catch { /* The process may already have ended. */ }
    });
}

async function waitReady(port, alive) {
    const end = Date.now() + 5000;
    while (Date.now() < end && alive()) {
        const connected = await new Promise(resolve => {
            const socket = net.createConnection({ host: '127.0.0.1', port });
            let finished = false;
            const done = value => { if (finished) return; finished = true; socket.destroy(); resolve(value); };
            socket.once('connect', () => done(true));
            socket.once('error', () => done(false));
            socket.setTimeout(150, () => done(false));
        });
        if (connected && alive()) return;
        await new Promise(resolve => nodeTimers.setTimeout(resolve, 40));
    }
    throw error('adb_start_failed', 'The private Android connection could not be started.');
}

class AdbRuntime {
    constructor({ dataDir, adbPath = '', useBundledAdb = true, spawnImpl = spawn,
        downloadImpl = downloadBuffer, platform = process.platform, arch = process.arch } = {}) {
        if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw error('invalid_runtime_directory', 'The adapter data directory must be absolute.');
        this.dataDir = path.resolve(dataDir);
        this.adbPath = adbPath;
        this.useBundledAdb = useBundledAdb;
        this._spawn = spawnImpl;
        this._download = downloadImpl;
        // Platform injection is for unit tests; adapter configuration does not expose it.
        this._platform = platform;
        this._arch = arch;
        this._clients = new Map();
        this._server = null;
        this._ready = false;
        this._stopping = false;
    }

    get bundledPath() { return path.join(this.dataDir, 'runtime', 'platform-tools', 'adb'); }
    get readyInfo() { return { started: this._ready, version: this.useBundledAdb ? PLATFORM_TOOLS.version : null }; }

    async install({ acceptLicense = false } = {}) {
        if (acceptLicense !== true) throw error('runtime_license_required', 'Accept the Android SDK download terms before installing the runtime.');
        if (this._platform !== 'linux' || this._arch !== 'x64') throw error('runtime_platform_unsupported', 'The included Android runtime supports Linux x64.');
        if (this._server || this._startPromise || this._installPromise) throw error('runtime_busy', 'Stop the Android connection before installing its runtime.');
        this._installPromise = this._install();
        try { return await this._installPromise; } finally { this._installPromise = null; }
    }

    async _install() {
        let staging;
        let backup;
        const runtimeDir = path.join(this.dataDir, 'runtime');
        const target = path.join(runtimeDir, 'platform-tools');
        try {
            const archive = await this._download(PLATFORM_TOOLS.url, { maxBytes: MAX_DOWNLOAD, timeoutMs: 45000 });
            if (!Buffer.isBuffer(archive) || archive.length !== PLATFORM_TOOLS.size ||
                crypto.createHash('sha256').update(archive).digest('hex') !== PLATFORM_TOOLS.sha256) {
                throw error('runtime_checksum_failed', 'The Android runtime download failed its integrity check.');
            }
            await fsp.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
            staging = await fsp.mkdtemp(path.join(runtimeDir, '.install-'));
            await extractArchive(archive, staging);
            const extracted = path.join(staging, 'platform-tools');
            for (const required of ['adb', 'NOTICE.txt']) {
                const stat = await fsp.lstat(path.join(extracted, required));
                if (!stat.isFile() || stat.isSymbolicLink()) throw error('runtime_archive_invalid', 'The Android runtime archive is incomplete.');
            }
            await fsp.chmod(path.join(extracted, 'adb'), 0o700);
            try {
                const stat = await fsp.lstat(target);
                if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('runtime_archive_invalid', 'The runtime installation directory is invalid.');
                backup = await fsp.mkdtemp(path.join(runtimeDir, '.previous-'));
                await fsp.rename(target, path.join(backup, 'platform-tools'));
            } catch (err) { if (err.code !== 'ENOENT') throw err; }
            try { await fsp.rename(extracted, target); }
            catch (err) {
                if (backup) {
                    try { await fsp.rename(path.join(backup, 'platform-tools'), target); }
                    catch { backup = null; } // Preserve the previous files if restoring them fails.
                }
                throw err;
            }
            return { version: PLATFORM_TOOLS.version, adbPath: this.bundledPath };
        } catch (err) {
            if (err instanceof BridgeError) throw err;
            throw error('runtime_install_failed', 'The Android runtime could not be installed in the adapter data directory.');
        } finally {
            if (staging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
            if (backup) await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
        }
    }

    async start() {
        if (this._stopPromise) await this._stopPromise;
        if (this._ready) return this.readyInfo;
        if (this._startPromise) return this._startPromise;
        if (this._installPromise) throw error('runtime_busy', 'Wait until the Android runtime installation finishes.');
        this._stopping = false;
        this._startPromise = this._start();
        try { return await this._startPromise; } finally { this._startPromise = null; }
    }

    async _start() {
        let server;
        try {
            if (this._platform !== 'linux' || this.useBundledAdb && this._arch !== 'x64') {
                throw error('runtime_platform_unsupported', 'This Android connection currently supports Linux; its included runtime requires x64.');
            }
            const binary = this.useBundledAdb ? this.bundledPath : this.adbPath;
            if (typeof binary !== 'string' || !path.isAbsolute(binary)) throw error('invalid_adb_path', 'Select an existing absolute path to adb.');
            try {
                if (!(await fsp.stat(binary)).isFile()) throw new Error('not a file');
                await fsp.access(binary, fs.constants.X_OK);
            } catch { throw error('runtime_missing', 'Install the Android runtime in the adapter settings or select an existing adb executable.'); }
            const home = path.join(this.dataDir, 'adb-home');
            await fsp.mkdir(home, { recursive: true, mode: 0o700 });
            await fsp.chmod(home, 0o700);
            // Inherit a copy for the ADB subprocess only (for example locale and
            // executable dependencies). Never modify the adapter's process.env:
            // keys, server selection and Android homes are isolated below.
            // Allow discovery, but prevent ADB from connecting to arbitrary paired
            // mDNS devices before the adapter has selected the configured phone.
            const env = { ...process.env, HOME: home, ANDROID_ADB_LOG_PATH: path.join(home, 'adb.log'),
                ADB_MDNS: '1', ADB_MDNS_AUTO_CONNECT: '0' };
            for (const key of ['ADB_VENDOR_KEYS', 'ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_ADDRESS', 'ANDROID_ADB_SERVER_PORT', 'ANDROID_SERIAL', 'ADB_TRACE', 'ANDROID_USER_HOME', 'ANDROID_SDK_HOME']) delete env[key];
            const port = await freePort();
            if (this._stopping) throw error('runtime_stopped', 'The Android connection has been stopped.');
            this._binary = binary;
            this._env = env;
            this._port = port;
            // ADB's listen parser recognizes localhost, but not numeric 127.0.0.1.
            server = this._spawn(binary, ['-L', `tcp:localhost:${port}`, 'server', 'nodaemon'], {
                env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            });
            this._server = server;
            let exited = false;
            const ended = () => { exited = true; if (this._server === server) this._ready = false; };
            server.once('error', ended);
            server.once('close', ended);
            server.stdout?.on('data', () => {});
            server.stderr?.on('data', () => {});
            server.stdout?.on('error', ended);
            server.stderr?.on('error', ended);
            await waitReady(port, () => !exited && !this._stopping && this._server === server);
            this._ready = true;
            return this.readyInfo;
        } catch (err) {
            await terminate(server);
            if (this._server === server) this._server = null;
            if (err instanceof BridgeError) throw err;
            throw error('adb_start_failed', 'The private Android connection could not be started.');
        }
    }

    async run(args, { timeoutMs = 15000, input, maxOutputBytes = DEFAULT_OUTPUT } = {}) {
        if (!this._ready || !this._server || this._stopping) throw error('runtime_not_started', 'Start the Android connection before sending commands.');
        if (!Array.isArray(args) || !args.length || args.length > 256 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 65536) ||
            !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
            !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024 ||
            input !== undefined && (typeof input !== 'string' && !Buffer.isBuffer(input) || Buffer.byteLength(input) > 65536)) {
            throw error('invalid_adb_command', 'The Android command options are invalid.');
        }
        // Callers can select a device, but cannot redirect clients to another server.
        let commandIndex = 0;
        while (commandIndex < args.length && args[commandIndex].startsWith('-')) {
            if (args[commandIndex] === '-s' || args[commandIndex] === '-t') commandIndex += 2;
            else if (args[commandIndex] === '-d' || args[commandIndex] === '-e') commandIndex++;
            else throw error('invalid_adb_command', 'The Android server options cannot be changed by a command.');
        }
        if (commandIndex >= args.length || ['server', 'nodaemon', 'fork-server', 'start-server', 'kill-server'].includes(args[commandIndex])) {
            throw error('invalid_adb_command', 'The Android server lifecycle is managed by the adapter.');
        }
        return new Promise((resolve, reject) => {
            let child;
            let settled = false;
            let total = 0;
            let timer;
            const chunks = [];
            const cleanup = () => { nodeTimers.clearTimeout(timer); if (child) this._clients.delete(child); };
            const finish = (err, value) => {
                if (settled) return;
                settled = true;
                nodeTimers.clearTimeout(timer);
                if (err) {
                    if (child) terminate(child).finally(cleanup);
                    reject(err);
                } else { cleanup(); resolve(value); }
            };
            try {
                // Numeric loopback is deliberately used for clients: ADB treats it as
                // a remote server and therefore cannot auto-start a detached daemon.
                child = this._spawn(this._binary, ['-H', '127.0.0.1', '-P', String(this._port), ...args], {
                    env: this._env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
                });
                this._clients.set(child, () => finish(error('runtime_stopped', 'The Android connection has been stopped.')));
                child.once('error', () => finish(error('adb_execution_failed', 'The Android command could not be started.')));
                child.once('close', code => {
                    cleanup();
                    if (settled) return;
                    if (code !== 0) finish(error('adb_command_failed', 'The Android command failed. Check the phone connection.'));
                    else finish(null, Buffer.concat(chunks).toString('utf8'));
                });
                const receive = (chunk, stdout) => {
                    if (settled) return;
                    const bytes = Buffer.from(chunk);
                    total += bytes.length;
                    if (total > maxOutputBytes) return finish(error('adb_output_limit', 'The Android command returned too much data.'));
                    if (stdout) chunks.push(bytes);
                };
                child.stdout?.on('data', chunk => receive(chunk, true));
                child.stderr?.on('data', chunk => receive(chunk, false));
                child.stdout?.on('error', () => finish(error('adb_execution_failed', 'The Android command output could not be read.')));
                child.stderr?.on('error', () => finish(error('adb_execution_failed', 'The Android command output could not be read.')));
                child.stdin?.on('error', () => finish(error('adb_execution_failed', 'The Android command input could not be sent.')));
                timer = nodeTimers.setTimeout(() => finish(error('adb_timeout', 'The Android command timed out.')), timeoutMs);
                child.stdin?.end(input);
            } catch { finish(error('adb_execution_failed', 'The Android command could not be started.')); }
        });
    }

    async pair(address, code) {
        validateEndpoint(address);
        if (typeof code !== 'string' || /^[0-9]{6}$/.exec(code)?.[0] !== code) throw error('invalid_pairing_code', 'Enter the six digits currently shown on the phone.');
        const output = await this.run(['pair', address], { timeoutMs: 20000, input: `${code}\n`, maxOutputBytes: 65536 });
        if (!/^(?:Enter pairing code:\s*)?Successfully paired to /m.test(output)) throw error('adb_pair_failed', 'Pairing did not succeed. Open a new pairing code on the phone and try again.');
        return true;
    }

    async stop() {
        if (this._stopPromise) return this._stopPromise;
        this._stopping = true;
        this._ready = false;
        this._stopPromise = (async () => {
            const pending = [];
            for (const [child, abort] of this._clients) { abort(); pending.push(terminate(child)); }
            pending.push(terminate(this._server));
            await Promise.all(pending);
            if (this._startPromise) await this._startPromise.catch(() => {});
            this._server = null;
            this._clients.clear();
        })();
        try { await this._stopPromise; } finally { this._stopPromise = null; }
    }
}

module.exports = { AdbRuntime, PLATFORM_TOOLS, _internals: { downloadBuffer, extractArchive, archivePath } };
