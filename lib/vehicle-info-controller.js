'use strict';

const { BridgeError } = require('./errors');
const { DEFAULT_TARGET_SETTINGS } = require('./settings');
const { validateVehicleInfo } = require('./vehicle-info');
const { Screen } = require('./ui');
const { extendedViewToXml } = require('./accessibility-view');
const vehicleInfoUi = require('./vehicle-info-ui');

const SAFE_CODES = new Set(['cancelled', 'busy', 'phone_timeout', 'wifi_unavailable', 'wifi_wrong_device',
    'wifi_identity_required', 'wifi_identity_unavailable', 'runtime_missing', 'adb_missing', 'app_missing',
    'phone_locked_or_other_app', 'phone_setting_failed', 'security_ui_active', 'blocked_ui', 'invalid_ui',
    'version_not_approved', 'wrong_vehicle', 'unexpected_screen', 'unknown_state', 'ambiguous_ui',
    'target_unavailable', 'charging_navigation_unavailable', 'unsaved_settings', 'departure_editor_open', 'invalid_vehicle_info',
    'vehicle_info_unavailable', 'vehicle_info_changed', 'extended_ui_unavailable', 'android_payload_invalid']);

function fixedFailure(error) {
    let code = 'vehicle_info_unavailable';
    try {
        const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
        if (descriptor && Object.hasOwn(descriptor, 'value') && SAFE_CODES.has(descriptor.value)) code = descriptor.value;
    } catch (_) { /* A foreign error cannot expose a getter or an identifier. */ }
    const message = code === 'cancelled' ? 'Die FIN-Abfrage wurde abgebrochen; keine weiteren App-Eingaben.'
        : code === 'phone_timeout' ? 'Das Zeitlimit der FIN-Abfrage wurde erreicht; keine weiteren App-Eingaben.'
            : 'Die FIN konnte nicht sicher aus der Fahrzeugverwaltung gelesen werden. App, Fahrzeugauswahl und Verbindung prüfen.';
    return new BridgeError(code, message);
}

async function readVehicleInfoScreen(controller) {
    try {
        if (typeof controller.phone.departureView !== 'function') throw new BridgeError('extended_ui_unavailable', '');
        const view = await controller._step(() => controller.phone.departureView());
        const descriptor = Object.getOwnPropertyDescriptor(view, 'observation');
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new BridgeError('extended_ui_unavailable', '');
        // Rebuild from the validated native observation, never a cached standard
        // dump or an independently supplied xml field. There is no fallback.
        const screen = new Screen(extendedViewToXml(JSON.stringify(descriptor.value)));
        screen.checkClear();
        if (screen.nodes.some(node => node.attrs.password === 'true'
            || [node.attrs.text, node.attrs['content-desc']].some(value => typeof value === 'string' && value.includes('S-PIN eingeben')))) {
            throw new BridgeError('security_ui_active', '');
        }
        controller._check();
        return screen;
    } catch (error) { throw fixedFailure(error); }
}

async function waitNativeKind(controller, expected) {
    const until = controller.now() + (expected === 'overview' ? 8000 : 20000);
    while (true) {
        const screen = await module.exports.readVehicleInfoScreen(controller);
        if (screen.kind() === expected) return screen;
        if (controller.now() >= until) throw new BridgeError('unexpected_screen', '');
        await controller._pause(Math.min(controller.pollIntervalMs, until - controller.now()));
    }
}

async function returnFromVehicleInfo(controller) {
    const previousProtection = controller.readHandoffProtected;
    if (controller.readOnlyExecution) controller.readHandoffProtected = true;
    let overview;
    try {
        // Inspect a fresh view, including its version, before a single return
        // gesture. Unknown forms, overlays and vehicle editing are never closed.
        await controller._version();
        const screen = await module.exports.readVehicleInfoScreen(controller);
        if (screen.kind() === 'overview') {
            screen.requireVehicle(controller.config.vehicleMarker);
            overview = screen;
        } else {
            if (screen.kind() !== 'vehicleInfo' || !vehicleInfoUi.vehicleInfoPage(screen)) {
                throw new BridgeError('unexpected_screen', 'Die lesbare Fahrzeugverwaltung ist nicht mehr sichtbar.');
            }
            const target = vehicleInfoUi.vehicleInfoBackTarget(screen);
            await controller._step(() => controller.phone.tap(target.x, target.y));
            overview = await waitNativeKind(controller, 'overview');
            overview.requireVehicle(controller.config.vehicleMarker);
        }
    } catch (error) {
        throw fixedFailure(error);
    } finally {
        controller.readHandoffProtected = previousProtection;
    }
    controller._check();
    return overview;
}

async function executeVehicleInfo(controller) {
    if (controller.closing) throw fixedFailure(new BridgeError('cancelled', ''));
    if (controller.busy) throw fixedFailure(new BridgeError('busy', ''));
    // Reserve synchronously. A read does not consult any wishes, journal or PIN.
    controller.busy = true;
    controller.observedTemperature = null;
    controller.observedSettings = { ...DEFAULT_TARGET_SETTINGS };
    controller.deadline = controller.now() + controller.config.commandTimeoutSeconds * 1000;
    controller.phone.deadline = controller.deadline;
    const previousProtection = controller.readHandoffProtected;
    const previousNativeRead = controller.readVehicleInfoNative;
    controller.readVehicleInfoNative = true;
    let mayReturnAfterFailure = false;
    try {
        await controller._connect();
        const appVersion = await controller._version();
        await controller._overview();
        await controller._version();
        const overview = await controller._read();
        if (overview.kind() !== 'overview') throw new BridgeError('unexpected_screen', 'Die Fahrzeugübersicht wurde verlassen.');
        overview.requireVehicle(controller.config.vehicleMarker);
        const entry = vehicleInfoUi.vehicleInfoEntryTarget(overview);

        // A manual command may take over only after this inspected read-only
        // child has returned to Home. Shutdown and operation deadlines still win.
        controller.readHandoffProtected = true;
        mayReturnAfterFailure = true;
        await controller._step(() => controller.phone.tap(entry.x, entry.y));
        const initial = await waitNativeKind(controller, 'vehicleInfo');
        if (!vehicleInfoUi.vehicleInfoPage(initial)) throw new BridgeError('vehicle_info_unavailable', '');
        const first = validateVehicleInfo(vehicleInfoUi.readVehicleInfo(initial, controller.config.vehicleMarker));

        await controller._version();
        const fresh = await controller._read();
        if (fresh.kind() !== 'vehicleInfo' || !vehicleInfoUi.vehicleInfoPage(fresh)) throw new BridgeError('unexpected_screen', '');
        const vehicleInfo = validateVehicleInfo(vehicleInfoUi.readVehicleInfo(fresh, controller.config.vehicleMarker));
        if (vehicleInfo.vin !== first.vin) throw new BridgeError('vehicle_info_changed', '');
        const observedAt = new Date(controller.now()).toISOString();

        // Never retry a failed return gesture. Cleanup below is only for an
        // earlier parse/read failure, and always inspects the current view anew.
        mayReturnAfterFailure = false;
        await returnFromVehicleInfo(controller);
        await controller._version();
        controller.readHandoffProtected = previousProtection;
        controller.readVehicleInfoNative = previousNativeRead;
        controller._check();
        return { domain: 'vehicleInfo', source: 'volkswagen_android_app', vehicleConfirmed: false,
            appVersion, vehicleInfo, observedAt };
    } catch (error) {
        if (mayReturnAfterFailure) {
            try { await returnFromVehicleInfo(controller); }
            catch (_) { /* Do not guess through an unknown view or exceed a deadline. */ }
        }
        throw fixedFailure(error);
    } finally {
        controller.readHandoffProtected = previousProtection;
        controller.readVehicleInfoNative = previousNativeRead;
        controller.phone.deadline = null;
        controller.deadline = null;
        controller.busy = false;
    }
}

module.exports = { executeVehicleInfo, returnFromVehicleInfo, readVehicleInfoScreen };
