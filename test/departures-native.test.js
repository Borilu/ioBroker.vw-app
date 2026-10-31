'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractActiveDepartureNative, parseDepartureTimer, parseChargingLocationIdentity } = require('../lib/departures-native');
const { BridgeError } = require('../lib/errors');

const SECRET = 'PRIVATE-DEPARTURE-FIXTURE';
const FRAGMENT = 'EditDepartureTimerFragment';

// All argument values, fragment tokens, process IDs and dates below are
// independently generated. No private phone dump is included in these tests.
function recurring(options = {}) {
    const values = { startTime: '07:15', isLocalVehicleTime: false,
        sundays: false, mondays: true, tuesdays: false, wednesdays: true,
        thursdays: false, fridays: false, saturdays: false, ...options };
    return 'Recurring(' + Object.entries(values).map(([key, value]) => key + '=' + value).join(', ') + ')';
}

function single(startTime = '2024-02-29T18:45', local = false) {
    return 'Single(startTime=' + startTime + ', isLocalVehicleTime=' + local + ')';
}

function args(options = {}) {
    const values = { id: '1', isEnabled: false, vehicleOffset: '+02:00',
        timeInCar: '2024-06-05T12:34:56+02:00', timer: recurring(), ...options };
    return 'Bundle[{departureTimer=ClimaTimer('
        + Object.entries(values).map(([key, value]) => key + '=' + value).join(', ') + ')}]';
}

function chargingArgs(options = {}) {
    const values = { id: '1', isEnabled: false, vehicleOffset: '+02:00',
        timer: single('2024-08-03T08:30'), climatisation: false, profileId: '7',
        isPreferredTimesAvailable: true, ...options };
    return 'Bundle[{departureTimer=ChargingTimer('
        + Object.entries(values).map(([key, value]) => key + '=' + value).join(', ') + ')}]';
}

function fragment(argumentValue = args(), options = {}) {
    const values = { token: 'a123', who: 'synthetic-fragment-1', state: 7, added: true,
        removing: false, hidden: false, detached: false, depth: 12, ...options };
    const pad = ' '.repeat(values.depth);
    return [
        pad + FRAGMENT + '{' + values.token + '} (' + values.who + ' id=0x7f000123 tag=synthetic-tag)',
        pad + '    mState=' + values.state + ' mWho=' + values.who + ' mBackStackNesting=2',
        pad + '    mAdded=' + values.added + ' mRemoving=' + values.removing + ' mFromLayout=false mInLayout=false',
        pad + '    mHidden=' + values.hidden + ' mDetached=' + values.detached + ' mMenuVisible=true mHasMenu=false',
        pad + '    mArguments=' + argumentValue,
        pad + '    Child FragmentManager{c123 in ' + FRAGMENT + '{' + values.token + '}}}:',
        pad + '      mParent=' + FRAGMENT + '{' + values.token + '} (' + values.who + ' id=0x7f000123 tag=synthetic-tag)',
    ].join('\n');
}

function dump(options = {}) {
    const blocks = options.blocks ?? [fragment(options.arguments ?? args())];
    return [
        ...(options.task === false ? [] : ['TASK 10101:com.volkswagen.weconnect id=17 userId=0']),
        '  ACTIVITY com.volkswagen.weconnect/' + (options.activity ?? '.SingleActivity') + ' abc1 pid=4321',
        '    Local Activity abc2 State:',
        '      mResumed=' + (options.resumed ?? true) + ' mStopped=' + (options.stopped ?? false)
            + ' mFinished=' + (options.finished ?? false),
        '    Unrelated private diagnostic: ' + SECRET,
        '          Child FragmentManager{abc3 in NavHostFragment{abc4}}}:',
        '            Active Fragments:',
        ...blocks,
        '            Added Fragments:',
        '              #0: ' + FRAGMENT + '{a123} (synthetic-fragment-1 id=0x7f000123 tag=synthetic-tag)',
        '            Back Stack:',
        '              #0: BackStackEntry{ab12 #7 synthetic-entry}',
        '                Op #2: ADD ' + FRAGMENT + '{a123} (synthetic-fragment-1 id=0x7f000123 tag=synthetic-tag)',
        '            FragmentManager misc state:',
        '              mCurState=7 mStateSaved=false mStopped=false mDestroyed=false',
    ].join('\n');
}

function record(argumentValue = args()) { return { fragment: FRAGMENT, arguments: argumentValue }; }
function expectation(id = '1') { return { kind: 'climate', id }; }

function locationFragment(kind = 'overview', id = '7', options = {}) {
    const className = kind === 'settings' ? 'ChargingLocationSettingsFragment' : 'ChargingLocationOverviewFragment';
    const argumentValue = 'Bundle[{chargingLocationId=' + id + (kind === 'settings' ? ', isOneTonCargo=false' : '') + '}]';
    return fragment(argumentValue, options).replaceAll(FRAGMENT, className);
}

function invalid(operation) {
    assert.throws(operation, error => error instanceof BridgeError
        && error.code === 'departure_native_unavailable'
        && !error.message.includes(SECRET)
        && !JSON.stringify(error.toJSON()).includes(SECRET));
}

test('extracts only the active editor argument record and omits unrelated private diagnostics', () => {
    const value = extractActiveDepartureNative(dump());
    assert.deepEqual(value, record());
    assert.deepEqual(Object.keys(value), ['fragment', 'arguments']);
    assert.equal(JSON.stringify(value).includes(SECRET), false);
    assert.equal(JSON.stringify(value).includes('synthetic-fragment'), false);
    assert.equal(JSON.stringify(value).includes('4321'), false);
});

test('targeted activity dumps with or without TASK, CRLF and UTF-8 buffers have identical results', () => {
    for (const task of [true, false]) {
        for (const activity of ['.SingleActivity', 'com.volkswagen.weconnect.SingleActivity']) {
            const text = dump({ task, activity });
            assert.deepEqual(extractActiveDepartureNative(text), record());
            assert.deepEqual(extractActiveDepartureNative(Buffer.from(text.replaceAll('\n', '\r\n'))), record());
        }
    }
});

test('Android 16 internal-display metadata is accepted only with matching task and activity', () => {
    const text = dump()
        .replace('id=17 userId=0', 'id=17 userId=0 displayId=0(type=INTERNAL)')
        .replace('abc1 pid=4321', 'abc1 pid=4321 userId=0 uid=10123 displayId=0(type=INTERNAL)');
    assert.deepEqual(extractActiveDepartureNative(text), record());
    for (const bad of [
        text.replace('uid=10123', 'uid=missing'),
        text.replace('pid=4321 userId=0', 'pid=4321 userId=1'),
        text.replace('uid=10123 displayId=0', 'uid=10123 displayId=1'),
        text.replace('displayId=0(type=INTERNAL)', 'displayId=0(type=EXTERNAL)'),
        text.replace('uid=10123 displayId=0(type=INTERNAL)', 'uid=10123 displayId=0(type=EXTERNAL)'),
        text.replace('userId=0 displayId=0(type=INTERNAL)', 'userId=0'),
        text.replace(' userId=0 uid=10123 displayId=0(type=INTERNAL)', ''),
        text.replace('uid=10123', 'uid=10123 extra=unexpected'),
        text.replace('mResumed=true', 'mResumed=false'),
    ]) invalid(() => extractActiveDepartureNative(bad));
});

test('a single resumed Volkswagen activity is mandatory and other activity/task prefixes are rejected', () => {
    const text = dump();
    for (const bad of [
        dump({ resumed: false }), dump({ stopped: true }), dump({ finished: true }),
        dump({ activity: '.OtherActivity' }),
        text.replaceAll('com.volkswagen.weconnect', 'example.foreign'),
        text.replace('TASK 10101:com.volkswagen.weconnect', 'TASK 10101:example.foreign'),
        text + '\n  ACTIVITY example.foreign/.MainActivity abcd pid=9876',
        text + '\n      mResumed=true mStopped=false mFinished=false',
        text.replace('      mResumed=true mStopped=false mFinished=false', ''),
        SECRET + '\n' + text,
    ]) invalid(() => extractActiveDepartureNative(bad));
});

test('inactive editor objects and Added Fragments/Back Stack references do not count as another active editor', () => {
    for (const flags of [{ state: 1 }, { added: false }, { removing: true }, { hidden: true }, { detached: true }]) {
        const text = dump({ blocks: [fragment(), fragment(SECRET, { token: 'b123', who: 'inactive-copy', ...flags })] });
        assert.deepEqual(extractActiveDepartureNative(text), record());
    }
    const text = dump() + '\n' + fragment(SECRET);
    assert.deepEqual(extractActiveDepartureNative(text), record());
    invalid(() => extractActiveDepartureNative(dump({ blocks: [] })));
});

test('zero or two active editor blocks are unavailable even when their argument values agree', () => {
    invalid(() => extractActiveDepartureNative(dump({ blocks: [fragment(args(), { state: 1 })] })));
    invalid(() => extractActiveDepartureNative(dump({ blocks: [fragment(), fragment()] })));
    invalid(() => extractActiveDepartureNative(dump({ blocks: [fragment(), fragment(args({ id: '2' }), { token: 'b456', who: 'second-active' })] })));
    invalid(() => extractActiveDepartureNative(dump({ blocks: [fragment(), fragment().replace('{a123}', '{NOT-HEX}')] })));
});

test('fragment lifecycle fields and direct arguments must each be complete, unique and scoped to their block', () => {
    const text = dump();
    for (const bad of [
        text.replace('mWho=synthetic-fragment-1', 'mWho=another-fragment'),
        text.replace('mState=7 mWho', 'mState=seven mWho'),
        text.replace('mAdded=true mRemoving=false mFromLayout=false mInLayout=false', ''),
        text.replace('mHidden=false mDetached=false mMenuVisible=true mHasMenu=false', ''),
        text.replace('mArguments=', 'otherArguments='),
        text.replace('                mArguments=', '                  mArguments='),
        text.replace('                mArguments=', '                mState=7 mWho=synthetic-fragment-1 mBackStackNesting=2\n                mArguments='),
        text.replace('                mArguments=', '                mArguments=' + args() + '\n                mArguments='),
        text.replace('            Active Fragments:', '            Added Fragments:'),
    ]) invalid(() => extractActiveDepartureNative(bad));
});

test('raw input limits and invalid encodings fail with fixed errors', () => {
    const text = dump();
    for (const bad of [null, true, 7, {}, [], Buffer.from([0xc3, 0x28]),
        text + '\x00', text + '\t', text + '\r', text + '\ud800', text + '\uffff',
        'x'.repeat(2 * 1024 * 1024 + 1), '\n'.repeat(40001),
        text + '\n' + 'x'.repeat(16385),
        dump({ arguments: 'x'.repeat(4097) }),
    ]) invalid(() => extractActiveDepartureNative(bad));
});

test('recurring timers return canonical Monday-to-Sunday keys and mark their initial-snapshot provenance', () => {
    const value = parseDepartureTimer(record(), expectation());
    assert.deepEqual(value, {
        kind: 'climate', id: '1', enabled: false, time: '07:15', days: ['mon', 'wed'],
        repeat: true, date: null, vehicleOffset: '+02:00', isLocalVehicleTime: false,
        source: 'editor_initial_snapshot',
    });
    const all = recurring(Object.fromEntries(['sundays', 'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays', 'saturdays']
        .map(key => [key, true])));
    assert.deepEqual(parseDepartureTimer(record(args({ timer: all })), expectation()).days,
        ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
});

test('each native weekday maps by its named field rather than source order, locale or array position', () => {
    const mapping = { mondays: 'mon', tuesdays: 'tue', wednesdays: 'wed', thursdays: 'thu',
        fridays: 'fri', saturdays: 'sat', sundays: 'sun' };
    const empty = Object.fromEntries(Object.keys(mapping).map(key => [key, false]));
    for (const [native, canonical] of Object.entries(mapping)) {
        const selected = parseDepartureTimer(record(args({ timer: recurring({ ...empty, [native]: true }) })), expectation());
        assert.deepEqual(selected.days, [canonical]);
    }
    invalid(() => parseDepartureTimer(record(args({ timer: recurring(empty) })), expectation()));
});

test('single timers preserve their original local date including past dates and compute the Gregorian weekday without time zones', () => {
    const cases = [
        ['0001-01-01', 'mon'], ['1999-12-31', 'fri'], ['2000-01-01', 'sat'],
        ['2023-12-31', 'sun'], ['2024-01-01', 'mon'], ['2024-02-29', 'thu'],
        ['2100-03-01', 'mon'], ['9999-12-31', 'fri'],
    ];
    for (const [date, day] of cases) {
        const value = parseDepartureTimer(record(args({ id: '2', timer: single(date + 'T00:00') })), expectation('2'));
        assert.equal(value.date, date);
        assert.equal(value.time, '00:00');
        assert.equal(value.repeat, false);
        assert.deepEqual(value.days, [day]);
    }
});

test('explicit enabled/local-time flags and vehicle offsets are preserved without converting the departure time', () => {
    for (const offset of ['Z', '+00:00', '-03:30', '+14:00', '+18:00', '-18:00']) {
        const value = parseDepartureTimer(record(args({ isEnabled: true, vehicleOffset: offset,
            timer: recurring({ startTime: '23:59', isLocalVehicleTime: true }) })), expectation());
        assert.equal(value.enabled, true);
        assert.equal(value.isLocalVehicleTime, true);
        assert.equal(value.vehicleOffset, offset);
        assert.equal(value.time, '23:59');
    }
    assert.equal(parseDepartureTimer(record(args({ timer: single('2024-06-01T18:45', true) })), expectation()).isLocalVehicleTime, true);
});

test('record, expectation, exact timer identity and the currently supported climate schema are mandatory', () => {
    for (const input of [null, false, 1, SECRET, [], {}, { ...record(), extra: SECRET },
        { ...record(), fragment: 'OtherFragment' }, { ...record(), arguments: null },
        record(args({ id: '2' })), record(args().replace('ClimaTimer', 'ChargingTimer'))]) {
        invalid(() => parseDepartureTimer(input, expectation()));
    }
    for (const input of [null, false, 1, SECRET, [], {}, { kind: 'charging', id: '1' },
        { kind: 'climate', id: 1 }, { kind: 'climate', id: '3' },
        { ...expectation(), locationId: SECRET }, { ...expectation(), extra: true }]) {
        invalid(() => parseDepartureTimer(record(), input));
    }
    const badRecord = Object.defineProperty({ fragment: FRAGMENT }, 'arguments', {
        enumerable: true, get() { throw new Error(SECRET); },
    });
    invalid(() => parseDepartureTimer(badRecord, expectation()));
});

test('timer argument grammar rejects unknown, missing, duplicate or executable-looking fields without echoing them', () => {
    const good = args();
    for (const bad of [
        good + SECRET, good.replace(')}]', ', private=' + SECRET + ')}]'),
        good.replace('id=1, ', ''), good.replace('id=1, ', 'id=1, id=1, '),
        good.replace('isEnabled=false', 'isEnabled=0'),
        good.replace('isEnabled=false', 'isEnabled=False'),
        good.replace('isLocalVehicleTime=false', 'isLocalVehicleTime=undefined'),
        good.replace('mondays=true', 'mondays=1'),
        good.replace('sundays=false, ', ''),
        good.replace('saturdays=false', 'saturdays=false, extra=true'),
        good.replace('Recurring(', 'Unknown('),
        good.replace('07:15', '(()=>' + SECRET + ')()'),
        good.replace('departureTimer=', 'other='),
        'Bundle[{departureTimer=' + SECRET + '}]',
    ]) invalid(() => parseDepartureTimer(record(bad), expectation()));
});

test('invalid clocks, calendar dates and zone offsets are not normalized into accepted values', () => {
    for (const time of ['7:15', '24:00', '23:60', '00:00:00', '12:30Z', '12:30 ', '-1:00']) {
        invalid(() => parseDepartureTimer(record(args({ timer: recurring({ startTime: time }) })), expectation()));
        invalid(() => parseDepartureTimer(record(args({ timer: single('2024-06-01T' + time) })), expectation()));
    }
    for (const date of ['0000-01-01', '2023-02-29', '2100-02-29', '2024-04-31', '2024-00-01',
        '2024-13-01', '2024-01-00', '2024-01-32', '24-01-01']) {
        invalid(() => parseDepartureTimer(record(args({ timer: single(date + 'T12:30') })), expectation()));
    }
    for (const offset of ['+19:00', '+18:01', '-18:30', '+02:60', 'UTC', '02:00']) {
        invalid(() => parseDepartureTimer(record(args({ vehicleOffset: offset })), expectation()));
    }
    for (const carTime of ['not-a-date', '2023-02-29T12:30+02:00', '2024-01-01T24:00+02:00',
        '2024-01-01T12:30+19:00', '2024-01-01T12:30:60+02:00', '2024-01-01T12:30']) {
        invalid(() => parseDepartureTimer(record(args({ timeInCar: carTime })), expectation()));
    }
});

test('valid optional seconds/fractions in the car snapshot clock do not alter minute-precision departure values', () => {
    for (const carTime of ['2024-02-29T12:30Z', '2024-02-29T12:30:00Z',
        '2024-02-29T12:30:59.123456789-03:30']) {
        const value = parseDepartureTimer(record(args({ timeInCar: carTime })), expectation());
        assert.equal(value.time, '07:15');
        assert.equal(Object.hasOwn(value, 'timeInCar'), false);
    }
});

test('mutable draft/state diagnostics cannot replace the fragment initial arguments', () => {
    const text = dump().replace('                mArguments=',
        '                mSavedViewState={draftTime=23:59, draftDays=' + SECRET + '}\n                mArguments=');
    const value = parseDepartureTimer(extractActiveDepartureNative(text), expectation());
    assert.equal(value.time, '07:15');
    assert.deepEqual(value.days, ['mon', 'wed']);
    assert.equal(value.source, 'editor_initial_snapshot');
});

test('active charging-location overview and settings expose only their exact native identity', () => {
    for (const kind of ['overview', 'settings']) {
        const value = extractActiveDepartureNative(dump({ blocks: [locationFragment(kind)] }));
        assert.equal(value.fragment, kind === 'overview' ? 'ChargingLocationOverviewFragment' : 'ChargingLocationSettingsFragment');
        assert.deepEqual(parseChargingLocationIdentity(value), { nativeId: '7' });
        invalid(() => parseDepartureTimer(value, expectation()));
    }
});

test('a settings editor excludes its inactive overview back-stack object and cross-type active ambiguity is rejected', () => {
    const inactive = locationFragment('overview', '7', { state: 1, added: false, removing: true, token: 'b123', who: 'location-overview' });
    const active = locationFragment('settings', '7', { token: 'b456', who: 'location-settings' });
    const value = extractActiveDepartureNative(dump({ blocks: [inactive, active] }));
    assert.equal(value.fragment, 'ChargingLocationSettingsFragment');
    assert.deepEqual(parseChargingLocationIdentity(value), { nativeId: '7' });
    for (const blocks of [
        [locationFragment(), fragment()],
        [locationFragment(), locationFragment('settings')],
        [locationFragment(), locationFragment('overview', '8')],
        [locationFragment(), locationFragment('settings').replace('{a123}', '{NOT-HEX}')],
    ]) invalid(() => extractActiveDepartureNative(dump({ blocks })));
});

test('native location identity is a bounded canonical decimal string rather than a position, coerced number or rounded value', () => {
    for (const nativeId of ['0', '1', '7', '9007199254740993', '12345678901234567890123456789012']) {
        const value = extractActiveDepartureNative(dump({ blocks: [locationFragment('overview', nativeId)] }));
        assert.deepEqual(parseChargingLocationIdentity(value), { nativeId });
    }
    for (const nativeId of ['', '01', '-1', '+1', '1.0', '1e2', ' 1', '1 ', '1\n', SECRET, '1'.repeat(33)]) {
        invalid(() => parseChargingLocationIdentity({ fragment: 'ChargingLocationOverviewFragment',
            arguments: 'Bundle[{chargingLocationId=' + nativeId + '}]' }));
    }
});

test('location argument schemas are exact and fragment-specific; cargo is validated but never exposed as identity', () => {
    const overview = { fragment: 'ChargingLocationOverviewFragment', arguments: 'Bundle[{chargingLocationId=7}]' };
    const settings = { fragment: 'ChargingLocationSettingsFragment', arguments: 'Bundle[{chargingLocationId=7, isOneTonCargo=false}]' };
    assert.deepEqual(parseChargingLocationIdentity({ ...settings, arguments: settings.arguments.replace('false', 'true') }), { nativeId: '7' });
    for (const value of [
        null, [], {}, record(), { ...overview, fragment: 'OtherFragment' },
        { ...overview, arguments: settings.arguments }, { ...settings, arguments: overview.arguments },
        { ...overview, extra: SECRET }, { ...overview, arguments: null },
        { ...overview, arguments: 'Bundle[{chargingLocationId=7, chargingLocationId=8}]' },
        { ...settings, arguments: settings.arguments.replace('false', '0') },
        { ...settings, arguments: settings.arguments.replace('false', 'False') },
        { ...settings, arguments: settings.arguments.replace('}]', ', vehicleName=' + SECRET + '}]') },
    ]) invalid(() => parseChargingLocationIdentity(value));
    const malicious = Object.defineProperty({ fragment: 'ChargingLocationOverviewFragment' }, 'arguments', {
        enumerable: true, get() { throw new Error(SECRET); },
    });
    invalid(() => parseChargingLocationIdentity(malicious));
});

test('charging timers preserve their local single date and all read-only metadata with no invented timeInCar', () => {
    const native = extractActiveDepartureNative(dump({ arguments: chargingArgs() }));
    assert.deepEqual(parseDepartureTimer(native, { kind: 'charging', id: '1', locationId: '7' }), {
        kind: 'charging', id: '1', enabled: false, time: '08:30', days: ['sat'],
        repeat: false, date: '2024-08-03', vehicleOffset: '+02:00', isLocalVehicleTime: false,
        source: 'editor_initial_snapshot', climatisation: false, profileId: '7', isPreferredTimesAvailable: true,
    });
    assert.equal(Object.hasOwn(parseDepartureTimer(native, { kind: 'charging', id: '1' }), 'timeInCar'), false);
});

test('each charging timer ID is exact and recurring weekdays retain the climate timer semantics', () => {
    for (const id of ['1', '2', '3']) {
        const native = record(chargingArgs({ id, isEnabled: true,
            timer: recurring({ startTime: '21:05', isLocalVehicleTime: true }),
            climatisation: true, isPreferredTimesAvailable: false }));
        const value = parseDepartureTimer(native, { kind: 'charging', id, locationId: '7' });
        assert.equal(value.id, id);
        assert.equal(value.enabled, true);
        assert.equal(value.time, '21:05');
        assert.deepEqual(value.days, ['mon', 'wed']);
        assert.equal(value.date, null);
        assert.equal(value.repeat, true);
        assert.equal(value.isLocalVehicleTime, true);
        assert.equal(value.climatisation, true);
        assert.equal(value.isPreferredTimesAvailable, false);
    }
});

test('charging profile identity must exactly match the expected location when supplied and is never coerced', () => {
    for (const locationId of ['0', '7', '9007199254740993']) {
        const native = record(chargingArgs({ profileId: locationId }));
        const value = parseDepartureTimer(native, { kind: 'charging', id: '1', locationId });
        assert.equal(value.profileId, locationId);
    }
    const native = record(chargingArgs());
    for (const expected of [
        { kind: 'charging', id: '2', locationId: '7' },
        { kind: 'charging', id: '1', locationId: '8' },
        { kind: 'charging', id: '1', locationId: 7 },
        { kind: 'charging', id: '1', locationId: '07' },
        { kind: 'charging', id: '1', locationId: undefined },
        { kind: 'charging', id: '1', locationId: null },
        { kind: 'charging', id: '4' }, { kind: 'charging', id: 1 },
        { kind: 'charging', id: '1', climatisation: false },
    ]) invalid(() => parseDepartureTimer(native, expected));
    invalid(() => parseDepartureTimer(native, { kind: 'climate', id: '1' }));
    invalid(() => parseDepartureTimer(record(), { kind: 'charging', id: '1' }));
});

test('charging metadata and schema reject unknown fields, missing flags, unsupported IDs and noncanonical profile IDs', () => {
    const good = chargingArgs();
    for (const bad of [
        good.replace('id=1', 'id=0'), good.replace('id=1', 'id=4'),
        good.replace('profileId=7', 'profileId=07'), good.replace('profileId=7', 'profileId=-1'),
        good.replace('climatisation=false', 'climatisation=0'),
        good.replace('climatisation=false, ', ''),
        good.replace('isPreferredTimesAvailable=true', 'isPreferredTimesAvailable=True'),
        good.replace(', isPreferredTimesAvailable=true', ''),
        good.replace('timer=Single(', 'timeInCar=2024-06-05T12:34:56+02:00, timer=Single('),
        good.replace(')}]', ', private=' + SECRET + ')}]'),
        good.replace('isEnabled=false', 'isEnabled=false, climatisation=true'),
        good.replace('2024-08-03T08:30', '2024-02-30T08:30'),
    ]) invalid(() => parseDepartureTimer(record(bad), { kind: 'charging', id: '1' }));
});

test('the preferred-times fragment shares exact location identity but cannot be mistaken for a timer', () => {
    const argumentValue = 'Bundle[{preferredChargingTimes=OfProfile(profileId=7)}]';
    const preferred = fragment(argumentValue, { token: 'c789', who: 'preferred-times' })
        .replaceAll(FRAGMENT, 'PreferredChargingTimesFragment');
    const inactive = locationFragment('settings', '7', { state: 1, added: false, removing: true, token: 'c123', who: 'old-settings' });
    const native = extractActiveDepartureNative(dump({ blocks: [inactive, preferred] }));
    assert.deepEqual(native, { fragment: 'PreferredChargingTimesFragment', arguments: argumentValue });
    assert.deepEqual(parseChargingLocationIdentity(native), { nativeId: '7' });
    invalid(() => parseDepartureTimer(native, { kind: 'charging', id: '1', locationId: '7' }));
    invalid(() => extractActiveDepartureNative(dump({ blocks: [locationFragment(), preferred] })));
    for (const bad of [
        argumentValue.replace('profileId=7', 'profileId=07'),
        argumentValue.replace('OfProfile', 'OfVehicle'),
        argumentValue.replace('profileId=7', 'profileId=7, private=' + SECRET),
        'Bundle[{chargingLocationId=7}]',
    ]) invalid(() => parseChargingLocationIdentity({ fragment: 'PreferredChargingTimesFragment', arguments: bad }));
});
