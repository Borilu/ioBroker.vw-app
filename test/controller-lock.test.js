'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../lib/controller');
const { BridgeError } = require('../lib/errors');
const { readSecurityAuth, clearSecurityAuth, securityErrorDiagnostic } = require('../lib/security-auth');
const { vehicleAccessScreen, partiallyScrolledAccessScreen } = require('./support/access-fixtures.cjs');
const { lockSheet, hierarchy, node } = require('./support/lock-fixtures.cjs');

const CLEAR = { blocked: false, reason: null, blockedAt: null };
const MARKER = { contentDescPrefix: 'Ihr Fahrzeug: Testwagen. ' };
const SECRET = '0942'; // Deliberately synthetic, leading-zero validation fixture.

class LockApp {
    constructor(options = {}) {
        this.page = 'home'; this.locked = true; this.calls = []; this.entryCount = 0;
        this.operation = 'unlock';
        this.versionValue = '4.8.1'; this.deadline = null; this.postEntryProbes = 0; this.homeReadsAfterEntry = 0;
        this.token = Object.freeze({}); Object.assign(this, options);
    }
    async connect() { this.calls.push(['connect']); if (this.connectGate) await this.connectGate; }
    async version() { this.calls.push(['version']); return this.versionValue; }
    async launch() { this.calls.push(['launch']); this.background = false; }
    async keepAwake() { this.calls.push(['keepAwake']); return { active: true }; }
    async securityStatus() {
        this.calls.push(['probe', this.page]);
        if (this.entryCount && this.postEntryStatuses?.length) {
            const next = this.postEntryStatuses.shift();
            if (next instanceof Error) throw next;
            return typeof next === 'function' ? next(this) : next;
        }
        if (this.background) throw new BridgeError('security_status_unavailable', 'PRIVATE_UNTRUSTED');
        if (this.probeOverride) return this.probeOverride();
        if (this.page === 'pin') {
            if (this.entryCount) {
                if (this.pinError) return { kind: 'pinUnsupported', operation: this.operation, errorCode: 'SECURITY_CONTEXT_UNSUPPORTED' };
                if (!this.neverHome && ++this.postEntryProbes >= 3) {
                    this.page = this.postAuthSheet ? 'sheet' : this.postAuthUnknown ? 'unknown' : 'home';
                    this.partial = this.postAuthPartial === true;
                }
            }
            if (this.page === 'pin') return { kind: this.nonEmpty ? 'pinNonEmpty' : 'pinEmpty',
                token: this.nonEmpty ? undefined : this.token, operation: this.pinOperation || this.operation, errorCode: null };
        }
        return { kind: this.page === 'home' ? 'home' : 'other', errorCode: null };
    }
    async dump() {
        if (this.entryCount && this.foregroundReadFailures > 0) {
            this.foregroundReadFailures--;
            this.calls.push(['foregroundBlocked', this.page]);
            throw new BridgeError('phone_locked_or_other_app', 'PRIVATE_UNTRUSTED ' + SECRET);
        }
        this.calls.push(['read', this.page]);
        assert.notEqual(this.page, 'pin', 'The controller must never dump an authentication page');
        if (this.dumpError) throw this.dumpError;
        if (this.page === 'sheet') {
            if (this.entryCount && this.loadingSheetReads > 0) {
                this.loadingSheetReads--;
                return lockSheet({ locked: this.locked }).replace(/text="(?:Verriegelt|Entriegelt)"/u, 'text="Wird aktualisiert"');
            }
            return this.badSheet ? lockSheet().replace('text="Verriegelt"', 'text="Unbekannt"') : lockSheet({ locked: this.locked });
        }
        if (this.page === 'unknown') return hierarchy([node('', { text: 'Unbekannte Ansicht' })]);
        if (this.entryCount && !this.neverConfirm && ++this.homeReadsAfterEntry >= 3) this.locked = this.operation === 'lock';
        const xml = (this.partial ? partiallyScrolledAccessScreen : vehicleAccessScreen)({ locked: this.locked, open: this.open || [] });
        if (this.entryCount && this.loadingHomeReads > 0) {
            this.loadingHomeReads--;
            return xml.replace(/Fahrzeug\. (?:Verriegelt|Entriegelt)\. Details öffnen/u, 'Fahrzeug. Wird aktualisiert. Details öffnen');
        }
        return this.wrongVehicle ? xml.replace('Ihr Fahrzeug: Testwagen.', 'Ihr Fahrzeug: Anderes Fahrzeug.') : xml;
    }
    async tap(x, y) {
        this.calls.push(['tap', this.page, x, y]);
        if (this.page === 'sheet' && x === 70 && y === 675) { this.page = 'home'; return; }
        if (this.page === 'home') {
            assert.deepEqual({ x, y }, { x: 500, y: 975 });
            if (this.beforeNavigation) this.beforeNavigation();
            this.page = 'sheet'; return;
        }
        assert.equal(this.page, 'sheet');
        assert.deepEqual({ x, y }, { x: 500, y: this.locked ? 1265 : 955 });
        this.operation = this.locked ? 'unlock' : 'lock';
        if (this.beforeAction) await this.beforeAction();
        this.page = 'pin';
        if (this.tapError) throw this.tapError;
    }
    async departureView() {
        this.homeSnapshot = Object.freeze({}); this.calls.push(['homeNativeRead']);
        return { xml: await this.dump(), observation: this.homeSnapshot };
    }
    async departureAction(request) {
        assert.equal(request.snapshot, this.homeSnapshot); assert.equal(request.action, 'scrollBackward');
        assert.equal(request.header, 'Ihr Fahrzeug: Testwagen. Gerade synchronisiert');
        assert.deepEqual(request.target, { class: 'android.widget.ScrollView', bounds: [0, 40, 1000, 1440] });
        this.calls.push(['homeNativeAction', request.action]); this.partial = false;
        return { beforeMatched: true, actionAttempted: true, actionAccepted: true, success: true,
            errorCode: null, postRead: { xml: await this.dump() } };
    }
    async secretPinEntry(token, options, getter) {
        this.calls.push(['secretEntry', { ...options }]);
        assert.equal(this.page, 'pin'); assert.equal(token, this.token);
        assert.equal(options.operation, this.operation);
        this.entryCount++;
        assert.equal(getter(), SECRET);
        if (this.entryError) throw this.entryError;
        if (this.afterEntry) this.afterEntry();
        return this.ack || { beforeMatched: true, actionAttempted: true, actionAccepted: true, errorCode: null };
    }
    async hideSecurityKeyboard() {
        this.calls.push(['hideKeyboard', this.page]);
        assert.equal(this.entryCount, 1); assert.notEqual(this.page, 'pin');
        if (this.keyboardError) throw this.keyboardError;
        return this.keyboardAck || { kind: 'alreadyHidden', actionAttempted: false };
    }
}

function setup(options = {}, config = {}, getter = () => SECRET, reusedState = null) {
    const phone = new LockApp(options);
    const clock = { value: 1700000000000 };
    const state = reusedState || { auth: null };
    const store = {
        events: [], reservations: 0,
        async read(name, fallback) {
            this.events.push(['read', name]);
            if (this.readError) throw this.readError;
            return state.auth === null ? fallback : structuredClone(state.auth);
        },
        async write(name, value) {
            this.events.push(['write', name, structuredClone(value)]);
            if (this.writeError) throw this.writeError;
            state.auth = structuredClone(value);
        },
        async reserveCommand(seconds) {
            this.events.push(['reserve', seconds]); this.reservations++;
            if (this.reserveError) throw this.reserveError;
        },
    };
    let getterCalls = 0;
    const controller = new Controller({ phone, store, config: {
        approvedAppVersion: '4.8.1', vehicleMarker: MARKER, allowWrites: false, allowVehicleLocking: true,
        commandTimeoutSeconds: 180, outcomeTimeoutSeconds: 30, cooldownSeconds: 60, ...config,
    }, getSecurityPin: getter === null ? undefined : () => { getterCalls++; return getter(); },
    now: () => clock.value, sleep: async ms => { clock.value += ms; } });
    return { phone, controller, clock, store, state, getterCalls: () => getterCalls };
}

async function rejects(operation, code) {
    await assert.rejects(operation, error => error instanceof BridgeError && error.code === code
        && !error.message.includes(SECRET) && !error.message.includes('PRIVATE_UNTRUSTED'));
}
function actions(phone) { return phone.calls.filter(call => call[0] === 'tap' && call[1] === 'sheet' && !(call[2] === 70 && call[3] === 675)); }
function lifecycleReleased(controller, phone) {
    assert.equal(controller.busy, false); assert.equal(controller.deadline, null); assert.equal(phone.deadline, null);
    assert.equal(controller.readOnlyExecution, false); assert.equal(controller.readHandoffProtected, false);
}

test('unlock sends exactly one PIN and action, waits through app delay, and returns a fresh full access observation', async () => {
    const { controller, phone, store, state, getterCalls } = setup();
    phone.beforeAction = () => {
        assert.equal(store.reservations, 1);
        assert.deepEqual(state.auth, { blocked: true, reason: 'attempt_pending', blockedAt: '2023-11-14T22:13:20.000Z' });
    };
    const result = await controller.execute('unlockVehicle');
    assert.equal(result.domain, 'vehicleAccess'); assert.equal(result.changed, true); assert.equal(result.requestedAction, 'unlockVehicle');
    assert.equal(result.vehicleAccess.locked, false); assert.equal(result.vehicleConfirmed, false);
    assert.equal(result.confirmationSource, 'app_vehicle_access'); assert.equal(result.appVersion, '4.8.1');
    assert.deepEqual(Object.values(result.vehicleAccess.doors), [false, false, false, false]);
    assert.ok(Date.parse(result.observedAt) > 1700000000000); assert.equal(phone.entryCount, 1);
    assert.equal(actions(phone).length, 1); assert.equal(getterCalls(), 2); assert.equal(store.reservations, 1);
    assert.deepEqual(state.auth, CLEAR); assert.ok(phone.calls.some(call => call[0] === 'probe' && call[1] === 'pin'));
    assert.equal(JSON.stringify({ controller, result, events: store.events, calls: phone.calls }).includes(SECRET), false);
    lifecycleReleased(controller, phone);
});

test('already desired state for either command is a read-only no-op without PIN, gate, journal or latch reset', async () => {
    for (const locked of [true, false]) {
        const blocked = { blocked: true, reason: 'pin_rejected', blockedAt: '2023-11-14T22:13:20.000Z' };
        const { controller, phone, store, state, getterCalls } = setup({ locked }, { allowVehicleLocking: false }, null, { auth: blocked });
        const result = await controller.execute(locked ? 'lockVehicle' : 'unlockVehicle');
        assert.equal(result.alreadyInState, true); assert.equal(result.changed, false); assert.equal(result.vehicleConfirmed, false);
        assert.equal(getterCalls(), 0); assert.deepEqual(store.events, []); assert.deepEqual(state.auth, blocked);
        assert.equal(phone.calls.filter(call => call[0] === 'tap').length, 0); lifecycleReleased(controller, phone);
    }
});

test('dry run and rejected dry-run types never trigger a vehicle gesture or use a PIN', async () => {
    const { controller, phone, store, getterCalls } = setup({}, { allowVehicleLocking: false }, null);
    const result = await controller.execute('unlockVehicle', { dryRun: true });
    assert.equal(result.dryRun, true); assert.equal(result.wouldRequest, 'unlock');
    assert.equal(getterCalls(), 0); assert.deepEqual(store.events, []);
    for (const options of [{ dryRun: 'false' }, { get dryRun() { throw new Error(SECRET); } }, null, []]) {
        await rejects(controller.execute('unlockVehicle', options), 'invalid_action');
    }
    assert.equal(phone.calls.filter(call => call[0] === 'tap').length, 0);
});

test('the independent locking gate is required even when ordinary writes are enabled', async () => {
    const { controller, phone, store, getterCalls } = setup({}, { allowWrites: true, allowVehicleLocking: false });
    await rejects(controller.execute('unlockVehicle'), 'vehicle_locking_disabled');
    assert.equal(getterCalls(), 0); assert.deepEqual(store.events, []); assert.equal(actions(phone).length, 0);
});

test('a backgrounded app is resumed before minimal probing without recreating a visible manual form', async () => {
    const { controller, phone } = setup({ background: true });
    const result = await controller.execute('unlockVehicle');
    assert.equal(result.vehicleAccess.locked, false);
    assert.ok(phone.calls.findIndex(call => call[0] === 'launch') < phone.calls.findIndex(call => call[0] === 'probe'));
    assert.equal(phone.entryCount, 1); assert.equal(actions(phone).length, 1);
});

test('missing or invalid PIN is rejected before opening vehicle details or authentication', async () => {
    for (const getter of [null, () => '', () => '123', () => 942, () => '９４２０', () => SECRET + '\n']) {
        const { controller, phone, store } = setup({}, {}, getter);
        const expected = getter === null || getter() === '' ? 'security_pin_required' : 'security_pin_invalid';
        await rejects(controller.execute('unlockVehicle'), expected);
        assert.equal(phone.calls.filter(call => call[0] === 'tap').length, 0); assert.equal(store.reservations, 0);
        assert.equal(store.events.filter(call => call[0] === 'write').length, 0);
    }
});

test('wrong profile and unapproved version fail before PIN access, navigation and journal', async () => {
    for (const options of [{ wrongVehicle: true }, { versionValue: '99.0' }]) {
        const { controller, phone, store, getterCalls } = setup(options);
        await rejects(controller.execute('unlockVehicle'), options.wrongVehicle ? 'wrong_vehicle' : 'version_not_approved');
        assert.equal(getterCalls(), 0); assert.equal(phone.calls.filter(call => call[0] === 'tap').length, 0); assert.deepEqual(store.events, []);
    }
});

test('manually open blank/nonempty/unsupported PIN pages are preserved without an ordinary dump or new PIN entry', async () => {
    for (const kind of ['pinEmpty', 'pinNonEmpty', 'pinUnsupported']) {
        const { controller, phone, store, getterCalls } = setup({ probeOverride: () => ({ kind, errorCode: null }) });
        await rejects(controller.execute('unlockVehicle'), 'security_pin_pending');
        assert.equal(getterCalls(), 0); assert.deepEqual(store.events, []);
        assert.equal(phone.calls.filter(call => ['read', 'tap', 'secretEntry'].includes(call[0])).length, 0);
        assert.equal(phone.calls.filter(call => call[0] === 'launch').length, 1);
    }
});

test('malformed minimal probe or unavailable protected transport fails before ordinary UI access', async () => {
    for (const mutate of [phone => { phone.probeOverride = () => ({ kind: 'home', errorCode: 'PRIVATE_UNTRUSTED' }); },
        phone => { phone.secretPinEntry = undefined; }, phone => { phone.probeOverride = () => null; }]) {
        const { controller, phone, store } = setup(); mutate(phone);
        await rejects(controller.execute('unlockVehicle'), typeof phone.secretPinEntry === 'function' ? 'security_context_invalid' : 'security_pin_transport_unavailable');
        assert.deepEqual(store.events, []); assert.equal(phone.calls.filter(call => call[0] === 'read').length, 0);
    }
});

test('unknown sheet geometry cannot reserve or dispatch a command', async () => {
    for (const locked of [true, false]) {
        const { controller, phone, store } = setup({ locked, badSheet: true });
        await rejects(controller.execute(locked ? 'unlockVehicle' : 'lockVehicle'), 'lock_ui_unsupported');
        assert.equal(store.reservations, 0); assert.equal(actions(phone).length, 0); assert.equal(phone.entryCount, 0);
    }
});

test('the separately verified lock direction enters only its matching PIN form and confirms fresh Home locking', async () => {
    const { controller, phone, store, state, getterCalls } = setup({ locked: false });
    const result = await controller.execute('lockVehicle');
    assert.equal(result.changed, true); assert.equal(result.requestedAction, 'lockVehicle');
    assert.equal(result.vehicleAccess.locked, true); assert.equal(result.vehicleConfirmed, false);
    assert.equal(phone.entryCount, 1); assert.equal(getterCalls(), 2); assert.equal(store.reservations, 1);
    assert.deepEqual(actions(phone), [['tap', 'sheet', 500, 955]]); assert.deepEqual(state.auth, CLEAR);
    lifecycleReleased(controller, phone);
});

test('post-PIN confirmation can safely leave the known Vehicle sheet and normalize a partially scrolled Home', async () => {
    for (const locked of [true, false]) for (const postAuthSheet of [true, false]) {
        const { controller, phone, store, state } = setup({ locked, postAuthSheet, postAuthPartial: true });
        const result = await controller.execute(locked ? 'unlockVehicle' : 'lockVehicle');
        assert.equal(result.vehicleAccess.locked, !locked); assert.equal(result.vehicleConfirmed, false);
        assert.equal(actions(phone).length, 1); assert.equal(phone.entryCount, 1); assert.equal(store.reservations, 1);
        assert.equal(phone.calls.filter(call => call[0] === 'homeNativeAction').length, 1);
        assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[2] === 70 && call[3] === 675).length, postAuthSheet ? 1 : 0);
        assert.equal(phone.calls.filter(call => call[0] === 'read' && call[1] === 'pin').length, 0);
        assert.deepEqual(state.auth, CLEAR); lifecycleReleased(controller, phone);
    }
});

test('an unknown post-PIN view never supplies a guessed Back target or repeats the security action', async () => {
    const { controller, phone, state } = setup({ postAuthUnknown: true });
    await rejects(controller.execute('unlockVehicle'), 'outcome_unknown');
    assert.equal(actions(phone).length, 1); assert.equal(phone.entryCount, 1); assert.equal(state.auth.blocked, true);
    assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[2] === 70 && call[3] === 675).length, 0);
});

test('an opposite-operation PIN form never receives the configured secret or causes a repeated gesture', async () => {
    for (const locked of [true, false]) {
        const { controller, phone, state, getterCalls } = setup({ locked, pinOperation: locked ? 'lock' : 'unlock' });
        await rejects(controller.execute(locked ? 'unlockVehicle' : 'lockVehicle'), 'outcome_unknown');
        assert.equal(phone.entryCount, 0); assert.equal(getterCalls(), 1); assert.equal(actions(phone).length, 1);
        assert.equal(state.auth.blocked, true); lifecycleReleased(controller, phone);
    }
});

test('existing auth block, corrupt state and failed persistence fail closed without a vehicle attempt', async () => {
    for (const scenario of ['blocked', 'invalid', 'readError', 'writeError', 'reserveError']) {
        const { controller, phone, store, state, getterCalls } = setup();
        const codes = { blocked: 'security_auth_blocked', invalid: 'security_auth_invalid', readError: 'security_auth_unavailable',
            writeError: 'security_auth_not_saved', reserveError: 'cooldown' };
        if (scenario === 'blocked') state.auth = { blocked: true, reason: 'outcome_unknown', blockedAt: '2023-11-14T22:13:20.000Z' };
        if (scenario === 'invalid') state.auth = { ...CLEAR, secret: SECRET };
        if (scenario === 'readError') store.readError = new Error(SECRET);
        if (scenario === 'writeError') store.writeError = new BridgeError('outcome_unknown', SECRET);
        if (scenario === 'reserveError') store.reserveError = new BridgeError('cooldown', SECRET);
        await rejects(controller.execute('unlockVehicle'), codes[scenario]);
        assert.equal(actions(phone).length, 0); assert.equal(phone.entryCount, 0);
        if (['blocked', 'invalid', 'readError'].includes(scenario)) assert.equal(getterCalls(), 0);
    }
});

test('lost action response is never retried and retains the authentication block across controller restart', async () => {
    const first = setup({ tapError: new Error(SECRET) });
    await rejects(first.controller.execute('unlockVehicle'), 'outcome_unknown');
    assert.equal(actions(first.phone).length, 1); assert.equal(first.phone.entryCount, 0);
    assert.equal(first.state.auth.blocked, true); assert.equal(first.state.auth.reason, 'outcome_unknown');
    lifecycleReleased(first.controller, first.phone);
    const restarted = setup({}, {}, () => SECRET, first.state);
    await rejects(restarted.controller.execute('unlockVehicle'), 'security_auth_blocked');
    assert.equal(actions(restarted.phone).length, 0); assert.equal(restarted.getterCalls(), 0);
});

test('regular access refresh after an uncertain command observes external changes without PIN use, retry or latch reset', async () => {
    const { controller, phone, store, state, getterCalls } = setup({ tapError: new Error(SECRET) });
    await rejects(controller.execute('unlockVehicle'), 'outcome_unknown');
    const blocked = structuredClone(state.auth);
    const callsBefore = getterCalls(), reservations = store.reservations, entries = phone.entryCount;
    // The user has closed the prompt and operated the car outside the adapter.
    phone.page = 'home'; phone.locked = false; phone.open = ['Tür vorne links'];
    const result = await controller.execute('refreshVehicleAccess');
    assert.equal(result.vehicleAccess.locked, false); assert.equal(result.vehicleAccess.doors.frontLeft, true);
    assert.equal(result.vehicleConfirmed, false); assert.equal(getterCalls(), callsBefore);
    assert.equal(store.reservations, reservations); assert.equal(phone.entryCount, entries);
    assert.equal(actions(phone).length, 1); assert.deepEqual(state.auth, blocked);
});

test('entry exceptions or malformed acknowledgements never repeat PIN input or dump the PIN page', async () => {
    for (const options of [{ entryError: new BridgeError('security_entry_uncertain', SECRET) },
        { ack: { beforeMatched: true, actionAttempted: true, actionAccepted: false, errorCode: 'PRIVATE_UNTRUSTED' } },
        { ack: { beforeMatched: false, actionAttempted: false, actionAccepted: false, errorCode: null } }]) {
        const { controller, phone, state } = setup(options);
        await rejects(controller.execute('unlockVehicle'), 'outcome_unknown');
        assert.equal(actions(phone).length, 1); assert.equal(phone.entryCount, 1); assert.equal(state.auth.blocked, true);
        assert.equal(phone.calls.filter(call => call[0] === 'read' && call[1] === 'pin').length, 0);
        lifecycleReleased(controller, phone);
    }
});

test('a persistently unsupported PIN form ends in bounded uncertainty after one attempt without reading or repeating input', async () => {
    const { controller, phone, state, clock } = setup({ pinError: true });
    await rejects(controller.execute('unlockVehicle'), 'outcome_unknown');
    assert.equal(phone.entryCount, 1); assert.equal(actions(phone).length, 1);
    assert.equal(state.auth.reason, 'outcome_unknown'); assert.ok(clock.value >= 1700000030000);
    phone.page = 'home';
    await rejects(controller.execute('unlockVehicle'), 'security_auth_blocked');
    assert.equal(phone.entryCount, 1);
});

test('accepted PIN input tolerates fixed minimal status transitions without a dump, second PIN or vehicle action', async () => {
    const transitions = [
        { kind: 'pinUnsupported', errorCode: 'SECURITY_CONTEXT_UNSUPPORTED' },
        { kind: 'other', errorCode: 'SECURITY_CONTEXT_UNAVAILABLE' },
        { kind: 'other', errorCode: 'SECURITY_SESSION_CLEANUP' },
        new BridgeError('security_status_unavailable', 'PRIVATE_UNTRUSTED ' + SECRET),
    ];
    const { controller, phone, state } = setup({ postEntryStatuses: transitions });
    const result = await controller.execute('unlockVehicle');
    assert.equal(result.vehicleAccess.locked, false); assert.equal(phone.entryCount, 1); assert.equal(actions(phone).length, 1);
    assert.equal(phone.calls.filter(call => call[0] === 'read' && call[1] === 'pin').length, 0);
    assert.equal(phone.calls.filter(call => call[0] === 'hideKeyboard').length, 1);
    assert.deepEqual(state.auth, CLEAR);
});

test('keyboard hiding is attempted once only after a clean post-PIN classification and can never repeat vehicle input', async () => {
    for (const keyboardError of [null, new BridgeError('security_keyboard_unavailable', SECRET),
        new BridgeError('security_keyboard_uncertain', SECRET)]) {
        const { controller, phone, state } = setup({ keyboardError, keyboardAck: { kind: 'hidden', actionAttempted: true } });
        const result = await controller.execute('unlockVehicle');
        assert.equal(result.vehicleAccess.locked, false); assert.equal(phone.entryCount, 1); assert.equal(actions(phone).length, 1);
        assert.equal(phone.calls.filter(call => call[0] === 'hideKeyboard').length, 1); assert.deepEqual(state.auth, CLEAR);
        const entry = phone.calls.findIndex(call => call[0] === 'secretEntry');
        const hide = phone.calls.findIndex(call => call[0] === 'hideKeyboard');
        assert.ok(entry >= 0 && hide > entry);
    }
});

test('a PIN form that remains unsupported is never sent a keyboard-hide Back or another PIN', async () => {
    const { controller, phone } = setup({ pinError: true });
    await rejects(controller.execute('unlockVehicle'), 'outcome_unknown');
    assert.equal(phone.calls.filter(call => call[0] === 'hideKeyboard').length, 0);
    assert.equal(phone.entryCount, 1); assert.equal(actions(phone).length, 1);
});

test('a missing guarded keyboard API fails before vehicle input and malformed keyboard acknowledgements retain the block', async () => {
    const missing = setup(); missing.phone.hideSecurityKeyboard = undefined;
    await rejects(missing.controller.execute('unlockVehicle'), 'security_keyboard_unavailable');
    assert.equal(missing.phone.entryCount, 0); assert.equal(actions(missing.phone).length, 0);
    const malformed = setup({ keyboardAck: { kind: 'hidden', actionAttempted: false } });
    await rejects(malformed.controller.execute('unlockVehicle'), 'outcome_unknown');
    assert.equal(malformed.state.auth.blocked, true); assert.equal(malformed.phone.entryCount, 1);
    assert.equal(malformed.phone.calls.filter(call => call[0] === 'hideKeyboard').length, 1);
});

test('security failures carry only branded fixed stage and cause while the public outcome remains unchanged', async () => {
    for (const [options, stage, cause] of [[{ tapError: new Error(SECRET) }, 'cta', 'internal_error'],
        [{ pinOperation: 'lock' }, 'pin_context', 'security_context_invalid'],
        [{ entryError: new BridgeError('security_entry_uncertain', SECRET) }, 'pin_entry', 'security_entry_uncertain'],
        [{ keyboardError: new BridgeError('security_keyboard_unauthorized', SECRET) }, 'keyboard_hide', 'security_keyboard_unauthorized']]) {
        const { controller } = setup(options);
        await assert.rejects(controller.execute('unlockVehicle'), error => {
            assert.equal(error.code, 'outcome_unknown');
            assert.deepEqual(securityErrorDiagnostic(error), { stage, cause });
            assert.deepEqual(Object.keys(error.toJSON()), ['code', 'message']);
            assert.equal(JSON.stringify(error).includes(SECRET), false);
            return true;
        });
    }
});

test('a transient second confirmation probe does not turn an unsafe form into an ordinary read', async () => {
    const { controller, phone, state } = setup({ postEntryStatuses: [
        app => { app.page = 'home'; return { kind: 'home', errorCode: null }; },
        app => { app.page = 'pin'; return { kind: 'pinUnsupported', errorCode: 'SECURITY_CONTEXT_UNSUPPORTED' }; },
    ] });
    const result = await controller.execute('unlockVehicle');
    assert.equal(result.vehicleAccess.locked, false); assert.equal(phone.entryCount, 1); assert.equal(actions(phone).length, 1);
    assert.equal(phone.calls.filter(call => call[0] === 'read' && call[1] === 'pin').length, 0);
    assert.deepEqual(state.auth, CLEAR);
});

test('focus loss after the second post-PIN probe waits for a fresh probe without ordinary UI read or repeated input', async () => {
    const { controller, phone, state } = setup({ foregroundReadFailures: 1 });
    const result = await controller.execute('unlockVehicle');
    assert.equal(result.vehicleAccess.locked, false); assert.deepEqual(state.auth, CLEAR);
    const blocked = phone.calls.findIndex(call => call[0] === 'foregroundBlocked');
    assert.ok(blocked >= 0); assert.equal(phone.calls[blocked + 1][0], 'probe');
    assert.equal(phone.calls.filter(call => call[0] === 'foregroundBlocked').length, 1);
    assert.equal(phone.calls.filter(call => call[0] === 'read' && call[1] === 'pin').length, 0);
    assert.equal(phone.calls.filter(call => call[0] === 'hideKeyboard').length, 1);
    assert.equal(phone.calls.filter(call => call[0] === 'tap').length, 2);
    assert.equal(phone.entryCount, 1); assert.equal(actions(phone).length, 1);
});

test('focus loss during the pre-entry Home read remains strict and never reaches PIN, keyboard or vehicle input', async () => {
    const { controller, phone, store } = setup();
    phone.dump = async () => {
        phone.calls.push(['foregroundBlocked', phone.page]);
        throw new BridgeError('phone_locked_or_other_app', 'PRIVATE_UNTRUSTED ' + SECRET);
    };
    await rejects(controller.execute('unlockVehicle'), 'phone_locked_or_other_app');
    assert.equal(phone.calls.filter(call => ['read', 'tap', 'secretEntry', 'hideKeyboard'].includes(call[0])).length, 0);
    assert.equal(phone.entryCount, 0); assert.equal(store.reservations, 0);
});

test('transitional Vehicle-sheet and Home labels are waited out without guessed navigation or a false observation', async () => {
    for (const options of [{ postAuthSheet: true, loadingSheetReads: 2 }, { loadingHomeReads: 2 }]) {
        const { controller, phone, state } = setup(options);
        const result = await controller.execute('unlockVehicle');
        assert.equal(result.vehicleAccess.locked, false); assert.equal(actions(phone).length, 1); assert.equal(phone.entryCount, 1);
        assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[2] === 70 && call[3] === 675).length,
            options.postAuthSheet ? 1 : 0);
        assert.deepEqual(state.auth, CLEAR);
    }
});

test('status errors before PIN entry remain strict and cannot use the post-entry transition exception', async () => {
    const { controller, phone, store } = setup({ probeOverride: () => ({ kind: 'pinUnsupported', errorCode: 'SECURITY_CONTEXT_UNSUPPORTED' }) });
    await rejects(controller.execute('unlockVehicle'), 'security_context_invalid');
    assert.equal(phone.entryCount, 0); assert.equal(actions(phone).length, 0); assert.equal(store.reservations, 0);
});

test('PIN page that never leaves and unchanged Home telemetry end in bounded uncertainty without repeated writes', async () => {
    for (const options of [{ neverHome: true }, { neverConfirm: true }]) {
        const { controller, phone, state, clock } = setup(options);
        await rejects(controller.execute('unlockVehicle'), 'outcome_unknown');
        assert.equal(phone.entryCount, 1); assert.equal(actions(phone).length, 1); assert.equal(state.auth.blocked, true);
        assert.ok(clock.value >= 1700000030000 && clock.value < 1700000032000); lifecycleReleased(controller, phone);
    }
});

test('manual cancellation after PIN entry leaves an uncertain block and releases only this operation', async () => {
    const { controller, phone, state } = setup(); phone.afterEntry = () => controller.cancel();
    await rejects(controller.execute('unlockVehicle'), 'outcome_unknown');
    assert.equal(phone.entryCount, 1); assert.equal(state.auth.blocked, true); lifecycleReleased(controller, phone);
});

test('a competing request cannot release the active command, and automatic reads cannot hand it off', async () => {
    let release;
    const connectGate = new Promise(resolve => { release = resolve; });
    const { controller, phone } = setup({ connectGate });
    const active = controller.execute('unlockVehicle');
    assert.equal(controller.busy, true); assert.equal(controller.requestReadHandoff(), false);
    await rejects(controller.execute('unlockVehicle'), 'busy'); assert.equal(controller.busy, true);
    release(); await active; lifecycleReleased(controller, phone);
});

test('foreign credential and UI errors are reduced to fixed codes without reading message/accessor/toJSON', async () => {
    let read = 0;
    const hostile = { code: 'security_pin_invalid', get message() { read++; return SECRET; }, toJSON() { read++; throw new Error(SECRET); } };
    const { controller, phone, store } = setup({}, {}, () => { throw hostile; });
    await rejects(controller.execute('unlockVehicle'), 'security_pin_invalid');
    assert.equal(read, 0); assert.equal(actions(phone).length, 0); assert.equal(store.reservations, 0);
    const foreign = setup({ dumpError: new BridgeError('wrong_vehicle', 'PRIVATE_UNTRUSTED ' + SECRET) });
    await rejects(foreign.controller.execute('unlockVehicle'), 'wrong_vehicle');
});

test('a confirmed command clears the auth latch only after the full Home model agrees', async () => {
    const { controller, phone, store, state } = setup();
    const write = store.write.bind(store);
    store.write = async (name, value) => {
        if (value.blocked === false) { assert.equal(phone.page, 'home'); assert.equal(phone.locked, false); }
        return write(name, value);
    };
    await controller.execute('unlockVehicle'); assert.deepEqual(await readSecurityAuth(store), CLEAR);
    await clearSecurityAuth(store); assert.deepEqual(state.auth, CLEAR);
});
