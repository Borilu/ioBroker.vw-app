'use strict';

const { BridgeError } = require('./errors');

function fenced() {
    return new BridgeError('guardian_phone_fenced',
        'A Guardian setup operation may still be active. Further phone operations are blocked; do not remove or restore the private journals.');
}

// Read only durable per-instance markers. This cannot fence other instances,
// other hosts, deleted/restored markers, or non-Guardian Android commands.
async function assertGuardianJobsClear(store) {
    try {
        const permission = await store.read('guardian-permission-state', null);
        const pair = await store.read('guardian-pair-state', null);
        const synthetic = await store.read('guardian-test-state', null);
        // Legacy "confirmed" could originate from the old unsafe attempt ->
        // observed-granted transition, so it is not evidence of quiescence.
        if (permission !== null && !(permission.status === 'confirmed' && permission.version === 2)) throw fenced();
        if (pair !== null && (!['host_prepared', 'android_verified_host_not_enabled'].includes(pair.status)
            || typeof pair.keyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(pair.keyDigest))) throw fenced();
        if (synthetic !== null && (synthetic.version !== 1 || synthetic.status !== 'confirmed')) throw fenced();
    } catch (_) { throw fenced(); }
}

module.exports = { assertGuardianJobsClear, fenced };
