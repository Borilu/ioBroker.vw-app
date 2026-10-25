'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Screen } = require('../lib/ui');
const { vehicleLockNavigationTarget, vehicleLockSheet, vehicleLockActionTarget } = require('../lib/lock-ui');
const { vehicleAccessScreen } = require('./support/access-fixtures.cjs');
const { lockSheet, node, hierarchy } = require('./support/lock-fixtures.cjs');

test('vehicle navigation is a separate exact row from either observed Home lock state', () => {
    for (const locked of [true, false]) {
        const screen = new Screen(vehicleAccessScreen({ locked }));
        assert.deepEqual(vehicleLockNavigationTarget(screen, locked), { x: 500, y: 975 });
        assert.throws(() => vehicleLockNavigationTarget(screen, !locked));
    }
});

test('the observed unlock target comes from the fresh lower gap, including scaled and moved layouts', () => {
    for (const scale of [1, 2]) for (const offset of [0, 90]) {
        const screen = new Screen(lockSheet({ scale, offset }));
        const sheet = vehicleLockSheet(screen);
        assert.equal(sheet.locked, true); assert.equal(sheet.position, 'upper');
        const target = vehicleLockActionTarget(screen, 'unlock');
        assert.equal(target.x, Math.floor((sheet.outer[0] + sheet.outer[2]) / 2));
        assert.equal(target.y, Math.floor((sheet.inner[3] + sheet.outer[3]) / 2));
        assert.ok(target.y > sheet.inner[3] && target.y < sheet.outer[3]);
    }
});

test('the separately observed lock target comes from the fresh upper gap in an unlocked sheet', () => {
    for (const scale of [1, 2]) for (const offset of [0, 90]) {
        const screen = new Screen(lockSheet({ locked: false, scale, offset }));
        const sheet = vehicleLockSheet(screen);
        assert.equal(sheet.locked, false); assert.equal(sheet.position, 'lower');
        const target = vehicleLockActionTarget(screen, 'lock');
        assert.equal(target.x, Math.floor((sheet.outer[0] + sheet.outer[2]) / 2));
        assert.equal(target.y, Math.floor((sheet.outer[1] + sheet.inner[1]) / 2));
        assert.ok(target.y > sheet.outer[1] && target.y < sheet.inner[1]);
    }
    assert.throws(() => vehicleLockActionTarget(new Screen(lockSheet()), 'lock'));
    assert.throws(() => vehicleLockActionTarget(new Screen(lockSheet({ locked: false })), 'unlock'));
    assert.throws(() => vehicleLockActionTarget(new Screen(lockSheet()), 'toggle'), error => error.code === 'invalid_action');
});

test('hidden, clipped, contradictory and extended controls cannot authorize an unlabeled action', () => {
    const valid = lockSheet();
    const invalid = [
        valid.replace('text="Verriegelt"', 'text="Entriegelt"'),
        valid.replace('bounds="[400,820][600,1110]"', 'bounds="[400,950][600,1240]"'),
        valid.replace('bounds="[400,820][600,1110]"', 'bounds="[100,820][300,1110]"'),
        valid.replace('bounds="[380,800][620,1420]"', 'bounds="[380,800][620,1500]"'),
        valid.replace('text="Fahrzeug"', 'text="Fahrzeug" visible-to-user="false"'),
        valid.replace('text="Verriegelt"', 'text="Verriegelt" enabled="false"'),
        valid.replace('bounds="[380,800][620,1420]"', 'bounds="[380,800][620,1420]" clickable="true"'),
        valid.replace('</hierarchy>', node('', { class: 'android.widget.TextView', text: 'Fahrzeug' }) + '</hierarchy>'),
        valid.replace('</hierarchy>', node('', { class: 'android.widget.EditText', text: 'PRIVATE_UNTRUSTED' }) + '</hierarchy>'),
        valid.replace('</hierarchy>', node('alert_dialog') + '</hierarchy>'),
    ];
    for (const xml of invalid) assert.throws(() => vehicleLockActionTarget(new Screen(xml), 'unlock'));
    const unlocked = lockSheet({ locked: false });
    for (const xml of [unlocked.replace('text="Entriegelt"', 'text="Verriegelt"'),
        unlocked.replace('[400,1110][600,1400]', '[400,950][600,1240]'),
        unlocked.replace('[400,1110][600,1400]', '[100,1110][300,1400]'),
        unlocked.replace('[380,800][620,1420]', '[380,800][620,1500]'),
        unlocked.replace('text="Fahrzeug"', 'text="Fahrzeug" visible-to-user="false"'),
        unlocked.replace('text="Entriegelt"', 'text="Entriegelt" enabled="false"')]) {
        assert.throws(() => vehicleLockActionTarget(new Screen(xml), 'lock'));
    }
    assert.equal(vehicleLockSheet(new Screen(hierarchy())), null);
});

test('an ambiguous vehicle row or a missing same-bounds button cannot authorize navigation', () => {
    const valid = vehicleAccessScreen({ locked: true });
    assert.throws(() => vehicleLockNavigationTarget(new Screen(valid.replace('class="android.widget.Button"', 'class="android.view.View"')), true));
    assert.throws(() => vehicleLockNavigationTarget(new Screen(valid.replace('</hierarchy>', node('', {
        'content-desc': 'Fahrzeug. Verriegelt. Details öffnen' }) + '</hierarchy>')), true));
});
