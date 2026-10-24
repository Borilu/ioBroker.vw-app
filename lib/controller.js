'use strict';

const { Screen } = require('./ui');
const { BridgeError } = require('./errors');
const { validateTargetTemperature, TEMPERATURE_STEP_CELSIUS } = require('./temperature');

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
    }

    cancel() {
        this.closing = true;
    }

    _check() {
        if (this.closing) throw new BridgeError('cancelled', 'Der Adapter wird beendet; keine weiteren Eingaben.');
        if (this.deadline !== null && this.now() >= this.deadline) {
            throw new BridgeError('phone_timeout', 'Zeitlimit erreicht; keine automatische Wiederholung.');
        }
    }

    async _step(operation) {
        this._check();
        const result = await operation();
        this._check();
        return result;
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
        if (screen.kind() === 'climate') this.observedTemperature = this._temperature(screen);
        return screen;
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
        const until = this.now() + 8000;
        while (true) {
            const screen = await this._read();
            if (screen.kind() === expected) return screen;
            if (this.now() >= until) {
                throw new BridgeError('unexpected_screen', 'Die erwartete VW-Ansicht fehlt; keine weiteren Eingaben.');
            }
            await this._pause(Math.min(this.pollIntervalMs, until - this.now()));
        }
    }

    async _overview() {
        await this._step(() => this.phone.launch());
        let screen = await this._read();
        if (screen.kind() === 'climate') {
            // Back is permitted only from this recognized climate sheet.
            await this._step(() => this.phone.back());
            screen = await this._waitKind('overview');
        } else if (screen.kind() !== 'overview') {
            screen = await this._waitKind('overview');
        }
        screen.requireVehicle(this.config.vehicleMarker);
        return screen;
    }

    async _detail() {
        // Read the tile and vehicle marker anew immediately before navigation.
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

    async execute(action, { dryRun = false, targetTemperature = null } = {}) {
        if (!['status', 'start', 'stop', 'setTemperature'].includes(action)) {
            throw new BridgeError('invalid_action', 'Erlaubt sind status, start, stop und setTemperature.');
        }
        targetTemperature = validateTargetTemperature(targetTemperature);
        if (action === 'setTemperature' && targetTemperature === null) throw new BridgeError('temperature_required', 'Zuerst eine gewünschte Temperatur auswählen.');
        if (this.closing) throw new BridgeError('cancelled', 'Der Adapter wird beendet; keine weiteren Eingaben.');
        // Reserve synchronously before the first await; no work is queued.
        if (this.busy) throw new BridgeError('busy', 'Ein anderer Auftrag läuft bereits.');
        this.busy = true;
        this.observedTemperature = null;
        this.temperatureUncertain = false;
        let attempted = false;
        this.deadline = this.now() + this.config.commandTimeoutSeconds * 1000;
        this.phone.deadline = this.deadline;
        try {
            // Reconnection is allowed once, before any app action, never after a
            // lost response to a potentially vehicle-affecting gesture.
            await this._step(() => this.phone.connect());
            const version = await this._version();
            const overview = await this._overview();
            const overviewEvidence = overview.overviewClimateEvidence();
            let screen = await this._detail();
            const state = screen.climateState();
            if (state === 'on' && overviewEvidence?.appState === 'unknown') {
                throw new BridgeError('unknown_state', 'Die Klima-Detailansicht zeigt An, die Übersicht bestätigt den Betrieb noch nicht.');
            }
            const confirmationSource = state === 'on' && overviewEvidence?.appState === 'on' ? overviewEvidence.confirmationSource : 'app_controls';
            if (action === 'status') return this._result(state, version, false, { confirmationSource });
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
            if (action === 'start') screen.requireAcMode(this.config.modeTitles);
            if (desired === state) {
                return this._result(state, version, false, { alreadyInState: true, confirmationSource, temperatureChanged });
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
            const fresh = await this._read();
            if (fresh.climateState() !== state) {
                throw new BridgeError('state_changed', 'Der App-Zustand hat sich geändert; kein Schaltversuch.');
            }
            if (action === 'start') fresh.requireAcMode(this.config.modeTitles);
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
            if (error instanceof BridgeError) throw error;
            throw new BridgeError('internal_error', 'Der Auftrag konnte nicht sicher ausgeführt werden; Einrichtung und Handy prüfen.');
        } finally {
            this.phone.deadline = null;
            this.deadline = null;
            this.busy = false;
            this.temperatureUncertain = false;
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
            vehicleConfirmed: false,
            appVersion: version,
            observedAt: new Date(this.now()).toISOString(),
            ...extra,
        };
    }
}

module.exports = { Controller };
