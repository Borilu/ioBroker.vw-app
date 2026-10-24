'use strict';

const { Screen } = require('./ui');
const { BridgeError } = require('./errors');

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
        return screen;
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

    async execute(action, { dryRun = false } = {}) {
        if (!['status', 'start', 'stop'].includes(action)) {
            throw new BridgeError('invalid_action', 'Erlaubt sind status, start und stop.');
        }
        if (this.closing) throw new BridgeError('cancelled', 'Der Adapter wird beendet; keine weiteren Eingaben.');
        // Reserve synchronously before the first await; no work is queued.
        if (this.busy) throw new BridgeError('busy', 'Ein anderer Auftrag läuft bereits.');
        this.busy = true;
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
            const screen = await this._detail();
            const state = screen.climateState();
            if (state === 'on' && overviewEvidence?.appState === 'unknown') {
                throw new BridgeError('unknown_state', 'Die Klima-Detailansicht zeigt An, die Übersicht bestätigt den Betrieb noch nicht.');
            }
            const confirmationSource = state === 'on' && overviewEvidence?.appState === 'on' ? overviewEvidence.confirmationSource : 'app_controls';
            if (action === 'status') return this._result(state, version, false, { confirmationSource });
            const desired = action === 'start' ? 'on' : 'off';
            // An already-running windows-only mode is not evidence that A/C is on.
            if (action === 'start') screen.requireAcMode(this.config.modeTitles);
            if (desired === state) {
                return this._result(state, version, false, { alreadyInState: true, confirmationSource });
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
            if (error instanceof BridgeError) throw error;
            throw new BridgeError('internal_error', 'Der Auftrag konnte nicht sicher ausgeführt werden; Einrichtung und Handy prüfen.');
        } finally {
            this.phone.deadline = null;
            this.deadline = null;
            this.busy = false;
        }
    }

    _result(state, version, changed, extra = {}) {
        this._check();
        return {
            appState: state,
            changed,
            source: 'volkswagen_android_app',
            confirmationSource: 'app_controls',
            vehicleConfirmed: false,
            appVersion: version,
            observedAt: new Date(this.now()).toISOString(),
            ...extra,
        };
    }
}

module.exports = { Controller };
