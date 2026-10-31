'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOverview } = require('../lib/charging-controller');
const { BridgeError } = require('../lib/errors');

function screen({ kind = 'overview', needsTop = false, wrongVehicle = false } = {}) {
    return {
        kind: () => kind,
        requireVehicle() { if (wrongVehicle) throw new BridgeError('wrong_vehicle', 'Synthetic wrong vehicle'); },
        overviewNeedsTop: () => needsTop,
        overviewNativeScrollContext: () => ({ header: 'synthetic', target: { class: 'android.widget.ScrollView', bounds: [0, 0, 1, 1] } }),
    };
}

function setup({ response, verification }) {
    const calls = [];
    const lower = screen({ needsTop: true });
    const controller = {
        config: { vehicleMarker: { contentDesc: 'synthetic vehicle' } },
        phone: {
            async departureView() { calls.push('snapshot'); return { observation: {} }; },
            async departureAction() { calls.push('scroll'); return response; },
        },
        async _version() { calls.push('version'); },
        async _step(operation) { return operation(); },
        _nativeScreenFromView() { return lower; },
        async _navigationRead() { calls.push('verification'); return verification; },
    };
    return { calls, lower, controller };
}

test('an unconfirmed scroll can be confirmed by one independent fresh read without another gesture', async () => {
    for (const response of [
        { beforeMatched: true, actionAttempted: true, actionAccepted: false, success: false, errorCode: null, postRead: null },
        { beforeMatched: true, actionAttempted: true, actionAccepted: true, success: false, errorCode: 'POST_READ_UNAVAILABLE', postRead: null },
    ]) {
        const verified = screen();
        const { calls, lower, controller } = setup({ response, verification: verified });
        assert.equal(await normalizeOverview(controller, lower), verified);
        assert.equal(calls.filter(call => call === 'scroll').length, 1);
        assert.equal(calls.filter(call => call === 'verification').length, 1);
    }
});

test('unconfirmed scrolling stops without retry if the fresh view is not the correct aligned vehicle', async () => {
    const response = { beforeMatched: true, actionAttempted: true, actionAccepted: false, success: false, errorCode: null, postRead: null };
    for (const verification of [screen({ needsTop: true }), screen({ kind: 'settings' }), screen({ wrongVehicle: true })]) {
        const { calls, lower, controller } = setup({ response, verification });
        await assert.rejects(normalizeOverview(controller, lower), error =>
            error instanceof BridgeError && ['charging_navigation_unavailable', 'wrong_vehicle'].includes(error.code));
        assert.equal(calls.filter(call => call === 'scroll').length, 1);
        assert.equal(calls.filter(call => call === 'verification').length, 1);
    }
});

test('an action not verified and attempted cannot be rescued by a later view', async () => {
    const response = { beforeMatched: false, actionAttempted: false, actionAccepted: null, success: false, errorCode: 'VIEW_CHANGED', postRead: null };
    const { calls, lower, controller } = setup({ response, verification: screen() });
    await assert.rejects(normalizeOverview(controller, lower), error => error.code === 'charging_navigation_unavailable');
    assert.equal(calls.filter(call => call === 'scroll').length, 1);
    assert.equal(calls.includes('verification'), false);
});
