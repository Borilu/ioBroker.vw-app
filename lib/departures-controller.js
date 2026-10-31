'use strict';

const { BridgeError } = require('./errors');
const { DepartureScreen } = require('./departures-ui');
const { parseDepartureTimer, parseChargingLocationIdentity } = require('./departures-native');
const { normalizeObservedTimer, validateTimerTargets } = require('./departures');
const { validateLocationTargets, validatePreferredTargets } = require('./departures-adapter');
const { DEFAULT_TARGET_SETTINGS } = require('./settings');

const READ_ACTIONS = ['departuresClimateStatus', 'departuresLocationsStatus', 'departuresLocationStatus'];
const WRITE_ACTIONS = ['applyDepartureClimateTimer', 'applyDepartureLocationTimer',
    'applyDepartureLocationSettings', 'applyDeparturePreferredTimes'];
const ACTIONS = [...READ_ACTIONS, ...WRITE_ACTIONS];
const NEW_PAGES = ['departuresOverview', 'locationOverview', 'timerEditor', 'locationSettings', 'preferredTimes'];
const LOCATION_FRAGMENTS = {
    locationOverview: 'ChargingLocationOverviewFragment',
    locationSettings: 'ChargingLocationSettingsFragment',
    preferredTimes: 'PreferredChargingTimesFragment',
};
const OPEN_DESCRIPTION = 'Abfahrtszeiten. Details öffnen';

function failure(code) {
    const messages = {
        invalid_action: 'Unbekannter Abfahrtszeit-Auftrag.',
        invalid_departures_request: 'Der Abfahrtszeit-Auftrag enthält ungültige Angaben.',
        departure_changed: 'Die angezeigten Abfahrtszeiten haben sich während des Lesens geändert.',
        departure_incomplete: 'Die Abfahrtszeiten konnten nicht vollständig und eindeutig gelesen werden.',
        departure_location_mismatch: 'Der geöffnete Ladeort stimmt nicht eindeutig mit der erwarteten Bindung überein.',
        unsaved_settings: 'Offene Abfahrtszeit-Einstellungen zuerst direkt in der VW-App prüfen und fertigstellen oder schließen.',
        unexpected_screen: 'Die erwartete Abfahrtszeit-Ansicht wurde verlassen; keine weiteren Eingaben.',
        departures_settings_required: 'Zuerst mindestens einen gewünschten Abfahrtszeit- oder Ladeortwert auswählen.',
        unsupported_departure_time: 'Die unterstützte Abfahrtszeit muss auf einem Fünf-Minuten-Schritt liegen.',
        unsupported_departure_combination: 'Eine einmalige Abfahrtszeit benötigt genau einen ausgewählten Wochentag.',
        departure_setting_not_confirmed: 'Die gewünschte Abfahrtszeit-Einstellung wurde nicht bestätigt.',
        departure_outcome_unknown: 'Eine Abfahrtszeit-Änderung wurde begonnen; die Rückmeldung ist unklar. Nicht automatisch wiederholen.',
        writes_disabled: 'Änderungen der Fahrzeugeinstellungen sind deaktiviert.',
    };
    return new BridgeError(code, messages[code]);
}
function requireValue(condition, code = 'departure_changed') { if (!condition) throw failure(code); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function confirmTargets(observed, targets) {
    requireValue(observed && typeof observed === 'object', 'departure_setting_not_confirmed');
    for (const [key, value] of Object.entries(targets)) if (value !== null) {
        requireValue(same(observed[key], value), 'departure_setting_not_confirmed');
    }
}
function plain(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure('invalid_departures_request');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const copy = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
        const property = descriptors[key];
        requireValue(typeof key === 'string' && keys.includes(key) && property.enumerable
            && Object.hasOwn(property, 'value'), 'invalid_departures_request');
        copy[key] = property.value;
    }
    return copy;
}
function locationOption(value) {
    const result = plain(value, ['nativeId', 'name']);
    requireValue(Object.keys(result).length === 2 && typeof result.nativeId === 'string'
        && /^(?:0|[1-9][0-9]{0,31})$/.exec(result.nativeId)?.[0] === result.nativeId
        && typeof result.name === 'string' && result.name.length > 0 && result.name.length <= 128
        && result.name.trim() === result.name && !/[\x00-\x1f]/.test(result.name), 'invalid_departures_request');
    return { nativeId: result.nativeId, name: result.name };
}
function optionsFor(action, value) {
    try {
        const timerAction = ['applyDepartureClimateTimer', 'applyDepartureLocationTimer'].includes(action);
        const gearAction = action === 'applyDepartureLocationSettings';
        const preferredAction = action === 'applyDeparturePreferredTimes';
        const input = plain(value, ['dryRun', ...(READ_ACTIONS.includes(action) ? ['overviewOnly'] : []), ...(action !== 'departuresClimateStatus' && action !== 'departuresLocationsStatus'
            && action !== 'applyDepartureClimateTimer' ? ['location'] : []),
        ...(timerAction ? ['timerId', 'targetTimer'] : []), ...(gearAction ? ['targetSettings'] : []),
        ...(preferredAction ? ['targetPreferredTimes'] : [])]);
        requireValue(input.dryRun === undefined || typeof input.dryRun === 'boolean', 'invalid_departures_request');
        requireValue(input.overviewOnly === undefined || typeof input.overviewOnly === 'boolean', 'invalid_departures_request');
        const result = { dryRun: input.dryRun === true, overviewOnly: input.overviewOnly === true };
        if (!['departuresClimateStatus', 'departuresLocationsStatus', 'applyDepartureClimateTimer'].includes(action)) {
            result.location = locationOption(input.location);
        }
        if (timerAction) {
            requireValue((action === 'applyDepartureClimateTimer' ? ['1', '2'] : ['1', '2', '3']).includes(input.timerId), 'invalid_departures_request');
            result.timerId = input.timerId;
            result.targetTimer = validateTimerTargets(input.targetTimer);
            requireValue(Object.values(result.targetTimer).some(item => item !== null), 'departures_settings_required');
            if (result.targetTimer.time !== null) requireValue(Number(result.targetTimer.time.slice(3)) % 5 === 0, 'unsupported_departure_time');
        }
        if (gearAction) {
            result.targetSettings = validateLocationTargets(input.targetSettings);
            requireValue(Object.values(result.targetSettings).some(item => item !== null), 'departures_settings_required');
            if (result.targetSettings.name !== null) requireValue(!['Abfahrtszeiten', 'Zeit einstellen', 'Ladeeinstellungen', 'Bevorzugte Zeiten']
                .includes(result.targetSettings.name), 'invalid_departures_request');
        }
        if (preferredAction) {
            result.targetPreferredTimes = validatePreferredTargets(input.targetPreferredTimes);
            requireValue(result.targetPreferredTimes.some(item => item.enabled !== null), 'departures_settings_required');
        }
        return result;
    } catch (error) {
        if (error instanceof BridgeError && ['departures_settings_required', 'unsupported_departure_time'].includes(error.code)) throw error;
        throw failure('invalid_departures_request');
    }
}

function viewFrom(value) {
    requireValue(value && (typeof value.xml === 'string' || Buffer.isBuffer(value.xml))
        && value.observation && typeof value.observation === 'object' && !Array.isArray(value.observation), 'departure_incomplete');
    const screen = new DepartureScreen(value.xml);
    screen.checkClear();
    return { screen, observation: value.observation, xml: Buffer.isBuffer(value.xml) ? value.xml.toString('utf8') : value.xml };
}
async function read(c) {
    return viewFrom(await c._step(() => c.phone.departureView()));
}
async function waitForScreen(c, kind) {
    const until = c.now() + 20000;
    while (true) {
        const view = await read(c);
        if (view.screen.kind() === kind) return view;
        if (c.now() >= until) throw failure('unexpected_screen');
        await c._pause(Math.min(c.pollIntervalMs, until - c.now()));
    }
}
function clean(view) {
    const kind = view.screen.kind();
    if (kind === 'timerEditor') requireValue(view.screen.timerEditor().canSave === false, 'unsaved_settings');
    if (kind === 'locationSettings') requireValue(view.screen.gearSettings().canSave === false, 'unsaved_settings');
    if (kind === 'preferredTimes') requireValue(view.screen.preferredTimes().canSave === false, 'unsaved_settings');
    const header = view.screen._base();
    if (header?.right) {
        const saves = [...view.screen._descendants(header.right)].some(node =>
            node.attrs.text === 'Speichern' || node.attrs['content-desc'] === 'Speichern');
        requireValue(!saves, 'unsaved_settings');
    }
    return view;
}
function title(view) {
    const value = view.screen._base()?.title;
    requireValue(typeof value === 'string' && value.length > 0 && value.length <= 128, 'departure_location_mismatch');
    return value;
}
async function identity(c, view, expected = null) {
    const kind = view.screen.kind();
    requireValue(Object.hasOwn(LOCATION_FRAGMENTS, kind), 'departure_location_mismatch');
    if (kind === 'locationOverview') view.screen.locationOverview(expected?.name ?? title(view));
    if (kind === 'locationSettings') {
        const settings = view.screen.gearSettings();
        if (expected?.name !== null && expected?.name !== undefined && settings.name !== null) {
            requireValue(settings.name === expected.name, 'departure_location_mismatch');
        }
    }
    const native = await c._step(() => c.phone.departureNative());
    requireValue(native?.fragment === LOCATION_FRAGMENTS[kind], 'departure_location_mismatch');
    const parsed = parseChargingLocationIdentity(native);
    if (expected) requireValue(parsed.nativeId === expected.nativeId, 'departure_location_mismatch');
    return { nativeId: parsed.nativeId, name: expected?.name ?? (kind === 'locationOverview' ? title(view) : null) };
}
async function back(c, kind, expected, check = () => {}, expectedLocation = null) {
    await c._version();
    const current = clean(await read(c));
    requireValue(current.screen.kind() === kind, 'unexpected_screen');
    check(current);
    const point = current.screen.headerTarget('back');
    if (c.readOnlyExecution && kind === 'locationOverview' && expected === 'departuresOverview') {
        // This page only lists timer status; it has no settings draft. Verify
        // its native location identity, then re-read before one system Back.
        // Never use this path for an editor, settings page or actual write;
        // explicitly read-only dry runs are eligible.
        requireValue(expectedLocation !== null, 'departure_location_mismatch');
        await identity(c, current, expectedLocation);
        const verified = clean(await read(c));
        requireValue(verified.screen.kind() === kind, 'unexpected_screen');
        check(verified);
        verified.screen.headerTarget('back');
        await c._step(() => c.phone.back());
        return waitForScreen(c, expected);
    }
    await c._step(() => c.phone.tap(point.x, point.y));
    return waitForScreen(c, expected);
}
async function protectedRead(c, operation) {
    c._check();
    const previous = c.readHandoffProtected;
    c.readHandoffProtected = true;
    let result;
    try { result = await operation(); }
    finally { c.readHandoffProtected = previous; }
    c._check();
    return result;
}

/**
 * Core recovery only: a fresh rich read, known clean pages and checked header
 * returns. Never calls c._overview(), launches an app or guesses Android Back.
 * An already open timer editor remains a user's editor, even without Save.
 */
async function returnFromDeparturePage(c) {
    c._check();
    let view;
    try { view = await read(c); view.screen.kind(); }
    catch (error) {
        if (error instanceof BridgeError && ['unknown_state', 'blocked_ui', 'invalid_ui'].includes(error.code)) return null;
        throw error;
    }
    let kind = view.screen.kind();
    if (!NEW_PAGES.includes(kind)) return null;
    let bound = null;
    for (let step = 0; step < 5; step++) {
        kind = view.screen.kind();
        if (kind === 'overview') { view.screen.requireVehicle(c.config.vehicleMarker); return view.screen; }
        if (kind === 'timerEditor') throw new BridgeError('unsaved_settings',
            'Der Timereditor ist bereits geöffnet. Bitte zuerst direkt in der VW-App fertigstellen oder schließen.');
        clean(view);
        if (kind === 'preferredTimes') {
            bound = await identity(c, view, bound);
            view = await back(c, kind, 'locationSettings');
            const next = await identity(c, clean(view), bound);
            bound = { nativeId: next.nativeId, name: view.screen.gearSettings().name };
        } else if (kind === 'locationSettings') {
            bound = await identity(c, view, bound);
            const name = view.screen.gearSettings().name;
            view = await back(c, kind, 'locationOverview');
            bound = await identity(c, view, { nativeId: bound.nativeId, name: bound.name ?? name ?? title(view) });
        } else if (kind === 'locationOverview') {
            bound = await identity(c, view, bound);
            view = await back(c, kind, 'departuresOverview', fresh => fresh.screen.locationOverview(bound.name), bound);
            bound = null;
        } else if (kind === 'departuresOverview') {
            view.screen.departuresOverview({ allowPartial: true });
            view = await back(c, kind, 'overview');
        } else throw failure('unexpected_screen');
    }
    if (view.screen.kind() === 'overview') { view.screen.requireVehicle(c.config.vehicleMarker); return view.screen; }
    throw failure('departure_incomplete');
}

function openingTarget(screen, marker) {
    screen.requireVehicle(marker);
    const page = screen._overviewPage({ allowClippedTiles: true, requireRange: false });
    requireValue(page, 'departure_incomplete');
    const matches = screen.nodes.filter(node => screen._package(node) === screen.package
        && node.attrs['content-desc'] === OPEN_DESCRIPTION && screen._visible(node) && screen._bounds(node));
    if (matches.length !== 1) {
        if (matches.length > 1) throw new BridgeError('ambiguous_ui', 'Die App zeigt mehrere Abfahrtszeit-Menüs.');
        throw new BridgeError('target_unavailable', 'Das bestätigte Abfahrtszeit-Menü ist nicht sichtbar.');
    }
    const label = matches[0];
    requireValue(screen._within(label, page.scroll), 'departure_changed');
    let control = label;
    while (control && control !== page.scroll && control.attrs.clickable !== 'true') control = control.parent;
    requireValue(control && control !== page.scroll, 'departure_changed');
    screen._point(control);
    const box = screen._bounds(label), outer = screen._bounds(page.scroll), click = screen._bounds(control);
    requireValue(box[0] >= outer[0] && box[1] >= outer[1] && box[2] <= outer[2] && box[3] <= outer[3]
        && box[0] >= click[0] && box[1] >= click[1] && box[2] <= click[2] && box[3] <= click[3]);
    return { x: Math.floor((box[0] + box[2]) / 2), y: Math.floor((box[1] + box[3]) / 2) };
}
async function open(c) {
    await c._step(() => c.phone.launch());
    const recovered = await returnFromDeparturePage(c);
    if (!recovered) await c._overview();
    for (let attempt = 0; attempt < 5; attempt++) {
        await c._version();
        const view = await read(c);
        requireValue(view.screen.kind() === 'overview', 'unexpected_screen');
        view.screen.requireVehicle(c.config.vehicleMarker);
        let point;
        try {
            point = openingTarget(view.screen, c.config.vehicleMarker);
        } catch (error) {
            if (!(error instanceof BridgeError) || error.code !== 'target_unavailable' || attempt === 4) throw error;
            await c._step(() => c.phone.swipe(view.screen.overviewScrollTarget('down')));
            await waitForScreen(c, 'overview');
            continue;
        }
        await c._step(() => c.phone.tap(point.x, point.y));
        return waitForScreen(c, 'departuresOverview');
    }
    throw failure('departure_incomplete');
}
function overview(view) {
    requireValue(view.screen.kind() === 'departuresOverview', 'unexpected_screen');
    const state = view.screen.departuresOverview({ allowPartial: true });
    requireValue(typeof state.scrollState.forward === 'boolean' && typeof state.scrollState.backward === 'boolean', 'departure_incomplete');
    return state;
}
async function move(c, view, direction, kind) {
    await c._version();
    const before = await read(c);
    requireValue(before.screen.kind() === kind, 'unexpected_screen');
    clean(before);
    const gesture = before.screen.scrollTarget(direction);
    await c._step(() => c.phone.swipe(gesture));
    const until = c.now() + 5000;
    while (true) {
        const next = await read(c);
        requireValue(next.screen.kind() === kind, 'unexpected_screen');
        clean(next);
        if (next.xml !== before.xml) return next;
        if (c.now() >= until) throw failure('departure_incomplete');
        await c._pause(Math.min(c.pollIntervalMs, until - c.now()));
    }
}
async function top(c, initial) {
    let view = initial;
    for (let attempt = 0; attempt < 6; attempt++) {
        if (!overview(view).scrollState.backward) return view;
        view = await move(c, view, 'up', 'departuresOverview');
    }
    if (!overview(view).scrollState.backward) return view;
    throw failure('departure_incomplete');
}
function mergeLocations(map, rows) {
    for (const row of rows) {
        if (map.has(row.name)) requireValue(map.get(row.name).activeCount === row.activeCount);
        else map.set(row.name, { ...row });
        requireValue(map.size <= 5, 'departure_incomplete');
    }
}
async function collect(c, initial) {
    let view = await top(c, initial);
    const locations = new Map();
    let climate = null;
    for (let page = 0; page < 6; page++) {
        const state = overview(view);
        mergeLocations(locations, state.locations);
        if (state.climateTimers !== null) {
            if (climate) requireValue(same(climate, state.climateTimers));
            climate = state.climateTimers;
        }
        if (!state.scrollState.forward) return { locations: [...locations.values()], climate, view };
        if (page === 5) break;
        view = await move(c, view, 'down', 'departuresOverview');
    }
    throw failure('departure_incomplete');
}
function listed(view, expected) {
    const state = overview(view);
    for (const row of state.locations) {
        const baseline = expected.find(item => item.name === row.name);
        requireValue(baseline && baseline.activeCount === row.activeCount);
    }
    return state;
}
async function seek(c, name, expected) {
    let view = await top(c, await waitForScreen(c, 'departuresOverview'));
    for (let attempt = 0; attempt < 6; attempt++) {
        const state = listed(view, expected);
        if (state.locations.some(row => row.name === name)) return view;
        if (!state.scrollState.forward) break;
        view = await move(c, view, 'down', 'departuresOverview');
    }
    throw failure('departure_location_mismatch');
}
async function openLocation(c, row, all, expected = null) {
    await seek(c, row.name, all);
    await c._version();
    const current = await read(c);
    const state = listed(current, all);
    requireValue(state.locations.some(item => item.name === row.name && item.activeCount === row.activeCount));
    const point = current.screen.locationOpen(row.name);
    await c._step(() => c.phone.tap(point.x, point.y));
    const view = await waitForScreen(c, 'locationOverview');
    const values = view.screen.locationOverview(row.name);
    requireValue(values.timers.filter(timer => timer.enabled).length === row.activeCount);
    const binding = await identity(c, view, expected ?? null);
    requireValue(binding.name === row.name, 'departure_location_mismatch');
    return { view, values, location: { nativeId: binding.nativeId, name: row.name } };
}
function parentTimers(view, kind, location) {
    if (kind === 'climate') {
        const rows = overview(view).climateTimers;
        requireValue(rows?.length === 2, 'departure_incomplete');
        return rows;
    }
    return view.screen.locationOverview(location.name).timers;
}
function compareTimer(native, row, editor) {
    requireValue(native.id === row.id && native.time === row.time && native.enabled === row.enabled
        && native.repeat === editor.repeat && (editor.time === null || native.time === editor.time));
    if (Array.isArray(row.days)) requireValue(same(native.days, row.days));
}
async function timer(c, kind, id, baseline, location = null) {
    return protectedRead(c, async () => {
        await c._version();
        let parent = await read(c);
        const expectedKind = kind === 'climate' ? 'departuresOverview' : 'locationOverview';
        requireValue(parent.screen.kind() === expectedKind, 'unexpected_screen');
        const rows = parentTimers(parent, kind, location);
        requireValue(same(rows, baseline));
        if (location) await identity(c, parent, location);
        parent = await read(c);
        requireValue(same(parentTimers(parent, kind, location), baseline));
        const point = parent.screen.overviewTimer(id, 'editor');
        await c._step(() => c.phone.tap(point.x, point.y));
        let view = clean(await waitForScreen(c, 'timerEditor'));
        const editor = view.screen.timerEditor();
        const expectation = { kind, id, ...(location ? { locationId: location.nativeId } : {}) };
        const native = parseDepartureTimer(await c._step(() => c.phone.departureNative()), expectation);
        compareTimer(native, baseline.find(row => row.id === id), editor);
        view = clean(await read(c));
        requireValue(view.screen.kind() === 'timerEditor' && same(view.screen.timerEditor(), editor));
        const verified = parseDepartureTimer(await c._step(() => c.phone.departureNative()), expectation);
        requireValue(same(native, verified));
        const returned = await back(c, 'timerEditor', expectedKind, fresh => {
            requireValue(same(fresh.screen.timerEditor(), editor));
        });
        requireValue(same(parentTimers(returned, kind, location), baseline));
        if (location) await identity(c, returned, location);
        const { climatisation, profileId, isPreferredTimesAvailable, ...core } = native;
        const row = baseline.find(item => item.id === id);
        const normalized = { ...normalizeObservedTimer(core), daysSummary: row.daysText,
            daysSummaryRecognized: Array.isArray(row.days) };
        return kind === 'charging' ? { ...normalized, climatisation, profileId, isPreferredTimesAvailable } : normalized;
    });
}
async function settings(c, location) {
    return protectedRead(c, async () => {
        await c._version();
        let view = await read(c);
        await identity(c, view, location);
        view = await read(c);
        view.screen.locationOverview(location.name);
        const gear = view.screen.headerTarget('right');
        await c._step(() => c.phone.tap(gear.x, gear.y));
        view = clean(await waitForScreen(c, 'locationSettings'));
        await identity(c, view, location);
        const found = { name: null, directSoc: null, socLimit: null, reducedAcCurrent: null, autoUnlockAc: null };
        let available = false;
        // Settings may reopen at a previous scroll position. An upward sweep
        // first recovers the name without changing any field or draft.
        for (let attempt = 0; attempt < 6 && view.screen.gearSettings().name === null; attempt++) {
            view = await move(c, view, 'up', 'locationSettings');
            await identity(c, view, location);
        }
        for (let page = 0; page < 6; page++) {
            const values = view.screen.gearSettings();
            requireValue(values.canSave === false, 'unsaved_settings');
            for (const key of Object.keys(found)) if (values[key] !== null) {
                requireValue(found[key] === null || found[key] === values[key]);
                found[key] = values[key];
            }
            available ||= values.preferredTimesAvailable;
            if (found.name !== null && found.reducedAcCurrent !== null && found.autoUnlockAc !== null && available) break;
            if (page === 5) throw failure('departure_incomplete');
            view = await move(c, view, 'down', 'locationSettings');
            await identity(c, view, location);
        }
        requireValue(found.name === location.name && typeof found.reducedAcCurrent === 'boolean'
            && typeof found.autoUnlockAc === 'boolean' && available, 'departure_incomplete');
        await c._version();
        view = clean(await read(c));
        await identity(c, view, location);
        const nav = view.screen.preferredNavTarget();
        await c._step(() => c.phone.tap(nav.x, nav.y));
        view = clean(await waitForScreen(c, 'preferredTimes'));
        await identity(c, view, location);
        const preferred = view.screen.preferredTimes();
        requireValue(preferred.windows.length === 4 && preferred.windows.every(window => window.editable === false), 'departure_incomplete');
        view = clean(await read(c));
        requireValue(same(view.screen.preferredTimes(), preferred));
        await identity(c, view, location);
        view = await back(c, 'preferredTimes', 'locationSettings', fresh => requireValue(same(fresh.screen.preferredTimes(), preferred)));
        await identity(c, clean(view), location);
        view = await back(c, 'locationSettings', 'locationOverview', fresh => {
            const values = fresh.screen.gearSettings();
            if (values.name !== null) requireValue(values.name === location.name, 'departure_location_mismatch');
            for (const key of ['reducedAcCurrent', 'autoUnlockAc']) if (values[key] !== null) requireValue(values[key] === found[key]);
        });
        await identity(c, view, location);
        return { settings: found, preferredTimes: { windows: preferred.windows.map(window => ({ ...window })), notice: preferred.notice } };
    });
}
async function home(c) {
    const screen = await returnFromDeparturePage(c);
    requireValue(screen?.kind() === 'overview', 'departure_incomplete');
    screen.requireVehicle(c.config.vehicleMarker);
    await c._version();
    c._check();
}
async function climateResult(c, view = null) {
    const current = await top(c, view ?? await read(c));
    const baseline = parentTimers(current, 'climate');
    const timers = [];
    for (const id of ['1', '2']) timers.push(await timer(c, 'climate', id, baseline));
    requireValue(same(parentTimers(await read(c), 'climate'), baseline));
    await home(c);
    return { domain: 'departureClimate', timers };
}
function overviewTimerResults(rows) {
    return rows.map(row => ({ id: row.id, time: row.time, enabled: row.enabled,
        daysSummary: row.daysText, daysSummaryRecognized: Array.isArray(row.days) }));
}
async function climateOverviewResult(c, view = null) {
    const current = await top(c, view ?? await read(c));
    const baseline = parentTimers(current, 'climate');
    requireValue(same(parentTimers(await read(c), 'climate'), baseline));
    await home(c);
    return { domain: 'departureClimate', partial: true, timers: overviewTimerResults(baseline) };
}
async function locationOverviewResult(c, location, view = null) {
    const current = view ?? await read(c);
    await identity(c, current, location);
    const baseline = parentTimers(current, 'charging', location);
    const values = await settings(c, location);
    const currentRows = await read(c);
    await identity(c, currentRows, location);
    requireValue(same(parentTimers(currentRows, 'charging', location), baseline));
    await home(c);
    return { domain: 'departureLocation', partial: true, location: { ...location },
        timers: overviewTimerResults(baseline), ...values };
}
async function locationResult(c, location, view = null) {
    const current = view ?? await read(c);
    await identity(c, current, location);
    const baseline = parentTimers(current, 'charging', location);
    const timers = [];
    for (const id of ['1', '2', '3']) timers.push(await timer(c, 'charging', id, baseline, location));
    const values = await settings(c, location);
    requireValue(same(parentTimers(await read(c), 'charging', location), baseline));
    await home(c);
    return { domain: 'departureLocation', location: { ...location }, timers, ...values };
}
async function run(c, action, options) {
    let view = await open(c);
    if (action === 'departuresClimateStatus') return options.overviewOnly ? climateOverviewResult(c, view) : climateResult(c, view);
    const discovered = await collect(c, view);
    if (action === 'departuresLocationsStatus') {
        const locations = [], ids = new Set();
        for (const row of discovered.locations) {
            const opened = await openLocation(c, row, discovered.locations);
            requireValue(!ids.has(opened.location.nativeId), 'departure_location_mismatch');
            ids.add(opened.location.nativeId);
            locations.push({ ...opened.location, activeCount: row.activeCount });
            await back(c, 'locationOverview', 'departuresOverview', fresh => fresh.screen.locationOverview(row.name), opened.location);
        }
        const final = await collect(c, await read(c));
        requireValue(same([...final.locations].sort((a, b) => a.name.localeCompare(b.name)),
            [...discovered.locations].sort((a, b) => a.name.localeCompare(b.name))));
        await home(c);
        return { domain: 'departureLocations', locations };
    }
    const row = discovered.locations.find(item => item.name === options.location.name);
    requireValue(row, 'departure_location_mismatch');
    const opened = await openLocation(c, row, discovered.locations, options.location);
    return options.overviewOnly ? locationOverviewResult(c, opened.location, opened.view) : locationResult(c, opened.location, opened.view);
}

function resolvedTimer(initial, target) {
    const result = { ...initial, days: [...initial.days] };
    for (const key of ['time', 'enabled', 'repeat', 'days']) if (target[key] !== null) {
        result[key] = key === 'days' ? [...target[key]] : target[key];
    }
    requireValue(result.repeat || result.days.length === 1, 'unsupported_departure_combination');
    return result;
}
function savedTimerMatches(actual, wanted, initial) {
    for (const key of ['id', 'time', 'enabled', 'repeat', 'vehicleOffset', 'isLocalVehicleTime',
        'profileId', 'climatisation', 'isPreferredTimesAvailable']) requireValue(actual[key] === wanted[key], 'departure_setting_not_confirmed');
    requireValue(same(actual.days, wanted.days), 'departure_setting_not_confirmed');
    if (!initial.repeat && !wanted.repeat && same(initial.days, wanted.days)) {
        requireValue(actual.date === initial.date, 'departure_setting_not_confirmed');
    }
}

class DepartureWriteFlow {
    constructor(c, options) {
        this.c = c; this.options = options;
        this.pending = false; this.unverifiedDays = false;
        this.saveIssued = false; this.saveVerified = false;
        this.commitPending = false;
        this.changed = false;
    }
    uncertain() { return this.pending || this.unverifiedDays || this.commitPending || this.saveIssued && !this.saveVerified; }
    async settle() {
        const until = this.c.now() + 20000;
        while (this.c.now() < until) await this.c._pause(Math.min(500, until - this.c.now()));
        this.c._check();
    }
    async nativeTimer(expectation, initial = null) {
        const native = parseDepartureTimer(await this.c._step(() => this.c.phone.departureNative()), expectation);
        if (initial) requireValue(same(native, initial));
        return native;
    }
    async enterTimer(kind, id, location, baseline = null) {
        const c = this.c;
        await c._version();
        let parent = clean(await read(c));
        const rows = parentTimers(parent, kind, location);
        if (baseline) requireValue(same(rows, baseline));
        if (location) await identity(c, parent, location);
        parent = clean(await read(c));
        requireValue(same(parentTimers(parent, kind, location), rows));
        const point = parent.screen.overviewTimer(id, 'editor');
        await c._step(() => c.phone.tap(point.x, point.y));
        let view = clean(await waitForScreen(c, 'timerEditor'));
        const expectation = { kind, id, ...(location ? { locationId: location.nativeId } : {}) };
        const native = await this.nativeTimer(expectation);
        compareTimer(native, rows.find(row => row.id === id), view.screen.timerEditor());
        view = clean(await read(c));
        compareTimer(native, rows.find(row => row.id === id), view.screen.timerEditor());
        return { view, native, expectation, rows };
    }
    editorValues(view, expected, dirty) {
        requireValue(view.screen.kind() === 'timerEditor', 'unexpected_screen');
        const state = view.screen.timerEditor();
        requireValue(state.time === expected.time && state.repeat === expected.repeat);
        requireValue(state.canSave === dirty, dirty ? 'departure_setting_not_confirmed' : 'unsaved_settings');
        return state;
    }
    async timerFresh(session, expected, dirty) {
        await this.c._version();
        await this.nativeTimer(session.expectation, session.native);
        const view = await read(this.c);
        this.editorValues(view, expected, dirty);
        return view;
    }
    async confirmDraft(kind, expected, check, first = null) {
        const until = this.c.now() + 8000;
        let view = first;
        while (true) {
            view ??= await read(this.c);
            requireValue(view.screen.kind() === kind, 'unexpected_screen');
            if (check(view, expected)) { this.pending = false; this.changed = true; return view; }
            if (this.c.now() >= until) throw failure('departure_setting_not_confirmed');
            await this.c._pause(Math.min(this.c.pollIntervalMs, until - this.c.now()));
            view = null;
        }
    }
    async accessibility(view, header, target, action, value, check) {
        this.pending = true;
        const result = await this.c._step(() => this.c.phone.departureAction({
            snapshot: view.observation, header, target, action, value,
        }));
        if (result?.actionAttempted === false) {
            this.pending = false;
            throw failure('departure_setting_not_confirmed');
        }
        requireValue(result?.beforeMatched === true && result.actionAttempted === true
            && result.actionAccepted === true, 'departure_outcome_unknown');
        const first = result.postRead ? viewFrom(result.postRead) : null;
        return this.confirmDraft(view.screen.kind(), null, check, first);
    }
    async timerTime(session, expected, desired, dirty) {
        for (const [part, index, modulus, unit] of [['hour', 0, 24, 1], ['minute', 1, 12, 5]]) {
            const wanted = Number(desired.split(':')[index]);
            const old = Number(expected.time.split(':')[index]);
            if (wanted === old) continue;
            const view = await this.timerFresh(session, expected, dirty);
            const wheel = view.screen.wheelTarget(part);
            requireValue(wheel.state === old && Number.isInteger(wheel.range.current), 'departure_changed');
            let delta = (wanted - old) / unit;
            requireValue(Number.isInteger(delta), 'unsupported_departure_time');
            if (delta > modulus / 2) delta -= modulus;
            if (delta < -modulus / 2) delta += modulus;
            const progress = wheel.range.current + delta;
            requireValue(progress >= wheel.range.min && progress <= wheel.range.max, 'departure_setting_not_confirmed');
            const parts = expected.time.split(':'); parts[index] = String(wanted).padStart(2, '0');
            const next = { ...expected, time: parts.join(':') };
            await this.accessibility(view, 'Zeit einstellen', { description: part === 'hour' ? 'Hour' : 'Minute',
                bounds: wheel.bounds }, 'setProgress', progress, current => {
                const state = current.screen.timerEditor();
                requireValue(state.repeat === expected.repeat);
                requireValue(state.time === expected.time || state.time === next.time);
                return state.time === next.time && state.canSave;
            });
            expected = next; dirty = true;
        }
        return { expected, dirty };
    }
    async timerRepeat(session, expected, desired, dirty) {
        if (expected.repeat === desired) return { expected, dirty };
        const view = await this.timerFresh(session, expected, dirty);
        const point = view.screen.repeatTarget(desired);
        this.pending = true;
        await this.c._step(() => this.c.phone.tap(point.x, point.y));
        await this.confirmDraft('timerEditor', null, current => {
            const state = current.screen.timerEditor();
            requireValue(state.time === expected.time);
            return state.repeat === desired && state.canSave;
        });
        return { expected: { ...expected, repeat: desired }, dirty: true };
    }
    async timerDays(session, expected, wanted, dirty) {
        const add = wanted.filter(day => !expected.days.includes(day));
        const remove = expected.days.filter(day => !wanted.includes(day));
        for (const day of [...add, ...remove]) {
            const view = await this.timerFresh(session, expected, dirty);
            const point = view.screen.dayTarget(day);
            const nextDays = expected.days.includes(day) ? expected.days.filter(item => item !== day)
                : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].filter(item => expected.days.includes(item) || item === day);
            this.pending = true; this.unverifiedDays = true;
            await this.c._step(() => this.c.phone.tap(point.x, point.y));
            const confirmed = await this.confirmDraft('timerEditor', null, current => {
                const state = current.screen.timerEditor();
                requireValue(state.time === expected.time);
                // Observed app behavior: adding another weekday to a Single
                // selection automatically turns Repeat on. Day buttons still
                // carry no checked state, so Save+native Reopen is mandatory.
                const automaticRepeat = !expected.repeat && nextDays.length > 1 && add.includes(day);
                const nextRepeat = automaticRepeat ? true : expected.repeat;
                requireValue(state.repeat === expected.repeat || state.repeat === nextRepeat);
                return state.canSave && state.repeat === nextRepeat;
            });
            expected = { ...expected, days: nextDays, repeat: confirmed.screen.timerEditor().repeat };
            dirty = true;
        }
        return { expected: { ...expected, days: [...wanted] }, dirty };
    }
    async save(kind, verify) {
        const c = this.c;
        await c._version();
        let view = await read(c);
        requireValue(view.screen.kind() === kind, 'unexpected_screen');
        await verify(view);
        // The verification may read the native fragment. Consume a fresh rich
        // frame for the only Save gesture, retaining every expected draft field.
        view = await read(c); await verify(view);
        const point = view.screen.saveTarget();
        this.saveIssued = true; this.saveVerified = false; this.commitPending = true;
        await c._step(() => c.phone.tap(point.x, point.y));
        const until = c.now() + 60000;
        while (true) {
            try {
                view = await read(c);
                const current = view.screen.kind();
                if (current === kind) {
                    const values = kind === 'timerEditor' ? view.screen.timerEditor()
                        : kind === 'locationSettings' ? view.screen.gearSettings() : view.screen.preferredTimes();
                    if (!values.canSave) { await this.settle(); return view; }
                } else if ((kind === 'timerEditor' && ['departuresOverview', 'locationOverview'].includes(current))
                    || kind === 'locationSettings' && current === 'locationOverview'
                    || kind === 'preferredTimes' && current === 'locationSettings') {
                    clean(view); await this.settle(); return view;
                }
                else requireValue(current === 'unknown', 'unexpected_screen');
            } catch (error) {
                // A disabled Save control can temporarily make the strict page
                // parser unknown. Observe only; never issue Save a second time.
                if (!(error instanceof BridgeError) || error.code !== 'unknown_state') throw error;
            }
            if (c.now() >= until) throw failure('departure_setting_not_confirmed');
            await c._pause(Math.min(c.pollIntervalMs, until - c.now()));
        }
    }
    async closeTimer(kind, location, expected) {
        let view = await read(this.c);
        const parentKind = kind === 'climate' ? 'departuresOverview' : 'locationOverview';
        if (view.screen.kind() === 'timerEditor') {
            view = await back(this.c, 'timerEditor', parentKind, fresh => {
                const values = fresh.screen.timerEditor();
                requireValue(values.time === expected.time && values.repeat === expected.repeat);
            });
        }
        requireValue(view.screen.kind() === parentKind, 'unexpected_screen');
        if (location) await identity(this.c, view, location);
        return view;
    }
    async applyTimer(kind, location) {
        const c = this.c, { timerId: id, targetTimer: target, dryRun } = this.options;
        let session = await this.enterTimer(kind, id, location);
        const initial = session.native, wanted = resolvedTimer(initial, target);
        // Preflight every requested control before the first possible draft.
        if (wanted.time !== initial.time) {
            session.view.screen.wheelTarget('hour'); session.view.screen.wheelTarget('minute');
            requireValue(Number(initial.time.slice(3)) % 5 === 0, 'unsupported_departure_time');
        }
        if (wanted.repeat !== initial.repeat) session.view.screen.repeatTarget(wanted.repeat);
        for (const day of [...new Set([...initial.days, ...wanted.days])]) session.view.screen.dayTarget(day);
        const change = ['time', 'enabled', 'repeat', 'days'].some(key => !same(initial[key], wanted[key]));
        if (dryRun || !change) {
            await this.closeTimer(kind, location, initial);
            const result = kind === 'climate' ? await climateResult(c) : await locationResult(c, location);
            if (!dryRun) confirmTargets(result.timers.find(item => item.id === id), target);
            return { ...result, changed: false, ...(dryRun ? { wouldSetTimer: { ...target, days: target.days && [...target.days] } } : {}) };
        }
        let expected = { ...initial, days: [...initial.days] }, dirty = false;
        let actualEnabled = initial.enabled;
        ({ expected, dirty } = await this.timerTime(session, expected, wanted.time, dirty));
        // Preserve the saved selection when converting modes: select one day
        // while still recurring, or enter recurring before adding more days.
        if (!expected.repeat && wanted.repeat) ({ expected, dirty } = await this.timerRepeat(session, expected, true, dirty));
        ({ expected, dirty } = await this.timerDays(session, expected, wanted.days, dirty));
        ({ expected, dirty } = await this.timerRepeat(session, expected, wanted.repeat, dirty));
        if (dirty) {
            await this.save('timerEditor', async view => {
                this.editorValues(view, expected, true);
                await this.nativeTimer(session.expectation, session.native);
            });
            await this.closeTimer(kind, location, expected);
            session = await this.enterTimer(kind, id, location);
            actualEnabled = session.native.enabled;
            savedTimerMatches(session.native, { ...wanted, enabled: actualEnabled }, initial);
            this.unverifiedDays = false;
        }
        const approvedRows = session.rows;
        await this.closeTimer(kind, location, dirty ? session.native : initial);
        if (wanted.enabled !== actualEnabled) {
            await c._version();
            let view = clean(await read(c));
            const baseline = parentTimers(view, kind, location);
            requireValue(same(baseline, approvedRows));
            if (location) await identity(c, view, location);
            view = clean(await read(c));
            requireValue(same(parentTimers(view, kind, location), baseline));
            const row = baseline.find(item => item.id === id);
            requireValue(row.time === wanted.time && row.enabled === actualEnabled);
            const point = view.screen.overviewTimer(id, 'enabled');
            this.pending = true; this.commitPending = true;
            await c._step(() => c.phone.tap(point.x, point.y));
            const until = c.now() + 8000;
            while (true) {
                view = await read(c);
                // A new Save must be deliberately supported, never mistaken for
                // the gear button or dismissed by returning to another page.
                clean(view);
                const rows = parentTimers(view, kind, location);
                const expectedRows = baseline.map(item => item.id === id ? { ...item, enabled: wanted.enabled } : item);
                if (same(rows, expectedRows)) break;
                requireValue(same(rows, baseline));
                if (c.now() >= until) throw failure('departure_setting_not_confirmed');
                await c._pause(Math.min(c.pollIntervalMs, until - c.now()));
            }
            await this.settle();
            view = clean(await read(c));
            requireValue(same(parentTimers(view, kind, location),
                baseline.map(item => item.id === id ? { ...item, enabled: wanted.enabled } : item)), 'departure_setting_not_confirmed');
            // Reopening, rather than the switch animation, proves persistence.
            session = await this.enterTimer(kind, id, location);
            savedTimerMatches(session.native, wanted, initial);
            this.pending = false; this.changed = true;
            await this.closeTimer(kind, location, session.native);
        }
        // Saving the timer editor can enable the timer even when it was
        // previously disabled. Only the final native state, after at most one
        // corrective switch gesture, completes the requested transaction.
        const result = kind === 'climate' ? await climateResult(c) : await locationResult(c, location);
        savedTimerMatches(result.timers.find(item => item.id === id), wanted, initial);
        this.saveVerified = true; this.commitPending = false;
        return { ...result, changed: this.changed };
    }
    gearValues(view, expected, dirty) {
        requireValue(view.screen.kind() === 'locationSettings', 'unexpected_screen');
        const values = view.screen.gearSettings();
        for (const key of ['name', 'reducedAcCurrent', 'autoUnlockAc']) if (values[key] !== null) {
            requireValue(values[key] === expected[key]);
        }
        requireValue(values.canSave === dirty, dirty ? 'departure_setting_not_confirmed' : 'unsaved_settings');
        return values;
    }
    async gearFresh(location, expected, dirty) {
        await this.c._version();
        const view = await read(this.c);
        this.gearValues(view, expected, dirty);
        await identity(this.c, view, { nativeId: location.nativeId, name: null });
        const fresh = await read(this.c);
        this.gearValues(fresh, expected, dirty);
        return fresh;
    }
    async gearField(location, expected, key, dirty) {
        let view = await this.gearFresh(location, expected, dirty);
        const visible = current => key === 'preferredTimesAvailable' ? current[key] === true : current[key] !== null;
        if (visible(view.screen.gearSettings())) return view;
        for (const direction of ['up', 'down']) for (let step = 0; step < 6; step++) {
            view = await this.gearFresh(location, expected, dirty);
            const before = view.xml, gesture = view.screen.scrollTarget(direction);
            await this.c._step(() => this.c.phone.swipe(gesture));
            view = await this.gearFresh(location, expected, dirty);
            if (visible(view.screen.gearSettings())) return view;
            if (view.xml === before) break;
        }
        throw failure('departure_incomplete');
    }
    nameTarget(view) {
        const screen = view.screen, page = screen._base();
        requireValue(!page.readOnlyNonScrollable, 'target_unavailable');
        const nodes = screen._members(page.body).filter(node => node.attrs.class === 'android.widget.EditText');
        requireValue(nodes.length === 1 && screen.gearSettings().name !== null, 'departure_incomplete');
        screen._valid(nodes[0], page.body);
        return { class: 'android.widget.EditText', bounds: [...screen._bounds(nodes[0])] };
    }
    async openGear(location) {
        await this.c._version();
        let view = clean(await read(this.c)); await identity(this.c, view, location);
        view = clean(await read(this.c)); view.screen.locationOverview(location.name);
        const point = view.screen.headerTarget('right');
        await this.c._step(() => this.c.phone.tap(point.x, point.y));
        view = clean(await waitForScreen(this.c, 'locationSettings'));
        requireValue(!view.screen._base().readOnlyNonScrollable, 'target_unavailable');
        await identity(this.c, view, location);
        return view;
    }
    async applyGear(location, all) {
        const c = this.c, { targetSettings: target, dryRun } = this.options;
        const baseline = await settings(c, location);
        let expected = { ...baseline.settings };
        const wanted = { ...expected };
        for (const key of ['name', 'reducedAcCurrent', 'autoUnlockAc']) if (target[key] !== null) wanted[key] = target[key];
        if (wanted.name !== location.name) requireValue(!all.some(row => row.name === wanted.name), 'departure_location_mismatch');
        const changes = ['reducedAcCurrent', 'autoUnlockAc', 'name'].filter(key => wanted[key] !== expected[key]);
        if (!changes.length || dryRun) {
            const result = await locationResult(c, location);
            if (!dryRun) confirmTargets(result.settings, target);
            return { ...result, changed: false, ...(dryRun ? { wouldSetSettings: { ...target } } : {}) };
        }
        await this.openGear(location);
        // Inspect all controls before any draft change, including offscreen ones.
        for (const key of changes) {
            const view = await this.gearField(location, expected, key, false);
            if (key === 'name') this.nameTarget(view); else view.screen.gearToggleTarget(key, wanted[key]);
        }
        let dirty = false;
        for (const key of changes) {
            const view = await this.gearField(location, expected, key, dirty);
            const next = { ...expected, [key]: wanted[key] };
            const check = current => {
                const values = current.screen.gearSettings();
                for (const field of ['name', 'reducedAcCurrent', 'autoUnlockAc']) if (field !== key && values[field] !== null) {
                    requireValue(values[field] === expected[field]);
                }
                requireValue(values[key] === expected[key] || values[key] === next[key]);
                return values[key] === next[key] && values.canSave;
            };
            if (key === 'name') await this.accessibility(view, 'Ladeeinstellungen', this.nameTarget(view), 'setText', wanted.name, check);
            else {
                const point = view.screen.gearToggleTarget(key, wanted[key]);
                this.pending = true;
                await c._step(() => c.phone.tap(point.x, point.y));
                await this.confirmDraft('locationSettings', null, check);
            }
            expected = next; dirty = true;
        }
        // The settings page can be split across scroll positions. Revisit all
        // observed editable fields after the last mutation, so an offscreen
        // preference is not silently included in the following form Save.
        for (const key of ['name', 'reducedAcCurrent', 'autoUnlockAc']) {
            await this.gearField(location, expected, key, true);
        }
        await this.save('locationSettings', async view => {
            this.gearValues(view, expected, true);
            await identity(c, view, { nativeId: location.nativeId, name: null });
        });
        let view = await read(c);
        const renamed = wanted.name !== location.name;
        const confirmed = { nativeId: location.nativeId, name: wanted.name };
        if (view.screen.kind() === 'locationSettings') {
            this.gearValues(view, expected, false);
            view = await back(c, 'locationSettings', 'locationOverview');
        }
        requireValue(view.screen.kind() === 'locationOverview', 'unexpected_screen');
        await identity(c, view, confirmed);
        if (renamed) {
            await back(c, 'locationOverview', 'departuresOverview', fresh => fresh.screen.locationOverview(confirmed.name));
            const discovered = await collect(c, await read(c));
            const expectedNames = all.map(row => ({ ...row, name: row.name === location.name ? wanted.name : row.name }));
            requireValue(same([...discovered.locations].sort((a, b) => a.name.localeCompare(b.name)),
                [...expectedNames].sort((a, b) => a.name.localeCompare(b.name))), 'departure_setting_not_confirmed');
            const row = discovered.locations.find(item => item.name === wanted.name);
            await openLocation(c, row, discovered.locations, confirmed);
        }
        const verified = await settings(c, confirmed);
        requireValue(same(verified.settings, expected)
            && same(verified.preferredTimes, baseline.preferredTimes), 'departure_setting_not_confirmed');
        const result = await locationResult(c, confirmed);
        requireValue(same(result.settings, expected) && same(result.preferredTimes, baseline.preferredTimes), 'departure_setting_not_confirmed');
        this.saveVerified = true; this.commitPending = false;
        return { ...result, changed: true, ...(renamed ? { renamedFrom: location.name } : {}) };
    }
    async preferredFresh(location, expected, dirty) {
        await this.c._version();
        let view = await read(this.c);
        requireValue(view.screen.kind() === 'preferredTimes', 'unexpected_screen');
        let values = view.screen.preferredTimes();
        requireValue(same(values.windows, expected.windows) && values.notice === expected.notice);
        requireValue(values.canSave === dirty, dirty ? 'departure_setting_not_confirmed' : 'unsaved_settings');
        await identity(this.c, view, location);
        view = await read(this.c); values = view.screen.preferredTimes();
        requireValue(same(values.windows, expected.windows) && values.notice === expected.notice && values.canSave === dirty);
        return view;
    }
    async applyPreferred(location) {
        const c = this.c, { targetPreferredTimes: target, dryRun } = this.options;
        const baseline = await settings(c, location);
        let expected = { ...baseline.preferredTimes, windows: baseline.preferredTimes.windows.map(row => ({ ...row })) };
        const changes = target.filter(row => row.enabled !== null && row.enabled !== expected.windows.find(item => item.id === row.id).enabled);
        if (!changes.length || dryRun) {
            const result = await locationResult(c, location);
            if (!dryRun) for (const row of target) {
                confirmTargets(result.preferredTimes.windows.find(item => item.id === row.id), { enabled: row.enabled });
            }
            return { ...result, changed: false, ...(dryRun ? { wouldSetPreferredTimes: target.map(row => ({ ...row })) } : {}) };
        }
        let view = await this.openGear(location);
        view = await this.gearField(location, baseline.settings, 'preferredTimesAvailable', false);
        requireValue(view.screen.gearSettings().preferredTimesAvailable, 'departure_incomplete');
        const nav = view.screen.preferredNavTarget();
        await c._step(() => c.phone.tap(nav.x, nav.y));
        view = clean(await waitForScreen(c, 'preferredTimes'));
        view = await this.preferredFresh(location, expected, false);
        for (const row of changes) view.screen.preferredToggleTarget(row.id, row.enabled);
        let dirty = false;
        for (const row of changes) {
            view = await this.preferredFresh(location, expected, dirty);
            const next = { ...expected, windows: expected.windows.map(item => item.id === row.id ? { ...item, enabled: row.enabled } : item) };
            const point = view.screen.preferredToggleTarget(row.id, row.enabled);
            this.pending = true;
            await c._step(() => c.phone.tap(point.x, point.y));
            view = await this.confirmDraft('preferredTimes', null, current => {
                const values = current.screen.preferredTimes();
                requireValue(values.notice === expected.notice);
                requireValue(same(values.windows, expected.windows) || same(values.windows, next.windows));
                if (dirty) requireValue(values.canSave);
                return same(values.windows, next.windows);
            });
            expected = next;
            dirty = view.screen.preferredTimes().canSave;
            if (!dirty) {
                // Some app versions persist this switch directly. No second
                // persistence request may overlap its delayed backend reply.
                this.pending = true; this.commitPending = true;
                await this.settle();
                view = await read(c);
                const values = view.screen.preferredTimes();
                requireValue(same(values.windows, expected.windows) && values.notice === expected.notice);
                await identity(c, view, location);
                dirty = values.canSave;
                if (!dirty) {
                    await back(c, 'preferredTimes', 'locationSettings', fresh => {
                        const current = fresh.screen.preferredTimes();
                        requireValue(same(current.windows, expected.windows) && current.notice === expected.notice);
                    });
                    view = await this.gearField(location, baseline.settings, 'preferredTimesAvailable', false);
                    const reopen = view.screen.preferredNavTarget();
                    await c._step(() => c.phone.tap(reopen.x, reopen.y));
                    await waitForScreen(c, 'preferredTimes');
                    await this.preferredFresh(location, expected, false);
                }
                this.pending = false;
            }
        }
        if (dirty) await this.save('preferredTimes', async current => {
            const values = current.screen.preferredTimes();
            requireValue(same(values.windows, expected.windows) && values.notice === expected.notice && values.canSave);
            await identity(c, current, location);
        });
        view = await read(c);
        if (view.screen.kind() === 'preferredTimes') {
            clean(view);
            await back(c, 'preferredTimes', 'locationSettings');
        } else requireValue(view.screen.kind() === 'locationSettings', 'unexpected_screen');
        await identity(c, clean(await read(c)), location);
        await back(c, 'locationSettings', 'locationOverview');
        const verified = await settings(c, location);
        requireValue(same(verified.preferredTimes, expected) && same(verified.settings, baseline.settings), 'departure_setting_not_confirmed');
        const result = await locationResult(c, location);
        requireValue(same(result.preferredTimes, expected) && same(result.settings, baseline.settings), 'departure_setting_not_confirmed');
        this.saveVerified = true; this.commitPending = false;
        return { ...result, changed: true };
    }
    async run(action) {
        let view = await open(this.c);
        if (action === 'applyDepartureClimateTimer') {
            view = await top(this.c, view);
            return this.options.dryRun ? protectedRead(this.c, () => this.applyTimer('climate', null))
                : this.applyTimer('climate', null);
        }
        const discovered = await collect(this.c, view);
        const row = discovered.locations.find(item => item.name === this.options.location.name);
        requireValue(row, 'departure_location_mismatch');
        const opened = await openLocation(this.c, row, discovered.locations, this.options.location);
        if (action === 'applyDepartureLocationTimer') return this.options.dryRun
            ? protectedRead(this.c, () => this.applyTimer('charging', opened.location))
            : this.applyTimer('charging', opened.location);
        if (action === 'applyDepartureLocationSettings') return this.applyGear(opened.location, discovered.locations);
        return this.applyPreferred(opened.location);
    }
}

async function executeDepartures(c, action, input = {}) {
    if (!ACTIONS.includes(action)) throw failure('invalid_action');
    const options = optionsFor(action, input);
    if (c.closing) throw new BridgeError('cancelled', 'Der Adapter wird beendet; keine weiteren Eingaben.');
    if (c.busy) throw new BridgeError('busy', 'Ein anderer Auftrag läuft bereits.');
    const write = WRITE_ACTIONS.includes(action);
    if (write && !options.dryRun && !c.config.allowWrites) throw failure('writes_disabled');
    c.busy = true;
    const previousFlags = { readOnlyExecution: c.readOnlyExecution, readHandoffRequested: c.readHandoffRequested,
        readHandoffProtected: c.readHandoffProtected };
    c.readOnlyExecution = !write || options.dryRun; c.readHandoffRequested = false; c.readHandoffProtected = false;
    c.observedTemperature = null; c.observedSettings = { ...DEFAULT_TARGET_SETTINGS };
    c.deadline = c.now() + c.config.commandTimeoutSeconds * 1000;
    c.phone.deadline = c.deadline;
    let flow;
    try {
        await c._connect();
        const appVersion = await c._version();
        flow = write ? new DepartureWriteFlow(c, options) : null;
        const result = flow ? await flow.run(action) : await run(c, action, options);
        c._check();
        return { ...result, source: 'volkswagen_android_app', vehicleConfirmed: false, appVersion,
            observedAt: new Date(c.now()).toISOString(), ...(options.dryRun ? { dryRun: true } : {}) };
    } catch (error) {
        if (flow?.uncertain()) throw failure('departure_outcome_unknown');
        if (error instanceof BridgeError) throw error;
        throw new BridgeError('internal_error', 'Die Abfahrtszeiten konnten nicht sicher gelesen werden.');
    } finally {
        c.phone.deadline = null; c.deadline = null; c.busy = false;
        Object.assign(c, previousFlags);
    }
}

module.exports = { executeDepartures, returnFromDeparturePage };
