'use strict';

const { TextDecoder } = require('node:util');
const { BridgeError } = require('./errors');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 40000;
const MAX_LINE_LENGTH = 16384;
const MAX_ARGUMENT_LENGTH = 4096;
const FRAGMENT = 'EditDepartureTimerFragment';
const LOCATION_FRAGMENTS = Object.freeze(['ChargingLocationOverviewFragment', 'ChargingLocationSettingsFragment', 'PreferredChargingTimesFragment']);
const ALLOWED_FRAGMENT_START = /^ *(?:EditDepartureTimerFragment|ChargingLocationOverviewFragment|ChargingLocationSettingsFragment|PreferredChargingTimesFragment)(?:\{|$)/;
const FRAGMENT_HEADER = /^( *)(EditDepartureTimerFragment|ChargingLocationOverviewFragment|ChargingLocationSettingsFragment|PreferredChargingTimesFragment)\{[0-9a-fA-F]+\} \(([A-Za-z0-9-]+) id=0x[0-9a-fA-F]+ tag=[A-Za-z0-9_-]+\) *$/;
const DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const NATIVE_DAYS = Object.freeze(['sundays', 'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays', 'saturdays']);

function unavailable() {
    // The native dump may contain private names, identifiers and other app
    // state. Never echo raw lines, fragment tokens or supplied values.
    return new BridgeError('departure_native_unavailable', 'Der native Abfahrtstimer lässt sich nicht sicher mit der geöffneten App-Ansicht abgleichen.');
}

function requireCondition(condition) {
    if (!condition) throw unavailable();
}

function sourceText(input) {
    let text;
    if (Buffer.isBuffer(input)) {
        requireCondition(input.length <= MAX_BYTES);
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(input); }
        catch (_) { throw unavailable(); }
    } else {
        requireCondition(typeof input === 'string' && Buffer.byteLength(input, 'utf8') <= MAX_BYTES);
        text = input;
    }
    text = text.replaceAll('\r\n', '\n');
    requireCondition(text.length > 0 && !/[\x00-\x09\x0b-\x1f\ufffe\uffff]/.test(text)
        && !/[\ud800-\udfff]/u.test(text));
    const lines = text.split('\n');
    requireCondition(lines.length <= MAX_LINES && lines.every(line => line.length <= MAX_LINE_LENGTH));
    return lines;
}

function indent(line) { return line.search(/\S/); }

function activeSection(lines, index, depth) {
    // Added Fragments / Back Stack repeat the same fragment identity. Only a
    // full, unprefixed fragment block in Active Fragments can be a candidate.
    for (let i = index - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        const current = indent(lines[i]);
        if (current < depth) return false;
        if (current !== depth) continue;
        const title = lines[i].trim();
        if (title === 'Active Fragments:') return true;
        if (/^(?:Added Fragments|Back Stack|FragmentManager misc state|Back Stack Index):/.test(title)) return false;
    }
    return false;
}

function singleField(fields, prefix, pattern) {
    const values = fields.filter(line => line.startsWith(prefix));
    requireCondition(values.length === 1);
    const match = pattern.exec(values[0]);
    requireCondition(match);
    return match;
}

function extract(raw) {
    const lines = sourceText(raw);
    const activityIndexes = [];
    const stateIndexes = [];
    for (let i = 0; i < lines.length; i++) {
        if (/^ *ACTIVITY(?: |$)/.test(lines[i])) activityIndexes.push(i);
        if (/^ *mResumed=/.test(lines[i])) stateIndexes.push(i);
    }
    requireCondition(activityIndexes.length === 1 && stateIndexes.length === 1);
    const activityIndex = activityIndexes[0];
    const activity = /^( *)ACTIVITY com\.volkswagen\.weconnect\/(?:\.SingleActivity|com\.volkswagen\.weconnect\.SingleActivity) [0-9a-fA-F]+ pid=[1-9][0-9]* *$/.exec(lines[activityIndex]);
    requireCondition(activity && activity[1].length <= 32);
    const prelude = lines.slice(0, activityIndex).filter(line => line.trim());
    requireCondition(prelude.length === 0 || prelude.length === 1
        && /^TASK [1-9][0-9]*:com\.volkswagen\.weconnect id=[0-9]+ userId=[0-9]+ *$/.test(prelude[0]));
    const stateIndex = stateIndexes[0];
    requireCondition(stateIndex > activityIndex && indent(lines[stateIndex]) > activity[1].length
        && /^ +mResumed=true +mStopped=false +mFinished=false *$/.test(lines[stateIndex]));

    const candidates = [];
    let fragmentCount = 0;
    for (let index = stateIndex + 1; index < lines.length; index++) {
        if (!ALLOWED_FRAGMENT_START.test(lines[index])) continue;
        const depth = indent(lines[index]);
        if (!activeSection(lines, index, depth)) continue;
        const header = FRAGMENT_HEADER.exec(lines[index]);
        requireCondition(header && depth > activity[1].length && depth <= 256 && ++fragmentCount <= 32);
        const fields = [];
        for (let next = index + 1; next < lines.length; next++) {
            if (!lines[next].trim()) continue;
            const nextDepth = indent(lines[next]);
            if (nextDepth <= depth) break;
            if (nextDepth === depth + 4) fields.push(lines[next].trim());
        }
        const state = singleField(fields, 'mState=', /^mState=([0-9]+) mWho=([A-Za-z0-9-]+) mBackStackNesting=[0-9]+$/);
        requireCondition(state[2] === header[3]);
        const added = singleField(fields, 'mAdded=', /^mAdded=(true|false) mRemoving=(true|false) mFromLayout=(true|false) mInLayout=(true|false)$/);
        const hidden = singleField(fields, 'mHidden=', /^mHidden=(true|false) mDetached=(true|false) mMenuVisible=(true|false) mHasMenu=(true|false)$/);
        if (state[1] !== '7' || added[1] !== 'true' || added[2] !== 'false'
            || hidden[1] !== 'false' || hidden[2] !== 'false') continue;
        const args = singleField(fields, 'mArguments=', /^mArguments=(.{1,4096})$/)[1];
        requireCondition(args.length <= MAX_ARGUMENT_LENGTH);
        candidates.push({ fragment: header[2], arguments: args });
    }
    requireCondition(candidates.length === 1);
    return candidates[0];
}

function plainRecord(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value))
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function dateParts(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    requireCondition(match);
    const [year, month, day] = match.slice(1).map(Number);
    requireCondition(year >= 1 && month >= 1 && month <= 12);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    requireCondition(day >= 1 && day <= lengths[month - 1]);
    return { year, month, day };
}

function timeValue(value) {
    requireCondition(typeof value === 'string' && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value));
    return value;
}

function validOffset(value) {
    if (value === 'Z') return true;
    const match = /^[+-]([0-9]{2}):([0-9]{2})$/.exec(value);
    return Boolean(match && Number(match[1]) <= 18 && Number(match[2]) <= 59
        && (Number(match[1]) < 18 || Number(match[2]) === 0));
}

function validateCarTime(value) {
    const match = /^(\d{4}-\d{2}-\d{2})T((?:[01][0-9]|2[0-3]):[0-5][0-9])(?::([0-5][0-9])(?:\.([0-9]{1,9}))?)?(Z|[+-][0-9]{2}:[0-9]{2})$/.exec(value);
    requireCondition(match && validOffset(match[5]));
    dateParts(match[1]);
}

function weekday(value) {
    // Gregorian calendar arithmetic only. A Single date is a vehicle-local
    // calendar date, never an instant to convert through the host time zone.
    let { year, month, day } = dateParts(value);
    if (month < 3) year--;
    const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    const sundayIndex = (year + Math.floor(year / 4) - Math.floor(year / 100)
        + Math.floor(year / 400) + offsets[month - 1] + day) % 7;
    return DAYS[(sundayIndex + 6) % 7];
}

function timerValues(type, body) {
    let time;
    let days;
    let date = null;
    const repeat = type === 'Recurring';
    if (repeat) {
        const recurring = /^startTime=([^, ]+), isLocalVehicleTime=(true|false), sundays=(true|false), mondays=(true|false), tuesdays=(true|false), wednesdays=(true|false), thursdays=(true|false), fridays=(true|false), saturdays=(true|false)$/.exec(body);
        requireCondition(recurring);
        time = timeValue(recurring[1]);
        const selected = Object.fromEntries(NATIVE_DAYS.map((key, index) => [key, recurring[index + 3] === 'true']));
        days = DAYS.filter((_, index) => selected[NATIVE_DAYS[(index + 1) % 7]]);
        requireCondition(days.length > 0);
        return { time, days, repeat, date, isLocalVehicleTime: recurring[2] === 'true' };
    }
    const single = /^startTime=(\d{4}-\d{2}-\d{2})T([^, ]+), isLocalVehicleTime=(true|false)$/.exec(body);
    requireCondition(single);
    date = single[1];
    time = timeValue(single[2]);
    days = [weekday(date)];
    return { time, days, repeat, date, isLocalVehicleTime: single[3] === 'true' };
}

function canonicalLocationId(value) {
    return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,31})$/.test(value);
}

function parse(record, expectation) {
    requireCondition(plainRecord(record, ['fragment', 'arguments']) && record.fragment === FRAGMENT
        && typeof record.arguments === 'string' && record.arguments.length <= MAX_ARGUMENT_LENGTH);
    const keys = expectation && Object.hasOwn(expectation, 'locationId') ? ['kind', 'id', 'locationId'] : ['kind', 'id'];
    requireCondition(plainRecord(expectation, keys) && ['climate', 'charging'].includes(expectation.kind));
    let match;
    let values;
    let extras = {};
    if (expectation.kind === 'climate') {
        requireCondition(keys.length === 2 && ['1', '2'].includes(expectation.id));
        match = /^Bundle\[\{departureTimer=ClimaTimer\(id=([12]), isEnabled=(true|false), vehicleOffset=(Z|[+-][0-9]{2}:[0-9]{2}), timeInCar=([^,(){}\[\]\s]{1,64}), timer=(Recurring|Single)\(([^(){}\[\]\r\n]{1,2048})\)\)\}\]$/.exec(record.arguments);
        requireCondition(match);
        validateCarTime(match[4]);
        values = timerValues(match[5], match[6]);
    } else {
        requireCondition(['1', '2', '3'].includes(expectation.id)
            && (keys.length === 2 || canonicalLocationId(expectation.locationId)));
        match = /^Bundle\[\{departureTimer=ChargingTimer\(id=([123]), isEnabled=(true|false), vehicleOffset=(Z|[+-][0-9]{2}:[0-9]{2}), timer=(Recurring|Single)\(([^(){}\[\]\r\n]{1,2048})\), climatisation=(true|false), profileId=(0|[1-9][0-9]{0,31}), isPreferredTimesAvailable=(true|false)\)\}\]$/.exec(record.arguments);
        requireCondition(match && (keys.length === 2 || match[7] === expectation.locationId));
        values = timerValues(match[4], match[5]);
        // These are observed metadata, not a request to change climatisation
        // or preferred charging times while applying a timer.
        extras = { climatisation: match[6] === 'true', profileId: match[7], isPreferredTimesAvailable: match[8] === 'true' };
    }
    requireCondition(match[1] === expectation.id && validOffset(match[3]));
    return { kind: expectation.kind, id: match[1], enabled: match[2] === 'true',
        time: values.time, days: values.days, repeat: values.repeat, date: values.date,
        vehicleOffset: match[3], isLocalVehicleTime: values.isLocalVehicleTime,
        source: 'editor_initial_snapshot', ...extras };
}

function extractActiveDepartureNative(raw) {
    try { return extract(raw); }
    catch (_) { throw unavailable(); }
}

function parseDepartureTimer(record, expectation) {
    try { return parse(record, expectation); }
    catch (_) { throw unavailable(); }
}

function parseChargingLocationIdentity(record) {
    try {
        requireCondition(plainRecord(record, ['fragment', 'arguments']) && LOCATION_FRAGMENTS.includes(record.fragment)
            && typeof record.arguments === 'string' && record.arguments.length <= MAX_ARGUMENT_LENGTH);
        // Identity is not a list position and is deliberately returned as text.
        // Bound its representation without converting it through Number.
        const patterns = {
            ChargingLocationOverviewFragment: /^Bundle\[\{chargingLocationId=(0|[1-9][0-9]{0,31})\}\]$/,
            ChargingLocationSettingsFragment: /^Bundle\[\{chargingLocationId=(0|[1-9][0-9]{0,31}), isOneTonCargo=(?:true|false)\}\]$/,
            PreferredChargingTimesFragment: /^Bundle\[\{preferredChargingTimes=OfProfile\(profileId=(0|[1-9][0-9]{0,31})\)\}\]$/,
        };
        const pattern = patterns[record.fragment];
        const match = pattern.exec(record.arguments);
        requireCondition(match);
        return { nativeId: match[1] };
    } catch (_) { throw unavailable(); }
}

module.exports = { extractActiveDepartureNative, parseDepartureTimer, parseChargingLocationIdentity };
