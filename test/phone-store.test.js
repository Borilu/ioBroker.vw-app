'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Phone, PACKAGE } = require('../lib/phone');
const { integer, validateHost, endpoint, validateEndpoint, normalizeConfig } = require('../lib/config');
const { StateStore } = require('../lib/store');
const { DeviceLease } = require('../lib/lease');
const { BridgeError } = require('../lib/errors');

const ENDPOINT = '192.0.2.14:37123';
const SERIAL = 'serial:A31-TEST';
const ANDROID = 'android_id:001122334455aabb';
const FOCUS = 'mCurrentFocus=Window{18ab u0 ' + PACKAGE + '/.MainActivity}\n';

function throwsCode(expected, operation) {
    assert.throws(operation, error => error instanceof BridgeError && error.code === expected);
}
async function rejectsCode(expected, promise) {
    await assert.rejects(promise, error => error instanceof BridgeError && error.code === expected && !error.message.includes('SECRET'));
}

class FakeRuntime {
    constructor(handler = () => undefined) { this.calls = []; this.handler = handler; }
    async run(args, options = {}) {
        this.calls.push({ args: [...args], options: { ...options } });
        const override = await this.handler(args, options);
        if (override !== undefined) return override;
        if (args[0] === 'connect') return 'connected to ' + args[1] + '\n';
        assert.equal(args[0], '-s');
        assert.equal(args[1], ENDPOINT);
        const command = args.slice(2);
        if (command[0] === 'get-state') return 'device\n';
        if (command.join(' ') === 'shell getprop ro.serialno') return 'A31-TEST\n';
        if (command.join(' ') === 'shell settings get secure android_id') return '001122334455aabb\n';
        if (command.join(' ') === 'shell dumpsys package ' + PACKAGE) return 'versionName=4.8.1\n';
        if (command.join(' ') === 'shell dumpsys window') return FOCUS;
        if (command.includes('resolve-activity')) return 'priority=0\n' + PACKAGE + '/.MainActivity\n';
        if (command[1] === 'cat') return '<hierarchy/>\n';
        return '';
    }
}

function makePhone({ deviceId = SERIAL, handler, onVerified = async () => {} } = {}) {
    const runtime = new FakeRuntime(handler);
    const abort = new AbortController();
    const phone = new Phone({ runtime, endpoint: ENDPOINT, deviceId, onVerified, signal: abort.signal });
    return { phone, runtime, abort };
}

function deviceCommands(runtime) { return runtime.calls.filter(call => call.args[0] === '-s').map(call => call.args.slice(2)); }
function assertNoUi(runtime) {
    assert.ok(!deviceCommands(runtime).some(args => args[1] === 'input' || args[1] === 'am' || args[1] === 'uiautomator'));
}

async function temporaryDirectory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-app-phone-store-test-'));
    t.after(async () => {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('vw-app-phone-store-test-'));
        await fs.rm(resolved, { recursive: true, force: true });
    });
    return directory;
}

test('numeric endpoints accept only explicit valid IP addresses and ports', () => {
    assert.equal(endpoint('192.0.2.14', '37123'), ENDPOINT);
    assert.equal(endpoint('fd00::14', 37123), '[fd00::14]:37123');
    assert.equal(validateEndpoint(ENDPOINT), ENDPOINT);
    assert.equal(validateEndpoint('[FD00:0000::14]:37123'), '[FD00:0000::14]:37123');
    for (const invalid of [null, {}, '', 'phone.local:37123', '192.0.2.14', '192.0.2.14:0',
        '192.0.2.14:65536', '192.0.2.14:37123;id', '192.0.2.14:37123\n',
        '192.0.2.14:037123', 'fd00::14:37123', '[fe80::14%eth0]:37123',
        '[::]:37123', '0.0.0.0:37123', '224.0.0.1:37123', '[ff02::1]:37123']) {
        throwsCode('invalid_wifi_endpoint', () => validateEndpoint(invalid));
    }
    for (const host of ['phone.local', '127.0.0.1:37123', '[fd00::14]', ' 192.0.2.14',
        '192.0.2.14\n', '0.0.0.0', '::', 'fe80::14%eth0', '224.0.0.1', 'ff02::1']) {
        throwsCode('invalid_wifi_endpoint', () => validateHost(host));
    }
});

test('numeric configuration rejects booleans, NaN, out-of-range and non-decimal strings', () => {
    assert.equal(integer('37123', 1, 65535), 37123);
    assert.equal(integer(37123, 1, 65535), 37123);
    for (const value of [true, false, NaN, Infinity, -1, 65536, 1.5, '', 'NaN', 'Infinity',
        '1e3', '0x123', '+123', '123.0', '123 ', ' 123', '123\n', '123\r\n']) {
        throwsCode('invalid_config', () => integer(value, 1, 65535));
        throwsCode('invalid_config', () => normalizeConfig({ connectPort: value }));
    }
    for (const config of [{ allowWrites: 'true' }, { useBundledAdb: 1 }, { stayAwakeOnCharge: 'false' },
        { commandTimeoutSeconds: true }, { cooldownSeconds: NaN }, { pollIntervalSeconds: 299 },
        { legacyStatePrefix: 'system.adapter.vw-app.0' }, { modeTitles: ' | ' }]) {
        throwsCode('invalid_config', () => normalizeConfig(config));
    }
});

test('configuration preserves the complete vehicle prefix and its trailing delimiter', () => {
    const marker = 'Ihr Fahrzeug: ID.7 GTX Tourer. ';
    const cfg = normalizeConfig({ hostIp: '192.0.2.14', connectPort: '37123', vehicleMarker: marker,
        commandTimeoutSeconds: '125', cooldownSeconds: '60', modeTitles: ' Klimatisierung | Air conditioning ' });
    assert.equal(cfg.vehicleMarker, marker);
    assert.equal(cfg.connectPort, 37123);
    assert.equal(cfg.commandTimeoutSeconds, 125);
    assert.equal(cfg.cooldownSeconds, 60);
    assert.deepEqual(cfg.modeTitles, ['Klimatisierung', 'Air conditioning']);
    assert.equal(cfg.allowWrites, false);
});

test('normal connection refuses an unpinned phone before contacting ADB', async () => {
    const { phone, runtime } = makePhone({ deviceId: '' });
    await rejectsCode('wifi_identity_required', phone.connect());
    assert.equal(runtime.calls.length, 0);
});

test('connection uses the configured endpoint and verifies identity before callback', async () => {
    const verified = [];
    const { phone, runtime } = makePhone({ onVerified: async identity => verified.push(identity) });
    assert.deepEqual(await phone.connect(), { deviceId: SERIAL });
    assert.deepEqual(runtime.calls.map(call => call.args), [['connect', ENDPOINT], ['-s', ENDPOINT, 'get-state'], ['-s', ENDPOINT, 'shell', 'getprop', 'ro.serialno']]);
    assert.deepEqual(verified, [SERIAL]);
    assertNoUi(runtime);
});

test('wrong physical identity blocks verification callback and all app input', async () => {
    let verified = false;
    const { phone, runtime } = makePhone({ onVerified: async () => { verified = true; },
        handler: args => args.slice(2).join(' ') === 'shell getprop ro.serialno' ? 'ANOTHER-PHONE\n' : undefined });
    await rejectsCode('wifi_wrong_device', phone.connect());
    assert.equal(verified, false);
    assertNoUi(runtime);
});

test('a zero-exit connect failure is detected through the targeted device state', async () => {
    const { phone, runtime } = makePhone({ handler: args => {
        if (args[0] === 'connect') return 'failed to connect: SECRET\n';
        if (args[2] === 'get-state') return 'offline\n';
    } });
    await rejectsCode('wifi_unavailable', phone.connect());
    assert.equal(runtime.calls.length, 2);
    assertNoUi(runtime);
});

test('runtime failure during connection stays controlled and cannot expose raw output', async () => {
    const { phone, runtime } = makePhone({ handler: () => { throw new Error('SECRET'); } });
    await rejectsCode('wifi_unavailable', phone.connect());
    assert.equal(runtime.calls.length, 1);
    assertNoUi(runtime);
});

test('setup discovery falls back to Android ID while a stored serial never silently changes scheme', async () => {
    const handler = args => args.slice(2).join(' ') === 'shell getprop ro.serialno' ? 'unknown\n' : undefined;
    const discovery = makePhone({ deviceId: '', handler });
    assert.deepEqual(await discovery.phone.connect({ allowUnpinned: true }), { deviceId: ANDROID });
    assert.ok(deviceCommands(discovery.runtime).some(args => args.join(' ') === 'shell settings get secure android_id'));
    const pinned = makePhone({ handler });
    await rejectsCode('wifi_identity_unavailable', pinned.phone.connect());
    assert.ok(!deviceCommands(pinned.runtime).some(args => args[1] === 'settings'));
    assertNoUi(pinned.runtime);
});

test('a stored Android ID uses the same identity scheme even if a serial is available', async () => {
    const { phone, runtime } = makePhone({ deviceId: ANDROID });
    assert.deepEqual(await phone.connect(), { deviceId: ANDROID });
    assert.ok(!deviceCommands(runtime).some(args => args[1] === 'getprop'));
    const invalid = makePhone({ deviceId: ANDROID, handler: args => args[3] === 'settings' ? 'null\n' : undefined });
    await rejectsCode('wifi_identity_unavailable', invalid.phone.connect());
});

test('application version requires one unique value and uses only the fixed package', async () => {
    const good = makePhone({ handler: () => 'versionName=4.8.1\nversionName=4.8.1\n' });
    assert.equal(await good.phone.version(), '4.8.1');
    assert.deepEqual(good.runtime.calls[0].args, ['-s', ENDPOINT, 'shell', 'dumpsys', 'package', PACKAGE]);
    for (const output of ['', 'No packages found', 'versionName=4.8.1\nversionName=4.8.2\n']) {
        await rejectsCode('app_missing', makePhone({ handler: () => output }).phone.version());
    }
});

test('lock screen, absent focus, and any foreign focused app prevent all gestures', async () => {
    for (const focus of ['mCurrentFocus=null\n', 'mCurrentFocus=Window{5f u0 com.android.systemui/.Keyguard}\n',
        'mCurrentFocus=Window{6a u0 com.android.settings/.Settings}\n', FOCUS + 'mCurrentFocus=Window{7b u0 com.android.settings/.Settings}\n']) {
        const { phone, runtime } = makePhone({ handler: () => focus });
        await rejectsCode('phone_locked_or_other_app', phone.tap(60, 130));
        await rejectsCode('phone_locked_or_other_app', phone.back());
        assertNoUi(runtime);
    }
});

test('launcher resolution permits only the fixed package and argv has no shell interpolation', async () => {
    const { phone, runtime } = makePhone();
    await phone.launch();
    assert.deepEqual(deviceCommands(runtime), [
        ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'],
        ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', PACKAGE],
        ['shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity'],
    ]);
    for (const component of ['com.android.settings/.Settings', PACKAGE + '/.MainActivity;id', PACKAGE + '/.One\n' + PACKAGE + '/.Two']) {
        const bad = makePhone({ handler: args => args.includes('resolve-activity') ? component : undefined });
        await rejectsCode('app_missing', bad.phone.launch());
        assert.ok(!deviceCommands(bad.runtime).some(args => args[1] === 'am'));
    }
});

test('UI dump checks focus around the dump and cleans only its own generated path', async () => {
    const { phone, runtime } = makePhone();
    assert.equal(await phone.dump(), '<hierarchy/>\n');
    const commands = deviceCommands(runtime);
    assert.deepEqual(commands[0], ['shell', 'dumpsys', 'window']);
    assert.match(commands[1][3], /^\/data\/local\/tmp\/vw-app-[0-9a-f]{32}\.xml$/);
    const temporary = commands[1][3];
    assert.deepEqual(commands[1].slice(0, 3), ['shell', 'uiautomator', 'dump']);
    assert.deepEqual(commands[2], ['shell', 'cat', temporary]);
    assert.deepEqual(commands[3], ['shell', 'rm', '-f', temporary]);
    assert.deepEqual(runtime.calls[3].options, { timeoutMs: 1500, maxOutputBytes: 4096 });
    assert.deepEqual(commands[4], ['shell', 'dumpsys', 'window']);
});

test('dump failures still attempt cleanup and cleanup failure preserves the original controlled failure', async () => {
    for (const failedCommand of ['uiautomator', 'cat']) {
        const { phone, runtime } = makePhone({ handler: args => {
            if (args[3] === failedCommand) throw new BridgeError('phone_timeout', 'Controlled timeout');
            if (args[3] === 'rm') throw new BridgeError('phone_unavailable', 'Cleanup failed');
        } });
        await rejectsCode('phone_timeout', phone.dump());
        const commands = deviceCommands(runtime);
        const dumped = commands.find(args => args[1] === 'uiautomator');
        assert.ok(dumped);
        assert.deepEqual(commands.at(-1), ['shell', 'rm', '-f', dumped[3]]);
    }
});

test('cancellation during a dump still attempts bounded private-file cleanup and sends no further app input', async () => {
    for (const stage of ['dump', 'inflight-failure', 'cat']) {
        const { phone, runtime, abort } = makePhone();
        runtime.handler = args => {
            const command = args[3];
            if ((stage === 'cat' && command === 'cat') || (stage !== 'cat' && command === 'uiautomator')) {
                abort.abort();
                if (stage === 'inflight-failure') throw new BridgeError('phone_unavailable', 'Controlled interruption');
            }
        };
        await rejectsCode(stage === 'inflight-failure' ? 'phone_unavailable' : 'cancelled', phone.dump());
        const commands = deviceCommands(runtime);
        const dump = commands.find(args => args[1] === 'uiautomator');
        assert.match(dump[3], /^\/data\/local\/tmp\/vw-app-[0-9a-f]{32}\.xml$/);
        assert.deepEqual(commands.at(-1), ['shell', 'rm', '-f', dump[3]]);
        assert.deepEqual(runtime.calls.at(-1).options, { timeoutMs: 1500, maxOutputBytes: 4096 });
        assert.ok(!commands.some(args => args[1] === 'input' || args[1] === 'am'));
        assert.equal(commands.filter(args => args[1] === 'dumpsys').length, 1);
        assert.equal(commands.some(args => args[1] === 'cat'), stage === 'cat');
    }
});

test('tap validates coordinates and sends no gesture after cancellation during focus check', async () => {
    for (const [x, y] of [[-1, 10], [10, 20001], ['60', 130], [60, true], [1.5, 2], [NaN, 1], [Infinity, 1]]) {
        const { phone, runtime } = makePhone();
        await rejectsCode('invalid_target', phone.tap(x, y));
        assert.equal(runtime.calls.length, 0);
    }
    const before = makePhone();
    before.abort.abort();
    await rejectsCode('cancelled', before.phone.tap(60, 130));
    assert.equal(before.runtime.calls.length, 0);
    const during = makePhone();
    during.runtime.handler = () => { during.abort.abort(); return FOCUS; };
    await rejectsCode('cancelled', during.phone.tap(60, 130));
    assertNoUi(during.runtime);
});

test('device calls honor an active deadline and refuse expired work before runtime invocation', async () => {
    const active = makePhone();
    active.phone.deadline = Date.now() + 4000;
    assert.equal(await active.phone.version(), '4.8.1');
    assert.ok(active.runtime.calls[0].options.timeoutMs > 0 && active.runtime.calls[0].options.timeoutMs <= 4000);
    assert.equal(active.runtime.calls[0].options.maxOutputBytes, 2 * 1024 * 1024);
    const expired = makePhone();
    expired.phone.deadline = Date.now() - 1;
    await rejectsCode('phone_timeout', expired.phone.version());
    assert.equal(expired.runtime.calls.length, 0);
});

test('journal reservation persists cooldown across new StateStore instances', async t => {
    const directory = await temporaryDirectory(t);
    const store = new StateStore(path.join(directory, 'private'));
    const before = Date.now();
    await store.reserveCommand(60);
    const saved = await store.read('command-journal');
    assert.ok(saved.lastAttempt >= before && saved.lastAttempt <= Date.now());
    const restarted = new StateStore(store.dataDir);
    await rejectsCode('cooldown', restarted.reserveCommand(60));
    assert.deepEqual(await restarted.read('command-journal'), saved);
    await restarted.write('command-journal', { lastAttempt: Date.now() - 61000 });
    await restarted.reserveCommand(60);
    assert.ok((await restarted.read('command-journal')).lastAttempt > saved.lastAttempt - 61000);
});

test('invalid or damaged journal never resets the cooldown by assuming a fresh state', async t => {
    const directory = await temporaryDirectory(t);
    const store = new StateStore(directory);
    for (const content of ['broken SECRET', '[]', 'null', '{}', '{"lastAttempt":"1"}', '{"lastAttempt":-1}', '{"lastAttempt":1e309}', ' '.repeat(65537)]) {
        await fs.writeFile(store.file('command-journal'), content, 'utf8');
        await rejectsCode('invalid_state', store.reserveCommand(60));
        assert.equal(await fs.readFile(store.file('command-journal'), 'utf8'), content);
    }
    throwsCode('invalid_state', () => store.file('../escape'));
});

test('private data files reject directories and symlinks instead of following them', async t => {
    const directory = await temporaryDirectory(t);
    const store = new StateStore(directory);
    await fs.mkdir(store.file('command-journal'));
    await rejectsCode('invalid_state', store.reserveCommand(60));
    await fs.rmdir(store.file('command-journal'));
    if (process.platform === 'win32') return; // Symlink privileges vary on Windows.
    const target = path.join(directory, 'other.json');
    await fs.writeFile(target, JSON.stringify({ lastAttempt: 0 }));
    await fs.symlink(target, store.file('command-journal'));
    await rejectsCode('invalid_state', store.reserveCommand(60));
    assert.equal(await fs.readFile(target, 'utf8'), '{"lastAttempt":0}');
});

test('an inaccessible private data directory produces a controlled persistence failure', async t => {
    const directory = await temporaryDirectory(t);
    const blocked = path.join(directory, 'blocked');
    await fs.writeFile(blocked, 'KEEP');
    await rejectsCode('state_not_saved', new StateStore(blocked).write('enrollment', { deviceId: SERIAL }));
    assert.equal(await fs.readFile(blocked, 'utf8'), 'KEEP');
});

test('new private directories and atomically replaced data files use restrictive POSIX modes', { skip: process.platform === 'win32' }, async t => {
    const directory = await temporaryDirectory(t);
    const store = new StateStore(path.join(directory, 'private'));
    await store.write('enrollment', { deviceId: SERIAL });
    assert.equal((await fs.stat(store.dataDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(store.file('enrollment'))).mode & 0o777, 0o600);
    await fs.chmod(store.file('enrollment'), 0o644);
    await store.write('enrollment', { deviceId: ANDROID });
    assert.equal((await fs.stat(store.file('enrollment'))).mode & 0o777, 0o600);
    assert.deepEqual(await store.read('enrollment'), { deviceId: ANDROID });
    assert.ok(!(await fs.readdir(store.dataDir)).some(name => name.endsWith('.tmp')));
});

test('two DeviceLease instances cannot control the same identity until the owner closes', async t => {
    const id = 'serial:TEST-' + crypto.randomUUID();
    const first = new DeviceLease();
    const second = new DeviceLease();
    t.after(async () => { await first.close(); await second.close(); });
    await first.acquire(id);
    await first.acquire(id); // Reacquiring the same identity is idempotent.
    await rejectsCode('device_busy', second.acquire(id));
    await rejectsCode('wrong_device', first.acquire(id + '-other'));
    await first.close();
    await second.acquire(id);
    assert.equal(second.deviceId, id);
    await second.close();
    assert.equal(second.deviceId, null);
});
