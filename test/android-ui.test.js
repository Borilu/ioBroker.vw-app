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
            if (args[1] === 'sha256sum') return manifest.sha256 + '  helper.jar\n';
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
function invocations(calls) { return calls.filter(call => call.includes(RUNNERS.action)); }

test('own read helper verifies the payload, returns immutable observations and cleans its unique result file', async t => {
    const subject = await setup(t);
    const { xml, observation } = await subject.bridge.read();
    assert.match(xml, /state-description="08"/);
    assert.ok(Object.isFrozen(observation.root.children[1].rangeInfo));
    assert.equal(subject.calls.filter(call => call.includes(RUNNERS.read)).length, 1);
    assert.equal(invocations(subject.calls).length, 0);
    assert.equal(subject.calls.filter(call => call.includes('rm')).length, 1);
    assert.ok(subject.calls.some(call => call[1] === 'sha256sum'));
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
    for (const mode of ['outside', 'hidden', 'disabled']) {
        const subject = await setup(t);
        const wheel = subject.frame.root.children[1];
        if (mode === 'outside') wheel.bounds = [1100, 500, 1180, 800];
        else {
            subject.frame.root.children[1] = node({ visible: mode !== 'hidden', enabled: mode !== 'disabled', children: [wheel] });
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
    await assert.rejects(phone.departureNative(), error => !error.message.includes('PRIVATE'));
    assert.ok(calls.some(call => call.slice(2).join(' ') === 'shell dumpsys activity com.volkswagen.weconnect/.SingleActivity'));
    assert.ok(!calls.some(call => call.includes('top')));
});
