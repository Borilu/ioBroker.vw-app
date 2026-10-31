'use strict';

// Explicit setup action only. Its caller must serialize it with every phone
// operation and obtain consent in Admin. No arbitrary command is accepted.
const { BridgeError } = require('./errors');
const { parsePackagePath, parseHash } = require('./guardian-pair-utils');
const { APPROVED_APK_SHA256 } = require('./guardian-binder-pair');
const PACKAGE = 'de.borilu.wirelessguardian';
const PERMISSION = 'android.permission.WRITE_SECURE_SETTINGS';

function denied() {
    return new BridgeError('guardian_permission_unconfirmed',
        'The Guardian permission could not be confirmed. Check the phone before any further attempt.');
}
function userId(output) {
    const value = String(output).trim();
    if (!/^(?:0|[1-9][0-9]{0,5})$/.test(value)) throw denied();
    return value;
}
function permissionState(output) {
    const value = String(output).trim();
    if (value === '0') return true;
    if (value === '-1') return false;
    throw denied();
}
function ensureActive(signal) { if (signal?.aborted) throw denied(); }

async function verifyInstalledGuardian(phone, user, signal) {
    ensureActive(signal);
    // This special setup action has only been designed for Android 16.
    if (String(await phone.run(['shell', 'getprop', 'ro.build.version.sdk'])).trim() !== '36') throw denied();
    ensureActive(signal);
    if (userId(await phone.run(['shell', 'am', 'get-current-user'])) !== user) throw denied();
    ensureActive(signal);
    const apk = parsePackagePath(await phone.run(['shell', 'pm', 'path', '--user', user, PACKAGE]));
    ensureActive(signal);
    const output = String(await phone.run(['shell', 'sha256sum', apk])).trim();
    const digest = parseHash(output);
    if (digest !== APPROVED_APK_SHA256 || ![digest + '  ' + apk, digest + ' ' + apk].includes(output)) throw denied();
    ensureActive(signal);
    return apk;
}
async function queryPermission(phone, user, signal) {
    ensureActive(signal);
    const result = await phone.run(['shell', 'dumpsys', 'package', 'check-permission', PERMISSION, PACKAGE, user]);
    ensureActive(signal);
    return permissionState(result);
}

/**
 * journal.read()/write() must use a durable, private per-instance store. The
 * caller supplies a phone obtained from the pinned-identity private ADB server,
 * and MUST serialize this action with other phone operations. A failed write
 * or an unresolved earlier attempt blocks another grant, even after restart.
 */
async function grantGuardianPermission({ phone, userConfirmed, journal, signal }) {
    if (userConfirmed !== true || !phone || !/^(?:serial:[A-Za-z0-9_.-]{1,100}|android_id:[0-9a-fA-F]{16})$/.test(phone.deviceId || '') ||
        typeof phone.connect !== 'function' || typeof phone.run !== 'function' ||
        !journal || typeof journal.read !== 'function' || typeof journal.write !== 'function') {
        throw new BridgeError('guardian_permission_consent_required', 'Confirm the requested Android permission explicitly first.');
    }
    try {
        ensureActive(signal);
        await phone.connect(); // pinned device identity and lease, via private server
        ensureActive(signal);
        const user = userId(await phone.run(['shell', 'am', 'get-current-user']));
        const apk = await verifyInstalledGuardian(phone, user, signal);
        const granted = await queryPermission(phone, user, signal);
        // Idempotent read-only success: no grant is sent when Android already
        // reports the permission for the verified package and active user.
        if (granted) {
            await phone.connect(); ensureActive(signal);
            if (await verifyInstalledGuardian(phone, user, signal) !== apk) throw denied();
            if (!await queryPermission(phone, user, signal)) throw denied();
            const previous = await journal.read();
            if (previous !== null && !['attempting', 'confirmed'].includes(previous?.status)) throw denied();
            if (previous?.status === 'attempting') {
                // An explicit new user action has independently confirmed
                // the prior uncertain grant. Close only this local fence;
                // never send a second grant for that previous attempt.
                ensureActive(signal);
                await journal.write({ status: 'confirmed' });
            }
            return { result: 'guardian_permission_already_granted' };
        }
        const previous = await journal.read();
        if (previous !== null && previous?.status !== 'confirmed') throw denied();
        ensureActive(signal);
        // Persist before the potentially effective command. On timeout or lost
        // acknowledgement the marker stays; no automatic grant is repeated.
        await journal.write({ status: 'attempting' });
        ensureActive(signal);
        await phone.connect(); ensureActive(signal);
        if (await verifyInstalledGuardian(phone, user, signal) !== apk) throw denied();
        ensureActive(signal);
        const output = await phone.run(['shell', 'pm', 'grant', '--user', user, PACKAGE, PERMISSION]);
        if (String(output).trim() !== '') throw denied();
        ensureActive(signal);
        await phone.connect(); ensureActive(signal);
        if (!await queryPermission(phone, user, signal)) throw denied();
        if (await verifyInstalledGuardian(phone, user, signal) !== apk) throw denied();
        if (!await queryPermission(phone, user, signal)) throw denied();
        ensureActive(signal);
        await journal.write({ status: 'confirmed' });
        return { result: 'guardian_permission_granted' };
    } catch (_) { throw denied(); }
}

module.exports = { grantGuardianPermission, permissionState, userId };
