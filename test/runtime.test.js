'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AdbRuntime, PLATFORM_TOOLS, _internals } = require('../lib/runtime');

class FakeChild extends EventEmitter {
    constructor() {
        super();
        this.stdin = new PassThrough();
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.exitCode = null;
        this.signals = [];
    }
    close(code = 0) {
        if (this.exitCode !== null) return;
        this.exitCode = code;
        this.emit('close', code);
    }
    kill(signal) {
        this.signals.push(signal);
        if (!this._closing) {
            this._closing = true;
            if (this.listener) this.listener.close(() => this.close(143));
            else queueMicrotask(() => this.close(143));
        }
        return true;
    }
}

async function fixture(t, { serverFails = false, ...options } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-runtime-test-'));
    const binary = path.join(dataDir, 'test-adb');
    await fs.writeFile(binary, 'A test fixture; never executed.');
    await fs.chmod(binary, 0o700);
    const calls = [];
    const plans = [];
    const spawnImpl = (file, args, settings) => {
        const child = new FakeChild();
        const call = { file, args, settings, child, input: '' };
        calls.push(call);
        child.stdin.on('data', bytes => { call.input += bytes.toString(); });
        if (args[0] === '-L') {
            if (serverFails) queueMicrotask(() => { child.emit('error', new Error('private details')); child.close(1); });
            else {
                const port = Number(args[1].split(':').at(-1));
                child.listener = net.createServer(socket => socket.end());
                child.listener.on('error', () => { child.emit('error', new Error('private details')); child.close(1); });
                child.listener.listen(port, '127.0.0.1');
            }
        } else {
            const plan = plans.shift() || { stdout: 'ok\n' };
            queueMicrotask(() => {
                if (plan.hold) return;
                if (plan.error) { child.emit('error', new Error(plan.error)); child.close(1); return; }
                if (plan.stdout) child.stdout.write(plan.stdout);
                if (plan.stderr) child.stderr.write(plan.stderr);
                child.close(plan.code ?? 0);
            });
        }
        return child;
    };
    const runtime = new AdbRuntime({ dataDir, adbPath: binary, useBundledAdb: false, platform: 'linux', arch: 'x64', spawnImpl, ...options });
    t.after(async () => { await runtime.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
    return { runtime, dataDir, binary, calls, plans };
}

test('runtime metadata pins the reviewed official Linux x64 archive', () => {
    assert.equal(PLATFORM_TOOLS.version, '37.0.1');
    assert.equal(PLATFORM_TOOLS.url, 'https://dl.google.com/android/repository/platform-tools_r37.0.1-linux.zip');
    assert.equal(PLATFORM_TOOLS.sha256, 'd230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1');
    assert.ok(Object.isFrozen(PLATFORM_TOOLS));
});

test('installation requires explicit consent, supports x64 only, and checks the pin before extraction', async t => {
    let downloads = 0;
    const { runtime, dataDir } = await fixture(t, { downloadImpl: async () => { downloads++; return Buffer.from('untrusted'); } });
    await assert.rejects(runtime.install(), { code: 'runtime_license_required' });
    assert.equal(downloads, 0);
    runtime._arch = 'arm64';
    await assert.rejects(runtime.install({ acceptLicense: true }), { code: 'runtime_platform_unsupported' });
    assert.equal(downloads, 0);
    runtime._arch = 'x64';
    await assert.rejects(runtime.install({ acceptLicense: true }), { code: 'runtime_checksum_failed' });
    assert.equal(downloads, 1);
    await assert.rejects(fs.stat(path.join(dataDir, 'runtime')), { code: 'ENOENT' });
});

test('start never downloads or executes a missing bundled runtime', async t => {
    let downloads = 0;
    const { runtime, calls } = await fixture(t, { useBundledAdb: true, downloadImpl: () => { downloads++; } });
    await assert.rejects(runtime.start(), { code: 'runtime_missing' });
    assert.equal(downloads, 0);
    assert.equal(calls.length, 0);
    await assert.rejects(runtime.run(['devices']), { code: 'runtime_not_started' });
});

test('manual executable requires an absolute path and Linux', async t => {
    const { runtime } = await fixture(t, { adbPath: 'adb' });
    await assert.rejects(runtime.start(), { code: 'invalid_adb_path' });
    runtime._platform = 'win32';
    await assert.rejects(runtime.start(), { code: 'runtime_platform_unsupported' });
});

test('server and clients use an owned loopback port, private HOME, and no shell', async t => {
    const beforeHome = process.env.HOME;
    const beforeVendorKeys = process.env.ADB_VENDOR_KEYS;
    const inheritedHomes = ['ANDROID_USER_HOME', 'ANDROID_SDK_HOME'].map(name => [name, process.env[name]]);
    for (const [name] of inheritedHomes) process.env[name] = '/unrelated-inherited-android-home';
    t.after(() => {
        for (const [name, value] of inheritedHomes) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
    const originalEnvironment = { ...process.env };
    const { runtime, calls, dataDir, binary, plans } = await fixture(t);
    await runtime.start();
    assert.deepEqual(runtime.readyInfo, { started: true, version: null });
    const server = calls[0];
    assert.equal(server.file, binary);
    assert.match(server.args[1], /^tcp:localhost:[0-9]+$/);
    assert.deepEqual(server.args.slice(2), ['server', 'nodaemon']);
    assert.equal(server.settings.env.HOME, path.join(dataDir, 'adb-home'));
    assert.equal(server.settings.env.ANDROID_ADB_LOG_PATH, path.join(dataDir, 'adb-home', 'adb.log'));
    for (const name of ['ADB_VENDOR_KEYS', 'ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_ADDRESS', 'ANDROID_ADB_SERVER_PORT', 'ANDROID_SERIAL', 'ADB_TRACE', 'ANDROID_USER_HOME', 'ANDROID_SDK_HOME']) {
        assert.equal(Object.hasOwn(server.settings.env, name), false);
    }
    plans.push({ stdout: 'device-result\n', stderr: 'ignored diagnostic' });
    assert.equal(await runtime.run(['-s', '192.168.2.3:37123', 'shell', 'echo', 'result']), 'device-result\n');
    const client = calls[1];
    assert.deepEqual(client.args.slice(0, 4), ['-H', '127.0.0.1', '-P', server.args[1].split(':').at(-1)]);
    assert.equal(client.settings.env, server.settings.env);
    assert.equal(client.settings.shell, false);
    assert.equal(client.settings.windowsHide, true);
    assert.equal(process.env.HOME, beforeHome);
    assert.equal(process.env.ADB_VENDOR_KEYS, beforeVendorKeys);
    for (const [name] of inheritedHomes) assert.equal(process.env[name], '/unrelated-inherited-android-home');
    assert.notEqual(server.settings.env, process.env);
    assert.equal(Object.keys(process.env).length === Object.keys(originalEnvironment).length
        && Object.entries(originalEnvironment).every(([name, value]) => process.env[name] === value), true,
    'The runtime must not mutate the adapter environment.');
    await assert.rejects(runtime.install({ acceptLicense: true }), { code: 'runtime_busy' });
    await runtime.stop();
    assert.equal(server.child.signals[0], 'SIGTERM');
    assert.equal(calls.some(call => call.args.includes('kill-server')), false);
    assert.equal(runtime.readyInfo.started, false);
});

test('startup errors are fixed and do not reveal child process details', async t => {
    const { runtime } = await fixture(t, { serverFails: true });
    await assert.rejects(runtime.start(), err => err.code === 'adb_start_failed' && !err.message.includes('private details'));
});

test('commands cannot replace the owned server or control its lifecycle', async t => {
    const { runtime, calls } = await fixture(t);
    await runtime.start();
    for (const args of [['-H', 'elsewhere', 'devices'], ['-L', 'tcp:5037', 'devices'], ['kill-server'], ['start-server'], ['-s']]) {
        await assert.rejects(runtime.run(args), { code: 'invalid_adb_command' });
    }
    assert.equal(calls.length, 1);
});

test('client failures, timeouts, and combined stdout/stderr size are bounded', async t => {
    const { runtime, plans, calls } = await fixture(t);
    await runtime.start();
    plans.push({ stdout: 'secret detail', code: 1 });
    await assert.rejects(runtime.run(['devices']), err => err.code === 'adb_command_failed' && !err.message.includes('secret'));
    plans.push({ error: 'secret executable path' });
    await assert.rejects(runtime.run(['devices']), err => err.code === 'adb_execution_failed' && !err.message.includes('secret'));
    plans.push({ stdout: '12', stderr: '345' });
    await assert.rejects(runtime.run(['devices'], { maxOutputBytes: 4 }), { code: 'adb_output_limit' });
    plans.push({ hold: true });
    const before = Date.now();
    await assert.rejects(runtime.run(['devices'], { timeoutMs: 20 }), { code: 'adb_timeout' });
    assert.ok(Date.now() - before < 1000);
    assert.equal(calls.at(-1).child.signals[0], 'SIGTERM');
});

test('stop aborts pending clients and permits a fresh owned server afterwards', async t => {
    const { runtime, plans, calls } = await fixture(t);
    await runtime.start();
    plans.push({ hold: true });
    const pending = runtime.run(['devices']);
    const rejected = assert.rejects(pending, { code: 'runtime_stopped' });
    await runtime.stop();
    await rejected;
    assert.equal(runtime._clients.size, 0);
    assert.equal(calls[1].child.signals[0], 'SIGTERM');
    await assert.rejects(runtime.run(['devices']), { code: 'runtime_not_started' });
    await runtime.start();
    assert.equal(await runtime.run(['devices']), 'ok\n');
});

test('pair validates numeric endpoints and ASCII digits and sends the code only through stdin', async t => {
    const { runtime, plans, calls } = await fixture(t);
    await runtime.start();
    for (const address of ['phone.example:1234', '192.168.1.1:0', '192.168.1.1:65536', '999.1.1.1:12', '192.168.1.1:12\n']) {
        await assert.rejects(runtime.pair(address, '123456'), { code: 'invalid_wifi_endpoint' });
    }
    for (const code of ['12345', '1234567', '１２３４５６', '12345\n']) {
        await assert.rejects(runtime.pair('192.168.1.1:1234', code), { code: 'invalid_pairing_code' });
    }
    assert.equal(calls.length, 1);
    plans.push({ stdout: 'Enter pairing code: Successfully paired to 192.168.1.1:1234 [guid=private]\n' });
    // The real CLI prints the prompt without a newline before the success message.
    assert.equal(await runtime.pair('192.168.1.1:1234', '123456'), true);
    plans.push({ stdout: 'Successfully paired to 192.168.1.1:1234 [guid=private]\n' });
    assert.equal(await runtime.pair('192.168.1.1:1234', '123456'), true);
    const call = calls.at(-1);
    assert.equal(call.args.includes('123456'), false);
    assert.deepEqual(call.args.slice(4), ['pair', '192.168.1.1:1234']);
    assert.equal(call.input, '123456\n');
    plans.push({ stdout: 'failed to pair to phone\n', code: 0 });
    await assert.rejects(runtime.pair('[2001:db8::1]:1234', '123456'), { code: 'adb_pair_failed' });
});

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
    const local = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name);
        const data = Buffer.from(entry.data || '');
        const size = entry.size ?? data.length;
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50);
        header.writeUInt16LE(20, 4);
        header.writeUInt32LE(crc32(data), 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(size, 22);
        header.writeUInt16LE(name.length, 26);
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50);
        record.writeUInt16LE((3 << 8) | 20, 4);
        record.writeUInt16LE(20, 6);
        record.writeUInt32LE(crc32(data), 16);
        record.writeUInt32LE(data.length, 20);
        record.writeUInt32LE(size, 24);
        record.writeUInt16LE(name.length, 28);
        record.writeUInt32LE(((entry.mode ?? (entry.name.endsWith('/') ? 0o040700 : 0o100600)) << 16) >>> 0, 38);
        record.writeUInt32LE(offset, 42);
        local.push(header, name, data);
        central.push(record, name);
        offset += header.length + name.length + data.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}

test('safe ZIP extraction retains notices and libraries without executing files', async t => {
    const { dataDir } = await fixture(t);
    const destination = path.join(dataDir, 'extract');
    await _internals.extractArchive(makeZip([
        { name: 'platform-tools/' },
        { name: 'platform-tools/adb', data: 'not executable code' },
        { name: 'platform-tools/NOTICE.txt', data: 'upstream notices' },
        { name: 'platform-tools/lib64/' },
        { name: 'platform-tools/lib64/libc++.so', data: 'library bytes' },
    ]), destination);
    assert.equal(await fs.readFile(path.join(destination, 'platform-tools/NOTICE.txt'), 'utf8'), 'upstream notices');
    assert.equal(await fs.readFile(path.join(destination, 'platform-tools/lib64/libc++.so'), 'utf8'), 'library bytes');
});

test('ZIP extraction rejects traversal, links, duplicate entries and excessive expanded sizes', async t => {
    const { dataDir } = await fixture(t);
    const archives = [
        [{ name: 'platform-tools/../../escaped', data: 'bad' }],
        [{ name: '/tmp/escaped', data: 'bad' }],
        [{ name: 'platform-tools\\escaped', data: 'bad' }],
        [{ name: 'platform-tools/link', data: '../../escaped', mode: 0o120777 }],
        [{ name: 'platform-tools/a', data: 'a' }, { name: 'platform-tools/a', data: 'b' }],
        [{ name: 'platform-tools/a', data: 'a', size: 201 * 1024 * 1024 }],
    ];
    for (let i = 0; i < archives.length; i++) {
        await assert.rejects(_internals.extractArchive(makeZip(archives[i]), path.join(dataDir, `invalid-${i}`)), { code: 'runtime_archive_invalid' });
    }
    await assert.rejects(fs.stat(path.join(dataDir, 'escaped')), { code: 'ENOENT' });
});

function responseRequest({ status = 200, headers = {}, chunks = [], hold = false } = {}) {
    const state = { requested: 0, destroyed: false };
    state.impl = (url, options, callback) => {
        state.requested++;
        const request = new EventEmitter();
        request.destroy = () => { state.destroyed = true; };
        queueMicrotask(() => {
            const response = new PassThrough();
            response.statusCode = status;
            response.headers = headers;
            callback(response);
            if (!response.destroyed) {
                for (const chunk of chunks) response.write(chunk);
                if (!hold) response.end();
            }
        });
        return request;
    };
    return state;
}

test('downloader permits only the official HTTPS host and bounds received bytes and time', async () => {
    const valid = responseRequest({ chunks: ['ab', 'cd'] });
    assert.equal((await _internals.downloadBuffer(PLATFORM_TOOLS.url, { requestImpl: valid.impl, maxBytes: 4 })).toString(), 'abcd');
    for (const url of ['http://dl.google.com/file.zip', 'https://evil.example/file.zip', 'https://dl.google.com.evil.example/x', 'https://user@dl.google.com/x']) {
        await assert.rejects(async () => _internals.downloadBuffer(url, { requestImpl: valid.impl }), { code: 'runtime_download_failed' });
    }
    assert.equal(valid.requested, 1);
    const redirected = responseRequest({ status: 302, headers: { location: 'https://evil.example/x' } });
    await assert.rejects(_internals.downloadBuffer(PLATFORM_TOOLS.url, { requestImpl: redirected.impl }), { code: 'runtime_download_failed' });
    const advertised = responseRequest({ headers: { 'content-length': '5' } });
    await assert.rejects(_internals.downloadBuffer(PLATFORM_TOOLS.url, { requestImpl: advertised.impl, maxBytes: 4 }), { code: 'runtime_download_too_large' });
    const large = responseRequest({ chunks: ['123', '456'] });
    await assert.rejects(_internals.downloadBuffer(PLATFORM_TOOLS.url, { requestImpl: large.impl, maxBytes: 4 }), { code: 'runtime_download_too_large' });
    assert.equal(large.destroyed, true);
    const slow = responseRequest({ hold: true });
    await assert.rejects(_internals.downloadBuffer(PLATFORM_TOOLS.url, { requestImpl: slow.impl, timeoutMs: 20 }), { code: 'runtime_download_timeout' });
    assert.equal(slow.destroyed, true);
});
