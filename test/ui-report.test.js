'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Screen } = require('../lib/ui');
const { overviewReportScreen, reportScreen, POINTS, NOTICE, node, hierarchy } = require('./support/report-fixtures.cjs');
function fails(code) { return error => error.code === code; }
function editNode(xml, marker, changes) {
    return xml.replace(/<node [^>]*>/g, tag => {
        if (!tag.includes(marker)) return tag;
        for (const [key, value] of Object.entries(changes)) {
            const attr = new RegExp(' ' + key + '="[^"]*"');
            tag = attr.test(tag) ? tag.replace(attr, ' ' + key + '="' + value + '"') : tag.replace(/>$/, ' ' + key + '="' + value + '">');
        }
        return tag;
    });
}

test('report overview navigation uses the exact observed row and its local clickable parent', () => {
    const screen = new Screen(overviewReportScreen({ lower: true }));
    assert.equal(screen.kind(), 'overview');
    screen.requireVehicle({ contentDescPrefix: 'Ihr Fahrzeug: Testwagen. ' });
    assert.deepEqual(screen.reportNavigationTarget('open'), POINTS.open);
    assert.throws(() => new Screen(overviewReportScreen()).reportNavigationTarget('open'), fails('target_unavailable'));
    assert.throws(() => screen.reportNavigationTarget('start'), fails('target_unavailable'));
});

test('report top exposes raw observations and seven labels without inventing icon status', () => {
    const screen = new Screen(reportScreen());
    assert.equal(screen.kind(), 'vehicleReport');
    const page = screen.reportPage();
    assert.equal(page.atTop, true);
    assert.equal(page.atBottom, false);
    assert.equal(page.odometerText, '12.345 km');
    assert.equal(page.nextServiceText, '321 Tage');
    assert.equal(page.summary, 'Keine Meldungen');
    assert.equal(page.synchronizationText, 'Synchronisiert: Vor 2 h 15 min');
    assert.equal(page.notice, null);
    assert.equal(Object.keys(page.categories).length, 7);
    assert.deepEqual(page.categories.brakes, { label: 'Bremsen', texts: [] });
    assert.deepEqual(page.additionalTexts, []);
    assert.deepEqual(screen.reportNavigationTarget('back'), POINTS.back);
});

test('report bottom is complete only with the full final disclaimer inside the body', () => {
    const page = new Screen(reportScreen({ position: 'bottom' })).reportPage();
    assert.equal(page.atTop, false);
    assert.equal(page.atBottom, true);
    assert.equal(page.notice, NOTICE);
    assert.equal(page.odometerText, null);
    assert.equal(page.nextServiceText, null);
    assert.equal(new Screen(reportScreen({ position: 'bottom', notice: null })).reportPage().atBottom, false);
    assert.equal(new Screen(reportScreen({ position: 'bottom', notice: NOTICE + ' Extra' })).reportPage().atBottom, false);
});

test('report scrolling is derived from the unique report body and never targets a vehicle command', () => {
    const screen = new Screen(reportScreen());
    assert.deepEqual(screen.reportScrollTarget('down'), { x1: 500, y1: 1150, x2: 500, y2: 450, durationMs: 400 });
    assert.deepEqual(screen.reportScrollTarget('up'), { x1: 500, y1: 450, x2: 500, y2: 1150, durationMs: 400 });
    assert.throws(() => screen.reportScrollTarget('left'), fails('invalid_action'));
    assert.throws(() => new Screen(overviewReportScreen()).reportPage(), fails('target_unavailable'));
    assert.throws(() => screen.reportNavigationTarget('open'), fails('target_unavailable'));
    assert.throws(() => screen.target('cta_start'), fails('target_unavailable'));
});

test('partial report pages retain missing fields without treating them as zero or a complete report', () => {
    const page = new Screen(reportScreen({ odometerText: null, nextServiceText: null, summary: null,
        synchronizationText: null, categories: {}, notice: null })).reportPage();
    assert.deepEqual(page, { atTop: false, atBottom: false, odometerText: null, nextServiceText: null,
        summary: null, synchronizationText: null, categories: {}, notice: null, additionalTexts: [] });
    const hiddenSummary = editNode(reportScreen(), 'resource-id="warningHeaderTitle"', { 'visible-to-user': 'false' });
    assert.equal(new Screen(hiddenSummary).reportPage().summary, null);
});

test('category texts stay inside the exact labeled row and retain only actual textual evidence', () => {
    let xml = reportScreen({ categories: { engine: { label: 'Antrieb', texts: ['Ein sichtbarer Hinweis'] },
        brakes: { label: 'Bremsen', texts: [] } }, additionalTexts: ['Allgemeiner Berichtstext'] });
    xml = editNode(xml, 'resource-id="warningLeadingIconEngine"', { 'content-desc': 'Symbolbeschreibung aus der App' });
    const page = new Screen(xml).reportPage();
    assert.deepEqual(page.categories.engine, { label: 'Antrieb', texts: ['Symbolbeschreibung aus der App', 'Ein sichtbarer Hinweis'] });
    assert.deepEqual(page.categories.brakes, { label: 'Bremsen', texts: [] });
    assert.deepEqual(page.additionalTexts, ['Allgemeiner Berichtstext']);
    assert.equal(Object.hasOwn(page.categories.engine, 'status'), false);
    assert.equal(Object.hasOwn(page.categories.brakes, 'healthy'), false);
});

test('unknown report text is preserved while outside navigation, vehicle markers and foreign text are excluded', () => {
    let xml = reportScreen({ position: 'bottom', additionalTexts: ['Unbekannter Berichtshinweis', 'Unbekannter Berichtshinweis'] });
    const marker = node('', { 'content-desc': 'Ihr Fahrzeug: Anderes Merkmal. Synchronisiert', bounds: '[50,1170][950,1210]' });
    const outside = node('', { text: 'Text außerhalb des Berichts', bounds: '[0,0][100,50]' });
    const beforeBodyEnd = xml.lastIndexOf('</node></node></hierarchy>');
    xml = xml.slice(0, beforeBodyEnd) + marker + xml.slice(beforeBodyEnd);
    xml = xml.replace('</hierarchy>', outside + '</hierarchy>');
    assert.deepEqual(new Screen(xml).reportPage().additionalTexts, ['Unbekannter Berichtshinweis']);
    const foreign = editNode(reportScreen({ additionalTexts: ['Nicht aus VW'] }), 'text="Nicht aus VW"', { package: 'other.app' });
    assert.deepEqual(new Screen(foreign).reportPage().additionalTexts, []);
    assert.throws(() => new Screen(foreign).checkClear(), fails('blocked_ui'));
});

test('duplicate visible known fields or malformed card contents fail closed', () => {
    const xml = reportScreen();
    const summaryDuplicate = xml.replace(/<node [^>]*resource-id="warningHeaderTitle"[^>]*><\/node>/, '$&$&');
    assert.throws(() => new Screen(summaryDuplicate).reportPage(), fails('unknown_state'));
    assert.throws(() => new Screen(xml.replace('resource-id="nextInspection"', 'resource-id="totalDistance"')).reportPage(), fails('unknown_state'));
    assert.throws(() => new Screen(xml.replace('Gesamtstrecke', 'Unbekannte Strecke')).reportPage(), fails('unknown_state'));
    const valueDuplicate = xml.replace(/<node [^>]*text="12\.345 km"[^>]*><\/node>/, '$&$&');
    assert.throws(() => new Screen(valueDuplicate).reportPage(), fails('unknown_state'));
    assert.throws(() => new Screen(editNode(xml, 'text="12.345 km"', { class: 'android.view.View' })).reportPage(), fails('unknown_state'));
    assert.throws(() => new Screen(editNode(xml, 'text="12.345 km"', { bounds: '[50,185][50,230]' })).reportPage(), fails('unknown_state'));
});

test('known categories require exact labels and keep their icons in the same row', () => {
    const xml = reportScreen();
    assert.throws(() => new Screen(xml.replace('text="Antrieb"', 'text="Andere Kategorie"')).reportPage(), fails('unknown_state'));
    assert.throws(() => new Screen(xml.replace('resource-id="warningNameAssistance"', 'resource-id="warningNameEngine"')).reportPage(), fails('unknown_state'));
    const wrongParent = xml.replace('resource-id="warningLeadingIconEngine"', 'resource-id="unassignedIcon"')
        .replace('resource-id="warningLeadingIconAssistance"', 'resource-id="warningLeadingIconEngine"');
    assert.throws(() => new Screen(wrongParent).reportPage(), fails('unknown_state'));
    const foreignLabel = editNode(xml, 'resource-id="warningNameEngine"', { package: 'other.app' });
    assert.equal(new Screen(foreignLabel).reportPage().categories.engine, undefined);
    assert.throws(() => new Screen(foreignLabel).checkClear(), fails('blocked_ui'));
});

test('clipped values are not emitted and clipped cards cannot prove the top position', () => {
    const xml = reportScreen();
    const clippedValue = editNode(xml, 'text="12.345 km"', { bounds: '[50,100][650,110]' });
    assert.equal(new Screen(clippedValue).reportPage().odometerText, null);
    assert.equal(new Screen(clippedValue).reportPage().atTop, false);
    const clippedCard = editNode(xml, 'resource-id="totalDistance"', { bounds: '[0,100][1000,250]' });
    assert.equal(new Screen(clippedCard).reportPage().atTop, false);
    assert.equal(new Screen(clippedCard).reportPage().odometerText, '12.345 km');
});

test('the disclaimer is not an end marker if clipped, duplicated or followed by further report text', () => {
    const xml = reportScreen({ position: 'bottom' });
    const clipped = editNode(xml, 'text="Nur die Warn- und Kontrollleuchten', { bounds: '[50,1400][950,1500]' });
    assert.equal(new Screen(clipped).reportPage().notice, null);
    assert.equal(new Screen(clipped).reportPage().atBottom, false);
    const duplicate = xml.replace(/<node [^>]*text="Nur die Warn- und Kontrollleuchten[^>]*><\/node>/, '$&$&');
    assert.throws(() => new Screen(duplicate).reportPage(), fails('unknown_state'));
    const after = node('', { class: 'android.widget.TextView', text: 'Ein weiterer Berichtstext', bounds: '[50,1450][950,1490]' });
    const index = xml.lastIndexOf('</node></node></hierarchy>');
    const extended = new Screen(xml.slice(0, index) + after + xml.slice(index)).reportPage();
    assert.equal(extended.notice, NOTICE);
    assert.equal(extended.atBottom, false);
    assert.deepEqual(extended.additionalTexts, ['Ein weiterer Berichtstext']);
});

test('report identity and body geometry reject ambiguous, disabled or malformed views', () => {
    const xml = reportScreen();
    assert.throws(() => new Screen(xml.replace('content-desc="Fahrzeugzustandsbericht"', 'content-desc="Andere Ansicht"')).kind(), fails('unknown_state'));
    assert.throws(() => new Screen(editNode(xml, 'resource-id="vehicle_health_compose_view"', { enabled: 'false' })).kind(), fails('unknown_state'));
    assert.throws(() => new Screen(editNode(xml, 'resource-id="warningNameBrake"', { enabled: 'false' })).reportPage(), fails('unknown_state'));
    assert.throws(() => new Screen(editNode(xml, 'resource-id="warningHeaderSubtitle"', { bounds: 'invalid' })).reportPage(), fails('unknown_state'));
    const secondBody = node('', { class: 'android.widget.ScrollView', scrollable: 'true', bounds: '[0,100][1000,1500]' });
    assert.throws(() => new Screen(xml.replace(/(?=<node [^>]*class="android.widget.ScrollView")/, secondBody)).kind(), fails('unknown_state'));
    const wrongOwner = editNode(xml, 'resource-id="vehicle_health_compose_view"', { package: 'other.app' });
    assert.throws(() => new Screen(wrongOwner).reportPage(), fails('target_unavailable'));
});

test('report navigation refuses duplicate, foreign, disabled or unrelated overview entries', () => {
    const xml = overviewReportScreen({ lower: true });
    const duplicate = xml.replace(/<node [^>]*content-desc="Fahrzeugzustandsbericht\. Details öffnen"[^>]*><\/node>/, '$&$&');
    assert.throws(() => new Screen(duplicate).reportNavigationTarget('open'), fails('unknown_state'));
    assert.throws(() => new Screen(editNode(xml, 'content-desc="Fahrzeugzustandsbericht. Details öffnen"', { package: 'other.app' })).reportNavigationTarget('open'), fails('target_unavailable'));
    assert.throws(() => new Screen(editNode(xml, 'bounds="[50,900][950,1100]"', { enabled: 'false' })).reportNavigationTarget('open'), fails('unknown_state'));
    assert.throws(() => new Screen(editNode(reportScreen(), 'resource-id="vehicleHealthBack"', { clickable: 'false' })).reportNavigationTarget('back'), fails('target_unavailable'));
    const outside = node('', { 'content-desc': 'Fahrzeugzustandsbericht. Details öffnen', clickable: 'true', bounds: '[0,0][100,50]' });
    assert.throws(() => new Screen(overviewReportScreen().replace('</hierarchy>', outside + '</hierarchy>')).reportNavigationTarget('open'), fails('target_unavailable'));
});
