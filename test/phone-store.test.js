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
const { MIN_TEMPERATURE_CELSIUS, MAX_TEMPERATURE_CELSIUS, TEMPERATURE_STEP_CELSIUS,
    isTemperature, validateTargetTemperature } = require('../lib/temperature');

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
        if (command.join(' ') === 'exec-out uiautomator dump /proc/self/fd/1') return 'Warning\n<hierarchy/>\nUI hierarchy dumped to: /proc/self/fd/1\n';
        return '';
    }
}

function makePhone({ deviceId = SERIAL, handler, onVerified = async () => {} } = {}) {
    const runtime = new FakeRuntime(handler);
    const abort = new AbortController();
    const phone = new Phone({ runtime, endpoint: ENDPOINT, deviceId, onVerified, signal: abort.signal });
    // Native-view parser tests isolate the separately tested minimal protocol.
    phone.securityStatus = async () => ({ kind: 'other', errorCode: null });
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
        { commandTimeoutSeconds: true }, { outcomeTimeoutSeconds: true }, { outcomeTimeoutSeconds: 29 },
        { outcomeTimeoutSeconds: 151 }, { outcomeTimeoutSeconds: '120\n' },
        { cooldownSeconds: NaN }, { pollIntervalSeconds: 14 },
        { legacyStatePrefix: 'system.adapter.vw-app.0' }, { modeTitles: ' | ' }]) {
        throwsCode('invalid_config', () => normalizeConfig(config));
    }
});

test('confirmation wait defaults and bounds allow a shorter overall deadline without extending it', () => {
    const defaults = normalizeConfig();
    assert.equal(defaults.commandTimeoutSeconds, 300);
    assert.equal(defaults.outcomeTimeoutSeconds, 120);
    for (const outcomeTimeoutSeconds of [30, 150, '120']) {
        assert.equal(normalizeConfig({ outcomeTimeoutSeconds }).outcomeTimeoutSeconds, Number(outcomeTimeoutSeconds));
    }
    const shorter = normalizeConfig({ commandTimeoutSeconds: 60, outcomeTimeoutSeconds: 150 });
    assert.equal(shorter.commandTimeoutSeconds, 60);
    assert.equal(shorter.outcomeTimeoutSeconds, 150);
    const native = require('../io-package.json').native;
    const admin = require('../admin/jsonConfig.json').items;
    for (const key of ['commandTimeoutSeconds', 'outcomeTimeoutSeconds']) {
        assert.equal(native[key], defaults[key]);
        assert.equal(admin[key].default, defaults[key]);
    }
    assert.equal(admin.outcomeTimeoutSeconds.min, 30);
    assert.equal(admin.outcomeTimeoutSeconds.max, 150);
    assert.equal(admin.commandTimeoutSeconds.max, 360);
});

test('target temperatures accept only finite numeric 0.5-degree values in the verified 16 to 29.5 range or null', () => {
    assert.equal(MIN_TEMPERATURE_CELSIUS, 16);
    assert.equal(MAX_TEMPERATURE_CELSIUS, 29.5);
    assert.equal(TEMPERATURE_STEP_CELSIUS, 0.5);
    for (let value = MIN_TEMPERATURE_CELSIUS; value <= MAX_TEMPERATURE_CELSIUS; value += TEMPERATURE_STEP_CELSIUS) {
        assert.equal(isTemperature(value), true);
        assert.equal(validateTargetTemperature(value), value);
    }
    assert.equal(validateTargetTemperature(null), null);
    assert.equal(isTemperature(null), false);
    for (const value of [15.5, 30, 22.25, NaN, Infinity, -Infinity, true, false, undefined, '22.5', 'LO', 'HI', '', {}, []]) {
        assert.equal(isTemperature(value), false);
        throwsCode('invalid_temperature', () => validateTargetTemperature(value));
    }
});

test('configuration preserves the complete vehicle prefix and its trailing delimiter', () => {
    const marker = 'Ihr Fahrzeug: ID.7 GTX Tourer. ';
    const cfg = normalizeConfig({ hostIp: '192.0.2.14', connectPort: '37123', vehicleMarker: marker,
        commandTimeoutSeconds: '125', outcomeTimeoutSeconds: '90', cooldownSeconds: '60', modeTitles: ' Klimatisierung | Air conditioning ' });
    assert.equal(cfg.vehicleMarker, marker);
    assert.equal(cfg.connectPort, 37123);
    assert.equal(cfg.commandTimeoutSeconds, 125);
    assert.equal(cfg.outcomeTimeoutSeconds, 90);
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
    const otherFocus = 'mCurrentFocus=Window{18ab u0 com.android.launcher/.Home}\n';
    let focusReads=0;
    const { phone, runtime } = makePhone({ handler: args => args.slice(2).join(' ') === 'shell dumpsys window' && focusReads++===0 ? otherFocus : undefined });
    await phone.launch();
    assert.deepEqual(deviceCommands(runtime), [
        ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'],
        ['shell', 'dumpsys', 'window'],
        ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', PACKAGE],
        ['shell', 'am', 'start', '-W', '--activity-reorder-to-front', '--activity-single-top', '-n', PACKAGE + '/.MainActivity'],
        ['shell', 'dumpsys', 'window'],
    ]);
    for (const component of ['com.android.settings/.Settings', PACKAGE + '/.MainActivity;id', PACKAGE + '/.One\n' + PACKAGE + '/.Two']) {
        const bad = makePhone({ handler: args => args.slice(2).join(' ') === 'shell dumpsys window' ? otherFocus : args.includes('resolve-activity') ? component : undefined });
        await rejectsCode('app_missing', bad.phone.launch());
        assert.ok(!deviceCommands(bad.runtime).some(args => args[1] === 'am'));
    }
});

test('launcher waits for focus transition without launching twice and stops if focus never changes', async()=>{
    let focusReads=0;
    const otherFocus='mCurrentFocus=Window{18ab u0 com.android.launcher/.Home}\n';
    const delayed=makePhone({handler:args=>args.slice(2).join(' ')==='shell dumpsys window' && focusReads++<2 ? otherFocus : undefined});
    await delayed.phone.launch();
    assert.equal(deviceCommands(delayed.runtime).filter(args=>args[1]==='am').length,1);
    assert.equal(focusReads,3);
    const blocked=makePhone({handler:args=>args.slice(2).join(' ')==='shell dumpsys window' ? otherFocus : undefined});
    await rejectsCode('phone_locked_or_other_app',blocked.phone.launch());
    assert.equal(deviceCommands(blocked.runtime).filter(args=>args[1]==='am').length,1);
    assert.equal(deviceCommands(blocked.runtime).filter(args=>args.slice(0,3).join(' ')==='shell dumpsys window').length,6);
});

test('launch preserves an already visible VW screen without replacing its manual draft', async () => {
    const { phone, runtime } = makePhone();
    await phone.launch();
    assert.deepEqual(deviceCommands(runtime), [['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], ['shell', 'dumpsys', 'window']]);
});

test('launch does not treat a failed focus read as permission to open another Activity', async () => {
    const { phone, runtime } = makePhone({ handler: args => {
        if (args.slice(2).join(' ') === 'shell dumpsys window') throw new BridgeError('adb_command_failed', 'Focus failed.');
    } });
    await rejectsCode('adb_command_failed', phone.launch());
    assert.ok(!deviceCommands(runtime).some(args => args[1] === 'am'));
});

test('bounded swipes validate coordinates and recheck focus before sending input', async () => {
    const { phone, runtime } = makePhone();
    for (const gesture of [{}, {x1:1,y1:2,x2:1,y2:2}, {x1:1,y1:2,x2:3,y2:4,durationMs:0}, {x1:-1,y1:2,x2:3,y2:4}, {x1:1,y1:2,x2:3,y2:Infinity}]) {
        await rejectsCode('invalid_target', phone.swipe(gesture));
    }
    assert.equal(runtime.calls.length, 0);
    await phone.swipe({x1:50,y1:1000,x2:50,y2:300,durationMs:400});
    assert.deepEqual(deviceCommands(runtime), [['shell','dumpsys','window'], ['shell','input','swipe','50','1000','50','300','400']]);
});

test('native view returns only the current VW tree and lifecycle flags, excluding other tasks and app saved state', async () => {
    const native = '  ACTIVITY other.app/.Other aaaa pid=10\nSECRET_OTHER_TASK\n'
        + '  ACTIVITY '+PACKAGE+'/.SingleActivity bbbb pid=20\n    Local Activity State:\n      mResumed=true mStopped=false mFinished=false\n      SECRET_SAVED_STATE\n'
        + '    View Hierarchy:\n      DecorView@aaaa[SingleActivity]\n        android.widget.LinearLayout{aaaa V.E...... ........ 0,0-1000,2000}\n'
        + '    Looper data:\nSECRET_INTERNAL_LOG\n';
    const {phone}=makePhone({handler:args=>args.slice(2).join(' ')==='shell dumpsys activity top'?native:undefined});
    const result=await phone.nativeView();
    assert.ok(result.startsWith('  ACTIVITY '+PACKAGE+'/.SingleActivity'));
    assert.ok(result.includes('mResumed=true mStopped=false mFinished=false'));
    assert.ok(result.includes('View Hierarchy:'));
    assert.ok(!result.includes('SECRET')); assert.ok(!result.includes('other.app'));
});

test('native view ambiguity and missing lifecycle metadata fail with fixed diagnostics', async () => {
    const prefix='  ACTIVITY '+PACKAGE+'/.SingleActivity bbbb pid=20\n';
    for (const native of ['SECRET',prefix+'    View Hierarchy:\n      DecorView@aaaa[SingleActivity]\n',prefix+prefix]) {
        const {phone}=makePhone({handler:args=>args.slice(2).join(' ')==='shell dumpsys activity top'?native:undefined});
        await rejectsCode('native_ui_unavailable',phone.nativeView());
    }
});

test('UI dump checks focus around a stdout-only read and never creates, cats or removes a UI file', async () => {
    const { phone, runtime } = makePhone();
    assert.equal(await phone.dump(), '<hierarchy/>\n');
    const commands = deviceCommands(runtime);
    assert.deepEqual(commands[0], ['shell', 'dumpsys', 'window']);
    assert.deepEqual(commands[1], ['exec-out', 'uiautomator', 'dump', '/proc/self/fd/1']);
    assert.deepEqual(commands[2], ['shell', 'dumpsys', 'window']);
    assert.equal(commands.length, 3);
});

test('dump failures preserve fixed runtime errors without any temporary file or cleanup call', async () => {
    const { phone, runtime } = makePhone({ handler: args => {
        if (args[2] === 'exec-out') throw new BridgeError('phone_timeout', 'Controlled timeout');
    } });
    await rejectsCode('phone_timeout', phone.dump());
    assert.equal(deviceCommands(runtime).length, 2);
    assert.equal(deviceCommands(runtime).some(args => args.includes('cat') || args.includes('rm')), false);
});

test('cancellation during a stdout dump sends no more UI or diagnostic calls', async () => {
    for (const stage of ['dump', 'inflight-failure']) {
        const { phone, runtime, abort } = makePhone();
        runtime.handler = args => {
            if (args[2] === 'exec-out') {
                abort.abort();
                if (stage === 'inflight-failure') throw new BridgeError('phone_unavailable', 'Controlled interruption');
            }
        };
        await rejectsCode(stage === 'inflight-failure' ? 'phone_unavailable' : 'cancelled', phone.dump());
        const commands = deviceCommands(runtime);
        assert.deepEqual(commands.at(-1), ['exec-out', 'uiautomator', 'dump', '/proc/self/fd/1']);
        assert.ok(!commands.some(args => args[1] === 'input' || args[1] === 'am'));
        assert.equal(commands.filter(args => args[1] === 'dumpsys').length, 1);
        assert.equal(commands.some(args => args[1] === 'cat' || args[1] === 'rm'), false);
    }
});

test('ordinary XML reads reject decoded S-PIN headers, password fields and malformed/duplicate hierarchies without exposing values', async () => {
    const sensitive = [
        '<hierarchy><node text="S-PIN eingeben"/></hierarchy>',
        '<hierarchy><node content-desc="S&#45;PIN eingeben" text="SECRET"/></hierarchy>',
        '<hierarchy><node password="true" text="SECRET"/></hierarchy>',
    ];
    for (const output of sensitive) {
        const { phone, runtime } = makePhone({ handler: args => args[2] === 'exec-out' ? output : undefined });
        await rejectsCode('security_ui_active', phone.dump());
        assert.equal(runtime.calls.length, 2);
    }
    for (const output of ['SECRET', '<hierarchy/><hierarchy/>', '<hierarchy><node></hierarchy>', '<hierarchy/><hierarchy>']) {
        const { phone } = makePhone({ handler: args => args[2] === 'exec-out' ? output : undefined });
        await rejectsCode('invalid_ui', phone.dump());
    }
});

test('native diagnostic reads require a fresh minimal non-PIN scan, including after restart or uncertain entry', async () => {
    for (const method of ['nativeView', 'departureNative']) {
        for (const status of [{ kind: 'pinEmpty', errorCode: null }, { kind: 'pinNonEmpty', errorCode: null },
            { kind: 'pinUnsupported', errorCode: 'SECURITY_CONTEXT_UNSUPPORTED' }, { kind: 'other', errorCode: 'SECURITY_CONTEXT_UNAVAILABLE' }]) {
            const { phone, runtime } = makePhone(); let probes = 0;
            phone.securityStatus = async () => { probes++; return status; };
            await rejectsCode('security_ui_active', phone[method]());
            assert.equal(probes, 1); assert.equal(runtime.calls.length, 0);
        }
    }
});

test('sensitive process transport forwards bounded stdin and honors cancellation/deadline without echoing input', async () => {
    const { phone, runtime, abort } = makePhone();
    const input = Buffer.from('synthetic envelope');
    phone.deadline = Date.now() + 4000;
    await phone.runSensitive(['shell', '-T', 'uiautomator'], input);
    assert.deepEqual(runtime.calls[0].args, ['-s', ENDPOINT, 'shell', '-T', 'uiautomator']);
    assert.equal(runtime.calls[0].options.input, input); assert.equal(runtime.calls[0].options.maxOutputBytes, 8192);
    assert.ok(runtime.calls[0].options.timeoutMs > 0 && runtime.calls[0].options.timeoutMs <= 4000);
    await rejectsCode('security_context_invalid', phone.runSensitive([], Buffer.alloc(4097)));
    await rejectsCode('security_context_invalid', phone.runSensitive([], 'SECRET'));
    abort.abort(); await rejectsCode('cancelled', phone.runSensitive([], input));
    assert.equal(runtime.calls.length, 1);
});

async function keyboardPhone({ flags = [{ input: true, view: true }, { input: true, view: true }, { input: false, view: true }], handler, ack } = {}) {
    const subject = makePhone({ handler: (args, options) => {
        const custom = handler?.(args, options);
        if (custom !== undefined) return custom;
        if (args.slice(2).join(' ') === 'shell dumpsys input_method') {
            const next = flags.shift() || { input: true, view: true };
            return typeof next === 'string' ? next : '  mShowRequested=true mInputShown=' + next.input + '\n  mIsInputViewShown=' + next.view + '\n  EditorInfo: SECRET\n';
        }
    } });
    let clock = 1;
    subject.phone.androidUi.now = () => clock;
    subject.phone.androidUi.secretPinEntry = async () => ack || { beforeMatched: true, actionAttempted: true, actionAccepted: true, errorCode: null };
    await subject.phone.secretPinEntry({}, { operation: 'unlock' }, () => assert.fail('No actual credential in fixture'));
    return { ...subject, setClock: value => { clock = value; } };
}

test('accepted secret entry authorizes one verified keyboard hide, without another PIN, Enter, vehicle gesture or UI dump', async () => {
    const { phone, runtime } = await keyboardPhone();
    assert.deepEqual(await phone.hideSecurityKeyboard(), { kind: 'hidden', actionAttempted: true });
    const commands = deviceCommands(runtime);
    assert.equal(commands.filter(args => args.join(' ') === 'shell input keyevent KEYCODE_BACK').length, 1);
    assert.equal(commands.filter(args => args.join(' ') === 'shell dumpsys input_method').length, 3);
    assert.equal(commands.some(args => args.includes('tap') || args.includes('KEYCODE_ENTER') || args.includes('uiautomator')), false);
    await rejectsCode('security_keyboard_unauthorized', phone.hideSecurityKeyboard());
    assert.equal(commands.filter(args => args.includes('KEYCODE_BACK')).length, 1);
});

test('an already hidden keyboard is a no-op even when Samsung retains the stale viewShown flag', async () => {
    for (const flags of [[{ input: false, view: true }], [{ input: false, view: false }],
        [{ input: true, view: true }, { input: false, view: true }]]) {
        const { phone, runtime } = await keyboardPhone({ flags });
        assert.deepEqual(await phone.hideSecurityKeyboard(), { kind: 'alreadyHidden', actionAttempted: false });
        assert.equal(deviceCommands(runtime).some(args => args.includes('input')), false);
    }
});

test('keyboard hiding rejects absent, rejected, expired and consumed entry authorization before any device call', async () => {
    const blank = makePhone();
    await rejectsCode('security_keyboard_unauthorized', blank.phone.hideSecurityKeyboard());
    assert.equal(blank.runtime.calls.length, 0);
    for (const ack of [{ beforeMatched: false, actionAttempted: false, actionAccepted: null, errorCode: null },
        { beforeMatched: true, actionAttempted: true, actionAccepted: false, errorCode: 'SECURITY_ACTION_NOT_ACCEPTED' },
        { beforeMatched: true, actionAttempted: true, actionAccepted: true, errorCode: 'SECURITY_SESSION_CLEANUP' }]) {
        const { phone, runtime } = await keyboardPhone({ ack });
        await rejectsCode('security_keyboard_unauthorized', phone.hideSecurityKeyboard());
        assert.equal(runtime.calls.length, 0);
    }
    const expired = await keyboardPhone(); expired.setClock(180002);
    await rejectsCode('security_keyboard_unauthorized', expired.phone.hideSecurityKeyboard());
    assert.equal(expired.runtime.calls.length, 0);
});

test('one-use keyboard authorization remains valid during the bounded backend confirmation wait', async () => {
    const subject = await keyboardPhone(); subject.setClock(150001);
    assert.deepEqual(await subject.phone.hideSecurityKeyboard(), { kind: 'hidden', actionAttempted: true });
    assert.equal(deviceCommands(subject.runtime).filter(args => args.includes('KEYCODE_BACK')).length, 1);
});

test('a later failed entry invalidates earlier keyboard authorization and cancellation diagnostics remain fixed', async () => {
    const previous = await keyboardPhone();
    previous.phone.androidUi.secretPinEntry = async () => { throw new BridgeError('security_entry_uncertain', 'Fixed test failure'); };
    await rejectsCode('security_entry_uncertain', previous.phone.secretPinEntry({}, { operation: 'lock' }, () => assert.fail()));
    await rejectsCode('security_keyboard_unauthorized', previous.phone.hideSecurityKeyboard());
    assert.equal(previous.runtime.calls.length, 0);
    const cancelled = await keyboardPhone();
    cancelled.phone.securityStatus = async () => { throw new BridgeError('cancelled', 'SECRET diagnostic'); };
    await rejectsCode('cancelled', cancelled.phone.hideSecurityKeyboard());
    assert.equal(deviceCommands(cancelled.runtime).some(args => args.includes('input')), false);
});

test('missing, duplicate, inconsistent or malformed IME metadata never causes a Back gesture or leaks diagnostics', async () => {
    for (const flags of [['SECRET'], ['mInputShown=true\nmIsInputViewShown=true\nmInputShown=true\n'],
        ['mInputShown=true\nmIsInputViewShown=SECRET\n'], [{ input: true, view: false }]]) {
        const { phone, runtime } = await keyboardPhone({ flags });
        await rejectsCode('security_keyboard_unavailable', phone.hideSecurityKeyboard());
        assert.equal(deviceCommands(runtime).some(args => args.includes('input')), false);
        await rejectsCode('security_keyboard_unauthorized', phone.hideSecurityKeyboard());
    }
});

test('a foreign foreground or any open/uncertain PIN context prevents keyboard navigation', async () => {
    for (const status of [{ kind: 'pinEmpty', errorCode: null }, { kind: 'pinNonEmpty', errorCode: null },
        { kind: 'pinUnsupported', errorCode: 'SECURITY_CONTEXT_UNSUPPORTED' }, { kind: 'other', errorCode: 'SECURITY_CONTEXT_UNAVAILABLE' }]) {
        const { phone, runtime } = await keyboardPhone(); phone.securityStatus = async () => status;
        await rejectsCode('security_keyboard_unavailable', phone.hideSecurityKeyboard());
        assert.equal(deviceCommands(runtime).some(args => args.includes('input')), false);
    }
    const foreign = await keyboardPhone({ handler: args => args.slice(2).join(' ') === 'shell dumpsys window'
        ? 'mCurrentFocus=Window{test u0 other.app/.Activity}\n' : undefined });
    await rejectsCode('security_keyboard_unavailable', foreign.phone.hideSecurityKeyboard());
    assert.equal(deviceCommands(foreign.runtime).some(args => args.includes('input')), false);
});

test('a keyboard hide failure is uncertain after exactly one Back and never retries input', async () => {
    for (const mode of ['transport', 'stillShown']) {
        const { phone, runtime } = await keyboardPhone({ flags: Array.from({ length: 5 }, () => ({ input: true, view: true })),
            handler: args => { if (mode === 'transport' && args.includes('KEYCODE_BACK')) throw new Error('SECRET input failure'); } });
        await rejectsCode('security_keyboard_uncertain', phone.hideSecurityKeyboard());
        assert.equal(deviceCommands(runtime).filter(args => args.includes('KEYCODE_BACK')).length, 1);
        await rejectsCode('security_keyboard_unauthorized', phone.hideSecurityKeyboard());
    }
});

test('keyboard guard rechecks IME visibility and VW focus immediately before input, honoring cancellation and token expiry', async () => {
    const expired = await keyboardPhone();
    expired.phone.securityStatus = async () => { expired.setClock(180002); return { kind: 'other', errorCode: null }; };
    await rejectsCode('security_keyboard_unauthorized', expired.phone.hideSecurityKeyboard());
    assert.equal(deviceCommands(expired.runtime).some(args => args.includes('input')), false);
    const cancelled = await keyboardPhone();
    cancelled.phone.securityStatus = async () => { cancelled.abort.abort(); return { kind: 'other', errorCode: null }; };
    await rejectsCode('cancelled', cancelled.phone.hideSecurityKeyboard());
    assert.equal(deviceCommands(cancelled.runtime).some(args => args.includes('input')), false);
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

test('temperature preference persists independently of enrollment and the command cooldown journal', async t => {
    const directory = await temporaryDirectory(t);
    const store = new StateStore(directory);
    await store.write('enrollment', { deviceId: SERIAL });
    await store.write('command-journal', { lastAttempt: 123 });
    await store.write('temperature-preference', { targetCelsius: 22.5 });
    await store.write('settings-preference', { mode: 'windowHeating', climateOnUnlock: false, autoWindowHeating: true, zones: 'frontLeft' });
    const restored = new StateStore(directory);
    assert.equal(path.basename(restored.file('temperature-preference')), 'temperature-preference.json');
    assert.deepEqual(await restored.read('temperature-preference'), { targetCelsius: 22.5 });
    assert.deepEqual(await restored.read('settings-preference'), { mode: 'windowHeating', climateOnUnlock: false, autoWindowHeating: true, zones: 'frontLeft' });
    await restored.write('temperature-preference', { targetCelsius: null });
    assert.deepEqual(await store.read('temperature-preference'), { targetCelsius: null });
    assert.deepEqual(await store.read('enrollment'), { deviceId: SERIAL });
    assert.deepEqual(await store.read('command-journal'), { lastAttempt: 123 });
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
    for (const name of ['departure-preference', 'departure-location-bindings']) {
        await store.write(name, { version: 1, test: 'first' });
        assert.equal((await fs.stat(store.file(name))).mode & 0o777, 0o600);
        await fs.chmod(store.file(name), 0o644);
        await store.write(name, { version: 1, test: 'replacement' });
        assert.equal((await fs.stat(store.file(name))).mode & 0o777, 0o600);
        assert.deepEqual(await new StateStore(store.dataDir).read(name), { version: 1, test: 'replacement' });
    }
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
