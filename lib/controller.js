'use strict';

const { Screen } = require('./ui');
const { BridgeError } = require('./errors');
const { validateTargetTemperature, TEMPERATURE_STEP_CELSIUS } = require('./temperature');
const { validateTargetSettings, DEFAULT_TARGET_SETTINGS } = require('./settings');
const { executeCharging, normalizeOverview } = require('./charging-controller');
const { executeVehicleReport } = require('./report-controller');
const { executeVehicleAccess } = require('./access-controller');
const { executeDepartures, returnFromDeparturePage } = require('./departures-controller');

class Controller {
    constructor({ config, phone, store, pollIntervalMs = 400, now = () => Date.now(),
        sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
        this.config = config;
        this.phone = phone;
        this.store = store;
        this.pollIntervalMs = Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 400;
        this.now = now;
        this.sleep = sleep;
        this.busy = false;
        this.closing = false;
        this.deadline = null;
        this.readOnlyExecution = false;
        this.readHandoffRequested = false;
        this.readHandoffProtected = false;
    }

    cancel() {
        this.closing = true;
    }

    requestReadHandoff() {
        if (!this.busy || this.closing || !this.readOnlyExecution) return false;
        this.readHandoffRequested = true;
        return true;
    }

    async _executeReadOnly(operation) {
        // A competing rejected call must never clear the active job's flags.
        if (this.busy || this.closing) return operation();
        this.readOnlyExecution = true;
        this.readHandoffRequested = false;
        try { return await operation(); }
        finally {
            this.readOnlyExecution = false;
            this.readHandoffRequested = false;
            this.readHandoffProtected = false;
        }
    }

    _check() {
        if (this.closing) throw new BridgeError('cancelled', 'Der Adapter wird beendet; keine weiteren Eingaben.');
        if (this.deadline !== null && this.now() >= this.deadline) {
            throw new BridgeError('phone_timeout', 'Zeitlimit erreicht; keine automatische Wiederholung.');
        }
        if (this.readHandoffRequested && !this.readHandoffProtected) {
            throw new BridgeError('cancelled', 'Die automatische Leseabfrage übergibt das Handy an einen Bedienauftrag.');
        }
    }

    async _step(operation) {
        this._check();
        const result = await operation();
        this._check();
        return result;
    }

    async _connect() {
        await this._step(() => this.phone.connect());
        if (this.config.stayAwakeOnCharge) {
            const result = await this._step(() => this.phone.keepAwake());
            if (!result?.active) throw new BridgeError('phone_setting_failed', 'Das Wachhalten am Ladekabel wurde nicht bestätigt.');
        }
    }

    async _pause(milliseconds = this.pollIntervalMs) {
        this._check();
        const remaining = this.deadline === null ? milliseconds : this.deadline - this.now();
        await this.sleep(Math.max(0, Math.min(milliseconds, remaining)));
        this._check();
    }

    async _read() {
        const screen = new Screen(await this._step(() => this.phone.dump()));
        screen.checkClear();
        if (screen.kind() === 'climate') {
            this.observedTemperature = this._temperature(screen);
            this.observedSettings.mode = screen.climateMode();
        }
        return screen;
    }

    _requireClimate(screen, state, mode = undefined) {
        if (screen.kind() !== 'climate' || screen.climateState() !== state ||
            mode !== undefined && screen.climateMode() !== mode) {
            throw new BridgeError('state_changed', 'Der Klimazustand oder Modus hat sich während der Einstellung geändert.');
        }
    }

    async _navigate(screen, name, expected) {
        const target = screen.navigationTarget(name);
        // The zone header accepts the local zone selection into the parent
        // settings draft; Android Back would discard it. A clean settings page
        // may use Android Back, but never discard an unsaved settings draft.
        if (name === 'back' && screen.kind() === 'settings' && screen.hasPendingSettings()) {
            throw new BridgeError('unsaved_settings', 'Ungespeicherte Einstellungen zuerst in der VW-App speichern oder verwerfen.');
        }
        if (name === 'back' && screen.kind() !== 'zones') await this._step(() => this.phone.back());
        else await this._step(() => this.phone.tap(target.x, target.y));
        return this._waitKind(expected);
    }

    _settingsObservation(screen) {
        const values = screen.settingsValues();
        if (!values) throw new BridgeError('settings_unavailable', 'Die Klimaeinstellungen sind nicht eindeutig lesbar.');
        Object.assign(this.observedSettings, values);
        return values;
    }

    async _saveSettings(screen, state) {
        if (!screen.hasPendingSettings()) return screen;
        await this._version();
        screen = await this._read();
        if (screen.kind() !== 'settings') throw new BridgeError('state_changed', 'Die Einstellungsansicht hat sich vor dem Speichern geändert.');
        if (!screen.hasPendingSettings()) return screen;
        const target = screen.settingsSaveTarget();
        this.settingsUncertain = true;
        await this._step(() => this.phone.tap(target.x, target.y));
        const until = this.now() + 60000;
        while (true) {
            screen = await this._read();
            if (screen.kind() === 'climate') {
                this._requireClimate(screen, state);
                this.settingsUncertain = false;
                return screen;
            }
            if (screen.kind() === 'settings' && screen.hasPendingSettings() === false) {
                this.settingsUncertain = false;
                return screen;
            }
            if (screen.kind() !== 'settings' || this.now() >= until) throw new BridgeError('settings_not_confirmed', 'Das Speichern der Klimaeinstellungen wurde nicht bestätigt.');
            await this._pause(Math.min(this.pollIntervalMs, until - this.now()));
        }
    }

    _zonesObservation(screen) {
        const values = screen.zonesValues();
        if (!values) throw new BridgeError('settings_unavailable', 'Die vorderen Klimazonen sind nicht eindeutig lesbar.');
        this.observedSettings.zones = values.zones;
        return values;
    }

    async _settingTap(screen, targetFor, expectedKind, observe, expected) {
        await this._version();
        const fresh = await this._read();
        if (fresh.kind() !== screen.kind()) throw new BridgeError('state_changed', 'Die Einstellungsansicht hat sich vor der Eingabe geändert.');
        if (fresh.kind() === expectedKind && observe(fresh) === expected) return fresh;
        if (fresh.kind() === 'mode' && fresh.climateMode() === expected) {
            const detail = await this._navigate(fresh, 'back', 'climate');
            if (observe(detail) !== expected) throw new BridgeError('settings_not_confirmed', 'Die Moduswahl und die Klimaansicht stimmen nicht überein.');
            return detail;
        }
        const target = targetFor(fresh);
        // Each toggle is attempted once. A lost response is never resolved by
        // repeating a toggle, which could undo an accepted change.
        this.settingsUncertain = true;
        await this._step(() => this.phone.tap(target.x, target.y));
        const until = this.now() + 12000;
        while (true) {
            const updated = await this._read();
            if (updated.kind() !== expectedKind && updated.kind() !== screen.kind()) {
                throw new BridgeError('settings_not_confirmed', 'Die Einstellungsansicht wurde während einer Änderung verlassen.');
            }
            const value = updated.kind() === expectedKind ? observe(updated) : undefined;
            if (updated.kind() === expectedKind && value === expected) {
                this.settingsUncertain = false;
                return updated;
            }
            if (this.now() >= until) throw new BridgeError('settings_not_confirmed', 'Die gewählte Klimaeinstellung wurde nicht bestätigt.');
            await this._pause(Math.min(this.pollIntervalMs, until - this.now()));
        }
    }

    async _readSettings(screen, state, { required = false, preflight = null } = {}) {
        this._requireClimate(screen, state);
        try { screen.navigationTarget('settings'); }
        catch (error) {
            if (!required && error instanceof BridgeError && error.code === 'target_unavailable') return screen;
            throw error;
        }
        const mode = screen.climateMode();
        screen = await this._navigate(screen, 'settings', 'settings');
        if (screen.hasPendingSettings()) throw new BridgeError('unsaved_settings', 'Ungespeicherte Einstellungen zuerst am Handy prüfen.');
        const switches = this._settingsObservation(screen);
        if (preflight) for (const key of ['climateOnUnlock', 'autoWindowHeating']) {
            if (preflight[key] !== null && preflight[key] !== switches[key]) screen.settingsTarget(key, preflight[key]);
        }
        this._check();
        const protectReadNavigation = this.readOnlyExecution;
        if (protectReadNavigation) this.readHandoffProtected = true;
        try {
            // A known clean parent opened this read-only child. Complete its
            // header return before a cooperative handoff: Android Back would
            // discard a zone draft, and another controller must not guess that
            // an already open zone page belongs to this read operation.
            screen = await this._navigate(screen, 'zones', 'zones');
            const zones = this._zonesObservation(screen);
            if (preflight?.zones !== null && preflight?.zones !== undefined) {
                for (const side of ['frontLeft', 'frontRight']) {
                    const wanted = preflight.zones === side || preflight.zones === 'both';
                    if (zones[side] !== wanted) screen.zoneToggleTarget(side, wanted);
                }
            }
            screen = await this._navigate(screen, 'back', 'settings');
            this._settingsObservation(screen);
            if (screen.hasPendingSettings()) throw new BridgeError('unsaved_settings', 'Eine nicht gespeicherte Auswahl ist in der VW-App offen.');
        } finally {
            if (protectReadNavigation) this.readHandoffProtected = false;
        }
        this._check();
        screen = await this._navigate(screen, 'back', 'climate');
        this._requireClimate(screen, state, mode);
        return screen;
    }

    async _applySettings(screen, wanted, state, dryRun = false) {
        const mode = screen.climateMode();
        const changesMode = wanted.mode !== null && wanted.mode !== mode;
        const hasOther = ['climateOnUnlock', 'autoWindowHeating', 'zones'].some(key => wanted[key] !== null);
        if (changesMode && state === 'on') {
            throw new BridgeError('mode_change_requires_stop', 'Zum Wechsel des Klimatisierungsmodus zuerst die laufende Klimatisierung stoppen.');
        }
        // Inspect the complete requested surface before the first setting
        // change. These reads do not start or stop the climate operation.
        if (hasOther) screen = await this._readSettings(screen, state, { required: true, preflight: wanted });
        const changesOther = ['climateOnUnlock', 'autoWindowHeating', 'zones'].some(key =>
            wanted[key] !== null && wanted[key] !== this.observedSettings[key]);
        if (!changesMode && !changesOther) return { screen, changed: false };
        if (!dryRun && !this.config.allowWrites) throw new BridgeError('writes_disabled', 'Änderungen der Klimaeinstellungen sind deaktiviert.');
        if (changesMode && (changesOther || dryRun)) {
            screen = await this._navigate(screen, 'mode', 'mode');
            screen.modeChoice(wanted.mode);
            // Preflight only. The final mode is selected after saving global
            // preferences, whose completion may reset the app's mode picker.
            screen = await this._navigate(screen, 'back', 'climate');
            this._requireClimate(screen, state, mode);
        }
        if (dryRun) return { screen, changed: false };
        if (changesOther) {
            screen = await this._navigate(screen, 'settings', 'settings');
            let current = this._settingsObservation(screen);
            for (const key of ['climateOnUnlock', 'autoWindowHeating']) {
                if (wanted[key] === null || wanted[key] === current[key]) continue;
                screen = await this._settingTap(screen, updated => updated.settingsTarget(key, wanted[key]), 'settings', updated => this._settingsObservation(updated)[key], wanted[key]);
                current = this._settingsObservation(screen);
            }
            if (wanted.zones !== null) {
                screen = await this._navigate(screen, 'zones', 'zones');
                let zones = this._zonesObservation(screen);
                const desired = {
                    frontLeft: wanted.zones === 'frontLeft' || wanted.zones === 'both',
                    frontRight: wanted.zones === 'frontRight' || wanted.zones === 'both',
                };
                // Enable required zones before disabling others, preserving at
                // least one selected zone even during left/right transitions.
                for (const value of [true, false]) {
                    for (const side of ['frontLeft', 'frontRight']) {
                        if (desired[side] !== value || zones[side] === value) continue;
                        screen = await this._settingTap(screen, updated => updated.zoneToggleTarget(side, value), 'zones', updated => this._zonesObservation(updated)[side], value);
                        zones = this._zonesObservation(screen);
                    }
                }
                if (zones.zones !== wanted.zones) throw new BridgeError('settings_not_confirmed', 'Die gewählten Zonen wurden nicht bestätigt.');
                screen = await this._navigate(screen, 'back', 'settings');
                this._settingsObservation(screen);
            }
            // Re-read both switches after all changes, including any app-side
            // coupling between controls. Never claim an overwritten choice.
            current = this._settingsObservation(screen);
            for (const key of ['climateOnUnlock', 'autoWindowHeating']) {
                if (wanted[key] !== null && wanted[key] !== current[key]) throw new BridgeError('settings_not_confirmed', 'Eine Klimaeinstellung hat sich während der Übernahme geändert.');
            }
            screen = await this._saveSettings(screen, state);
            if (screen.kind() === 'settings') screen = await this._navigate(screen, 'back', 'climate');
            this._requireClimate(screen, state);
        }
        // Verify the entire requested selection together once more before a
        // possible Start. A partially applied job is never reported as success.
        if (hasOther) screen = await this._readSettings(screen, state, { required: true });
        if (wanted.mode !== null && screen.climateMode() !== wanted.mode) {
            if (state === 'on') throw new BridgeError('mode_change_requires_stop', 'Zum Wechsel des Klimatisierungsmodus zuerst die laufende Klimatisierung stoppen.');
            screen = await this._navigate(screen, 'mode', 'mode');
            screen = await this._settingTap(screen, current => current.modeChoice(wanted.mode), 'climate', current => current.climateMode(), wanted.mode);
            this._requireClimate(screen, state, wanted.mode);
        }
        for (const [key, value] of Object.entries(wanted)) {
            if (value !== null && this.observedSettings[key] !== value) throw new BridgeError('settings_not_confirmed', 'Die vollständige Klimaauswahl wurde nicht bestätigt.');
        }
        return { screen, changed: true };
    }

    _requireStartMode(screen, wantedMode) {
        if (wantedMode === 'windowHeating') {
            if (screen.climateMode() !== 'windowHeating') throw new BridgeError('unsafe_mode', 'Der ausdrücklich gewählte Modus Scheibenheizung ist nicht bestätigt.');
        } else screen.requireAcMode(this.config.modeTitles);
    }

    _temperature(screen) {
        try { return screen.climateTemperature(); }
        catch (error) {
            // An unsupported temperature view must not prevent the existing
            // status/start/stop flow when no temperature was requested.
            if (error instanceof BridgeError && ['unknown_state', 'target_unavailable'].includes(error.code)) return null;
            throw error;
        }
    }

    async _applyTemperature(wanted, state) {
        let screen = await this._read();
        let changed = false;
        // One gesture per adjacent value. Every gesture is followed by a fresh
        // read; no saved coordinates, blind swipe, or repeated uncertain tap.
        for (let step = 0; step < 64; step++) {
            if (screen.kind() !== 'climate' || screen.climateState() !== state) {
                throw new BridgeError('state_changed', 'Der Klimazustand hat sich während der Temperaturwahl geändert.');
            }
            screen.requireAcMode(this.config.modeTitles);
            const current = screen.climateTemperature();
            if (current === null) throw new BridgeError('temperature_unavailable', 'Die Temperaturwahl ist in dieser App-Ansicht nicht eindeutig lesbar.');
            if (current === wanted) return { screen, changed };
            const next = current + (wanted > current ? TEMPERATURE_STEP_CELSIUS : -TEMPERATURE_STEP_CELSIUS);
            validateTargetTemperature(next);
            await this._version();
            const target = screen.temperatureTarget(next);
            if (target.value !== next) throw new BridgeError('temperature_unavailable', 'Die benachbarte Temperatur ist nicht eindeutig auswählbar.');
            this.temperatureUncertain = true;
            await this._step(() => this.phone.tap(target.x, target.y));
            const until = this.now() + 8000;
            while (true) {
                screen = await this._read();
                if (screen.kind() !== 'climate' || screen.climateState() !== state) {
                    throw new BridgeError('state_changed', 'Die Klima-Ansicht hat sich während der Temperaturwahl geändert.');
                }
                screen.requireAcMode(this.config.modeTitles);
                const observed = screen.climateTemperature();
                if (observed === next) { this.temperatureUncertain = false; break; }
                if (observed !== current || this.now() >= until) {
                    throw new BridgeError('temperature_not_confirmed', 'Die gewählte Temperatur wurde in der App nicht bestätigt.');
                }
                await this._pause(Math.min(this.pollIntervalMs, until - this.now()));
            }
            changed = true;
        }
        throw new BridgeError('temperature_not_confirmed', 'Die Temperaturwahl hat ihre begrenzte Schrittzahl überschritten.');
    }

    async _version() {
        const actual = await this._step(() => this.phone.version());
        if (!this.config.approvedAppVersion || actual !== this.config.approvedAppVersion) {
            throw new BridgeError('version_not_approved', 'Die App-Version und ihre Ansichten zuerst prüfen und freigeben.');
        }
        return actual;
    }

    async _waitKind(expected) {
        const until = this.now() + (expected === 'overview' ? 8000 : 20000);
        while (true) {
            const screen = await this._read();
            if (screen.kind() === expected) return screen;
            if (this.now() >= until) {
                throw new BridgeError('unexpected_screen', 'Die erwartete VW-Ansicht fehlt (' + expected + '; gelesen: ' + screen.kind() + '); keine weiteren Eingaben.');
            }
            await this._pause(Math.min(this.pollIntervalMs, until - this.now()));
        }
    }

    async _overview() {
        await this._step(() => this.phone.launch());
        let screen = await this._read();
        if (screen.kind() === 'unknown' && typeof this.phone.departureView === 'function') {
            const returned = await returnFromDeparturePage(this);
            if (returned) screen = returned;
        }
        if (screen.kind() === 'vehicleReport') {
            const target = screen.reportNavigationTarget('back');
            await this._step(() => this.phone.tap(target.x, target.y));
            screen = await this._waitKind('overview');
        }
        if (screen.kind() === 'range' || screen.kind() === 'vehicleSettings') {
            if (screen.kind() === 'vehicleSettings' && screen.hasPendingChargingSettings() !== false) throw new BridgeError('unsaved_settings', 'Offene Fahrzeugeinstellungen zuerst am Handy speichern oder verwerfen.');
            const back = screen.chargingNavigationTarget('back');
            await this._step(() => this.phone.tap(back.x, back.y));
            screen = await this._waitKind('overview');
        }
        if (screen.kind() === 'zones') throw new BridgeError('unsaved_settings', 'Die geöffnete Zonenauswahl zuerst am Handy speichern oder schließen.');
        if (screen.kind() === 'settings' && screen.hasPendingSettings()) throw new BridgeError('unsaved_settings', 'Die geänderten Einstellungen zuerst am Handy speichern oder verwerfen.');
        if (['settings', 'mode'].includes(screen.kind())) screen = await this._navigate(screen, 'back', 'climate');
        if (screen.kind() === 'climate') {
            // Back is permitted only from this recognized climate sheet.
            await this._step(() => this.phone.back());
            screen = await this._waitKind('overview');
        } else if (screen.kind() !== 'overview') {
            screen = await this._waitKind('overview');
        }
        screen.requireVehicle(this.config.vehicleMarker);
        return normalizeOverview(this, screen);
    }

    async _detail() {
        // Recheck the selected vehicle immediately before opening its detail.
        const overview = await this._read();
        if (overview.kind() !== 'overview') {
            throw new BridgeError('unexpected_screen', 'Die Fahrzeugübersicht wurde verlassen.');
        }
        overview.requireVehicle(this.config.vehicleMarker);
        const target = overview.target('climateTile', { navigation: true });
        await this._step(() => this.phone.tap(target.x, target.y));
        return this._waitKind('climate');
    }

    async _confirmRunningOverview(version) {
        // The known climate sheet is the only screen from which Back is safe.
        // Read the vehicle overview after an observed start, without repeating
        // the vehicle command. Some app versions expose its active tile label.
        await this._step(() => this.phone.back());
        const overview = await this._waitKind('overview');
        overview.requireVehicle(this.config.vehicleMarker);
        const evidence = overview.overviewClimateEvidence();
        if (evidence && evidence.appState !== 'on') return null;
        return this._result('on', version, true, {
            confirmationSource: evidence?.confirmationSource || 'app_controls',
        });
    }

    async execute(action, options = {}) {
        if (action === 'refreshVehicleAccess') return this._executeReadOnly(() => executeVehicleAccess(this));
        if (['departuresClimateStatus', 'departuresLocationsStatus', 'departuresLocationStatus'].includes(action)) {
            return this._executeReadOnly(() => executeDepartures(this, action, options));
        }
        if (['applyDepartureClimateTimer', 'applyDepartureLocationTimer', 'applyDepartureLocationSettings', 'applyDeparturePreferredTimes'].includes(action)) {
            return executeDepartures(this, action, options);
        }
        let { dryRun = false, targetTemperature = null, targetSettings = {}, targetCharging = {} } = options;
        if (action === 'vehicleReportStatus') return this._executeReadOnly(() => executeVehicleReport(this));
        if (action === 'chargingStatus') return this._executeReadOnly(() => executeCharging(this, action, { dryRun, targetCharging }));
        if (['applyChargingSettings', 'synchronize'].includes(action)) return executeCharging(this, action, { dryRun, targetCharging });
        if (!['status', 'start', 'stop', 'setTemperature', 'applySettings'].includes(action)) {
            throw new BridgeError('invalid_action', 'Erlaubt sind status, start, stop, setTemperature und applySettings.');
        }
        targetSettings = validateTargetSettings(targetSettings);
        if (action === 'start' && targetSettings.mode === 'windowHeating') targetTemperature = null;
        targetTemperature = validateTargetTemperature(targetTemperature);
        if (action === 'setTemperature' && targetTemperature === null) throw new BridgeError('temperature_required', 'Zuerst eine gewünschte Temperatur auswählen.');
        if (action === 'applySettings' && Object.values(targetSettings).every(value => value === null)) throw new BridgeError('settings_required', 'Zuerst mindestens eine Klimaeinstellung auswählen.');
        if (this.closing) throw new BridgeError('cancelled', 'Der Adapter wird beendet; keine weiteren Eingaben.');
        // Reserve synchronously before the first await; no work is queued.
        if (this.busy) throw new BridgeError('busy', 'Ein anderer Auftrag läuft bereits.');
        this.busy = true;
        this.readOnlyExecution = action === 'status';
        this.readHandoffRequested = false;
        this.readHandoffProtected = false;
        this.observedTemperature = null;
        this.observedSettings = { ...DEFAULT_TARGET_SETTINGS };
        this.temperatureUncertain = false;
        this.settingsUncertain = false;
        let attempted = false;
        this.deadline = this.now() + this.config.commandTimeoutSeconds * 1000;
        this.phone.deadline = this.deadline;
        try {
            // Reconnection is allowed once, before any app action, never after a
            // lost response to a potentially vehicle-affecting gesture.
            await this._connect();
            const version = await this._version();
            const overview = await this._overview();
            const overviewEvidence = overview.overviewClimateEvidence();
            let screen = await this._detail();
            const state = screen.climateState();
            if (state === 'on' && overviewEvidence?.appState === 'unknown') {
                throw new BridgeError('unknown_state', 'Die Klima-Detailansicht zeigt An, die Übersicht bestätigt den Betrieb noch nicht.');
            }
            const confirmationSource = state === 'on' && overviewEvidence?.appState === 'on' ? overviewEvidence.confirmationSource : 'app_controls';
            if (action === 'status') {
                await this._readSettings(screen, state);
                return this._result(state, version, false, { confirmationSource });
            }
            let settingsChanged = false;
            if (['start', 'applySettings'].includes(action)) {
                // Preserve the existing A/C-only Start unless the user has
                // explicitly selected a mode, before any unrelated mutation.
                if (action === 'start' && targetSettings.mode === null) screen.requireAcMode(this.config.modeTitles);
                const applied = await this._applySettings(screen, targetSettings, state, dryRun);
                screen = applied.screen;
                settingsChanged = applied.changed;
                if (action === 'applySettings') return this._result(state, version, false, { settingsChanged, confirmationSource, ...(dryRun ? { dryRun: true } : {}) });
                if (dryRun && targetSettings.mode !== null && screen.climateMode() !== targetSettings.mode) {
                    if (state !== 'on') screen.target('cta_start');
                    return this._result(state, version, false, { dryRun: true, wouldSetSettings: { ...targetSettings },
                        ...(targetTemperature !== null ? { wouldSetTemperature: targetTemperature } : {}),
                        ...(state !== 'on' ? { wouldRequest: 'on' } : {}) });
                }
            }
            let temperatureChanged = false;
            if (action === 'setTemperature' || action === 'start' && targetTemperature !== null) {
                screen.requireAcMode(this.config.modeTitles);
                const current = screen.climateTemperature();
                if (current === null) throw new BridgeError('temperature_unavailable', 'Die Temperaturwahl ist in dieser App-Ansicht nicht eindeutig lesbar.');
                if (dryRun) {
                    if (current !== targetTemperature) screen.temperatureTarget(current + (targetTemperature > current ? TEMPERATURE_STEP_CELSIUS : -TEMPERATURE_STEP_CELSIUS));
                    if (action === 'start' && state !== 'on') screen.target('cta_start');
                    return this._result(state, version, false, { dryRun: true, wouldSetTemperature: targetTemperature,
                        ...(action === 'start' && state !== 'on' ? { wouldRequest: 'on' } : {}) });
                }
                if (current !== targetTemperature) {
                    if (!this.config.allowWrites) throw new BridgeError('writes_disabled', 'Schalten und Temperaturänderungen sind deaktiviert.');
                    const applied = await this._applyTemperature(targetTemperature, state);
                    screen = applied.screen;
                    temperatureChanged = applied.changed;
                }
                if (action === 'setTemperature') return this._result(state, version, false, { temperatureChanged, confirmationSource });
            }
            const desired = action === 'start' ? 'on' : 'off';
            // An already-running windows-only mode is not evidence that A/C is on.
            if (action === 'start') this._requireStartMode(screen, targetSettings.mode);
            if (desired === state) {
                return this._result(state, version, false, { alreadyInState: true, confirmationSource, temperatureChanged, settingsChanged });
            }
            const cta = action === 'start' ? 'cta_start' : 'cta_stop';
            if (dryRun) {
                screen.target(cta);
                return this._result(state, version, false, { dryRun: true, wouldRequest: desired });
            }
            if (!this.config.allowWrites) {
                throw new BridgeError('writes_disabled', 'Schalten ist deaktiviert; zuerst die Einrichtung prüfen.');
            }
            await this._version();
            let fresh = await this._read();
            if (fresh.climateState() !== state) {
                throw new BridgeError('state_changed', 'Der App-Zustand hat sich geändert; kein Schaltversuch.');
            }
            if (action === 'start' && ['climateOnUnlock', 'autoWindowHeating', 'zones'].some(key => targetSettings[key] !== null)) {
                fresh = await this._readSettings(fresh, state, { required: true });
                for (const [key, value] of Object.entries(targetSettings)) {
                    if (key !== 'mode' && value !== null && this.observedSettings[key] !== value) throw new BridgeError('settings_not_confirmed', 'Die Klimaauswahl hat sich vor dem Start geändert.');
                }
                if (targetSettings.mode !== null && fresh.climateMode() !== targetSettings.mode) {
                    if (state === 'on') throw new BridgeError('mode_change_requires_stop', 'Zum Wechsel des Klimatisierungsmodus zuerst die laufende Klimatisierung stoppen.');
                    fresh = await this._navigate(fresh, 'mode', 'mode');
                    fresh = await this._settingTap(fresh, current => current.modeChoice(targetSettings.mode), 'climate', current => current.climateMode(), targetSettings.mode);
                    this._requireClimate(fresh, state, targetSettings.mode);
                }
            }
            if (action === 'start') this._requireStartMode(fresh, targetSettings.mode);
            if (action === 'start' && targetTemperature !== null && fresh.climateTemperature() !== targetTemperature) {
                throw new BridgeError('temperature_not_confirmed', 'Die gewählte Temperatur hat sich vor dem Start geändert.');
            }
            const target = fresh.target(cta);
            // Persist before the only CTA attempt. Cancellation or persistence
            // failure prevents the gesture even if it consumes the cooldown.
            await this._step(() => this.store.reserveCommand(this.config.cooldownSeconds));
            this._check();
            attempted = true;
            await this._step(() => this.phone.tap(target.x, target.y));
            const until = this.now() + this.config.outcomeTimeoutSeconds * 1000;
            while (this.now() < until) {
                let observedScreen = await this._read();
                if (observedScreen.kind() === 'overview') {
                    observedScreen.requireVehicle(this.config.vehicleMarker);
                    const evidence = observedScreen.overviewClimateEvidence();
                    if (desired === 'on' && evidence) {
                        if (evidence.appState === 'on') return this._result('on', version, true, evidence);
                        await this._pause(Math.min(this.pollIntervalMs, until - this.now()));
                        continue;
                    }
                    observedScreen = await this._detail();
                }
                if (observedScreen.kind() === 'climate') {
                    const observed = observedScreen.climateState();
                    if (observed === desired) {
                        if (action === 'start') {
                            this._requireStartMode(observedScreen, targetSettings.mode);
                            const result = await this._confirmRunningOverview(version);
                            if (result) return result;
                        } else return this._result(observed, version, true);
                    }
                }
                await this._pause(Math.min(this.pollIntervalMs, until - this.now()));
            }
            throw new BridgeError('outcome_unknown', 'Schaltversuch gesendet, App-Zustand nicht bestätigt. VW-App manuell prüfen; nicht automatisch wiederholen.');
        } catch (error) {
            // Any exception after the attempt, including an unexpected transport
            // exception or cancellation, has an uncertain physical outcome.
            if (attempted) {
                throw new BridgeError('outcome_unknown', 'Schaltversuch erfolgt, Rückmeldung unklar. VW-App manuell prüfen; nicht automatisch wiederholen.');
            }
            if (this.temperatureUncertain) {
                throw new BridgeError('temperature_outcome_unknown', 'Temperaturänderung begonnen, Ergebnis unklar. Die App prüfen, bevor weitere Befehle gesendet werden.');
            }
            if (this.settingsUncertain) {
                throw new BridgeError('settings_outcome_unknown', 'Eine Klimaeinstellung wurde geändert, die Rückmeldung ist unklar. Die VW-App vor weiteren Befehlen prüfen.');
            }
            if (error instanceof BridgeError) throw error;
            throw new BridgeError('internal_error', 'Der Auftrag konnte nicht sicher ausgeführt werden; Einrichtung und Handy prüfen.');
        } finally {
            this.phone.deadline = null;
            this.deadline = null;
            this.busy = false;
            this.readOnlyExecution = false;
            this.readHandoffRequested = false;
            this.readHandoffProtected = false;
            this.temperatureUncertain = false;
            this.settingsUncertain = false;
        }
    }

    _result(state, version, changed, extra = {}) {
        this._check();
        return {
            appState: state,
            changed,
            source: 'volkswagen_android_app',
            confirmationSource: 'app_controls',
            temperature: this.observedTemperature ?? null,
            settings: { ...this.observedSettings },
            vehicleConfirmed: false,
            appVersion: version,
            observedAt: new Date(this.now()).toISOString(),
            ...extra,
        };
    }
}

module.exports = { Controller };
