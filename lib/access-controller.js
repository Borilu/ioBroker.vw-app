'use strict';

const { BridgeError } = require('./errors');
const { DEFAULT_TARGET_SETTINGS } = require('./settings');
const { validateVehicleAccess } = require('./vehicle-access');

async function executeVehicleAccess(controller) {
    if (controller.closing) throw new BridgeError('cancelled', 'Der Adapter wird beendet.');
    if (controller.busy) throw new BridgeError('busy', 'Ein anderer Auftrag läuft bereits.');
    // Reserve before the first asynchronous operation. No write permission,
    // staged wishes or vehicle-command journal is consulted for this read.
    controller.busy = true;
    controller.observedTemperature = null;
    controller.observedSettings = { ...DEFAULT_TARGET_SETTINGS };
    controller.deadline = controller.now() + controller.config.commandTimeoutSeconds * 1000;
    controller.phone.deadline = controller.deadline;
    try {
        await controller._connect();
        const appVersion = await controller._version();
        // The shared navigation preserves manual drafts and checks the enrolled
        // vehicle. It normalizes a scrolled Home without pulling to synchronize.
        const overview = await controller._overview();
        overview.requireVehicle(controller.config.vehicleMarker);
        const vehicleAccess = validateVehicleAccess(overview.vehicleAccess());
        controller._check();
        return {
            domain: 'vehicleAccess', source: 'volkswagen_android_app',
            vehicleConfirmed: false, appVersion, vehicleAccess,
            observedAt: new Date(controller.now()).toISOString(),
        };
    } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError('internal_error', 'Die Zustände von Türen, Fenstern und Verriegelung konnten nicht sicher gelesen werden.');
    } finally {
        controller.phone.deadline = null;
        controller.deadline = null;
        controller.busy = false;
    }
}

module.exports = { executeVehicleAccess };
