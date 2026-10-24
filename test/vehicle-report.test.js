'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BridgeError } = require('../lib/errors');
const {
    REPORT_CATEGORIES, mergeReportPages, validateVehicleReport, compatibleSynchronizationText,
} = require('../lib/vehicle-report');

const PRIVATE = 'PRIVATE-REPORT-MUST-NOT-LEAK';
const copy = value => JSON.parse(JSON.stringify(value));
function categories() {
    return Object.fromEntries(Object.entries(REPORT_CATEGORIES).map(([key, label]) => [key, { label, texts: [] }]));
}
function page(overrides = {}) {
    return {
        atTop: true, atBottom: true,
        odometerText: '42.123 km', nextServiceText: '123 Tage', summary: 'Keine Meldungen',
        synchronizationText: 'Synchronisiert: Vor 2 h 15 min', categories: categories(),
        notice: 'Synthetischer Hinweis: Die App zeigt den zuletzt verfügbaren Bericht.',
        additionalTexts: [], ...overrides,
    };
}
function emptyPage(overrides = {}) {
    return page({
        atTop: false, atBottom: false, odometerText: null, nextServiceText: null,
        summary: null, synchronizationText: null, categories: {}, notice: null, ...overrides,
    });
}
function reject(operation, code = 'invalid_report') {
    assert.throws(operation, error => error instanceof BridgeError && error.code === code
        && !error.message.includes(PRIVATE) && !JSON.stringify(error.toJSON()).includes(PRIVATE));
}

test('category contract is an immutable ordinary seven-label object', () => {
    assert.equal(Object.getPrototypeOf(REPORT_CATEGORIES), Object.prototype);
    assert.equal(Object.isFrozen(REPORT_CATEGORIES), true);
    assert.deepEqual(REPORT_CATEGORIES, {
        engine: 'Antrieb', assistance: 'Assistenten', brakes: 'Bremsen', lighting: 'Fahrlicht',
        comfort: 'Komfort', tires: 'Reifen', other: 'Sonstige',
    });
});

test('complete report derives explicit app message status and German unit values only', () => {
    const result = mergeReportPages([page()]);
    assert.deepEqual(Object.keys(result), [
        'odometerText', 'odometerKm', 'nextServiceText', 'nextServiceDays', 'nextServiceKm',
        'summary', 'hasMessages', 'messageCount', 'synchronizationText', 'categories', 'notice', 'additionalTexts',
    ]);
    assert.equal(result.odometerKm, 42123);
    assert.equal(result.nextServiceDays, 123);
    assert.equal(result.nextServiceKm, null);
    assert.equal(result.hasMessages, false);
    assert.equal(result.messageCount, 0);
    for (const [key, label] of Object.entries(REPORT_CATEGORIES)) {
        assert.deepEqual(result.categories[key], { label, status: 'no_messages', texts: [] });
    }
    assert.deepEqual(validateVehicleReport(result), result);
});

test('partial pages merge stable repeats, skip nulls and retain ordered unique additional texts', () => {
    const all = categories();
    const pages = [
        emptyPage({ atTop: true, odometerText: '42.123 km', summary: 'Keine Meldungen',
            synchronizationText: 'Synchronisiert: Vor 2 h 59 min', categories: { engine: all.engine, assistance: all.assistance },
            additionalTexts: ['Erster Text', 'Wiederholt'] }),
        emptyPage({ nextServiceText: '123 Tage', summary: 'Keine Meldungen',
            synchronizationText: 'Synchronisiert: Vor 3 h', categories: { assistance: all.assistance, brakes: all.brakes, lighting: all.lighting },
            additionalTexts: ['Wiederholt', 'Zweiter Text'] }),
        emptyPage({ atBottom: true, synchronizationText: null,
            categories: { comfort: all.comfort, tires: all.tires, other: all.other }, notice: 'Vollständiger synthetischer Footer.',
            additionalTexts: ['Erster Text', 'Dritter Text'] }),
    ];
    const before = copy(pages);
    const report = mergeReportPages(pages);
    assert.equal(report.synchronizationText, 'Synchronisiert: Vor 3 h');
    assert.deepEqual(report.additionalTexts, ['Erster Text', 'Wiederholt', 'Zweiter Text', 'Dritter Text']);
    assert.deepEqual(pages, before);
    report.categories.engine.texts.push('Lokale Änderung');
    assert.deepEqual(pages, before);
});

test('zero values and an exact zero message count remain explicit zero rather than missing', () => {
    const report = mergeReportPages([page({ odometerText: '0 km', nextServiceText: '0 Tage', summary: '0 Meldungen' })]);
    assert.equal(report.odometerKm, 0);
    assert.equal(report.nextServiceDays, 0);
    assert.equal(report.hasMessages, false);
    assert.equal(report.messageCount, 0);
    assert.equal(report.categories.engine.status, 'no_messages');
    assert.deepEqual(validateVehicleReport(report), report);
});

test('only grammatical exact positive count texts derive a message count', () => {
    for (const [summary, count] of [['1 Meldung', 1], ['12 Meldungen', 12]]) {
        const report = mergeReportPages([page({ summary })]);
        assert.equal(report.hasMessages, true);
        assert.equal(report.messageCount, count);
        assert.equal(report.categories.engine.status, 'unknown');
    }
    for (const summary of ['1 Meldungen', '2 Meldung', '01 Meldung', 'Keine Meldungen.',
        ' 0 Meldungen', 'Es gibt 2 Meldungen', '9007199254740992 Meldungen']) {
        const report = mergeReportPages([page({ summary })]);
        assert.equal(report.summary, summary);
        assert.equal(report.hasMessages, null);
        assert.equal(report.messageCount, null);
        assert.equal(report.categories.engine.status, 'unknown');
    }
});

test('unknown app texts stay raw and do not invent telemetry or a category health state', () => {
    const raw = page({ odometerText: 'Gesamtstrecke zurzeit nicht verfügbar', nextServiceText: 'Service nach Anzeige',
        summary: 'Bericht wird vorbereitet', synchronizationText: 'Synchronisation ausstehend' });
    const result = mergeReportPages([raw]);
    assert.equal(result.odometerText, raw.odometerText);
    assert.equal(result.odometerKm, null);
    assert.equal(result.nextServiceText, raw.nextServiceText);
    assert.equal(result.nextServiceDays, null);
    assert.equal(result.nextServiceKm, null);
    assert.equal(result.hasMessages, null);
    assert.equal(result.messageCount, null);
    assert.equal(result.categories.brakes.status, 'unknown');
    assert.deepEqual(validateVehicleReport(result), result);
});

test('category messages remain unknown even alongside explicit overall no-messages text', () => {
    const raw = page();
    raw.categories.engine.texts = ['Synthetischer App-Text'];
    const result = mergeReportPages([raw]);
    assert.equal(result.hasMessages, false);
    assert.equal(result.categories.engine.status, 'unknown');
    assert.equal(result.categories.brakes.status, 'no_messages');
    assert.deepEqual(result.categories.engine.texts, ['Synthetischer App-Text']);
});

test('service quantities support clear signed days or kilometres and explicit combined units', () => {
    for (const [nextServiceText, days, km] of [
        ['-3 Tage', -3, null], ['\u2212123 km', null, -123], ['Nächster Service: in 14 Tagen', 14, null],
        ['123 Tage / 31.000 km', 123, 31000], ['-2 Tage oder -100 km', -2, -100],
        ['0 Tage und 0 km', 0, 0], ['Service: +42 km', null, 42],
    ]) {
        const result = mergeReportPages([page({ nextServiceText })]);
        assert.equal(result.nextServiceDays, days, nextServiceText);
        assert.equal(result.nextServiceKm, km, nextServiceText);
        assert.deepEqual(validateVehicleReport(result), result);
    }
});

test('ambiguous or unlabelled numbers do not become odometer or service values', () => {
    for (const odometerText of ['42123', '42,123 km', '42.12 km', '42.123,5 km', '-42 km', '1e3 km',
        '42 km seit letztem Start', '9007199254740992 km']) {
        assert.equal(mergeReportPages([page({ odometerText })]).odometerKm, null, odometerText);
    }
    for (const nextServiceText of ['123', '12.03.2027', 'überfällig', '2 Tage 3 Tage', '2 Tage / 3 Tage',
        '1,5 km', '1.00 km', '9007199254740992 Tage', '123 miles', '5 Tage oder später']) {
        const result = mergeReportPages([page({ nextServiceText })]);
        assert.equal(result.nextServiceDays, null, nextServiceText);
        assert.equal(result.nextServiceKm, null, nextServiceText);
    }
    assert.equal(mergeReportPages([page({ odometerText: 'Gesamtstrecke: 31.000 km' })]).odometerKm, 31000);
});

test('complete reading requires first top, final bottom, every core text, notice and all seven categories', () => {
    reject(() => mergeReportPages([page({ atTop: false })]), 'report_incomplete');
    reject(() => mergeReportPages([page({ atBottom: false })]), 'report_incomplete');
    reject(() => mergeReportPages([emptyPage(), page()]), 'report_incomplete');
    reject(() => mergeReportPages([page(), emptyPage()]), 'report_incomplete');
    for (const key of ['odometerText', 'nextServiceText', 'summary', 'synchronizationText', 'notice']) {
        reject(() => mergeReportPages([page({ [key]: null })]), 'report_incomplete');
    }
    for (const key of Object.keys(REPORT_CATEGORIES)) {
        const raw = page();
        delete raw.categories[key];
        reject(() => mergeReportPages([raw]), 'report_incomplete');
    }
});

test('repeated core texts, footer and ordered category texts cannot change across pages', () => {
    for (const key of ['odometerText', 'nextServiceText', 'summary', 'notice']) {
        reject(() => mergeReportPages([page(), page({ [key]: PRIVATE })]), 'report_changed');
    }
    const first = page();
    first.categories.engine.texts = ['Erster Text', 'Zweiter Text'];
    const changed = copy(first);
    changed.categories.engine.texts.reverse();
    reject(() => mergeReportPages([first, changed]), 'report_changed');
    const changedLabel = page();
    changedLabel.categories.engine.label = PRIVATE;
    reject(() => mergeReportPages([page(), changedLabel]), 'report_changed');
    reject(() => mergeReportPages([changedLabel]), 'invalid_report');
});

test('relative synchronization ages advance conservatively across minute, hour and day boundaries', () => {
    for (const [before, after] of [
        ['Synchronisiert: Vor 2 h 15 min', 'Synchronisiert: Vor 2 h 20 min'],
        ['Synchronisiert: Vor 59 min', 'Synchronisiert: Vor 1 h'],
        ['Synchronisiert: Vor 23 h 59 min', 'Synchronisiert: Vor 1 Tag'],
        ['Synchronisiert: Vor 1 Tag 23 h 59 min', 'Synchronisiert: Vor 2 Tage'],
        ['Synchronisiert: Vor 1 d', 'Synchronisiert: Vor 1 Tag 3 min'],
    ]) {
        assert.equal(compatibleSynchronizationText(before, after), true, `${before} -> ${after}`);
        assert.equal(mergeReportPages([page({ synchronizationText: before }), page({ synchronizationText: after })]).synchronizationText, after);
    }
    assert.equal(compatibleSynchronizationText(null, 'Unbekannter stabiler App-Text'), true);
    assert.equal(compatibleSynchronizationText('Unbekannter stabiler App-Text', null), true);
    assert.equal(compatibleSynchronizationText(null, null), true);
    assert.equal(compatibleSynchronizationText('Unbekannt', 'Unbekannt'), true);
});

test('backwards, excessive, unknown or malformed changed synchronization texts are rejected', () => {
    for (const [before, after] of [
        ['Synchronisiert: Vor 20 min', 'Synchronisiert: Vor 19 min'],
        ['Synchronisiert: Vor 20 min', 'Synchronisiert: Vor 26 min'],
        ['Synchronisiert: Vor 1 Tag', 'Synchronisiert: Vor 23 h'],
        ['Synchronisiert: Vor 1 h', 'Synchronisiert: Vor 1 h 60 min'],
        ['Synchronisiert: Vor 1 h', 'Synchronisiert: Vor 1 min 1 h'],
        ['Synchronisiert: Vor 1 h', 'Synchronisiert: Vor 1 h 1 h'],
        ['Unbekannt', 'Anderer Text'], ['Unbekannt', 'Synchronisiert: Vor 1 min'],
        ['Synchronisiert: Vor 1 min', 'Synchronisiert: Vor 01 min'],
        ['Synchronisiert: Vor 1 Tag', 'Synchronisiert: Vor 1 Tage'],
    ]) {
        assert.equal(compatibleSynchronizationText(before, after), false, `${before} -> ${after}`);
        reject(() => mergeReportPages([page({ synchronizationText: before }), page({ synchronizationText: after })]), 'report_changed');
    }
    for (const value of [undefined, 1, false, {}, [], '', ' '.repeat(2), 'x'.repeat(2001)]) {
        assert.equal(compatibleSynchronizationText(value, null), false);
        assert.equal(compatibleSynchronizationText(null, value), false);
    }
});

test('synchronization drift is bounded across the entire reading rather than each neighbouring page', () => {
    const pages = [
        page({ synchronizationText: null }),
        emptyPage({ synchronizationText: 'Synchronisiert: Vor 10 min' }),
        emptyPage({ synchronizationText: 'Synchronisiert: Vor 14 min' }),
        emptyPage({ atBottom: true, synchronizationText: 'Synchronisiert: Vor 16 min' }),
    ];
    reject(() => mergeReportPages(pages), 'report_changed');
    pages[3].synchronizationText = 'Synchronisiert: Vor 15 min';
    assert.equal(mergeReportPages(pages).synchronizationText, 'Synchronisiert: Vor 15 min');
});

test('strict page schema rejects hidden state, raw UI fields, accessors, sparse arrays and exotic objects', () => {
    const invalidPages = [
        null, {}, { ...page(), rawDump: PRIVATE }, { ...page(), bounds: [0, 0, 1, 1] },
        { ...page(), atTop: 1 }, { ...page(), summary: false }, { ...page(), categories: [] },
        { ...page(), additionalTexts: [null] }, { ...page(), additionalTexts: new Array(1) },
        Object.assign(Object.create({ privateData: PRIVATE }), page()),
    ];
    const accessor = page();
    Object.defineProperty(accessor, 'summary', { enumerable: true, get() { throw new Error(PRIVATE); } });
    invalidPages.push(accessor);
    const hidden = page();
    Object.defineProperty(hidden, 'privateData', { value: PRIVATE });
    invalidPages.push(hidden);
    const symbolic = page();
    symbolic[Symbol(PRIVATE)] = PRIVATE;
    invalidPages.push(symbolic);
    for (const value of invalidPages) reject(() => mergeReportPages([value]));
    const extras = page();
    extras.additionalTexts.extra = PRIVATE;
    reject(() => mergeReportPages([extras]));
    const wrongCategory = page();
    wrongCategory.categories.engine = { label: 'Antrieb', texts: [], iconColor: 'green' };
    reject(() => mergeReportPages([wrongCategory]));
});

test('prototype pollution keys and throwing objects are redacted without changing global prototypes', () => {
    const pollutedPage = JSON.parse(JSON.stringify(page()).replace('"atTop":true', '"__proto__":{"polluted":true},"atTop":true'));
    reject(() => mergeReportPages([pollutedPage]));
    const pollutedCategory = page();
    Object.defineProperty(pollutedCategory.categories, '__proto__', { enumerable: true, value: { label: PRIVATE, texts: [] } });
    reject(() => mergeReportPages([pollutedCategory]));
    const proxy = new Proxy({}, { getPrototypeOf() { throw new BridgeError('report_changed', PRIVATE); } });
    reject(() => mergeReportPages([proxy]));
    assert.equal({}.polluted, undefined);
});

test('text, page and collection bounds reject excessive reports before producing a model', () => {
    reject(() => mergeReportPages([]));
    reject(() => mergeReportPages(Array.from({ length: 9 }, () => page())));
    reject(() => mergeReportPages([page({ summary: 'x'.repeat(2001) })]));
    reject(() => mergeReportPages([page({ notice: '' })]));
    reject(() => mergeReportPages([page({ notice: '  ' })]));
    reject(() => mergeReportPages([page({ notice: 'bad\0text' })]));
    reject(() => mergeReportPages([page({ additionalTexts: Array(65).fill('Text') })]));
    const tooMany = page();
    tooMany.categories.engine.texts = Array(33).fill('Text');
    reject(() => mergeReportPages([tooMany]));
    reject(() => mergeReportPages([
        page({ additionalTexts: Array.from({ length: 40 }, (_, index) => `Text A ${index}`) }),
        page({ additionalTexts: Array.from({ length: 40 }, (_, index) => `Text B ${index}`) }),
    ]));
    assert.equal(mergeReportPages([page({ notice: 'x'.repeat(2000) })]).notice.length, 2000);
});

test('model validation checks every derived value, exact labels and statuses against raw texts', () => {
    const valid = mergeReportPages([page()]);
    for (const [key, bad] of [
        ['odometerKm', 42124], ['nextServiceDays', null], ['nextServiceKm', 0],
        ['hasMessages', true], ['messageCount', 1], ['odometerKm', '42123'],
        ['nextServiceDays', NaN], ['nextServiceKm', Infinity], ['odometerKm', -1],
        ['messageCount', -1], ['messageCount', -0], ['nextServiceDays', 0.5],
        ['odometerKm', Number.MAX_SAFE_INTEGER + 1], ['hasMessages', 0],
    ]) reject(() => validateVehicleReport({ ...valid, [key]: bad }));
    for (const key of Object.keys(REPORT_CATEGORIES)) {
        const wrongLabel = copy(valid);
        wrongLabel.categories[key].label = PRIVATE;
        reject(() => validateVehicleReport(wrongLabel));
        const wrongStatus = copy(valid);
        wrongStatus.categories[key].status = 'healthy';
        reject(() => validateVehicleReport(wrongStatus));
        wrongStatus.categories[key].status = 'unknown';
        reject(() => validateVehicleReport(wrongStatus));
        const missingCategory = copy(valid);
        delete missingCategory.categories[key];
        reject(() => validateVehicleReport(missingCategory));
    }
    const nonempty = copy(valid);
    nonempty.categories.engine.texts = ['Synthetischer App-Text'];
    reject(() => validateVehicleReport(nonempty));
    nonempty.categories.engine.status = 'unknown';
    assert.deepEqual(validateVehicleReport(nonempty), nonempty);
});

test('model validation enforces exact schema, bounded fields and unique ordered additional text', () => {
    const valid = mergeReportPages([page()]);
    for (const key of Object.keys(valid)) {
        const missing = copy(valid);
        delete missing[key];
        reject(() => validateVehicleReport(missing));
    }
    reject(() => validateVehicleReport({ ...valid, rawDump: PRIVATE }));
    reject(() => validateVehicleReport({ ...valid, notice: null }));
    reject(() => validateVehicleReport({ ...valid, additionalTexts: ['Doppelt', 'Doppelt'] }));
    reject(() => validateVehicleReport({ ...valid, additionalTexts: Array(65).fill('Text') }));
    reject(() => validateVehicleReport({ ...valid, synchronizationText: 'x'.repeat(2001) }));
    reject(() => validateVehicleReport(new Proxy({}, { ownKeys() { throw new Error(PRIVATE); } })));
    const accessor = copy(valid);
    Object.defineProperty(accessor.categories.engine, 'texts', { enumerable: true, get() { throw new Error(PRIVATE); } });
    reject(() => validateVehicleReport(accessor));
});

test('model validation returns a deep independent ordinary serializable copy from frozen or null-prototype records', () => {
    const valid = mergeReportPages([page({ additionalTexts: ['Zusatz'] })]);
    Object.freeze(valid.categories.engine.texts);
    Object.freeze(valid.categories.engine);
    Object.freeze(valid.categories);
    Object.freeze(valid.additionalTexts);
    Object.freeze(valid);
    const source = Object.assign(Object.create(null), valid);
    const result = validateVehicleReport(source);
    assert.deepEqual(result, valid);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.getPrototypeOf(result.categories), Object.prototype);
    assert.equal(Object.getPrototypeOf(result.categories.engine), Object.prototype);
    assert.notEqual(result, valid);
    assert.notEqual(result.categories, valid.categories);
    assert.notEqual(result.categories.engine.texts, valid.categories.engine.texts);
    result.categories.engine.texts.push('Lokale Änderung');
    result.additionalTexts.push('Lokaler Zusatz');
    assert.deepEqual(valid.categories.engine.texts, []);
    assert.deepEqual(valid.additionalTexts, ['Zusatz']);
    assert.deepEqual(JSON.parse(JSON.stringify(validateVehicleReport(source))), valid);
});
