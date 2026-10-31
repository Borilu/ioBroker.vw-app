'use strict';

const { BridgeError } = require('./errors');

const FILE = 'security-auth-state';
const REASONS = Object.freeze(['attempt_pending', 'pin_rejected', 'pin_locked', 'outcome_unknown']);
const CLEAR = Object.freeze({ blocked: false, reason: null, blockedAt: null });
const DIAGNOSTICS = new WeakMap();
const FAILURE_STAGES = Object.freeze(['preflight', 'cta', 'pin_context', 'pin_entry', 'keyboard_hide',
    'confirmation_status', 'confirmation_sheet', 'confirmation_home', 'auth_clear']);
const MESSAGES = Object.freeze({
    security_pin_required: 'Die Volkswagen S-PIN zuerst in den Adaptereinstellungen hinterlegen.',
    security_pin_invalid: 'Die Volkswagen S-PIN muss aus genau vier Ziffern bestehen.',
    vehicle_locking_disabled: 'Verriegeln und Entriegeln sind in den Adaptereinstellungen nicht freigegeben.',
    security_auth_blocked: 'Der letzte Sicherheitsauftrag ist ungeklärt oder die S-PIN wurde abgewiesen. App und S-PIN prüfen und die Sperre ausdrücklich in den Adaptereinstellungen zurücksetzen.',
    security_auth_invalid: 'Der gespeicherte Sicherheitsstatus ist ungültig. Vor weiteren Schaltaufträgen prüfen.',
    security_auth_unavailable: 'Der gespeicherte Sicherheitsstatus konnte nicht sicher gelesen werden.',
    security_auth_not_saved: 'Der Sicherheitsstatus konnte nicht gespeichert werden; keine weitere Eingabe.',
    security_pin_rejected: 'Die Volkswagen-App hat die S-PIN abgewiesen. Keine automatische Wiederholung; S-PIN prüfen und Sperre ausdrücklich zurücksetzen.',
    security_pin_locked: 'Die Volkswagen-App hat die S-PIN-Eingabe gesperrt. App prüfen und keine weiteren Versuche auslösen.',
    security_pin_entry_failed: 'Die S-PIN-Eingabe konnte nicht bestätigt werden. App prüfen; keine automatische Wiederholung.',
    security_pin_transport_unavailable: 'Die geschützte S-PIN-Eingabe ist nicht verfügbar.',
    security_pin_unavailable: 'Die hinterlegte Volkswagen S-PIN konnte nicht sicher gelesen werden.',
    security_context_invalid: 'Die geschützte S-PIN-Ansicht ist nicht eindeutig freigegeben.',
    security_context_stale: 'Die geschützte S-PIN-Ansicht hat sich vor der Eingabe geändert.',
    security_entry_uncertain: 'Die S-PIN-Eingabe wurde begonnen, die Rückmeldung ist unklar. Keine automatische Wiederholung.',
    security_pin_pending: 'Auf dem Handy ist eine S-PIN-Eingabe offen. Diese zuerst direkt in der Volkswagen-App prüfen.',
    security_status_unavailable: 'Die geschützte App-Rückmeldung ist vorübergehend nicht eindeutig verfügbar.',
    security_ui_active: 'Die geschützte S-PIN-Ansicht wird nicht ausgelesen.',
    invalid_ui: 'Das Handy hat keine gültige Android-Ansicht geliefert.',
    security_keyboard_unauthorized: 'Das Ausblenden der Tastatur gehört nicht zu einer bestätigten S-PIN-Eingabe.',
    security_keyboard_unavailable: 'Die Tastatur konnte nicht eindeutig und sicher ausgeblendet werden.',
    security_keyboard_uncertain: 'Das Ausblenden der Tastatur wurde versucht, seine Rückmeldung ist unklar.',
    lock_control_unavailable: 'Das bestätigte Ver- oder Entriegelungsbedienelement ist nicht verfügbar.',
    lock_ui_unsupported: 'Die Ver- oder Entriegelungsansicht wird nicht eindeutig erkannt.',
    outcome_unknown: 'Sicherheitsauftrag begonnen, Rückmeldung unklar. Volkswagen-App prüfen; nicht automatisch wiederholen.',
    invalid_action: 'Ungültiger Sicherheitsauftrag.',
    busy: 'Ein anderer Handyauftrag läuft bereits.',
    cancelled: 'Der Adapter wird beendet; keine weitere Eingabe.',
    phone_timeout: 'Das Zeitlimit des Handyauftrags wurde erreicht.',
    version_not_approved: 'Die App-Version zuerst in der Einrichtung prüfen und freigeben.',
    profile_required: 'App und Fahrzeug zuerst in den Adaptereinstellungen übernehmen.',
    profile_mismatch: 'App, Handy oder Fahrzeug entsprechen nicht dem bestätigten Einrichtungsprofil.',
    wrong_vehicle: 'Das ausgewählte Fahrzeug entspricht nicht dem bestätigten Profil.',
    unknown_state: 'Der Fahrzeugzustand ist nicht eindeutig lesbar.',
    state_changed: 'Der Fahrzeugzustand hat sich vor dem Sicherheitsauftrag geändert.',
    blocked_ui: 'Ein Dialog oder eine fremde Ansicht verhindert den Auftrag.',
    unsaved_settings: 'Offene manuelle Einstellungen zuerst am Handy prüfen.',
    departure_editor_open: 'Eine Abfahrtszeit-Ansicht ist geöffnet. Bitte in der VW-App prüfen und schließen.',
    unexpected_screen: 'Die erwartete Volkswagen-Ansicht ist nicht sichtbar.',
    wifi_unavailable: 'Die geprüfte Android-WLAN-Verbindung ist nicht verfügbar.',
    wifi_wrong_device: 'Die Verbindung gehört nicht zum bestätigten Handy.',
    wifi_identity_required: 'Die Gerätebindung zuerst in der Einrichtung prüfen.',
    phone_locked_or_other_app: 'Das Handy entsperren und die Volkswagen-App öffnen.',
    app_missing: 'Die Volkswagen-App ist nicht verfügbar.',
    state_not_saved: 'Die Auftragssperre konnte nicht gespeichert werden; keine Eingabe.',
    cooldown: 'Den eingestellten Mindestabstand zwischen Schaltversuchen abwarten.',
    internal_error: 'Der Sicherheitsauftrag konnte nicht sicher ausgeführt werden. App und Einrichtung prüfen.',
});

function fixedSecurityError(code) {
    const safe = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'internal_error';
    return new BridgeError(safe, MESSAGES[safe]);
}

function sanitizeSecurityError(error) {
    // A foreign BridgeError is not trusted: its message, accessors and toJSON
    // can contain credentials. Only an own, allowlisted code is retained.
    try {
        const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : null;
        const safe = fixedSecurityError(descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : 'internal_error');
        const diagnostic = error && typeof error === 'object' ? DIAGNOSTICS.get(error) : null;
        if (diagnostic) DIAGNOSTICS.set(safe, diagnostic);
        return safe;
    } catch (_) { return fixedSecurityError('internal_error'); }
}

function withSecurityDiagnostic(error, stage, cause = undefined) {
    const safe = sanitizeSecurityError(error);
    if (!FAILURE_STAGES.includes(stage)) return safe;
    const existing = DIAGNOSTICS.get(safe);
    const candidate = cause === undefined ? existing?.cause || safe.code : cause;
    const fixedCause = typeof candidate === 'string' && Object.hasOwn(MESSAGES, candidate) ? candidate : 'internal_error';
    DIAGNOSTICS.set(safe, Object.freeze({ stage, cause: fixedCause }));
    return safe;
}

function securityErrorDiagnostic(error) {
    // No property on a foreign error, Proxy, getter or toJSON is inspected.
    const value = error && typeof error === 'object' ? DIAGNOSTICS.get(error) : null;
    return value ? { stage: value.stage, cause: value.cause } : null;
}

function validateSecurityAuthState(value) {
    try {
        if (!value || typeof value !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw 0;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const keys = ['blocked', 'reason', 'blockedAt'];
        if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !descriptors[key]
            || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw 0;
        const state = Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
        if (typeof state.blocked !== 'boolean') throw 0;
        if (!state.blocked) {
            if (state.reason !== null || state.blockedAt !== null) throw 0;
        } else if (!REASONS.includes(state.reason) || typeof state.blockedAt !== 'string'
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(state.blockedAt)
            || !Number.isFinite(Date.parse(state.blockedAt)) || new Date(state.blockedAt).toISOString() !== state.blockedAt) throw 0;
        return state;
    } catch (_) { throw fixedSecurityError('security_auth_invalid'); }
}

async function readSecurityAuth(store) {
    let value;
    try { value = await store.read(FILE, { ...CLEAR }); }
    catch (_) { throw fixedSecurityError('security_auth_unavailable'); }
    return validateSecurityAuthState(value);
}

async function persist(store, value) {
    const state = validateSecurityAuthState(value);
    try { await store.write(FILE, state); }
    catch (_) { throw fixedSecurityError('security_auth_not_saved'); }
    return { ...state };
}

async function blockSecurityAuth(store, reason, now = Date.now()) {
    if (!REASONS.includes(reason) || !Number.isSafeInteger(now) || now < 0) throw fixedSecurityError('security_auth_invalid');
    let blockedAt;
    try { blockedAt = new Date(now).toISOString(); }
    catch (_) { throw fixedSecurityError('security_auth_invalid'); }
    return persist(store, { blocked: true, reason, blockedAt });
}

async function clearSecurityAuth(store) { return persist(store, { ...CLEAR }); }

module.exports = { SECURITY_AUTH_REASONS: REASONS, readSecurityAuth, blockSecurityAuth, clearSecurityAuth,
    validateSecurityAuthState, fixedSecurityError, sanitizeSecurityError, withSecurityDiagnostic, securityErrorDiagnostic };
