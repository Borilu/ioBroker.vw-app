'use strict';
const { BridgeError } = require('./errors');
const { Screen } = require('./ui');
const { DEFAULT_TARGET_SETTINGS } = require('./settings');
const { CHARGING_KEYS, DEFAULT_TARGET_CHARGING, validateTargetCharging, MIN_TARGET_SOC, MAX_TARGET_SOC } = require('./charging');
const { chargingSliderGeometry } = require('./native-ui');

async function normalizeOverview(controller, screen) {
    for (let attempt = 0; attempt < 3; attempt++) {
        if (screen.kind() !== 'overview') throw new BridgeError('unexpected_screen', 'Die Fahrzeugübersicht fehlt.');
        screen.requireVehicle(controller.config.vehicleMarker);
        if (!screen.overviewNeedsTop()) return screen;
        if (typeof controller.phone.departureView !== 'function' || typeof controller.phone.departureAction !== 'function') {
            throw new BridgeError('charging_navigation_unavailable', 'Die sichere Rückkehr zum Anfang der Fahrzeugübersicht ist nicht verfügbar.');
        }
        await controller._version();
        const view = await controller._step(() => controller.phone.departureView());
        const fresh = new Screen(view?.xml);
        fresh.checkClear();
        if (fresh.kind() !== 'overview') throw new BridgeError('unexpected_screen', 'Die Fahrzeugübersicht wurde beim Ausrichten verlassen.');
        fresh.requireVehicle(controller.config.vehicleMarker);
        if (!fresh.overviewNeedsTop()) return fresh;
        const context = fresh.overviewNativeScrollContext();
        // Accessibility scrolling acts on this exact native scroll container.
        // A physical drag towards the top could pull-to-refresh after reaching
        // it, so there is deliberately no touch-gesture fallback here.
        const result = await controller._step(() => controller.phone.departureAction({
            snapshot: view.observation, ...context, action: 'scrollBackward',
        }));
        if (!result || result.beforeMatched !== true || result.actionAttempted !== true
            || result.actionAccepted !== true || result.success !== true || result.errorCode !== null || !result.postRead?.xml) {
            throw new BridgeError('charging_navigation_unavailable', 'Das sichere Ausrichten der Fahrzeugübersicht wurde nicht bestätigt.');
        }
        screen = new Screen(result.postRead.xml);
        screen.checkClear();
    }
    if (screen.overviewNeedsTop()) throw new BridgeError('charging_navigation_unavailable', 'Die Fahrzeugkacheln sind nicht sicher sichtbar.');
    screen.requireVehicle(controller.config.vehicleMarker);
    return screen;
}

class ChargingFlow {
    constructor(controller, version) {
        this.c = controller; this.version = version;
        this.battery = { soc: null, rangeKm: null };
        this.charging = { ...DEFAULT_TARGET_CHARGING };
        this.batteryAt = null;
        this.vehicleName = null;
        this.expected = null;
        this.draftStarted = false;
        this.draftTapPending = false;
        this.saveIssued = false; this.saveVerified = false;
        this.syncPending = false; this.syncRequestedAt = null;
    }
    changed() { return new BridgeError('charging_state_changed', 'Die Ladeeinstellungen oder der Fahrzeugname haben sich während des Auftrags geändert.'); }
    async openSettings(overview) {
        let screen = overview;
        for (let attempt = 0; attempt < 4; attempt++) {
            if (screen.kind() !== 'overview') throw new BridgeError('unexpected_screen', 'Die bestätigte Fahrzeugübersicht wurde verlassen.');
            screen.requireVehicle(this.c.config.vehicleMarker);
            let target;
            try { target = screen.chargingNavigationTarget('vehicleSettings'); }
            catch (error) {
                if (!(error instanceof BridgeError) || error.code !== 'target_unavailable' || attempt === 3) throw error;
                const gesture = screen.overviewScrollTarget('down');
                await this.c._step(() => this.c.phone.swipe(gesture));
                screen = await this.c._waitKind('overview');
                continue;
            }
            await this.c._step(() => this.c.phone.tap(target.x, target.y));
            screen = await this.c._waitKind('vehicleSettings');
            if (screen.hasPendingChargingSettings() !== false) throw new BridgeError('unsaved_settings', 'Offene Änderungen zuerst direkt in der VW-App speichern oder verwerfen.');
            for (let top = 0; top < 3 && screen.chargingNeedsTop(); top++) {
                const gesture = screen.chargingSettingsScrollTarget('up');
                await this.c._step(() => this.c.phone.swipe(gesture));
                screen = await this.c._waitKind('vehicleSettings');
                if (screen.hasPendingChargingSettings() !== false) throw new BridgeError('unsaved_settings', 'Offene Änderungen zuerst am Handy prüfen.');
            }
            if (screen.chargingNeedsTop()) throw new BridgeError('charging_navigation_unavailable', 'Die Ladeeinstellungen sind nicht vollständig sichtbar.');
            return screen;
        }
        throw new BridgeError('charging_navigation_unavailable', 'Die Ladeeinstellungen wurden nicht gefunden.');
    }
    values(screen, { compare = false, allowKey = null, wanted = undefined } = {}) {
        if (screen.kind() !== 'vehicleSettings' || screen.chargingNeedsTop()) throw this.changed();
        const name = screen.chargingVehicleName();
        if (typeof name !== 'string' || !name.trim() || name.length > 256) throw this.changed();
        if (this.vehicleName === null) this.vehicleName = name;
        else if (name !== this.vehicleName) throw this.changed();
        const values = screen.chargingValues();
        if (!values) throw new BridgeError('charging_unavailable', 'Die Ladeeinstellungen sind nicht eindeutig lesbar.');
        if (compare && this.expected) for (const key of CHARGING_KEYS) {
            if (values[key] !== this.expected[key] && !(key === allowKey && values[key] === wanted)) throw this.changed();
        }
        this.charging = { ...values };
        return values;
    }
    async closeSettings(screen) {
        if (screen.kind() !== 'vehicleSettings' || screen.hasPendingChargingSettings() !== false) {
            throw new BridgeError('unsaved_settings', 'Eine nicht gespeicherte Ladeauswahl ist in der App offen.');
        }
        const target = screen.chargingNavigationTarget('back');
        await this.c._step(() => this.c.phone.tap(target.x, target.y));
        const overview = await this.c._waitKind('overview');
        overview.requireVehicle(this.c.config.vehicleMarker);
        return overview;
    }
    async batteryRead(overview) {
        const screen = await normalizeOverview(this.c, overview);
        const overviewValues = screen.batteryValues(); // Reject contradictory overview evidence before navigation.
        const target = screen.chargingNavigationTarget('range');
        await this.c._step(() => this.c.phone.tap(target.x, target.y));
        const range = await this.c._waitKind('range');
        const values = range.batteryValues();
        if (!values) throw new BridgeError('battery_unavailable', 'Die Batterieanzeige ist nicht eindeutig lesbar.');
        this.battery = { soc: values.soc, rangeKm: values.rangeKm ?? overviewValues?.rangeKm ?? null }; this.batteryAt = this.c.now();
        const close = range.chargingNavigationTarget('back');
        await this.c._step(() => this.c.phone.tap(close.x, close.y));
        const returned = await this.c._waitKind('overview');
        returned.requireVehicle(this.c.config.vehicleMarker);
    }
    async setValue(screen, key, wanted) {
        await this.c._version();
        screen = await this.c._read();
        if (!this.draftStarted && screen.hasPendingChargingSettings() !== false) throw new BridgeError('unsaved_settings', 'Offene Änderungen zuerst direkt in der VW-App speichern oder verwerfen.');
        const before = this.values(screen, { compare: true, allowKey: key, wanted });
        if (before[key] === wanted) { this.expected = { ...before }; return screen; }
        let target;
        if (key === 'socLimit') {
            const context = screen.chargingSliderContext();
            const native = await this.c._step(() => this.c.phone.nativeView());
            const { bounds } = chargingSliderGeometry(native, context);
            // This verified GradientSlider exposes six discrete settings. The
            // rectangle is re-read, never stored; the selected text is checked.
            const fraction = (wanted - MIN_TARGET_SOC) / (MAX_TARGET_SOC - MIN_TARGET_SOC);
            target = { x: Math.max(bounds[0] + 1, Math.min(bounds[2] - 1, Math.round(bounds[0] + (bounds[2] - bounds[0]) * fraction))),
                y: bounds[1] + Math.floor((bounds[3] - bounds[1]) / 2) };
            const fresh = await this.c._read();
            this.values(fresh, { compare: true });
            const freshContext = fresh.chargingSliderContext();
            if (JSON.stringify(freshContext) !== JSON.stringify(context)) throw this.changed();
        } else target = screen.chargingToggleTarget(key, wanted);
        this.draftStarted = true;
        this.draftTapPending = true;
        await this.c._step(() => this.c.phone.tap(target.x, target.y));
        const until = this.c.now() + 8000;
        while (true) {
            screen = await this.c._read();
            const observed = this.values(screen, { compare: true, allowKey: key, wanted });
            this.draftTapPending = false;
            if (observed[key] === wanted) { this.expected = { ...observed }; return screen; }
            if (this.c.now() >= until) throw new BridgeError('charging_setting_not_confirmed', 'Die gewählte Ladeeinstellung wurde nicht bestätigt; es wird nicht gespeichert.');
            await this.c._pause(Math.min(this.c.pollIntervalMs, until - this.c.now()));
        }
    }
    async save(screen) {
        await this.c._version();
        screen = await this.c._read();
        this.values(screen, { compare: true });
        if (screen.hasPendingChargingSettings() === false) return screen;
        if (!this.draftStarted) throw new BridgeError('unsaved_settings', 'Offene Änderungen zuerst direkt in der VW-App speichern oder verwerfen.');
        const target = screen.chargingSaveTarget();
        this.saveIssued = true;
        await this.c._step(() => this.c.phone.tap(target.x, target.y));
        const until = this.c.now() + 60000;
        while (true) {
            screen = await this.c._read();
            if (screen.kind() === 'overview') {
                screen.requireVehicle(this.c.config.vehicleMarker);
                return screen;
            }
            if (screen.kind() === 'vehicleSettings' && screen.hasPendingChargingSettings() === false) return screen;
            if (!['vehicleSettings', 'unknown'].includes(screen.kind()) || this.c.now() >= until) {
                throw new BridgeError('charging_save_not_confirmed', 'Das Speichern der Ladeeinstellungen wurde nicht bestätigt.');
            }
            await this.c._pause(Math.min(this.c.pollIntervalMs, until - this.c.now()));
        }
    }
    async sync(screen) {
        for (let attempt = 0; attempt < 4; attempt++) {
            if (screen.kind() !== 'vehicleSettings' || screen.hasPendingChargingSettings() !== false) throw new BridgeError('unsaved_settings', 'Offene Fahrzeug-Einstellungen zuerst am Handy prüfen.');
            const state = screen.chargingSyncState();
            if (state === 'busy') throw new BridgeError('sync_busy', 'Die App synchronisiert bereits; zuerst die laufende Anfrage abwarten.');
            if (state === 'ready') {
                await this.c._version();
                screen = await this.c._read();
                if (screen.kind() !== 'vehicleSettings' || screen.hasPendingChargingSettings() !== false || screen.chargingSyncState() !== 'ready') throw this.changed();
                const target = screen.chargingNavigationTarget('synchronize');
                this.syncPending = true;
                await this.c._step(() => this.c.phone.tap(target.x, target.y));
                const until = this.c.now() + 8000;
                while (true) {
                    screen = await this.c._read();
                    if (screen.kind() !== 'vehicleSettings' || screen.hasPendingChargingSettings() !== false) throw this.changed();
                    if (screen.chargingSyncState() === 'busy') {
                        this.syncPending = false; this.syncRequestedAt = new Date(this.c.now()).toISOString(); return screen;
                    }
                    if (this.c.now() >= until) throw new BridgeError('sync_not_confirmed', 'Die App hat die Synchronisationsanfrage nicht eindeutig bestätigt.');
                    await this.c._pause(Math.min(this.c.pollIntervalMs, until - this.c.now()));
                }
            }
            if (attempt === 3) break;
            const gesture = screen.chargingSettingsScrollTarget('down');
            await this.c._step(() => this.c.phone.swipe(gesture));
            screen = await this.c._waitKind('vehicleSettings');
        }
        throw new BridgeError('sync_unavailable', 'Der bestätigte Synchronisierungslink wurde nicht gefunden.');
    }
    async run(action, target, dryRun) {
        let overview = await this.c._overview();
        let screen = await this.openSettings(overview);
        const before = this.values(screen); this.expected = { ...before };
        let changed = false;
        if (action === 'applyChargingSettings') {
            const differs = CHARGING_KEYS.some(key => target[key] !== null && target[key] !== before[key]);
            if (differs) {
                if (!dryRun && !this.c.config.allowWrites) throw new BridgeError('writes_disabled', 'Änderungen der Fahrzeugeinstellungen sind deaktiviert.');
                // Preflight all requested controls before the first draft edit.
                for (const key of CHARGING_KEYS) if (target[key] !== null && target[key] !== before[key]) {
                    if (key === 'socLimit') chargingSliderGeometry(await this.c._step(() => this.c.phone.nativeView()), screen.chargingSliderContext());
                    else screen.chargingToggleTarget(key, target[key]);
                }
                if (!dryRun) {
                    for (const key of CHARGING_KEYS) if (target[key] !== null && target[key] !== this.expected[key]) screen = await this.setValue(screen, key, target[key]);
                    screen = await this.save(screen);
                    overview = screen.kind() === 'overview' ? screen : await this.closeSettings(screen);
                    screen = await this.openSettings(overview);
                    const confirmed = this.values(screen, { compare: true });
                    for (const key of CHARGING_KEYS) if (target[key] !== null && confirmed[key] !== target[key]) throw new BridgeError('charging_setting_not_confirmed', 'Die gespeicherten Ladewerte stimmen nicht mit der Auswahl überein.');
                    this.saveVerified = true; changed = true;
                }
            }
        }
        if (action === 'synchronize' && !dryRun) screen = await this.sync(screen);
        overview = await this.closeSettings(screen);
        await this.batteryRead(overview);
        this.c._check();
        return { domain: 'charging', source: 'volkswagen_android_app', vehicleConfirmed: false, appVersion: this.version,
            observedAt: new Date(this.batteryAt).toISOString(), battery: { ...this.battery }, charging: { ...this.charging }, changed,
            ...(this.syncRequestedAt ? { syncRequestedAt: this.syncRequestedAt, syncRequested: true } : {}),
            ...(dryRun ? { dryRun: true, wouldSetCharging: { ...target } } : {}) };
    }
}

async function executeCharging(controller, action, { targetCharging = {}, dryRun = false } = {}) {
    if (!['chargingStatus', 'applyChargingSettings', 'synchronize'].includes(action)) throw new BridgeError('invalid_action', 'Unbekannter Ladeauftrag.');
    const target = validateTargetCharging(targetCharging);
    if (action === 'applyChargingSettings' && Object.values(target).every(value => value === null)) throw new BridgeError('charging_settings_required', 'Zuerst mindestens eine Ladeeinstellung auswählen.');
    if (controller.closing) throw new BridgeError('cancelled', 'Der Adapter wird beendet.');
    if (controller.busy) throw new BridgeError('busy', 'Ein anderer Auftrag läuft bereits.');
    controller.busy = true;
    controller.observedTemperature = null; controller.observedSettings = { ...DEFAULT_TARGET_SETTINGS };
    controller.deadline = controller.now() + controller.config.commandTimeoutSeconds * 1000;
    controller.phone.deadline = controller.deadline;
    let flow;
    try {
        await controller._connect();
        const version = await controller._version();
        flow = new ChargingFlow(controller, version);
        return await flow.run(action, target, dryRun);
    } catch (error) {
        if (flow?.syncPending) throw new BridgeError('sync_outcome_unknown', 'Synchronisationsanfrage gesendet, App-Rückmeldung unklar. Nicht automatisch wiederholen.');
        if (flow?.saveIssued && !flow.saveVerified || flow?.draftTapPending) throw new BridgeError('charging_outcome_unknown', 'Eine Ladeänderung wurde begonnen, die Rückmeldung ist unklar. Vor weiteren Änderungen die VW-App prüfen.');
        if (error instanceof BridgeError) throw error;
        throw new BridgeError('internal_error', 'Der Ladeauftrag konnte nicht sicher ausgeführt werden.');
    } finally {
        controller.phone.deadline = null; controller.deadline = null; controller.busy = false;
    }
}
module.exports = { executeCharging, normalizeOverview };
