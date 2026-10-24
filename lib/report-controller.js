'use strict';

const { BridgeError } = require('./errors');
const { DEFAULT_TARGET_SETTINGS } = require('./settings');
const { mergeReportPages, compatibleSynchronizationText } = require('./vehicle-report');

const positionShape = page => ({ ...page, synchronizationText: null });
async function waitReportMove(controller, previous) {
    const until = controller.now() + 5000;
    while (true) {
        const screen = await controller._read();
        if (screen.kind() !== 'vehicleReport') throw new BridgeError('unexpected_screen', 'Der Fahrzeugzustandsbericht wurde beim Scrollen verlassen.');
        const page = screen.reportPage();
        if (!compatibleSynchronizationText(previous.synchronizationText, page.synchronizationText)) throw new BridgeError('report_changed', 'Der Synchronisationshinweis hat sich während des Auslesens geändert.');
        if (JSON.stringify(positionShape(page)) !== JSON.stringify(positionShape(previous))) return { screen, page };
        if (controller.now() >= until) throw new BridgeError('report_incomplete', 'Der Fahrzeugzustandsbericht hat sich nach dem Scrollen nicht vollständig aktualisiert.');
        await controller._pause(Math.min(controller.pollIntervalMs, until - controller.now()));
    }
}

async function openReport(controller) {
    let overview = await controller._overview();
    for (let attempt = 0; attempt < 4; attempt++) {
        await controller._version();
        overview = await controller._read();
        if (overview.kind() !== 'overview') throw new BridgeError('unexpected_screen', 'Die Fahrzeugübersicht wurde verlassen.');
        overview.requireVehicle(controller.config.vehicleMarker);
        let target;
        try { target = overview.reportNavigationTarget('open'); }
        catch (error) {
            if (!(error instanceof BridgeError) || error.code !== 'target_unavailable' || attempt === 3) throw error;
            await controller._step(() => controller.phone.swipe(overview.overviewScrollTarget('down')));
            await controller._waitKind('overview');
            continue;
        }
        await controller._step(() => controller.phone.tap(target.x, target.y));
        return controller._waitKind('vehicleReport');
    }
    throw new BridgeError('report_unavailable', 'Der Fahrzeugzustandsbericht wurde nicht gefunden.');
}

async function readReport(controller, screen) {
    let page = screen.reportPage();
    // Reopening a read-only report can retain a previous scroll position.
    // Normalize using the report's own scroller, without a pull-to-refresh.
    for (let attempt = 0; attempt < 4 && !page.atTop; attempt++) {
        await controller._version();
        screen = await controller._read();
        if (screen.kind() !== 'vehicleReport') throw new BridgeError('unexpected_screen', 'Der Fahrzeugzustandsbericht wurde verlassen.');
        const current = screen.reportPage();
        if (current.atTop) { page = current; break; }
        await controller._step(() => controller.phone.swipe(screen.reportScrollTarget('up')));
        ({ screen, page } = await waitReportMove(controller, current));
    }
    if (!page.atTop) throw new BridgeError('report_incomplete', 'Der Anfang des Fahrzeugzustandsberichts ist nicht vollständig lesbar.');
    const pages = [page];
    for (let attempt = 0; attempt < 7 && !page.atBottom; attempt++) {
        await controller._version();
        screen = await controller._read();
        if (screen.kind() !== 'vehicleReport') throw new BridgeError('unexpected_screen', 'Der Fahrzeugzustandsbericht wurde verlassen.');
        const current = screen.reportPage();
        // Include a fresh page before navigation so conflicting readings cannot
        // be hidden by a later overlapping page.
        pages[pages.length - 1] = mergeSamePosition(page, current);
        if (current.atBottom) { page = current; break; }
        await controller._step(() => controller.phone.swipe(screen.reportScrollTarget('down')));
        const moved = await waitReportMove(controller, current);
        screen = moved.screen;
        const next = moved.page;
        pages.push(next); page = next;
    }
    if (!page.atBottom) throw new BridgeError('report_incomplete', 'Der Fahrzeugzustandsbericht ist nicht vollständig lesbar.');
    await controller._version();
    screen = await controller._read();
    if (screen.kind() !== 'vehicleReport') throw new BridgeError('unexpected_screen', 'Der Fahrzeugzustandsbericht wurde vor der Rückkehr verlassen.');
    pages[pages.length - 1] = mergeSamePosition(page, screen.reportPage());
    const vehicleReport = mergeReportPages(pages);
    const observedAt = new Date(controller.now()).toISOString();
    const back = screen.reportNavigationTarget('back');
    await controller._step(() => controller.phone.tap(back.x, back.y));
    const returned = await controller._waitKind('overview');
    returned.requireVehicle(controller.config.vehicleMarker);
    return { vehicleReport, observedAt };
}

function mergeSamePosition(previous, current) {
    // Relative synchronization text may advance naturally during a read.
    if (JSON.stringify(positionShape(previous)) !== JSON.stringify(positionShape(current))
        || !compatibleSynchronizationText(previous.synchronizationText, current.synchronizationText)) {
        throw new BridgeError('report_changed', 'Der angezeigte Fahrzeugzustandsbericht hat sich während des Auslesens geändert.');
    }
    return current;
}

async function executeVehicleReport(controller) {
    if (controller.closing) throw new BridgeError('cancelled', 'Der Adapter wird beendet.');
    if (controller.busy) throw new BridgeError('busy', 'Ein anderer Auftrag läuft bereits.');
    controller.busy = true;
    controller.observedTemperature = null; controller.observedSettings = { ...DEFAULT_TARGET_SETTINGS };
    controller.deadline = controller.now() + controller.config.commandTimeoutSeconds * 1000;
    controller.phone.deadline = controller.deadline;
    try {
        await controller._step(() => controller.phone.connect());
        const appVersion = await controller._version();
        const result = await readReport(controller, await openReport(controller));
        controller._check();
        return { domain: 'vehicleReport', source: 'volkswagen_android_app', vehicleConfirmed: false, appVersion, ...result };
    } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError('internal_error', 'Der Fahrzeugzustandsbericht konnte nicht sicher gelesen werden.');
    } finally {
        controller.phone.deadline = null; controller.deadline = null; controller.busy = false;
    }
}

module.exports = { executeVehicleReport };
