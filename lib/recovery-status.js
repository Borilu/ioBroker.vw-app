'use strict';

const crypto = require('node:crypto');

// A missing execution fence is NOT proof that a legacy process has stopped.
// This read-only status can only identify a candidate for a later manual
// offline recovery protocol. It never creates a marker, starts ADB, reads a
// phone, clears a journal, replays a command, or confirms an authorization.
async function recoveryStatus({ store, deviceId, guardianSecret }) {
    try {
        if (!store || !/^(?:serial:[A-Za-z0-9_.-]{1,100}|android_id:[0-9a-fA-F]{16})$/.test(deviceId || '') ||
            !/^[a-f0-9]{64}$/.test(guardianSecret || '')) return 'recovery_manual_review';
        const [permission, pairing, test, execution] = await Promise.all([
            store.read('guardian-permission-state', null), store.read('guardian-pair-state', null),
            store.read('guardian-test-state', null), store.read('adb-execution-fence', null),
        ]);
        const legacy = permission && permission.status === 'confirmed' && Object.keys(permission).length === 1;
        const key = Buffer.from(guardianSecret, 'hex');
        let digest;
        try { digest = crypto.createHash('sha256').update(key).digest('hex'); }
        finally { key.fill(0); }
        const pairComplete = pairing && Object.keys(pairing).length === 2 &&
            pairing.status === 'android_verified_host_not_enabled' && pairing.keyDigest === digest;
        const testClear = test === null || Object.keys(test).length === 2 && test.version === 1 && test.status === 'confirmed';
        if (legacy && pairComplete && testClear && execution === null) return 'recovery_legacy_candidate';
    } catch (_) { /* Broken/unreadable state never enables recovery. */ }
    return 'recovery_manual_review';
}

module.exports = { recoveryStatus };
