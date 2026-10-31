'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { AndroidUi, RUNNERS } = require('../lib/android-ui');
const { Phone } = require('../lib/phone');
const manifest = require('../lib/android/manifest.json');

function node(fields = {}) {
    return { package: 'com.volkswagen.weconnect', id: null, class: 'android.view.View', text: null,
        description: null, stateDescription: null, bounds: [0, 0, 1080, 2400], visible: true, enabled: true,
        clickable: false, longClickable: false, checkable: false, checked: false, selected: false, scrollable: false,
        focusable: false, focused: false, accessibilityFocused: false, password: false, heading: false,
        screenReaderFocusable: false, importantForAccessibility: true, rangeInfo: null, actions: [], children: [], ...fields };
}
function frame() {
    const window = { id: 7, type: 1, active: true, focused: true, accessibilityFocused: false,
        layer: 0, title: 'Synthetic', bounds: [0, 0, 1080, 2400] };
    const windows = { vwWindows: [window], multipleVwApplicationWindows: false, foreignWindowCount: 1 };
    return { format: 'vw-app-extended-accessibility-v1', package: 'com.volkswagen.weconnect', readOnly: true,
        startedAtEpochMs: 1000, finishedAtEpochMs: 1001, windowId: 7, windowsBefore: windows, windowsAfter: windows,
        nodeCount: 4, root: node({ children: [
            node({ description: 'Zeit einstellen', bounds: [100, 100, 900, 200] }),
            node({ description: 'Hour', class: 'android.widget.SeekBar', stateDescription: '08', bounds: [400, 500, 480, 800],
                rangeInfo: { type: 1, min: 0, max: 229999, current: 115007 }, actions: [{ id: 16908349, label: null }] }),
            node({ class: 'android.widget.EditText', text: 'Synthetic place', bounds: [100, 900, 980, 1000],
                actions: [{ id: 2097152, label: null }] }),
        ] }) };
}
const target = { description: 'Hour', bounds: [400, 500, 480, 800] };
async function setup(t, overrides = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-ui-test-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(dataDir).startsWith('vw-ui-test-'));
        await fs.rm(dataDir, { recursive: true, force: true });
    });
    const calls = [], files = new Map();
    let request, ticks = 1, stopped = false;
    const currentFrame = frame();
    const phone = {
        endpoint: '192.0.2.10:12345', runtime: { dataDir },
        check() { if (stopped) { const error = new Error('cancelled'); error.code = 'cancelled'; throw error; } },
        async foreground() { phone.check(); await overrides.foreground?.(); },
        async run(args) {
            phone.check(); calls.push([...args]);
            const custom = await overrides.run?.(args, { setTicks: value => { ticks = value; }, stop: () => { stopped = true; } });
            if (custom !== undefined) return custom;
            if (args[0] === 'push') {
                if (args[1].endsWith('.json')) request = JSON.parse(await fs.readFile(args[1], 'utf8'));
                return '';
            }
            if (args[3]?.startsWith('if [ -f ')) return manifest.sha256 + '  /data/local/tmp/vw-app-ui-' + manifest.sha256 + '.jar\n';
            if (args[1] === 'uiautomator') {
                const out = args[args.indexOf('out') + 1];
                if (args.includes(RUNNERS.read)) { files.set(out, JSON.stringify(currentFrame)); return 'Warning\nVW_UI_DUMP_OK\n'; }
                if (overrides.actionThrows) throw new Error('PRIVATE transport data');
                const result = { format: 'vw-app-accessibility-action-v1', requestNonce: request.nonce, action: request.action,
                    actionId: request.action === 'setText' ? 2097152 : 16908349,
                    beforeMatched: true, actionAttempted: true, actionAccepted: true, success: true,
                    nativeContextVerifiedByRunner: false, errorCode: null, postReadError: null, postRead: currentFrame,
                    ...(overrides.result || {}) };
                files.set(out, JSON.stringify(result)); return 'VW_UI_ACTION_RESULT\n';
            }
            if (args[1] === 'cat') return files.get(args[2]);
            throw new Error('Unexpected test call: ' + args.join(' '));
        },
    };
    phone.runtime.run = async args => { calls.push([...args]); return ''; };
    const bridge = new AndroidUi(phone, { now: () => ticks });
    return { bridge, phone, calls, frame: currentFrame, request: () => request, setTicks: value => { ticks = value; } };
}
async function readAndAct(subject, changes = {}) {
    const { observation } = await subject.bridge.read();
    return subject.bridge.action({ snapshot: observation, header: 'Zeit einstellen', target, action: 'setProgress', value: 115008, ...changes });
}
test('first installation uploads a genuinely absent Android helper and checks its hash', async t => {
    let present = false;
    const subject = await setup(t, {run: async args => {
        if (args[0] === 'push') { present = true; return ''; }
        if (args[3]?.startsWith('if [ -f ')) return present
            ? manifest.sha256 + '  /data/local/tmp/vw-app-ui-' + manifest.sha256 + '.jar\n' : 'absent\n';
    }});
    await subject.bridge.payload();
    assert.equal(subject.calls.filter(call => call[0] === 'push').length, 1);
    assert.equal(subject.calls.filter(call => call[3]?.startsWith('if [ -f ')).length, 2);
});
test('bad helper response or connection failure never triggers an upload', async t => {
    for (const bad of ['not-an-allowed-response', '']) {
        const subject = await setup(t, {run: async args => args[3]?.startsWith('if [ -f ') ? bad : undefined});
        await assert.rejects(subject.bridge.payload());
        assert.equal(subject.calls.filter(call => call[0] === 'push').length, 0);
    }
    const subject = await setup(t, {run: async args => { if (args[3]?.startsWith('if [ -f ')) throw Error('connection lost'); }});
    await assert.rejects(subject.bridge.payload());
    assert.equal(subject.calls.filter(call => call[0] === 'push').length, 0);
});
function invocations(calls) { return calls.filter(call => call.includes(RUNNERS.action)); }

async function setupSecurity(t, options = {}) {
    const subject = await setup(t);
    const originalRun = subject.phone.run.bind(subject.phone);
    const requests = [], buffers = [];
    subject.phone.run = async args => {
        if (!args.includes('securityMode')) return originalRun(args);
        subject.calls.push([...args]);
        const nonce = args[args.indexOf('nonce') + 1];
        const kind = options.kind || 'pinEmpty';
        const frame = { format: 'vw-app-security-status-v1', nonce, kind,
            operation: ['pinEmpty', 'pinNonEmpty'].includes(kind) ? 'unlock' : null,
            contextDigest: kind === 'pinEmpty' ? 'c'.repeat(64) : null, errorCode: null, ...options.status };
        return options.statusOutput?.(frame) ?? 'Warning one\nWarning two\nWarning three\nWarning four\nVW_SECURITY_STATUS_RESULT ' + JSON.stringify(frame) + '\n';
    };
    subject.phone.runSensitive = async (args, input) => {
        subject.calls.push([...args]); buffers.push(input);
        const request = JSON.parse(input.toString('utf8')); requests.push(request);
        if (options.entryThrows) throw new Error('PRIVATE input failure');
        await options.onEntry?.(request);
        const frame = { format: 'vw-app-security-entry-v1', nonce: request.nonce,
            beforeMatched: true, actionAttempted: true, actionAccepted: true, errorCode: null, ...options.entry };
        return options.entryOutput?.(frame) ?? 'Warning\nVW_SECURITY_ENTRY_RESULT ' + JSON.stringify(frame) + '\n';
    };
    return { ...subject, requests, buffers };
}

test('minimal security probe accepts one nonce frame after Android warnings and exposes only an opaque one-use token', async t => {
    const subject = await setupSecurity(t);
    const status = await subject.bridge.securityStatus();
    assert.equal(status.kind, 'pinEmpty'); assert.equal(status.operation, 'unlock'); assert.equal(status.errorCode, null);
    assert.deepEqual(Object.keys(status.token), []); assert.ok(Object.isFrozen(status.token));
    assert.equal(JSON.stringify(status).includes('cccc'), false);
    assert.equal(subject.calls.filter(call => call.includes('securityMode')).length, 1);
    assert.equal(subject.calls.some(call => call.includes('cat') || call.includes('push') || call.includes('rm')), false);
    await assert.rejects(fs.stat(path.join(subject.phone.runtime.dataDir, 'ui-requests')), { code: 'ENOENT' });
});

test('security protocol rejects malformed, duplicate, noncanonical, extra and mismatched status frames with fixed diagnostics', async t => {
    const variants = [
        frame => JSON.stringify({ ...frame, nonce: 'different' }),
        frame => JSON.stringify({ ...frame, contextDigest: 'invalid' }),
        frame => JSON.stringify({ ...frame, operation: 'unsupported' }),
        frame => JSON.stringify({ ...frame, extra: 'PRIVATE' }),
        frame => JSON.stringify({ ...frame, errorCode: 'PRIVATE' }),
        frame => JSON.stringify(frame).replace('{', '{"nonce":"duplicate",'),
        frame => JSON.stringify(frame, null, 1),
        () => 'PRIVATE invalid json',
    ];
    for (const change of variants) {
        const subject = await setupSecurity(t, { statusOutput: frame => 'VW_SECURITY_STATUS_RESULT ' + change(frame) + '\n' });
        await assert.rejects(subject.bridge.securityStatus(), error => error.code === 'security_status_unavailable' && !error.message.includes('PRIVATE'));
    }
    const duplicate = await setupSecurity(t, { statusOutput: frame => ('VW_SECURITY_STATUS_RESULT ' + JSON.stringify(frame) + '\n').repeat(2) });
    await assert.rejects(duplicate.bridge.securityStatus(), { code: 'security_status_unavailable' });
});

test('PIN entry uses only bounded stdin, preserves leading zeroes, wipes the transport buffer, and never requests post-read or files', async t => {
    const subject = await setupSecurity(t);
    const status = await subject.bridge.securityStatus();
    const result = await subject.bridge.secretPinEntry(status.token, { operation: 'unlock' }, () => '0073');
    assert.deepEqual(result, { beforeMatched: true, actionAttempted: true, actionAccepted: true, errorCode: null });
    assert.equal(subject.requests.length, 1); assert.equal(subject.requests[0].pin, '0073');
    assert.equal(subject.requests[0].operation, 'unlock'); assert.equal(subject.requests[0].contextDigest, 'c'.repeat(64));
    assert.ok(subject.buffers[0].every(byte => byte === 0));
    assert.equal(JSON.stringify(subject.calls).includes('0073'), false);
    assert.equal(JSON.stringify(result).includes('0073'), false);
    assert.equal(subject.calls.some(call => call.includes('cat') || call.includes('push') || call.includes('rm') || call.includes('out') || call.includes('request')), false);
    await assert.rejects(subject.bridge.secretPinEntry(status.token, { operation: 'unlock' }, () => assert.fail('Consumed token getter')), { code: 'security_context_invalid' });
    await assert.rejects(fs.stat(path.join(subject.phone.runtime.dataDir, 'ui-requests')), { code: 'ENOENT' });
});

test('nonempty or unsupported security forms never grant an entry token', async t => {
    for (const kind of ['pinNonEmpty', 'pinUnsupported', 'home', 'other']) {
        const subject = await setupSecurity(t, { kind });
        const status = await subject.bridge.securityStatus();
        assert.equal(status.kind, kind); assert.equal(status.token, undefined);
        await assert.rejects(subject.bridge.secretPinEntry(status.token, { operation: 'unlock' }, () => assert.fail('No token getter')), { code: 'security_context_invalid' });
        assert.equal(subject.requests.length, 0);
    }
});

test('the separately recognized locking form authorizes only lock and sends its bound operation through stdin', async t => {
    const subject = await setupSecurity(t, { status: { operation: 'lock' } });
    const status = await subject.bridge.securityStatus();
    assert.equal(status.kind, 'pinEmpty'); assert.equal(status.operation, 'lock');
    await assert.rejects(subject.bridge.secretPinEntry(status.token, { operation: 'unlock' }, () => assert.fail('Wrong operation getter')), { code: 'security_context_invalid' });
    const result = await subject.bridge.secretPinEntry(status.token, { operation: 'lock' }, () => '0073');
    assert.equal(result.actionAttempted, true); assert.equal(result.actionAccepted, true);
    assert.equal(subject.requests.length, 1); assert.equal(subject.requests[0].operation, 'lock');
    assert.ok(subject.buffers[0].every(byte => byte === 0));
});

test('entry refuses fabricated, stale, superseded, cross-instance, or wrong-operation tokens before touching the PIN getter', async t => {
    const subject = await setupSecurity(t), other = await setupSecurity(t);
    const first = await subject.bridge.securityStatus();
    await assert.rejects(other.bridge.secretPinEntry(first.token, { operation: 'unlock' }, () => assert.fail()), { code: 'security_context_invalid' });
    await assert.rejects(subject.bridge.secretPinEntry({}, { operation: 'unlock' }, () => assert.fail()), { code: 'security_context_invalid' });
    await assert.rejects(subject.bridge.secretPinEntry(first.token, { operation: 'lock' }, () => assert.fail()), { code: 'security_context_invalid' });
    const latest = await subject.bridge.securityStatus();
    await assert.rejects(subject.bridge.secretPinEntry(first.token, { operation: 'unlock' }, () => assert.fail()), { code: 'security_context_invalid' });
    subject.setTicks(15002);
    await assert.rejects(subject.bridge.secretPinEntry(latest.token, { operation: 'unlock' }, () => assert.fail()), { code: 'security_context_stale' });
    await assert.rejects(subject.bridge.secretPinEntry(latest.token, { operation: 'unlock' }, () => assert.fail()), { code: 'security_context_invalid' });
    assert.equal(subject.requests.length, 0);
});

test('invalid or failing PIN getters produce fixed errors without invoking the native entry', async t => {
    for (const [getter, code] of [[() => '', 'security_pin_required'], [() => 1234, 'security_pin_invalid'],
        [() => 'PRIVATE', 'security_pin_invalid'], [() => { throw new Error('PRIVATE'); }, 'security_pin_unavailable']]) {
        const subject = await setupSecurity(t), status = await subject.bridge.securityStatus();
        await assert.rejects(subject.bridge.secretPinEntry(status.token, { operation: 'unlock' }, getter), error => error.code === code && !error.message.includes('PRIVATE'));
        assert.equal(subject.requests.length, 0);
        await assert.rejects(subject.bridge.secretPinEntry(status.token, { operation: 'unlock' }, () => assert.fail()), { code: 'security_context_invalid' });
    }
});

test('one-use entry tokens are consumed before asynchronous getters and transport errors never authorize a retry', async t => {
    const subject = await setupSecurity(t, { entryThrows: true }), status = await subject.bridge.securityStatus();
    let resolve;
    const pending = subject.bridge.secretPinEntry(status.token, { operation: 'unlock' }, () => new Promise(done => { resolve = done; }));
    // Wait for payload preflight and the deferred getter without a wall-clock sleep.
    while (!resolve) await new Promise(done => setImmediate(done));
    await assert.rejects(subject.bridge.secretPinEntry(status.token, { operation: 'unlock' }, () => assert.fail()), { code: 'security_context_invalid' });
    resolve('0073');
    await assert.rejects(pending, error => error.code === 'security_entry_uncertain' && !error.message.includes('PRIVATE'));
    assert.equal(subject.requests.length, 1); assert.ok(subject.buffers[0].every(byte => byte === 0));
});

test('entry rejects malformed or impossible acknowledgement shapes as uncertain and keeps raw values out of errors', async t => {
    for (const entry of [{ actionAttempted: false }, { beforeMatched: false }, { errorCode: 'PRIVATE' }, { extra: 'PRIVATE' }, { actionAccepted: 'PRIVATE' }]) {
        const subject = await setupSecurity(t, { entry }), status = await subject.bridge.securityStatus();
        await assert.rejects(subject.bridge.secretPinEntry(status.token, { operation: 'unlock' }, () => '0073'), error => error.code === 'security_entry_uncertain' && !error.message.includes('PRIVATE') && !error.message.includes('0073'));
        assert.equal(subject.requests.length, 1); assert.ok(subject.buffers[0].every(byte => byte === 0));
    }
});

test('ordinary extended observations refuse S-PIN headers even when the app marks the field as non-password', async t => {
    const subject = await setup(t);
    for (const sensitive of [node({ text: 'S-PIN eingeben' }), node({ password: true })]) {
        const view = frame(); view.root.children.push(sensitive); view.nodeCount++;
        assert.throws(() => subject.bridge.accept(JSON.stringify(view)), error => ['security_ui_active', 'extended_ui_unavailable'].includes(error.code));
    }
});

test('own read helper verifies the payload, returns immutable observations and cleans its unique result file', async t => {
    const subject = await setup(t);
    const { xml, observation } = await subject.bridge.read();
    assert.match(xml, /state-description="08"/);
    assert.ok(Object.isFrozen(observation.root.children[1].rangeInfo));
    assert.equal(subject.calls.filter(call => call.includes(RUNNERS.read)).length, 1);
    assert.equal(invocations(subject.calls).length, 0);
    assert.equal(subject.calls.filter(call => call.includes('rm')).length, 1);
    assert.ok(subject.calls.some(call => call[3]?.startsWith('if [ -f ')));
});

test('action selects exact raw clock state and path, passes a private JSON file and reports API acceptance without inventing the requested value', async t => {
    const subject = await setup(t);
    const result = await readAndAct(subject);
    const request = subject.request();
    assert.equal(request.target.nodePath, '0.1');
    assert.equal(request.target.stateDescription, '08');
    assert.equal(request.target.rangeInfo.current, 115007);
    assert.equal(request.context.windowId, null);
    assert.equal(invocations(subject.calls).length, 1);
    assert.equal(result.actionAccepted, true);
    // The synthetic app did not change its value: accepting the API is not a
    // persisted-value assertion. That belongs to the controller's reopen check.
    assert.equal(result.postRead.observation.root.children[1].stateDescription, '08');
    assert.deepEqual(await fs.readdir(path.join(subject.phone.runtime.dataDir, 'ui-requests')), []);
});

test('Unicode and shell metacharacters remain literal file data, never command arguments', async t => {
    const subject = await setup(t);
    const value = 'Platz Äöß $(PRIVATE) `literal` "quoted"';
    await readAndAct(subject, { action: 'setText', target: { class: 'android.widget.EditText', bounds: [100, 900, 980, 1000] }, value });
    assert.equal(subject.request().value, value);
    assert.ok(subject.calls.every(call => !call.some(item => item.includes('PRIVATE'))));
});

test('an observation can authorize one action only, including a known rejected precondition', async t => {
    const subject = await setup(t, { result: { beforeMatched: false, actionAttempted: false, actionAccepted: null, success: false, errorCode: 'STALE_NODE' } });
    const { observation } = await subject.bridge.read();
    const request = { snapshot: observation, header: 'Zeit einstellen', target, action: 'setProgress', value: 115008 };
    assert.equal((await subject.bridge.action(request)).actionAttempted, false);
    await assert.rejects(subject.bridge.action(request), error => error.code === 'invalid_target');
    assert.equal(invocations(subject.calls).length, 1);
});

test('an action transport failure is uncertain, is never retried and still cleans request and result files', async t => {
    const subject = await setup(t, { actionThrows: true });
    await assert.rejects(readAndAct(subject), error => error.code === 'departure_action_uncertain' && !error.message.includes('PRIVATE'));
    assert.equal(invocations(subject.calls).length, 1);
    assert.deepEqual(await fs.readdir(path.join(subject.phone.runtime.dataDir, 'ui-requests')), []);
    assert.equal(subject.calls.filter(call => call.includes('rm')).length, 3);
});

test('snapshots from a different bridge, fabricated snapshots and stale snapshots never start an action', async t => {
    const subject = await setup(t), other = await setup(t);
    const { observation } = await other.bridge.read();
    for (const snapshot of [observation, frame()]) await assert.rejects(readAndAct(subject, { snapshot }), error => error.code === 'invalid_target');
    const own = await subject.bridge.read(); subject.setTicks(16002);
    await assert.rejects(subject.bridge.action({ snapshot: own.observation, header: 'Zeit einstellen', target, action: 'setProgress', value: 115008 }), error => error.code === 'invalid_target');
    assert.equal(invocations(subject.calls).length, 0);
});

test('a snapshot expiring during request upload is refused immediately before invocation', async t => {
    const subject = await setup(t, { run: async (args, controls) => {
        if (args[0] === 'push' && args[1].endsWith('.json')) controls.setTicks(16002);
    } });
    await assert.rejects(readAndAct(subject), error => error.code === 'invalid_target');
    assert.equal(invocations(subject.calls).length, 0);
});

test('invalid values, ambiguous targets and unsupported actions cause no invocation', async t => {
    for (const changes of [{ value: NaN }, { value: 230000 }, { action: 'globalBack' },
        { target: { bounds: [0, 0, 1080, 2400] } }, { header: 'Other page' }, { target: { description: 'Unknown' } }]) {
        const subject = await setup(t);
        await assert.rejects(readAndAct(subject, changes), error => error.code === 'invalid_target');
        assert.equal(invocations(subject.calls).length, 0);
    }
});

test('a mismatched result nonce, contradictory acknowledgement or foreign post-tree never becomes a confirmed result', async t => {
    const foreign = frame(); foreign.root.package = 'other.app';
    for (const result of [{ requestNonce: 'other' }, { actionAttempted: false }, { nativeContextVerifiedByRunner: true }, { postRead: foreign }]) {
        const subject = await setup(t, { result });
        await assert.rejects(readAndAct(subject), error => error.code === 'departure_action_uncertain');
        assert.equal(invocations(subject.calls).length, 1);
    }
});

test('cancellation before input prevents the action runner while allowing bounded file cleanup', async t => {
    const subject = await setup(t, { run: async (args, controls) => {
        if (args[0] === 'push' && args[1].endsWith('.json')) controls.stop();
    } });
    await assert.rejects(readAndAct(subject), error => error.code === 'cancelled');
    assert.equal(invocations(subject.calls).length, 0);
    assert.deepEqual(await fs.readdir(path.join(subject.phone.runtime.dataDir, 'ui-requests')), []);
});

test('a damaged bundled source or missing payload fails before any phone helper executes', async t => {
    const subject = await setup(t);
    subject.bridge.payloadRoot = subject.phone.runtime.dataDir;
    await assert.rejects(subject.bridge.read(), error => error.code === 'android_payload_invalid');
    assert.equal(subject.calls.length, 0);
});

test('off-window targets and hidden or disabled ancestors fail before invoking the Android action helper', async t => {
    for (const mode of ['outside', 'negativeTarget', 'negativeAncestor', 'hidden', 'disabled']) {
        const subject = await setup(t);
        const wheel = subject.frame.root.children[1];
        if (mode === 'outside') wheel.bounds = [1100, 500, 1180, 800];
        else if (mode === 'negativeTarget') wheel.bounds = [-10, 500, 80, 800];
        else {
            subject.frame.root.children[1] = node({ visible: mode !== 'hidden', enabled: mode !== 'disabled',
                ...(mode === 'negativeAncestor' ? { bounds: [0, -251, 1080, 2400] } : {}), children: [wheel] });
            subject.frame.nodeCount++;
        }
        await assert.rejects(readAndAct(subject, { target: { description: 'Hour', bounds: wheel.bounds } }), error => error.code === 'invalid_target');
        assert.equal(invocations(subject.calls).length, 0);
    }
});

test('targeted native read uses only the fixed VW component and returns no unparsed dump on failure', async () => {
    const calls = [];
    const phone = new Phone({ endpoint: '192.0.2.10:12345', runtime: { async run(args) {
        calls.push(args);
        if (args.includes('window')) return 'mCurrentFocus=Window{test u0 com.volkswagen.weconnect/.SingleActivity}\n';
        return 'PRIVATE malformed diagnostics';
    } } });
    phone.securityStatus = async () => ({ kind: 'other', errorCode: null });
    await assert.rejects(phone.departureNative(), error => !error.message.includes('PRIVATE'));
    assert.ok(calls.some(call => call.slice(2).join(' ') === 'shell dumpsys activity com.volkswagen.weconnect/.SingleActivity'));
    assert.ok(!calls.some(call => call.includes('top')));
});
