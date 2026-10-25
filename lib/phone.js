'use strict';
// Short transport waits belong to the current bounded phone operation, not the polling scheduler.
const nodeTimers = require('node:timers');
const { BridgeError } = require('./errors');
const { validateEndpoint } = require('./config');
const { AndroidUi } = require('./android-ui');
const { extractActiveDepartureNative } = require('./departures-native');
const { Screen } = require('./ui');
const PACKAGE = 'com.volkswagen.weconnect';
const KEYBOARD_AUTH = new WeakMap();
function keyboardFailure(code) {
    return new BridgeError(code, code === 'security_keyboard_uncertain'
        ? 'Das Ausblenden der Tastatur ist nicht eindeutig bestätigt. Keine automatische Wiederholung.'
        : 'Die Tastatur kann in dieser geschützten App-Sitzung nicht sicher ausgeblendet werden.');
}

class Phone {
    constructor({ runtime, endpoint, deviceId = '', onVerified = async () => {}, signal }) {
        this.runtime = runtime; this.endpoint = validateEndpoint(endpoint); this.deviceId = deviceId;
        this.onVerified = onVerified; this.signal = signal; this.deadline = null;
        this.androidUi = new AndroidUi(this);
    }
    check() {
        if (this.signal?.aborted) throw new BridgeError('cancelled', 'The adapter is stopping.');
        if (this.deadline && Date.now() >= this.deadline) throw new BridgeError('phone_timeout', 'The phone operation timed out.');
    }
    async run(args, timeoutMs = 15000) {
        this.check();
        const remaining = this.deadline ? Math.min(timeoutMs, this.deadline - Date.now()) : timeoutMs;
        return this.runtime.run(['-s', this.endpoint, ...args], { timeoutMs: remaining, maxOutputBytes: 2 * 1024 * 1024 });
    }
    async runSensitive(args, input, timeoutMs = 20000) {
        this.check();
        if (!Buffer.isBuffer(input) || input.length > 4096) throw new BridgeError('security_context_invalid', 'Die geschützte App-Eingabe ist nicht freigegeben.');
        const remaining = this.deadline ? Math.min(timeoutMs, this.deadline - Date.now()) : timeoutMs;
        return this.runtime.run(['-s', this.endpoint, ...args], { timeoutMs: remaining, maxOutputBytes: 8192, input });
    }
    async identity() {
        if (!this.deviceId.startsWith('android_id:')) {
            const serial = (await this.run(['shell', 'getprop', 'ro.serialno'])).trim();
            if (/^[A-Za-z0-9_.-]{1,100}$/.test(serial) && !['null', 'unknown'].includes(serial.toLowerCase())) return 'serial:' + serial;
            if (this.deviceId.startsWith('serial:')) throw new BridgeError('wifi_identity_unavailable', 'The saved phone identity could not be read.');
        }
        const androidId = (await this.run(['shell', 'settings', 'get', 'secure', 'android_id'])).trim();
        if (/^[0-9a-fA-F]{16}$/.test(androidId)) return 'android_id:' + androidId;
        throw new BridgeError('wifi_identity_unavailable', 'A stable phone identity is not available.');
    }
    async connect({ allowUnpinned = false } = {}) {
        this.check();
        if (!allowUnpinned && !this.deviceId) throw new BridgeError('wifi_identity_required', 'Read and save the phone identity with the setup assistant first.');
        try {
            await this.runtime.run(['connect', this.endpoint], { timeoutMs: 10000 });
            if ((await this.run(['get-state'])).trim() !== 'device') throw new Error('Device is not ready');
        } catch (error) {
            if (['runtime_missing', 'cancelled', 'adb_missing'].includes(error.code)) throw error;
            throw new BridgeError('wifi_unavailable', 'Check wireless debugging, pairing and the current connection port on the phone.');
        }
        const identity = await this.identity();
        if (this.deviceId && identity !== this.deviceId) throw new BridgeError('wifi_wrong_device', 'This endpoint belongs to a different phone. No app input was sent.');
        this.check(); await this.onVerified(identity); this.check();
        return { deviceId: identity };
    }
    async version() {
        const text = await this.run(['shell', 'dumpsys', 'package', PACKAGE]);
        const versions = [...new Set([...text.matchAll(/\bversionName=([^\s]+)/g)].map(x => x[1]))];
        if (versions.length !== 1) throw new BridgeError('app_missing', 'Install and sign in to the official Volkswagen app on the phone.');
        return versions[0];
    }
    async launch() {
        await this.run(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
        // Preserve a visible VW screen, including any manual settings draft.
        // Starting its standard Activity again can create another stale copy.
        try { await this.foreground(); return; }
        catch (error) { if (error.code !== 'phone_locked_or_other_app') throw error; }
        const text = await this.run(['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', PACKAGE]);
        const components = text.split(/\r?\n/).map(s => s.trim()).filter(s => /^com\.volkswagen\.weconnect\/[A-Za-z0-9_.$]+$/.test(s));
        if (components.length !== 1) throw new BridgeError('app_missing', 'Volkswagen app launcher not found.');
        await this.run(['shell', 'am', 'start', '-W', '--activity-reorder-to-front', '--activity-single-top', '-n', components[0]], 20000);
        // Android may finish am start before WindowManager changes focus.
        // Wait for that transition without issuing a second launch or app input.
        for (let attempt = 0; attempt < 5; attempt++) {
            try { await this.foreground(); return; }
            catch (error) {
                if (error.code !== 'phone_locked_or_other_app' || attempt === 4) throw error;
                this.check();
                await new Promise(resolve => nodeTimers.setTimeout(resolve, 200));
            }
        }
    }
    async foreground() {
        const text = await this.run(['shell', 'dumpsys', 'window']);
        const values = [...text.matchAll(/mCurrentFocus=Window\{[^\n]*?\s([A-Za-z0-9_.]+)\/[^\n]*\}/g)].map(m => m[1]);
        if (!values.length || values.some(x => x !== PACKAGE)) throw new BridgeError('phone_locked_or_other_app', 'Unlock the phone and open the Volkswagen app.');
    }
    async dump() {
        await this.foreground();
        // stdout only: a manually opened security form must never leave an XML
        // file on the phone, including after a restart or cancellation.
        const raw = await this.run(['exec-out', 'uiautomator', 'dump', '/proc/self/fd/1'], 12000);
        this.check();
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new BridgeError('invalid_ui', 'Das Handy hat keine gültige Android-Ansicht geliefert.');
        const matches = [...raw.matchAll(/<hierarchy\b[^>]*(?:\/\s*>|>[\s\S]*?<\/hierarchy\s*>)/g)];
        if (matches.length !== 1 || /<hierarchy\b/.test(raw.slice(matches[0].index + matches[0][0].length))) throw new BridgeError('invalid_ui', 'Das Handy hat keine gültige Android-Ansicht geliefert.');
        const text = matches[0][0] + '\n';
        const screen = new Screen(text);
        if (screen.nodes.some(node => node.attrs.password === 'true'
            || [node.attrs.text, node.attrs['content-desc']].some(value => typeof value === 'string' && value.includes('S-PIN eingeben')))) {
            throw new BridgeError('security_ui_active', 'Die geschützte S-PIN-Ansicht wird nicht ausgelesen.');
        }
        await this.foreground();
        this.check();
        return text;
    }
    async tap(x, y) {
        if (![x, y].every(n => Number.isInteger(n) && n >= 0 && n <= 20000)) throw new BridgeError('invalid_target', 'Invalid app control.');
        await this.foreground(); this.check();
        await this.run(['shell', 'input', 'tap', String(x), String(y)]);
    }
    async back() { await this.foreground(); this.check(); await this.run(['shell', 'input', 'keyevent', 'KEYCODE_BACK']); }
    async swipe({ x1, y1, x2, y2, durationMs = 400 } = {}) {
        if (![x1, y1, x2, y2].every(n => Number.isInteger(n) && n >= 0 && n <= 20000)
            || x1 === x2 && y1 === y2 || !Number.isInteger(durationMs) || durationMs < 100 || durationMs > 1500) {
            throw new BridgeError('invalid_target', 'Invalid bounded app gesture.');
        }
        await this.foreground(); this.check();
        await this.run(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(durationMs)]);
    }
    async nativeView() {
        await this.requireNonSecurityUi();
        await this.foreground();
        const raw = await this.run(['shell', 'dumpsys', 'activity', 'top'], 20000);
        await this.foreground();
        // Return only the focused app's visible view tree and lifecycle flags.
        // Other tasks, saved state and diagnostic logs are neither returned nor logged.
        const blocks = String(raw).split(/(?=^\s{2}ACTIVITY )/m).filter(block =>
            /^\s{2}ACTIVITY com\.volkswagen\.weconnect\/(?:\.SingleActivity|com\.volkswagen\.weconnect\.SingleActivity)\b/.test(block));
        if (blocks.length !== 1) throw new BridgeError('native_ui_unavailable', 'The current app view hierarchy is not unique.');
        const block = blocks[0];
        const header = block.split(/\r?\n/, 1)[0];
        const states = [...block.matchAll(/^\s{6}mResumed=(true|false) mStopped=(true|false) mFinished=(true|false)\s*$/gm)];
        const markers = [...block.matchAll(/^ {4}View Hierarchy:\s*$/gm)];
        if (states.length !== 1 || markers.length !== 1) throw new BridgeError('native_ui_unavailable', 'The current app view hierarchy is unavailable.');
        const remainder = block.slice(markers[0].index + markers[0][0].length).replace(/^\r?\n/, '');
        const lines = [];
        for (const line of remainder.split(/\r?\n/)) {
            if (/^\S|^ {1,4}\S/.test(line)) break;
            lines.push(line);
        }
        if (!lines.some(line => line.trim())) throw new BridgeError('native_ui_unavailable', 'The current app view hierarchy is empty.');
        return header + '\n      mResumed=' + states[0][1] + ' mStopped=' + states[0][2] + ' mFinished=' + states[0][3]
            + '\n    View Hierarchy:\n' + lines.join('\n');
    }
    async keepAwake() {
        this.check(); await this.run(['shell', 'svc', 'power', 'stayon', 'true']);
        return { active: (await this.run(['shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in'])).trim() === '7' };
    }
    async departureView() { return this.androidUi.read(); }
    async departureAction(request) { return this.androidUi.action(request); }
    async securityStatus() { return this.androidUi.securityStatus(); }
    async secretPinEntry(token, options, getSecurityPin) {
        KEYBOARD_AUTH.delete(this);
        const result = await this.androidUi.secretPinEntry(token, options, getSecurityPin);
        if (result?.beforeMatched === true && result.actionAttempted === true && result.actionAccepted === true && result.errorCode === null) {
            KEYBOARD_AUTH.set(this, this.androidUi.now());
        }
        return result;
    }
    async keyboardVisibility() {
        // This diagnostic may include editor metadata. Inspect two exact
        // booleans in bounded RAM only; never return, persist or log the dump.
        const raw = await this.run(['shell', 'dumpsys', 'input_method'], 5000);
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2 * 1024 * 1024) throw keyboardFailure('security_keyboard_unavailable');
        const result = {};
        for (const [name, key] of [['inputShown', 'mInputShown'], ['viewShown', 'mIsInputViewShown']]) {
            const values = [...raw.matchAll(new RegExp('(?:^|\\s)' + key + '=(true|false)(?=\\s|$)', 'g'))];
            if (values.length !== 1) throw keyboardFailure('security_keyboard_unavailable');
            result[name] = values[0][1] === 'true';
        }
        return result;
    }
    async hideSecurityKeyboard() {
        const captured = KEYBOARD_AUTH.get(this);
        KEYBOARD_AUTH.delete(this); // One use, including failed preconditions.
        const fresh = () => {
            const now = this.androidUi.now();
            if (captured === undefined || now < captured || now - captured > 180000) throw keyboardFailure('security_keyboard_unauthorized');
        };
        fresh();
        let invoked = false;
        try {
            await this.foreground();
            const before = await this.keyboardVisibility();
            // Samsung retains mIsInputViewShown=true after hiding the window.
            // mInputShown is the current visibility signal, not that cached flag.
            if (!before.inputShown) return { kind: 'alreadyHidden', actionAttempted: false };
            if (!before.viewShown) throw keyboardFailure('security_keyboard_unavailable');
            const status = await this.securityStatus();
            if (!['home', 'other'].includes(status.kind) || status.errorCode !== null) throw keyboardFailure('security_keyboard_unavailable');
            await this.foreground();
            const current = await this.keyboardVisibility();
            if (!current.inputShown) return { kind: 'alreadyHidden', actionAttempted: false };
            if (!current.viewShown) throw keyboardFailure('security_keyboard_unavailable');
            this.check(); fresh();
            // Exactly one guarded keyboard-dismiss gesture after an accepted
            // PIN submission. It cannot repeat the PIN or a vehicle command.
            invoked = true;
            await this.run(['shell', 'input', 'keyevent', 'KEYCODE_BACK'], 5000);
            for (let attempt = 0; attempt < 3; attempt++) {
                const after = await this.keyboardVisibility();
                if (!after.inputShown) return { kind: 'hidden', actionAttempted: true };
                this.check();
                if (attempt < 2) await new Promise(resolve => nodeTimers.setTimeout(resolve, 150));
            }
            throw keyboardFailure('security_keyboard_uncertain');
        } catch (error) {
            if (invoked) throw keyboardFailure('security_keyboard_uncertain');
            if (['cancelled', 'phone_timeout', 'security_keyboard_unauthorized'].includes(error?.code)) throw keyboardFailure(error.code);
            throw keyboardFailure('security_keyboard_unavailable');
        }
    }
    async requireNonSecurityUi() {
        const status = await this.securityStatus();
        if (!['home', 'other'].includes(status.kind) || status.errorCode !== null) {
            throw new BridgeError('security_ui_active', 'Die geschützte S-PIN-Ansicht wird nicht ausgelesen.');
        }
    }
    async departureNative() {
        await this.requireNonSecurityUi();
        await this.foreground();
        const raw = await this.run(['shell', 'dumpsys', 'activity', PACKAGE + '/.SingleActivity'], 15000);
        await this.foreground();
        return extractActiveDepartureNative(raw);
    }
}

module.exports = { Phone, PACKAGE };
