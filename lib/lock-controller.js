'use strict';

const { validateSecurityPin } = require('./config');
const { DEFAULT_TARGET_SETTINGS } = require('./settings');
const { validateVehicleAccess } = require('./vehicle-access');
const { readSecurityAuth, blockSecurityAuth, clearSecurityAuth, fixedSecurityError, sanitizeSecurityError,
    withSecurityDiagnostic, securityErrorDiagnostic } = require('./security-auth');
const { vehicleLockNavigationTarget, vehicleLockSheet, vehicleLockActionTarget } = require('./lock-ui');
const { normalizeOverview } = require('./charging-controller');

// Credentials never become enumerable controller/configuration properties or
// command options. Only the transport receives this narrow callback.
const PIN_GETTERS = new WeakMap();
function registerSecurityPinGetter(controller, getter) {
    if (typeof getter === 'function') PIN_GETTERS.set(controller, getter);
}

function pinGetter(controller) {
    return () => {
        const getter = PIN_GETTERS.get(controller);
        if (!getter) throw fixedSecurityError('security_pin_required');
        try { return validateSecurityPin(getter()); }
        catch (error) { throw sanitizeSecurityError(error); }
    };
}

async function securityStatus(controller, { allowTransition = false } = {}) {
    if (typeof controller.phone.securityStatus !== 'function' || typeof controller.phone.secretPinEntry !== 'function') {
        throw fixedSecurityError('security_pin_transport_unavailable');
    }
    let result;
    try { result = await controller._step(() => controller.phone.securityStatus()); }
    catch (error) {
        const safe = sanitizeSecurityError(error);
        if (allowTransition && safe.code === 'security_status_unavailable') return { kind: 'transition' };
        throw safe;
    }
    if (!result || !['pinEmpty', 'pinNonEmpty', 'pinUnsupported', 'home', 'other'].includes(result.kind)) {
        throw fixedSecurityError('security_context_invalid');
    }
    if (result.errorCode !== null) {
        if (allowTransition && ['SECURITY_CONTEXT_UNAVAILABLE', 'SECURITY_CONTEXT_UNSUPPORTED',
            'SECURITY_SESSION_CLEANUP'].includes(result.errorCode)) return { kind: 'transition' };
        throw fixedSecurityError('security_context_invalid');
    }
    return result;
}

function requireNoPin(status) {
    if (!['home', 'other'].includes(status.kind)) throw fixedSecurityError('security_pin_pending');
}

async function safeRead(controller, { homeOnly = false, allowTransition = false } = {}) {
    const status = await securityStatus(controller, { allowTransition });
    if (allowTransition && ['transition', 'pinEmpty', 'pinNonEmpty', 'pinUnsupported'].includes(status.kind)) return null;
    requireNoPin(status);
    if (homeOnly && status.kind !== 'home') return null;
    try { return await controller._read(); }
    catch (error) {
        const safe = sanitizeSecurityError(error);
        if (allowTransition && ['security_ui_active', 'invalid_ui', 'blocked_ui', 'phone_locked_or_other_app'].includes(safe.code)) return null;
        throw safe;
    }
}

function observation(controller, screen, appVersion, action, changed, extra = {}) {
    screen.requireVehicle(controller.config.vehicleMarker);
    const vehicleAccess = validateVehicleAccess(screen.vehicleAccess());
    controller._check();
    return { domain: 'vehicleAccess', source: 'volkswagen_android_app', vehicleConfirmed: false,
        appVersion, vehicleAccess, observedAt: new Date(controller.now()).toISOString(),
        changed, requestedAction: action, confirmationSource: 'app_vehicle_access', ...extra };
}

async function waitSheet(controller, expectedLocked) {
    const until = controller.now() + 12000;
    while (true) {
        const screen = await safeRead(controller);
        const sheet = vehicleLockSheet(screen);
        if (sheet) {
            if (sheet.locked !== expectedLocked) throw fixedSecurityError('state_changed');
            return screen;
        }
        if (screen.kind() !== 'overview' || controller.now() >= until) throw fixedSecurityError('lock_ui_unsupported');
        screen.requireVehicle(controller.config.vehicleMarker);
        if (screen.vehicleAccess().locked !== expectedLocked) throw fixedSecurityError('state_changed');
        await controller._pause(Math.min(controller.pollIntervalMs, until - controller.now()));
    }
}

async function waitBlankPin(controller, operation) {
    const until = controller.now() + 12000;
    while (true) {
        const status = await securityStatus(controller);
        if (status.kind === 'pinEmpty' && status.operation === operation && status.token) return status.token;
        if (['pinEmpty', 'pinNonEmpty', 'pinUnsupported'].includes(status.kind)) throw fixedSecurityError('security_context_invalid');
        if (controller.now() >= until) throw fixedSecurityError('security_context_invalid');
        await controller._pause(Math.min(controller.pollIntervalMs, until - controller.now()));
    }
}

async function hideKeyboard(controller) {
    let result;
    try { result = await controller._step(() => controller.phone.hideSecurityKeyboard()); }
    catch (error) {
        const safe = sanitizeSecurityError(error);
        // This is only a keyboard action. Do not repeat it; a complete fresh
        // Home can still prove the already-issued vehicle command succeeded.
        if (['security_keyboard_unavailable', 'security_keyboard_uncertain'].includes(safe.code)) return;
        throw safe;
    }
    if (!result || !['hidden', 'alreadyHidden'].includes(result.kind)
        || result.actionAttempted !== (result.kind === 'hidden')) throw fixedSecurityError('security_keyboard_uncertain');
}

async function confirmHome(controller, desired, appVersion, action, markStage) {
    const until = controller.now() + controller.config.outcomeTimeoutSeconds * 1000;
    let returnedVehicleSheet = false, keyboardHandled = false;
    while (true) {
        // Never dump the PIN page, even after the native entry has returned.
        // A minimal Home classification permits the complete observation; a
        // clean Other classification permits only recognized-sheet recovery.
        markStage('confirmation_status');
        const status = await securityStatus(controller, { allowTransition: true });
        if (status.kind === 'home' || status.kind === 'other') {
            if (!keyboardHandled) {
                keyboardHandled = true;
                markStage('keyboard_hide');
                await hideKeyboard(controller);
                markStage('confirmation_status');
            }
            let screen = await safeRead(controller, { homeOnly: status.kind === 'home', allowTransition: true });
            if (screen) {
                if (screen.kind() === 'overview') {
                    try {
                        markStage('confirmation_home');
                        screen = await normalizeOverview(controller, screen);
                        const result = observation(controller, screen, appVersion, action, true);
                        if (result.vehicleAccess.locked === desired) return result;
                    } catch (error) {
                        const safe = sanitizeSecurityError(error);
                        if (!['unknown_state'].includes(safe.code)) throw safe;
                    }
                } else if (!returnedVehicleSheet) {
                    let sheet;
                    markStage('confirmation_sheet');
                    try { sheet = vehicleLockSheet(screen); }
                    catch (error) {
                        const safe = sanitizeSecurityError(error);
                        if (safe.code !== 'lock_ui_unsupported') throw safe;
                    }
                    if (sheet) {
                        returnedVehicleSheet = true;
                        await controller._step(() => controller.phone.tap(sheet.back.x, sheet.back.y));
                    }
                }
            }
        }
        if (controller.now() >= until) throw fixedSecurityError('outcome_unknown');
        await controller._pause(Math.min(controller.pollIntervalMs, until - controller.now()));
    }
}

async function executeVehicleLock(controller, action, options = {}) {
    if (!['lockVehicle', 'unlockVehicle'].includes(action)) throw fixedSecurityError('invalid_action');
    let dryRun;
    try {
        if (options === null || typeof options !== 'object' || Array.isArray(options)) throw 0;
        const descriptor = Object.getOwnPropertyDescriptor(options, 'dryRun');
        if (descriptor && (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'boolean')) throw 0;
        dryRun = descriptor?.value === true;
    } catch (_) { throw fixedSecurityError('invalid_action'); }
    if (controller.closing) throw fixedSecurityError('cancelled');
    // Reserve synchronously. A rejected concurrent request cannot release the
    // first request's busy flag, deadline or cooperative handoff state.
    if (controller.busy) throw fixedSecurityError('busy');
    controller.busy = true;
    controller.readOnlyExecution = false;
    controller.readHandoffRequested = false;
    controller.readHandoffProtected = false;
    controller.observedTemperature = null;
    controller.observedSettings = { ...DEFAULT_TARGET_SETTINGS };
    controller.deadline = controller.now() + controller.config.commandTimeoutSeconds * 1000;
    controller.phone.deadline = controller.deadline;
    let attempted = false, authReserved = false, stage = 'preflight';
    const markStage = value => { stage = value; };
    const operation = action === 'lockVehicle' ? 'lock' : 'unlock';
    const desired = operation === 'lock';
    try {
        await controller._connect();
        const appVersion = await controller._version();
        // The minimal scanner requires the VW app to be foreground. This
        // existing preserving launch wakes/resumes it and leaves an already
        // visible PIN form or manual draft unchanged.
        await controller._step(() => controller.phone.launch());
        // Protect manually open credentials before shared Home navigation.
        requireNoPin(await securityStatus(controller));
        const overview = await controller._overview();
        const initial = observation(controller, overview, appVersion, action, false);
        if (initial.vehicleAccess.locked === desired) return { ...initial, alreadyInState: true };
        if (typeof initial.vehicleAccess.locked !== 'boolean') throw fixedSecurityError('unknown_state');
        if (dryRun) return { ...initial, dryRun: true, wouldRequest: operation };
        if (controller.config.allowVehicleLocking !== true) throw fixedSecurityError('vehicle_locking_disabled');
        if ((await controller._step(() => readSecurityAuth(controller.store))).blocked) throw fixedSecurityError('security_auth_blocked');
        if (typeof controller.phone.hideSecurityKeyboard !== 'function') throw fixedSecurityError('security_keyboard_unavailable');
        const getSecurityPin = pinGetter(controller);
        getSecurityPin(); // Validate without retaining the credential before any authentication CTA.

        await controller._version();
        const freshHome = await safeRead(controller);
        freshHome.requireVehicle(controller.config.vehicleMarker);
        const navigation = vehicleLockNavigationTarget(freshHome, !desired);
        await controller._step(() => controller.phone.tap(navigation.x, navigation.y));
        let sheet = await waitSheet(controller, !desired);
        vehicleLockActionTarget(sheet, operation); // Whole supported surface before persistence.
        await controller._version();
        sheet = await safeRead(controller);
        vehicleLockActionTarget(sheet, operation);
        // The common cooldown and the persistent authentication latch are both
        // committed before the first potentially dispatching gesture. A crash
        // can leave a conservative block, never a replay on startup/polling.
        await controller._step(() => controller.store.reserveCommand(controller.config.cooldownSeconds));
        await controller._step(() => blockSecurityAuth(controller.store, 'attempt_pending', controller.now()));
        authReserved = true;
        await controller._version();
        sheet = await safeRead(controller);
        const target = vehicleLockActionTarget(sheet, operation);
        controller._check();
        attempted = true;
        markStage('cta');
        await controller._step(() => controller.phone.tap(target.x, target.y));
        markStage('pin_context');
        const token = await waitBlankPin(controller, operation);
        await controller._version();
        // No public options or data structures ever contain the S-PIN. The
        // opaque token is one-use and transport revalidates the blank form.
        markStage('pin_entry');
        const ack = await controller._step(() => controller.phone.secretPinEntry(token, { operation }, getSecurityPin));
        if (!ack || ack.beforeMatched !== true || ack.actionAttempted !== true || ack.actionAccepted !== true || ack.errorCode !== null) {
            throw fixedSecurityError('security_entry_uncertain');
        }
        const result = await confirmHome(controller, desired, appVersion, action, markStage);
        markStage('auth_clear');
        await controller._step(() => clearSecurityAuth(controller.store));
        authReserved = false;
        return result;
    } catch (error) {
        const safe = sanitizeSecurityError(error);
        if (authReserved) {
            const reason = safe.code === 'security_pin_rejected' ? 'pin_rejected'
                : safe.code === 'security_pin_locked' ? 'pin_locked' : 'outcome_unknown';
            // The earlier persisted block survives even if this update fails.
            try { await blockSecurityAuth(controller.store, reason, controller.now()); }
            catch (_) { /* Already blocked before any credential was entered. */ }
        }
        const cause = securityErrorDiagnostic(safe)?.cause || safe.code;
        if (attempted && !['security_pin_rejected', 'security_pin_locked'].includes(safe.code)) {
            throw withSecurityDiagnostic(fixedSecurityError('outcome_unknown'), stage, cause);
        }
        throw withSecurityDiagnostic(safe, stage, cause);
    } finally {
        controller.phone.deadline = null;
        controller.deadline = null;
        controller.busy = false;
        controller.readOnlyExecution = false;
        controller.readHandoffRequested = false;
        controller.readHandoffProtected = false;
    }
}

module.exports = { registerSecurityPinGetter, executeVehicleLock };
