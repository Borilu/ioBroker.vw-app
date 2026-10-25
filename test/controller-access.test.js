'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../lib/controller');
const { BridgeError } = require('../lib/errors');
const { vehicleAccessScreen } = require('./support/access-fixtures.cjs');
const { node, hierarchy, overviewChargingScreen, rangeScreen, chargingSettingsScreen, POINTS } = require('./support/charging-fixtures.cjs');
const { completeDemoClimate } = require('./support/settings-fixtures.cjs');
const MARKER = 'Ihr Fahrzeug: Testwagen. ';
const ALL_OPEN = ['Kofferraum', 'Tür hinten rechts', 'Tür hinten links', 'Tür vorne rechts', 'Tür vorne links',
    'Fenster vorne links', 'Fenster vorne rechts', 'Fenster hinten links', 'Fenster hinten rechts'];

class AccessApp {
    constructor(options = {}) {
        this.page = 'overview'; this.lower = false; this.calls = [];
        this.versionValue = '4.8.1'; this.deadline = null;
        this.view = { locked: true, open: [] };
        Object.assign(this, options);
    }
    async connect() { this.calls.push(['connect']); if (this.connectGate) await this.connectGate; }
    async version() { this.calls.push(['version']); return this.versionValue; }
    async launch() { this.calls.push(['launch']); }
    async dump() {
        this.calls.push(['read', this.page]);
        if (this.beforeDump) await this.beforeDump();
        if (this.page === 'overview') {
            const view = this.lower ? overviewChargingScreen({ lower: true }) : vehicleAccessScreen(this.view);
            return this.wrongVehicle ? view.replace('Ihr Fahrzeug: Testwagen.', 'Ihr Fahrzeug: Anderes Auto.') : view;
        }
        if (this.page === 'climate') return completeDemoClimate();
        if (this.page === 'range') return rangeScreen();
        if (this.page === 'vehicleSettings') return chargingSettingsScreen({ dirty: true });
        if (this.page === 'blocked') return hierarchy([node('alert_dialog')]);
        return hierarchy([node('unrecognized_page')]);
    }
    async swipe(gesture) {
        this.calls.push(['swipe', this.page, { ...gesture }]);
        assert.equal(this.page, 'overview');
        assert.ok(gesture.y2 > gesture.y1, 'Only normalize the Home content; never pull to refresh');
        this.lower = false;
    }
    async back() {
        this.calls.push(['back', this.page]);
        assert.equal(this.page, 'climate');
        this.page = 'overview';
    }
    async tap(x, y) {
        this.calls.push(['tap', this.page, x, y]);
        assert.equal(this.page, 'range', 'No vehicle or settings control may be touched');
        assert.deepEqual({ x, y }, POINTS.back);
        this.page = 'overview';
    }
    async nativeView() { throw new Error('Native setting geometry is not part of access-state reads'); }
}

function setup(options = {}, config = {}) {
    const phone = new AccessApp(options);
    const clock = { value: 1700000000000 };
    const store = {
        reservations: 0, writes: 0, reads: 0,
        async reserveCommand() { this.reservations++; throw new Error('No vehicle command reservation'); },
        async write() { this.writes++; throw new Error('No preference writes'); },
        async read() { this.reads++; throw new Error('No wish or journal reads'); },
    };
    const controller = new Controller({ phone, store, config: {
        approvedAppVersion: '4.8.1', vehicleMarker: { contentDescPrefix: MARKER },
        modeTitles: ['Klimatisierung'], allowWrites: false,
        commandTimeoutSeconds: 300, outcomeTimeoutSeconds: 120, cooldownSeconds: 60, ...config,
    }, now: () => clock.value, sleep: async ms => { clock.value += ms; } });
    return { phone, controller, clock, store };
}

async function rejects(operation, code) {
    await assert.rejects(operation, error => error instanceof BridgeError && error.code === code && !error.message.includes('SECRET'));
}
function noVehicleActions(phone, store) {
    assert.equal(store.reservations, 0); assert.equal(store.writes, 0); assert.equal(store.reads, 0);
    assert.equal(phone.calls.filter(call => call[0] === 'tap' && call[1] !== 'range').length, 0);
}

test('read-only access status returns separate open components and an unlocked state from one Home read', async () => {
    const { controller, phone, store } = setup({ view: { locked: false, open: ALL_OPEN } });
    const result = await controller.execute('refreshVehicleAccess', {
        targetTemperature: 'invalid unused', targetSettings: { invalid: true }, targetCharging: { invalid: true },
    });
    assert.equal(result.domain, 'vehicleAccess'); assert.equal(result.appVersion, '4.8.1');
    assert.equal(result.source, 'volkswagen_android_app'); assert.equal(result.vehicleConfirmed, false);
    assert.equal(result.observedAt, '2023-11-14T22:13:20.000Z');
    assert.deepEqual(Object.values(result.vehicleAccess.doors), [true, true, true, true]);
    assert.deepEqual(Object.values(result.vehicleAccess.windows), [true, true, true, true]);
    assert.equal(result.vehicleAccess.trunkOpen, true); assert.equal(result.vehicleAccess.locked, false);
    assert.equal(result.vehicleAccess.synchronizationText, 'Gerade synchronisiert');
    assert.match(result.vehicleAccess.warningText, /Kofferraum/);
    assert.equal(phone.calls.filter(call => call[0] === 'read').length, 1);
    assert.equal(phone.calls.filter(call => ['tap', 'back', 'swipe'].includes(call[0])).length, 0);
    assert.equal(phone.page, 'overview'); assert.equal(phone.deadline, null); assert.equal(controller.busy, false);
    assert.equal(controller.readOnlyExecution, false); noVehicleActions(phone, store);
});

test('all openings closed remains independent from either locked or unlocked vehicle tile', async () => {
    for (const locked of [true, false]) {
        const { controller, phone, store } = setup({ view: { locked, open: [] } });
        const result = await controller.execute('refreshVehicleAccess', { dryRun: true });
        assert.deepEqual(Object.values(result.vehicleAccess.doors), [false, false, false, false]);
        assert.deepEqual(Object.values(result.vehicleAccess.windows), [false, false, false, false]);
        assert.equal(result.vehicleAccess.trunkOpen, false); assert.equal(result.vehicleAccess.locked, locked);
        assert.equal(result.vehicleAccess.warningText, ''); noVehicleActions(phone, store);
    }
});

test('a previously open climate sheet returns through Back without a climate or lock action', async () => {
    const { controller, phone, store } = setup({ page: 'climate' });
    const result = await controller.execute('refreshVehicleAccess');
    assert.equal(result.vehicleAccess.locked, true);
    assert.deepEqual(phone.calls.filter(call => call[0] === 'back'), [['back', 'climate']]);
    assert.equal(phone.page, 'overview'); noVehicleActions(phone, store);
});

test('a range sheet is closed only by its own inspected close control', async () => {
    const { controller, phone, store } = setup({ page: 'range' });
    await controller.execute('refreshVehicleAccess');
    assert.deepEqual(phone.calls.filter(call => call[0] === 'tap'), [['tap', 'range', POINTS.back.x, POINTS.back.y]]);
    assert.equal(phone.page, 'overview'); noVehicleActions(phone, store);
});

test('a retained lower Home position is normalized before interpreting absent opening warnings', async () => {
    const { controller, phone, store } = setup({ lower: true, view: { locked: false, open: ['Fenster hinten rechts'] } });
    const result = await controller.execute('refreshVehicleAccess');
    assert.equal(result.vehicleAccess.windows.rearRight, true);
    assert.equal(result.vehicleAccess.windows.frontLeft, false);
    assert.equal(phone.calls.filter(call => call[0] === 'swipe').length, 1);
    noVehicleActions(phone, store);
});

test('a manual vehicle-settings draft is neither saved nor discarded', async () => {
    const { controller, phone, store } = setup({ page: 'vehicleSettings' });
    await rejects(controller.execute('refreshVehicleAccess'), 'unsaved_settings');
    assert.equal(phone.calls.filter(call => ['tap', 'swipe', 'back'].includes(call[0])).length, 0);
    assert.equal(phone.page, 'vehicleSettings'); noVehicleActions(phone, store);
});

test('wrong enrolled vehicle is rejected before reporting a closed or locked state', async () => {
    const { controller, phone, store } = setup({ wrongVehicle: true });
    await assert.rejects(controller.execute('refreshVehicleAccess'), error => error instanceof BridgeError && /vehicle/.test(error.code));
    assert.equal(phone.calls.filter(call => ['tap', 'swipe', 'back'].includes(call[0])).length, 0);
    noVehicleActions(phone, store);
});

test('unapproved app versions prevent all app input and access observations', async () => {
    const { controller, phone, store } = setup({ versionValue: '999.0' });
    await rejects(controller.execute('refreshVehicleAccess'), 'version_not_approved');
    assert.equal(phone.calls.filter(call => call[0] === 'launch' || call[0] === 'read').length, 0);
    noVehicleActions(phone, store);
});

test('a modal blocks access status without dismissing it or publishing false closed values', async () => {
    const { controller, phone, store } = setup({ page: 'blocked' });
    await rejects(controller.execute('refreshVehicleAccess'), 'blocked_ui');
    assert.equal(phone.calls.filter(call => ['tap', 'swipe', 'back'].includes(call[0])).length, 0);
    noVehicleActions(phone, store);
});

test('an unrecognized page has a bounded wait and no blind navigation', async () => {
    const { controller, phone, store, clock } = setup({ page: 'unknown' });
    await rejects(controller.execute('refreshVehicleAccess'), 'unexpected_screen');
    assert.ok(clock.value <= 1700000008000);
    assert.equal(phone.calls.filter(call => ['tap', 'swipe', 'back'].includes(call[0])).length, 0);
    noVehicleActions(phone, store);
});

test('manual handoff cancels a pending automatic access read before any app navigation', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { controller, phone, store } = setup({ connectGate: gate });
    const active = controller.execute('refreshVehicleAccess');
    assert.equal(controller.requestReadHandoff(), true);
    release(); await rejects(active, 'cancelled');
    assert.equal(phone.calls.filter(call => call[0] !== 'connect').length, 0);
    assert.equal(controller.readOnlyExecution, false); assert.equal(controller.busy, false);
    assert.equal(phone.deadline, null); noVehicleActions(phone, store);
});

test('a competing rejected read cannot clear the active access read handoff flags', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { controller, phone } = setup({ connectGate: gate });
    const active = controller.execute('refreshVehicleAccess');
    await rejects(controller.execute('refreshVehicleAccess'), 'busy');
    assert.equal(controller.busy, true); assert.equal(controller.readOnlyExecution, true);
    assert.equal(controller.requestReadHandoff(), true);
    release(); await rejects(active, 'cancelled');
    assert.equal(controller.busy, false); assert.equal(phone.deadline, null);
});

test('an expired operation deadline stops the read and always releases the phone lifecycle', async () => {
    const { controller, phone, clock } = setup();
    phone.connect = async () => { clock.value += 300001; };
    await rejects(controller.execute('refreshVehicleAccess'), 'phone_timeout');
    assert.equal(phone.calls.length, 0); assert.equal(controller.busy, false); assert.equal(phone.deadline, null);
});

test('unknown transport errors expose neither private UI data nor retries', async () => {
    const { controller, phone, store } = setup();
    phone.beforeDump = () => { throw new Error('SECRET vehicle data'); };
    await rejects(controller.execute('refreshVehicleAccess'), 'internal_error');
    assert.equal(phone.calls.filter(call => call[0] === 'read').length, 1);
    assert.equal(controller.busy, false); assert.equal(phone.deadline, null); noVehicleActions(phone, store);
});

test('configured keep-awake is confirmed after connecting and before reading Home', async () => {
    const { controller, phone, store } = setup({}, { stayAwakeOnCharge: true });
    phone.keepAwake = async () => { phone.calls.push(['keepAwake']); return { active: true }; };
    await controller.execute('refreshVehicleAccess');
    assert.equal(phone.calls.filter(call => call[0] === 'connect').length, 1);
    assert.ok(phone.calls.findIndex(call => call[0] === 'connect') < phone.calls.findIndex(call => call[0] === 'keepAwake'));
    assert.ok(phone.calls.findIndex(call => call[0] === 'keepAwake') < phone.calls.findIndex(call => call[0] === 'read'));
    noVehicleActions(phone, store);
});

test('failed keep-awake and an already closing controller do not navigate the app', async () => {
    const failed = setup({}, { stayAwakeOnCharge: true });
    failed.phone.keepAwake = async () => ({ active: false });
    await rejects(failed.controller.execute('refreshVehicleAccess'), 'phone_setting_failed');
    assert.equal(failed.phone.calls.filter(call => call[0] === 'read' || call[0] === 'launch').length, 0);
    const closing = setup(); closing.controller.cancel();
    await rejects(closing.controller.execute('refreshVehicleAccess'), 'cancelled');
    assert.equal(closing.phone.calls.length, 0);
});
