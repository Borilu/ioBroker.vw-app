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
const { ExecutionFence, blocked } = require('./execution-fence');

// A code alone is not evidence of remote completion: other components can
// construct BridgeError objects. This brand is never exposed for writing and
// expires as soon as another command starts or the originating job ends.
const confirmedShellFailures = new WeakMap();
function isConfirmedShellFailure(runtime, error) {
    if (!error || typeof error !== 'object') return false;
    const proof = confirmedShellFailures.get(error);
    const job = runtime?._job;
    return Boolean(proof && proof.runtime === runtime && proof.job === job && job &&
        proof.sequence === job.sequence && !job.ending && !job.uncertain && !runtime._blocked &&
        !runtime._stopping && runtime._clients?.size === 0);
}
// Consume only an authentic proof; this cannot create a brand. The closure
// permits successful read-only checks in the same job, but any subsequent
// Runtime failure, stop, active client or job change permanently revokes it.
function makeConfirmedRecoveryPermit(runtime, error) {
    if (!isConfirmedShellFailure(runtime, error)) return null;
    const proof = confirmedShellFailures.get(error);
    confirmedShellFailures.delete(error);
    const epoch = proof.job.failureEpoch;
    let valid = true;
    return () => {
        if (valid && (runtime._job !== proof.job || proof.job.failureEpoch !== epoch || proof.job.ending ||
            proof.job.uncertain || runtime._blocked || runtime._stopping || runtime._clients?.size !== 0)) valid = false;
        return valid;
    };
}

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
    if (!child || child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return Promise.resolve(true);
    return new Promise(resolve => {
        let force;
        let limit;
        let settled = false;
        const done = closed => {
            if (settled) return;
            settled = true;
            nodeTimers.clearTimeout(force); nodeTimers.clearTimeout(limit);
            child.removeListener('close', onClose);
            resolve(closed);
        };
        const onClose = () => done(true);
        child.once('close', onClose);
        force = nodeTimers.setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Already ended. */ } }, 250);
        limit = nodeTimers.setTimeout(() => done(false), 750);
        try { child.kill('SIGTERM'); } catch { /* The process may already have ended. */ }
    });
}

// These exact commands do not start a device-side shell. Every other command
// is treated as potentially effective on Android after an abnormal result.
function readOnlyConnectionCommand(args, index) {
    const rest = args.slice(index);
    if (rest.length === 1 && rest[0] === 'get-state') return true;
    if (rest.length === 1 && rest[0] === 'devices') return true;
    if (rest.length === 2 && rest[0] === 'mdns' && rest[1] === 'services') return true;
    if (rest.length === 2 && rest[0] === 'connect') {
        try { validateEndpoint(rest[1]); return true; } catch (_) { return false; }
    }
    return false;
}

// ADB can report success after a prematurely ended stream (including on
// older shell-v2 clients). A fresh unguessable frame is emitted by Android's
// shell only after the target program exits. Never include stdin in this script.
function shellEnvelope(args, index) {
    let begin = index + 1;
    if (args[begin] === '-T') begin++;
    if (begin >= args.length || args[begin].startsWith('-')) throw error('invalid_adb_command', 'Unsupported Android shell options.');
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const marker = '__VW_ANDROID_DONE_' + crypto.randomBytes(16).toString('hex') + '__:';
    const script = args.slice(begin).map(quote).join(' ') + "; _vw_status=$?; printf '\\n" + marker + "%s\\n' \"$_vw_status\"";
    return { args: [...args.slice(0, index), 'shell', '-T', script], marker };
}

function parseShellEnvelope(output, marker) {
    const prefix = '\n' + marker;
    const position = output.lastIndexOf(prefix);
    if (position < 0 || output.indexOf(prefix) !== position) return null;
    const tail = output.slice(position + prefix.length);
    const match = /^(0|[1-9][0-9]{0,2})\r?\n$/.exec(tail);
    if (!match || Number(match[1]) > 255) return null;
    return { output: output.slice(0, position), status: Number(match[1]) };
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
        downloadImpl = downloadBuffer, platform = process.platform, arch = process.arch, executionFence } = {}) {
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
        this._executionFence = executionFence || new ExecutionFence(this.dataDir);
        this._job = null;
        this._jobStarting = false;
        this._blocked = false;
        this._server = null;
        this._ready = false;
        this._stopping = false;
    }

    // The adapter must bracket each exclusive phone job, including setup and
    // cleanup. No other work may bypass this scope. One durable fence covers
    // all ADB commands in the job; there is no fsync per individual command.
    _recordFailure() { if (this._job && !this._job.ending) this._job.failureEpoch++; }
    async beginJob() {
        try { return await this._beginJob(); }
        catch (failure) { this._recordFailure(); throw failure; }
    }
    async _beginJob() {
        if (this._jobStarting || this._job || this._blocked || this._stopping) throw blocked();
        this._jobStarting = true;
        try {
            const token = await this._executionFence.acquire();
            this._job = { token, uncertain: false, sequence: 0, failureEpoch: 0 };
            if (this._stopping) { await this.endJob(); throw error('runtime_stopped', 'The Android connection has been stopped.'); }
        } catch (err) { if (err?.code === 'adb_execution_fenced') this._blocked = true; throw err; }
        finally { this._jobStarting = false; }
    }
    async assertJobClear() {
        try {
            if (this._jobStarting || this._job || this._blocked || this._stopping) throw blocked();
            await this._executionFence.assertClear();
        } catch (failure) { this._recordFailure(); throw failure; }
    }
    async endJob() {
        const job = this._job;
        if (!job || job.ending || job.uncertain || this._clients.size) { this._blocked = true; throw blocked(); }
        // Close the job synchronously before the first asynchronous filesystem
        // operation; a racing run cannot start after fence removal begins.
        job.ending = true;
        try { await this._executionFence.release(job.token); this._job = null; }
        catch (_) { this._blocked = true; throw blocked(); }
    }

    // A guarded UI action was sent but its intended postcondition could not
    // be verified. Retain this job's existing durable execution fence: a
    // later refresh or adapter restart must never repeat the ambiguous input.
    fenceUncertainAction() {
        const job = this._job;
        if (!job || job.ending) { this._blocked = true; throw blocked(); }
        job.uncertain = true;
        job.failureEpoch++;
        this._blocked = true;
    }

    get bundledPath() { return path.join(this.dataDir, 'runtime', 'platform-tools', 'adb'); }
    get readyInfo() { return { started: this._ready, version: this.useBundledAdb ? PLATFORM_TOOLS.version : null }; }

    async install(options = {}) {
        try { return await this._installAuthorized(options); }
        catch (failure) { this._recordFailure(); throw failure; }
    }
    async _installAuthorized({ acceptLicense = false } = {}) {
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
        try { return await this._startAuthorized(); }
        catch (failure) { this._recordFailure(); throw failure; }
    }
    async _startAuthorized() {
        if (this._stopPromise) await this._stopPromise;
        if (this._jobStarting) throw error('runtime_busy', 'Wait for the current Android job to finish.');
        if (this._blocked) throw blocked();
        if (!this._job) await this._executionFence.assertClear();
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
        const rejectBeforeSend = failure => {
            this._recordFailure();
            throw failure;
        };
        if (!this._ready || !this._server || this._stopping) return rejectBeforeSend(error('runtime_not_started', 'Start the Android connection before sending commands.'));
        if (!this._job || this._job.ending || this._job.uncertain || this._blocked) return rejectBeforeSend(blocked());
        if (this._clients.size) return rejectBeforeSend(error('runtime_busy', 'Another Android command is still running.'));
        if (!Array.isArray(args) || !args.length || args.length > 256 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 65536) ||
            !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
            !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024 ||
            input !== undefined && (typeof input !== 'string' && !Buffer.isBuffer(input) || Buffer.byteLength(input) > 65536)) {
            return rejectBeforeSend(error('invalid_adb_command', 'The Android command options are invalid.'));
        }
        // Callers can select a device, but cannot redirect clients to another server.
        let commandIndex = 0;
        while (commandIndex < args.length && args[commandIndex].startsWith('-')) {
            if (args[commandIndex] === '-s' || args[commandIndex] === '-t') commandIndex += 2;
            else if (args[commandIndex] === '-d' || args[commandIndex] === '-e') commandIndex++;
            else return rejectBeforeSend(error('invalid_adb_command', 'The Android server options cannot be changed by a command.'));
        }
        // exec-out can return zero on transport EOF without a remote exit
        // status. It cannot establish completion for the durable fence.
        if (commandIndex >= args.length || !['shell', 'push', 'pair', 'connect', 'mdns', 'devices', 'get-state'].includes(args[commandIndex])) {
            return rejectBeforeSend(error('invalid_adb_command', 'The Android server lifecycle is managed by the adapter.'));
        }
        const hostOnly = readOnlyConnectionCommand(args, commandIndex);
        let envelope;
        try { envelope = args[commandIndex] === 'shell' ? shellEnvelope(args, commandIndex) : null; }
        catch (failure) { return rejectBeforeSend(failure); }
        const job = this._job;
        const sequence = ++job.sequence;
        return new Promise((resolve, reject) => {
            let child;
            let settled = false;
            let ending = false;
            let termination;
            let total = 0;
            let timer;
            const chunks = [];
            const cleanup = () => { nodeTimers.clearTimeout(timer); if (child) this._clients.delete(child); };
            const finish = (err, value) => {
                if (settled || ending) return termination;
                nodeTimers.clearTimeout(timer);
                if (err) {
                    ending = true;
                    job.failureEpoch++;
                    if (child && !hostOnly) { job.uncertain = true; this._blocked = true; }
                    termination = (async () => {
                        // Closing a local client does NOT prove an interrupted
                        // shell command has stopped on Android. Preserve the
                        // durable job fence for any uncertain device command.
                        const closed = child ? await terminate(child) : true;
                        if (!closed || child && !hostOnly) { job.uncertain = true; this._blocked = true; }
                        settled = true;
                        if (closed) cleanup();
                        reject(err);
                    })();
                    return termination;
                }
                settled = true; cleanup(); resolve(value);
            };
            try {
                // Numeric loopback is deliberately used for clients: ADB treats it as
                // a remote server and therefore cannot auto-start a detached daemon.
                child = this._spawn(this._binary, ['-H', '127.0.0.1', '-P', String(this._port), ...(envelope?.args || args)], {
                    env: this._env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
                });
                this._clients.set(child, () => finish(error('runtime_stopped', 'The Android connection has been stopped.')));
                child.once('error', () => finish(error('adb_execution_failed', 'The Android command could not be started.')));
                child.once('close', code => {
                    if (settled || ending) return;
                    if (code !== 0) finish(error('adb_command_failed', 'The Android command failed. Check the phone connection.'));
                    else if (envelope) {
                        const result = parseShellEnvelope(Buffer.concat(chunks).toString('utf8'), envelope.marker);
                        if (!result) return finish(error('adb_execution_unconfirmed', 'The Android command did not provide a complete result.'));
                        if (result.status !== 0) {
                            // The fixed frame proves the command returned even
                            // if that command itself reported an ordinary error.
                            settled = true; cleanup();
                            job.failureEpoch++;
                            const completed = error('adb_command_failed', 'The Android command failed. Check the phone connection.');
                            confirmedShellFailures.set(completed, { runtime: this, job, sequence });
                            return reject(completed);
                        }
                        finish(null, result.output);
                    } else finish(null, Buffer.concat(chunks).toString('utf8'));
                });
                const receive = (chunk, stdout) => {
                    if (settled || ending) return;
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
        try { return await this._pairChecked(address, code); }
        catch (failure) { this._recordFailure(); throw failure; }
    }
    async _pairChecked(address, code) {
        validateEndpoint(address);
        if (typeof code !== 'string' || /^[0-9]{6}$/.exec(code)?.[0] !== code) throw error('invalid_pairing_code', 'Enter the six digits currently shown on the phone.');
        const output = await this.run(['pair', address], { timeoutMs: 20000, input: `${code}\n`, maxOutputBytes: 65536 });
        const escapedAddress = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const paired = new RegExp('^(?:Enter pairing code:\\s*)?Successfully paired to ' + escapedAddress + '(?:\\s|$)', 'm');
        if (!paired.test(output)) {
            // ADB can perform pairing even when its success message is lost
            // or changes format. Do not remove the job fence or retry.
            if (this._job) this._job.uncertain = true;
            this._blocked = true;
            throw error('adb_pair_failed', 'Pairing could not be confirmed. Do not repeat until the Android connection is reviewed.');
        }
        return true;
    }

    async stop() {
        if (this._stopPromise) return this._stopPromise;
        this._stopping = true;
        this._ready = false;
        this._stopPromise = (async () => {
            const pending = [];
            for (const [, abort] of this._clients) pending.push(Promise.resolve(abort()));
            pending.push(terminate(this._server));
            await Promise.all(pending);
            // A wedged filesystem must not prevent ioBroker from stopping.
            // A late acquisition can perform no Android work because stopping
            // is already set; until then, never report the runtime as reusable.
            const acquireDeadline = Date.now() + 1000;
            while (this._jobStarting && Date.now() < acquireDeadline) await new Promise(resolve => nodeTimers.setTimeout(resolve, 10));
            if (this._jobStarting) this._blocked = true;
            if (this._startPromise) await this._startPromise.catch(() => {});
            this._server = null;
            // A child without a confirmed close remains tracked; never claim a
            // clean job or remove the persisted fence merely because stop ended.
        })();
        try { await this._stopPromise; } finally { this._stopPromise = null; }
    }
}

module.exports = { AdbRuntime, PLATFORM_TOOLS, isConfirmedShellFailure, makeConfirmedRecoveryPermit,
    _internals: { downloadBuffer, extractArchive, archivePath } };
