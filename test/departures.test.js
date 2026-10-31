'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TIMER_KEYS, TIMER_DAYS, DEFAULT_TARGET_TIMER, validateTimerField, validateTimerTargets,
    parseTimerDaysState, serializeTimerDaysState, normalizeObservedTimer } = require('../lib/departures');
const { BridgeError } = require('../lib/errors');

const SECRET = 'PRIVATE-TIMER-INPUT';

function invalid(operation) {
    assert.throws(operation, error => error instanceof BridgeError && error.code === 'invalid_departure_timer'
        && !error.message.includes(SECRET) && !JSON.stringify(error.toJSON()).includes(SECRET));
}

function observed(overrides = {}) {
    return { id: '1', enabled: false, time: '07:15', days: ['mon', 'wed'], repeat: true, date: null,
        vehicleOffset: '+02:00', isLocalVehicleTime: false, source: 'editor_initial_snapshot', ...overrides };
}

test('timer defaults and keys are immutable and each normalized target is independent', () => {
    assert.deepEqual(TIMER_KEYS, ['enabled', 'time', 'days', 'repeat']);
    assert.deepEqual(TIMER_DAYS, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    assert.deepEqual(DEFAULT_TARGET_TIMER, { enabled: null, time: null, days: null, repeat: null });
    for (const value of [TIMER_KEYS, TIMER_DAYS, DEFAULT_TARGET_TIMER]) assert.equal(Object.isFrozen(value), true);
    const target = validateTimerTargets();
    assert.deepEqual(target, DEFAULT_TARGET_TIMER);
    assert.notEqual(target, DEFAULT_TARGET_TIMER);
    target.enabled = true;
    assert.deepEqual(validateTimerTargets({}), DEFAULT_TARGET_TIMER);
});

test('enabled and repeat accept only strict booleans or explicit null without coercion', () => {
    for (const key of ['enabled', 'repeat']) {
        for (const value of [true, false, null]) assert.equal(validateTimerField(key, value), value);
        for (const value of [undefined, 0, 1, '', 'false', 'true', {}, [], new Boolean(false)]) {
            invalid(() => validateTimerField(key, value));
        }
    }
    invalid(() => validateTimerField('date', null));
    invalid(() => validateTimerField('__proto__', null));
    invalid(() => validateTimerField('enabled ', true));
});

test('target times require the exact supported 24-hour HH:mm representation', () => {
    for (const value of [null, '00:00', '07:05', '12:00', '23:59']) assert.equal(validateTimerField('time', value), value);
    for (const value of [undefined, true, 715, '7:15', '07:5', '24:00', '23:60', '00:00:00',
        '07:15Z', '07:15+02:00', ' 07:15', '07:15 ', '07:15\n', '07：15', SECRET, {}, []]) {
        invalid(() => validateTimerField('time', value));
    }
});

test('weekday wishes sort into ISO order, preserve the input and reject duplicates or empty selections', () => {
    const input = ['sun', 'wed', 'mon', 'fri'];
    const normalized = validateTimerField('days', input);
    assert.deepEqual(normalized, ['mon', 'wed', 'fri', 'sun']);
    assert.deepEqual(input, ['sun', 'wed', 'mon', 'fri']);
    assert.notEqual(normalized, input);
    normalized.push('tue');
    assert.deepEqual(validateTimerField('days', input), ['mon', 'wed', 'fri', 'sun']);
    assert.deepEqual(validateTimerField('days', [...TIMER_DAYS].reverse()), [...TIMER_DAYS]);
    assert.equal(validateTimerField('days', null), null);
    for (const value of [undefined, [], ['mon', 'mon'], ['Mon'], ['monday'], ['mon '], ['mon\n'],
        [1], [1, 2, 3], [null], ['mon', 'UNKNOWN'], ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'mon'],
        'mon', '["mon"]', {}, Array(1)]) invalid(() => validateTimerField('days', value));
});

test('partial wishes never infer enabled, repeat, dates or other fields from a staged change', () => {
    assert.deepEqual(validateTimerTargets({ enabled: false }), { enabled: false, time: null, days: null, repeat: null });
    assert.deepEqual(validateTimerTargets({ time: '23:59' }), { enabled: null, time: '23:59', days: null, repeat: null });
    assert.deepEqual(validateTimerTargets({ repeat: false }), { enabled: null, time: null, days: null, repeat: false });
    const target = validateTimerTargets({ repeat: false, days: ['sun', 'mon'] });
    assert.deepEqual(target, { enabled: null, time: null, days: ['mon', 'sun'], repeat: false });
    assert.equal(Object.hasOwn(target, 'date'), false);
    assert.deepEqual(validateTimerTargets(JSON.parse(JSON.stringify(target))), target);
});

test('target records reject unsupported fields, inherited data, accessors and hidden data without reading or echoing input', () => {
    let getterCalls = 0;
    const getter = Object.defineProperty({}, 'enabled', { enumerable: true, get() { getterCalls++; throw new Error(SECRET); } });
    const hidden = Object.defineProperty({}, 'enabled', { value: false });
    const symbol = { [Symbol(SECRET)]: false };
    for (const input of [null, false, 1, SECRET, [], new Date(), { time: undefined }, { time: SECRET },
        { date: '2024-01-01' }, { vehicleOffset: '+02:00' }, { source: 'vehicle' }, { arbitrary: SECRET },
        JSON.parse('{"__proto__":{"private":"' + SECRET + '"}}'), Object.create({ enabled: false }), getter, hidden, symbol,
        new Proxy({}, { ownKeys() { throw new Error(SECRET); } })]) invalid(() => validateTimerTargets(input));
    assert.equal(getterCalls, 0);
    const plain = Object.create(null);
    plain.enabled = false;
    assert.equal(validateTimerTargets(plain).enabled, false);
});

test('weekday array validation rejects holes, extra properties, symbols and getters without invoking them', () => {
    let getterCalls = 0;
    const getter = Object.defineProperty(['mon'], '0', { enumerable: true, get() { getterCalls++; throw new Error(SECRET); } });
    const extra = Object.assign(['mon'], { private: SECRET });
    const symbol = Object.assign(['mon'], { [Symbol(SECRET)]: true });
    const hidden = Object.defineProperty(['mon'], 'private', { value: SECRET });
    const sparse = ['mon', , 'wed'];
    for (const value of [getter, extra, symbol, hidden, sparse]) invalid(() => validateTimerField('days', value));
    assert.equal(getterCalls, 0);
});

test('ioBroker days parse and serialize as bounded JSON arrays or explicit null', () => {
    for (const input of [null, 'null', ' null ']) assert.equal(parseTimerDaysState(input), null);
    assert.equal(serializeTimerDaysState(null), null);
    for (const input of ['["sun", "mon"]', ' [ "sun", "mon" ] ', ['sun', 'mon']]) {
        assert.deepEqual(parseTimerDaysState(input), ['mon', 'sun']);
    }
    assert.equal(serializeTimerDaysState(['sun', 'mon']), '["mon","sun"]');
    const input = ['fri'];
    const parsed = parseTimerDaysState(input);
    parsed.push('sun');
    assert.deepEqual(input, ['fri']);
    for (const days of [null, ['mon'], ['sun', 'tue'], [...TIMER_DAYS]]) {
        assert.deepEqual(parseTimerDaysState(serializeTimerDaysState(days)), validateTimerField('days', days));
    }
    for (const input of [undefined, '', 'undefined', 'mon', '"mon"', 'false', '0', '{}', '[]',
        '["mon", "mon"]', '["mon", null]', '["mon",]', '["mon"]' + SECRET, ' '.repeat(257) + 'null', true, 1]) {
        invalid(() => parseTimerDaysState(input));
    }
    invalid(() => serializeTimerDaysState('["mon"]'));
});

test('observed recurring timers are bounded independent serializable snapshots with no vehicle confirmation', () => {
    const input = observed({ kind: 'climate', days: ['wed', 'mon'] });
    const output = normalizeObservedTimer(input);
    assert.deepEqual(output, observed());
    assert.deepEqual(JSON.parse(JSON.stringify(output)), output);
    assert.notEqual(output, input);
    assert.notEqual(output.days, input.days);
    output.days.push('sun');
    assert.deepEqual(input.days, ['wed', 'mon']);
    assert.equal(Object.hasOwn(output, 'vehicleConfirmed'), false);
    assert.equal(Object.hasOwn(output, 'kind'), false);
    for (const id of ['1', '2', '3']) assert.equal(normalizeObservedTimer(observed({ id })).id, id);
    assert.equal(normalizeObservedTimer(observed({ kind: 'charging', enabled: true })).enabled, true);
});

test('single observations preserve past and edge-calendar dates rather than converting them to future instants', () => {
    const cases = [['0001-01-01', 'mon'], ['1900-03-01', 'thu'], ['1999-12-31', 'fri'],
        ['2000-02-29', 'tue'], ['2024-02-29', 'thu'], ['2024-10-27', 'sun'], ['2100-03-01', 'mon'], ['9999-12-31', 'fri']];
    for (const [date, day] of cases) {
        const input = observed({ repeat: false, date, days: [day], time: '00:00', enabled: false });
        const output = normalizeObservedTimer(input);
        assert.equal(output.date, date);
        assert.equal(output.time, '00:00');
        assert.equal(output.enabled, false);
        assert.equal(output.repeat, false);
        assert.deepEqual(output.days, [day]);
    }
});

test('observed vehicle offsets and local-time flags are retained exactly without host-time conversion', () => {
    for (const vehicleOffset of ['Z', '+00:00', '-00:00', '-03:30', '+05:45', '+14:00', '-18:00', '+18:00']) {
        for (const isLocalVehicleTime of [true, false]) {
            const output = normalizeObservedTimer(observed({ vehicleOffset, isLocalVehicleTime, time: '23:59' }));
            assert.equal(output.vehicleOffset, vehicleOffset);
            assert.equal(output.isLocalVehicleTime, isLocalVehicleTime);
            assert.equal(output.time, '23:59');
        }
    }
});

test('observed timer contracts reject missing, unknown, unconfirmed or coerced fields before publication', () => {
    for (const key of Object.keys(observed())) {
        const input = observed();
        delete input[key];
        invalid(() => normalizeObservedTimer(input));
    }
    for (const overrides of [{ id: 1 }, { id: '0' }, { id: '4' }, { id: '01' }, { id: '1\n' },
        { enabled: null }, { enabled: 'false' }, { repeat: null }, { repeat: 0 }, { isLocalVehicleTime: null },
        { isLocalVehicleTime: 'true' }, { time: '7:15' }, { days: null }, { days: [] },
        { vehicleOffset: null }, { vehicleOffset: '+18:01' }, { vehicleOffset: '-19:00' }, { vehicleOffset: '+01:60' },
        { vehicleOffset: 'Z\n' }, { source: 'vehicle' }, { source: 'editor_current_draft' },
        { kind: 'unknown' }, { raw: SECRET }, { vehicleConfirmed: true }, { date: '2024-01-01' }]) {
        invalid(() => normalizeObservedTimer(observed(overrides)));
    }
    invalid(() => normalizeObservedTimer(null));
});

test('single dates must be exact calendar dates consistent with the one observed weekday', () => {
    for (const date of [null, '', '0000-01-01', '2023-02-29', '1900-02-29', '2024-04-31', '2024-00-01',
        '2024-13-01', '2024-01-00', '2024-01-32', '2024-2-29', '2024-02-29Z', '2024-02-29\n', 20240229]) {
        invalid(() => normalizeObservedTimer(observed({ repeat: false, date, days: ['thu'] })));
    }
    invalid(() => normalizeObservedTimer(observed({ repeat: false, date: '2024-02-29', days: ['fri'] })));
    invalid(() => normalizeObservedTimer(observed({ repeat: false, date: '2024-02-29', days: ['thu', 'fri'] })));
});
