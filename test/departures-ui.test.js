'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DepartureScreen } = require('../lib/departures-ui');
const { Screen, PACKAGE } = require('../lib/ui');
const { BridgeError } = require('../lib/errors');

// Original synthetic layouts: names, times, rectangles and data are invented.
// Only verified app labels, class names and control identifiers are reused.
function node(attrs = {}, children = []) {
    return { attrs: { package: PACKAGE, class: 'android.view.View', enabled: 'true',
        'visible-to-user': 'true', clickable: 'false', checkable: 'false', checked: 'false', selected: 'false',
        bounds: '[0,0][1000,1800]', ...attrs }, children };
}
function text(value, bounds, extra = {}) { return node({ class: 'android.widget.TextView', text: value, bounds, ...extra }); }
function escape(value) { return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function render(tree) {
    return '<node ' + Object.entries(tree.attrs).map(([key, value]) => key + '="' + escape(value) + '"').join(' ') + '>'
        + tree.children.map(render).join('') + '</node>';
}
function document(scope) { return '<hierarchy>' + render(scope) + '</hierarchy>'; }
function switchView(bounds, checked = false) {
    const inner = node({ bounds, clickable: 'true', checkable: 'true', checked: String(checked) });
    const outer = node({ bounds, clickable: 'true', checkable: 'true', checked: String(checked) }, [inner]);
    return { outer, inner };
}
function page(title, children, options = {}) {
    const titleNode = node({ 'content-desc': title, bounds: '[140,110][860,170]' });
    const back = node({ class: 'android.widget.Button', clickable: 'true', bounds: '[20,90][160,190]' });
    const right = options.right ? node({ class: 'android.widget.Button', clickable: 'true',
        text: options.right === 'save' ? 'Speichern' : '', bounds: '[840,90][980,190]' }) : null;
    const header = node({ bounds: '[0,80][1000,200]' }, [back, titleNode, ...(right ? [right] : [])]);
    const body = node({ class: options.bodyClass || 'android.widget.ScrollView', scrollable: String(options.scrollable ?? true),
        bounds: options.headerInside ? '[0,80][1000,1800]' : '[0,200][1000,1800]' }, children);
    const content = node({}, options.headerInside ? [body] : [header, body]);
    if (options.headerInside) body.children.unshift(back, titleNode, ...(right ? [right] : []));
    const scope = node({ class: 'androidx.compose.ui.platform.ComposeView', 'resource-id': 'composeView' }, [content]);
    return { scope, title: titleNode, back, right, header, body, xml: () => document(scope) };
}
function timerRow(top, time, days, checked = false) {
    const label = text(time, '[80,' + (top + 30) + '][250,' + (top + 90) + ']');
    const summary = text(days, '[80,' + (top + 125) + '][500,' + (top + 165) + ']');
    const control = switchView('[800,' + (top + 20) + '][930,' + (top + 140) + ']', checked);
    const row = node({ clickable: 'true', bounds: '[50,' + top + '][950,' + (top + 200) + ']' },
        [node({ bounds: '[70,' + (top + 10) + '][940,' + (top + 145) + ']' }, [label, control.outer]), summary]);
    return { row, label, summary, ...control };
}
function overview(options = {}) {
    const timers = [timerRow(500, '06:45', 'Montag', true), timerRow(720, '19:20', 'Dienstag', false)];
    const climate = node({ bounds: '[50,280][950,950]' }, [node({ bounds: '[50,280][950,450]' },
        [text('Klimatisierung', '[200,320][600,380]')]), ...timers.map(timer => timer.row)]);
    const names = options.names || ['Testort Alpha'];
    const places = names.map((name, index) => {
        const top = 1250 + index * 150;
        const label = text(name, '[80,' + top + '][450,' + (top + 50) + ']');
        const summary = text(index % 2 + ' aktive Abfahrtszeiten', '[80,' + (top + 60) + '][600,' + (top + 105) + ']');
        const button = node({ clickable: 'true', bounds: '[800,' + top + '][930,' + (top + 110) + ']' },
            [text('Aktiv', '[810,' + (top + 30) + '][920,' + (top + 80) + ']')]);
        return { row: node({ clickable: 'true', bounds: '[50,' + (top - 10) + '][950,' + (top + 120) + ']' }, [label, summary, button]), label, summary, button };
    });
    const charging = node({ bounds: '[50,1000][950,1790]' }, [node({ bounds: '[50,1000][950,1180]' },
        [text('Laden', '[200,1040][600,1100]')]), ...places.map(place => place.row)]);
    return { ...page('Abfahrtszeiten', [climate, charging], { headerInside: true }), timers, places, climate, charging };
}
function location(name = 'Testort Beta') {
    const timers = [timerRow(400, '08:10', 'Samstag', false), timerRow(650, '16:35', 'Am Wochenende', true), timerRow(900, '04:25', 'Jeden Tag', false)];
    return { ...page(name, timers.map(timer => timer.row), { right: 'gear' }), timers };
}
function editor(options = {}) {
    const dayDefs = [['MONDAY', 'Mo'], ['TUESDAY', 'Di'], ['WEDNESDAY', 'Mi'], ['THURSDAY', 'Do'], ['FRIDAY', 'Fr'], ['SATURDAY', 'Sa'], ['SUNDAY', 'So']];
    const days = dayDefs.map(([id, label], index) => {
        const left = 40 + 135 * index;
        return node({ 'resource-id': 'cta_' + id, clickable: 'true', bounds: '[' + left + ',900][' + (left + 120) + ',1030]' },
            [text(label, '[' + (left + 30) + ',940][' + (left + 90) + ',990]')]);
    });
    // Native Compose touch bounds extend beyond this small semantics anchor.
    const weekday = node({ 'resource-id': 'editDepartureTimerWeekday', bounds: '[50,910][950,1020]' }, days);
    const repeat = switchView('[800,1110][930,1230]', options.repeat ?? true);
    const repeatRow = node({ 'resource-id': 'editDepartureTimerRepeat', bounds: '[50,1080][950,1270]' },
        [text('Wiederholen', '[200,1130][600,1190]'), repeat.outer]);
    const wheels = ['hour', 'minute'].map((part, index) => node({ class: 'android.widget.SeekBar',
        'content-desc': index ? 'Minute' : 'Hour', 'state-description': index ? '25' : '07',
        'range-type': '1', 'range-min': '0', 'range-max': index ? '119999' : '229999',
        'range-current': index ? '60001' : '115001', 'a11y-actions': '[64,4096,8192,16908349]',
        bounds: index ? '[580,500][660,820]' : '[380,500][460,820]' }));
    const wheelContent = node({ bounds: '[50,480][950,840]' }, wheels);
    const wheelWrapper = node({ bounds: '[50,480][950,840]', 'visible-to-user': 'false',
        'important-for-accessibility': 'false', 'a11y-actions': '[64]' }, [wheelContent]);
    const wheelChildren = options.rich === false ? [] : options.wrapped ? [wheelWrapper] : wheels;
    const result = page('Zeit einstellen', [...wheelChildren, weekday, repeatRow], { right: options.dirty ? 'save' : null });
    return { ...result, days, weekday, repeatRow, repeat, wheels, wheelWrapper, wheelContent };
}
function gear(options = {}) {
    const name = node({ class: 'android.widget.EditText', text: 'Testort Gamma', clickable: 'true', bounds: '[50,280][950,400]' });
    const reduced = switchView('[800,1080][930,1200]', true);
    const unlock = switchView('[800,1320][930,1440]', false);
    const reducedRow = node({ clickable: 'true', bounds: '[0,1040][1000,1240]' }, [text('Reduzierter AC-Ladestrom', '[50,1100][650,1160]'), reduced.outer]);
    const unlockRow = node({ clickable: 'true', bounds: '[0,1280][1000,1480]' }, [text('AC-Stecker automatisch entriegeln', '[50,1340][700,1400]'), unlock.outer]);
    const preferredLabel = text('Bevorzugte Zeiten', '[50,1580][650,1640]');
    const preferred = node({ clickable: 'true', bounds: '[0,1540][1000,1700]' }, [preferredLabel]);
    return { ...page('Ladeeinstellungen', [name, text('Direkt laden bis (0-50 %)', '[50,500][700,560]'),
        text('Laden bis (50-100 %)', '[50,800][700,860]'), reducedRow, unlockRow, ...(options.preferred === false ? [] : [preferred])],
    { bodyClass: 'android.view.View', scrollable: true, right: options.dirty ? 'save' : null }),
    name, reduced, unlock, reducedRow, unlockRow, preferredLabel, preferred };
}
function preferred(options = {}) {
    const ranges = ['20:15 - 05:45', '06:20 - 08:50', '11:10 - 13:40', '16:05 - 19:30'];
    const slots = ranges.map((range, index) => {
        const top = 550 + index * 230;
        const label = text(range, '[50,' + (top + 30) + '][400,' + (top + 90) + ']');
        const control = switchView('[800,' + top + '][930,' + (top + 120) + ']', index % 2 === 0);
        return { label, ...control };
    });
    const container = node({ bounds: '[50,520][950,1400]' }, slots.flatMap(slot => [slot.label, slot.outer]));
    return { ...page('Bevorzugte Zeiten', [container], { bodyClass: 'android.view.View', scrollable: false, right: options.dirty ? 'save' : null }), slots, container };
}
function screen(fixture) { return new DepartureScreen(fixture.xml()); }
function invalid(operation, codes = ['unknown_state', 'target_unavailable', 'blocked_ui']) {
    assert.throws(operation, error => error instanceof BridgeError && codes.includes(error.code));
}

test('DepartureScreen reuses Screen parsing and recognizes only the verified departure page shapes', () => {
    for (const [fixture, expected] of [[overview(), 'departuresOverview'], [location(), 'locationOverview'],
        [editor(), 'timerEditor'], [gear(), 'locationSettings'], [preferred(), 'preferredTimes']]) {
        const view = screen(fixture);
        assert.ok(view instanceof Screen);
        assert.equal(view.kind(), expected);
    }
    assert.equal(new DepartureScreen('<hierarchy>' + render(node({ 'resource-id': 'climateTile' })) + '</hierarchy>').kind(), 'overview');
    invalid(() => new DepartureScreen('<!DOCTYPE x><hierarchy/>'), ['invalid_ui']);
});

test('home reads and return-home reads delegate to Screen before interpreting multiple tile descriptions as departure headers', () => {
    const tiles = ['climateTile', 'rangeTile'].map((id, index) => node({ 'resource-id': id,
        bounds: '[' + (index * 500) + ',400][' + (index * 500 + 490) + ',900]' }, [
        node({ 'content-desc': index ? 'Übersicht Reichweite. Details öffnen' : 'Vorklimatisierung. An. Details öffnen',
            bounds: '[' + (index * 500 + 20) + ',450][' + (index * 500 + 450) + ',600]' }),
        node({ class: 'android.widget.Button', clickable: 'true', bounds: '[' + (index * 500 + 20) + ',450][' + (index * 500 + 450) + ',600]' }),
    ]));
    const home = node({ 'resource-id': 'composeView', class: 'androidx.compose.ui.platform.ComposeView' }, tiles);
    const homeXml = () => document(home);
    assert.equal(new Screen(homeXml()).kind(), 'overview');
    assert.equal(new DepartureScreen(homeXml()).kind(), 'overview');
    const navigationReadSequence = [homeXml(), overview().xml(), homeXml()];
    assert.deepEqual(navigationReadSequence.map(xml => new DepartureScreen(xml).kind()), ['overview', 'departuresOverview', 'overview']);
    // A visible foreign/manual departure overlay must never inherit Home just
    // because the background still contains a climate tile.
    for (const overlay of [editor({ dirty: true }), gear({ dirty: true }), preferred({ dirty: true }), location()]) {
        home.children.push(overlay.scope.children[0]);
        invalid(() => new DepartureScreen(homeXml()).kind());
        home.children.pop();
    }
});

test('overview timers retain explicit enabled states, day labels and fixed slot order', () => {
    const fixture = overview();
    const view = screen(fixture);
    assert.deepEqual(view.departuresOverview(), { climateTimers: [
        { id: '1', time: '06:45', days: ['mon'], daysText: 'Montag', enabled: true },
        { id: '2', time: '19:20', days: ['tue'], daysText: 'Dienstag', enabled: false },
    ], locations: [{ name: 'Testort Alpha', activeCount: 0 }], scrollState: { forward: null, backward: null } });
    assert.deepEqual(view.overviewTimer('1'), { x: 165, y: 560 });
    assert.deepEqual(view.overviewTimer('1', 'enabled'), { x: 865, y: 580 });
    assert.deepEqual(view.locationOpen('Testort Alpha'), { x: 265, y: 1275 });
    for (const id of ['0', '3', 1, null, '__proto__']) invalid(() => view.overviewTimer(id));
    invalid(() => view.overviewTimer('1', 'arbitrary'));
    invalid(() => view.locationOpen('Testort alpha'));
});

test('three location timers require the exact expected private name and map verified weekend/every-day labels', () => {
    const view = screen(location());
    const value = view.locationOverview('Testort Beta');
    assert.equal(value.timers.length, 3);
    assert.deepEqual(value.timers[1].days, ['sat', 'sun']);
    assert.deepEqual(value.timers[2].days, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    assert.deepEqual(view.overviewTimer('3'), { x: 165, y: 960 });
    assert.deepEqual(view.headerTarget('right'), { x: 910, y: 140 });
    invalid(() => view.locationOverview('Other test location'));
    invalid(() => view.locationOverview(null));
    invalid(() => view.overviewTimer('4'));
});

test('a complete non-scrollable charging-location settings page is read-only', () => {
    const fixture = gear();
    fixture.body.attrs.scrollable = 'false';
    fixture.body.attrs['a11y-actions'] = '[64]';
    const view = screen(fixture);
    assert.equal(view.kind(), 'locationSettings');
    assert.equal(view.gearSettings().name, 'Testort Gamma');
    assert.deepEqual(view.preferredNavTarget(), { x: 350, y: 1610 });
    assert.deepEqual(view.headerTarget('back'), { x: 90, y: 140 });
    invalid(() => view.gearToggleTarget('reducedAcCurrent', false));
    invalid(() => view.gearToggleTarget('autoUnlockAc', true));
    invalid(() => view.saveTarget());
    const dirty = gear({ dirty: true });
    dirty.body.attrs.scrollable = 'false'; dirty.body.attrs['a11y-actions'] = '[64]';
    invalid(() => screen(dirty).saveTarget());
});

test('non-scrollable settings require complete content, no scroll action and unobstructed navigation', () => {
    for (const edit of [
        f => { delete f.body.attrs['a11y-actions']; },
        f => { f.body.attrs['a11y-actions'] = '[64,4096]'; },
        f => { f.body.attrs['a11y-actions'] = '[64,8192]'; },
        f => { f.preferredLabel.attrs.text = 'unrecognized'; },
        f => { f.body.children.push(text('Bevorzugte Zeiten', '[50,1400][400,1450]')); },
        f => { f.name.attrs.bounds = '[0,0][0,0]'; },
    ]) {
        const fixture = gear(); fixture.body.attrs.scrollable = 'false'; fixture.body.attrs['a11y-actions'] = '[64]'; edit(fixture);
        invalid(() => screen(fixture).gearSettings());
    }
    const covered = gear(); covered.body.attrs.scrollable = 'false'; covered.body.attrs['a11y-actions'] = '[64]';
    covered.body.children.push(node({ clickable: 'true', bounds: '[300,1590][400,1650]' }));
    invalid(() => screen(covered).preferredNavTarget());
    const clickableParent = gear(); clickableParent.body.attrs.scrollable = 'false';
    clickableParent.body.attrs['a11y-actions'] = '[64]'; clickableParent.body.attrs.clickable = 'true';
    invalid(() => screen(clickableParent).preferredNavTarget());
    const outside = gear(); outside.body.attrs.scrollable = 'false'; outside.body.attrs['a11y-actions'] = '[64]';
    const overlay = render(node({ clickable: 'true', bounds: '[300,1590][400,1650]' }));
    invalid(() => new DepartureScreen(outside.xml().replace('</hierarchy>', overlay + '</hierarchy>')).preferredNavTarget());
    const unbounded = render(node({ clickable: 'true', bounds: '[0,0][0,0]' }));
    invalid(() => new DepartureScreen(outside.xml().replace('</hierarchy>', unbounded + '</hierarchy>')).preferredNavTarget());
});

test('slightly shifted switch semantics can be observed but cannot be switched', () => {
    const fixture = overview();
    fixture.timers[0].inner.attrs.bounds = '[803,523][933,643]';
    const view = screen(fixture);
    assert.equal(view.departuresOverview().climateTimers[0].enabled, true);
    assert.deepEqual(view.overviewTimer('1', 'editor'), { x: 165, y: 560 });
    invalid(() => view.overviewTimer('1', 'enabled'));

    const timerEditor = editor();
    timerEditor.repeat.inner.attrs.bounds = '[803,1113][933,1233]';
    invalid(() => screen(timerEditor).repeatTarget(false));
    const settings = gear();
    settings.reduced.inner.attrs.bounds = '[803,1083][933,1203]';
    invalid(() => screen(settings).gearToggleTarget('reducedAcCurrent', false));
    const windows = preferred();
    windows.slots[0].inner.attrs.bounds = '[803,553][933,673]';
    invalid(() => screen(windows).preferredToggleTarget('1', false));
});

test('timer editor target must avoid every shifted switch rectangle', () => {
    const fixture = overview();
    fixture.timers[0].inner.attrs.bounds = '[805,520][935,640]';
    fixture.timers[0].label.attrs.bounds = '[795,530][809,590]';
    invalid(() => screen(fixture).departuresOverview());
    invalid(() => screen(fixture).overviewTimer('1', 'editor'));
});

test('anonymous switch copies must be nested, tightly aligned, enabled and consistent', () => {
    for (const edit of [
        f => { f.timers[0].inner.attrs.checked = 'false'; },
        f => { f.timers[0].inner.attrs.enabled = 'false'; },
        f => { f.timers[0].inner.attrs.bounds = '[790,520][920,640]'; },
        f => { f.timers[0].inner.attrs.bounds = '[810,520][940,640]'; },
        f => { f.timers[0].inner.attrs.bounds = '[803,523][930,640]'; },
        f => { f.timers[0].inner.attrs.class = 'android.widget.Button'; },
        f => { f.timers[0].inner.attrs.clickable = 'false'; },
        f => { f.timers[0].row.children.push(node({ checkable: 'true', checked: 'true', clickable: 'true', bounds: '[800,520][930,640]' })); },
    ]) {
        const fixture = overview(); edit(fixture);
        invalid(() => screen(fixture).departuresOverview());
        invalid(() => screen(fixture).overviewTimer('1', 'enabled'));
    }
});

test('missing/extra timer rows, ambiguous names and malformed location counts fail closed', () => {
    for (const edit of [
        f => { f.climate.children.pop(); },
        f => { f.climate.children.push(timerRow(400, '12:00', 'Montag').row); },
        f => { f.places[0].summary.attrs.text = '4 aktive Abfahrtszeiten'; },
        f => { f.places[0].summary.attrs.text = 'unknown count'; },
        f => { f.charging.children.push(f.places[0].row); },
        f => { f.places[0].label.attrs.text = ''; },
    ]) {
        const fixture = overview(); edit(fixture);
        invalid(() => screen(fixture).departuresOverview());
    }
    invalid(() => screen(overview({ names: Array.from({ length: 6 }, (_, index) => 'Place ' + index) })).departuresOverview());
});

test('unknown day summaries remain unknown instead of acquiring a guessed weekly schedule', () => {
    const fixture = overview();
    fixture.timers[0].summary.attrs.text = 'Andere Kalenderregel';
    fixture.timers[1].summary.attrs.text = 'Montag, Freitag';
    const values = screen(fixture).departuresOverview().climateTimers;
    assert.equal(values[0].days, null);
    assert.deepEqual(values[1].days, ['mon', 'fri']);
});

test('header targets tolerate verified overlap but require direct siblings, center positions and enabled paths', () => {
    const fixture = location();
    assert.deepEqual(screen(fixture).headerTarget('back'), { x: 90, y: 140 });
    for (const edit of [
        f => { f.back.attrs.bounds = '[300,90][420,190]'; },
        f => { f.right.attrs.bounds = '[840,250][980,350]'; },
        f => { f.back.attrs.enabled = 'false'; },
        f => { f.back.attrs.text = 'Unknown action'; },
        f => { f.header.children.push(node({ class: 'android.widget.Button', clickable: 'true', bounds: '[10,90][110,190]' })); },
    ]) {
        const changed = location(); edit(changed);
        invalid(() => screen(changed).headerTarget('back'));
    }
    const changed = location(); changed.right.attrs.text = 'Unknown action';
    invalid(() => screen(changed).headerTarget('right'));
    invalid(() => screen(changed).locationOverview('Testort Beta'));
});

test('package, visible bounds, foreign foreground and duplicate compose anchors are never bypassed', () => {
    for (const edit of [
        f => { f.scope.attrs.package = 'example.foreign'; },
        f => { f.scope.attrs.enabled = 'false'; },
        f => { f.title.attrs.bounds = '[140,110][140,170]'; },
        f => { f.timers[0].label.attrs['visible-to-user'] = 'false'; },
        f => { f.scope.children.push(node({ 'resource-id': 'composeView', class: 'androidx.compose.ui.platform.ComposeView' })); },
        f => { f.scope.children.push(node({ 'resource-id': 'dialog_alert' })); },
    ]) {
        const fixture = overview(); edit(fixture);
        invalid(() => screen(fixture).departuresOverview());
    }
});

test('basic timer editor reads repeat but leaves unavailable clock and every weekday selection unknown', () => {
    const fixture = editor({ rich: false });
    const view = screen(fixture);
    assert.deepEqual(view.timerEditor(), { time: null, repeat: true, days: null, canSave: false });
    assert.deepEqual(view.dayTarget('mon'), { x: 100, y: 965 });
    assert.deepEqual(view.dayTarget('sun'), { x: 910, y: 965 });
    assert.deepEqual(view.repeatTarget(false), { x: 865, y: 1170 });
    invalid(() => view.wheelTarget('hour'));
    for (const day of ['MONDAY', 'Mo', '__proto__', 'constructor', 1, null]) invalid(() => view.dayTarget(day));
    invalid(() => view.repeatTarget('false'));
});

test('extended wheels read exact state descriptions without treating virtual range indexes as times', () => {
    const fixture = editor({ repeat: false });
    const view = screen(fixture);
    assert.deepEqual(view.timerEditor(), { time: '07:25', repeat: false, days: null, canSave: false });
    const wheel = view.wheelTarget('hour');
    assert.deepEqual(wheel, { bounds: [380, 500, 460, 820], range: { type: 1, min: 0, max: 229999, current: 115001 },
        state: 7, actions: [64, 4096, 8192, 16908349] });
    wheel.bounds[0] = 99; wheel.actions.push(1); wheel.range.current = 99;
    assert.deepEqual(view.wheelTarget('hour').bounds, [380, 500, 460, 820]);
    assert.equal(view.wheelTarget('hour').range.current, 115001);
    assert.equal(view.wheelTarget('hour').actions.includes(1), false);
    invalid(() => view.wheelTarget('day'));
});

test('clock metadata rejects partial wheels, duplicate descriptions, invalid ranges, wrong states or unsafe action arrays', () => {
    for (const edit of [
        f => { f.body.children.splice(0, 1); },
        f => { f.body.children.push(f.wheels[0]); },
        f => { f.wheels[0].attrs.class = 'android.view.View'; },
        f => { f.wheels[0].attrs['state-description'] = '24'; },
        f => { f.wheels[1].attrs['state-description'] = '60'; },
        f => { f.wheels[0].attrs['state-description'] = '7'; },
        f => { f.wheels[0].attrs['range-current'] = '230000'; },
        f => { f.wheels[0].attrs['range-max'] = 'NaN'; },
        f => { f.wheels[0].attrs['range-type'] = '0'; },
        f => { f.wheels[0].attrs['a11y-actions'] = '[16]'; },
        f => { f.wheels[0].attrs['a11y-actions'] = '[4096,4096]'; },
        f => { f.wheels[0].attrs['a11y-actions'] = '[4096,"8192"]'; },
        f => { f.wheels[0].attrs['a11y-actions'] = 'not-json'; },
        f => { f.wheels[0].attrs.enabled = 'false'; },
    ]) {
        const fixture = editor(); edit(fixture);
        invalid(() => screen(fixture).timerEditor());
    }
});

test('weekday buttons require their exact scope and label while false checked/selected never means deselected', () => {
    const fixture = editor();
    assert.equal(screen(fixture).timerEditor().days, null);
    fixture.days[0].attrs.selected = 'true';
    assert.equal(screen(fixture).timerEditor().days, null);
    for (const edit of [
        f => { f.days[0].children[0].attrs.text = 'Di'; },
        f => { f.days[0].attrs.enabled = 'false'; },
        f => { f.weekday.children.push(f.days[0]); },
        f => { f.weekday.children.pop(); },
        f => { f.weekday.children.push(node({ clickable: 'true', 'resource-id': 'cta_UNKNOWN', bounds: '[40,900][160,1030]' })); },
    ]) {
        const changed = editor(); edit(changed);
        invalid(() => screen(changed).dayTarget('mon'));
    }
});

test('only an exact header Save button can save and pending edits cannot be closed through the generic back target', () => {
    const fixture = editor({ dirty: true });
    const view = screen(fixture);
    assert.equal(view.timerEditor().canSave, true);
    assert.deepEqual(view.saveTarget(), { x: 910, y: 140 });
    invalid(() => view.headerTarget('back'), ['unsaved_settings']);
    invalid(() => screen(editor()).saveTarget());
    fixture.right.attrs.text = 'Other action';
    invalid(() => screen(fixture).saveTarget());
    invalid(() => screen(fixture).headerTarget('right'));
    fixture.right.children.push(text('Speichern', '[860,110][970,170]'));
    invalid(() => screen(fixture).saveTarget());
    fixture.right.children = [];
    fixture.right.attrs.text = 'Speichern'; fixture.right.attrs.enabled = 'false';
    invalid(() => screen(fixture).saveTarget());
});

test('location gear reads only visible supported options and leaves inaccessible Canvas SOC values unknown', () => {
    const fixture = gear();
    const view = screen(fixture);
    assert.deepEqual(view.gearSettings(), { name: 'Testort Gamma', directSoc: null, socLimit: null,
        reducedAcCurrent: true, autoUnlockAc: false, preferredTimesAvailable: true, canSave: false });
    assert.deepEqual(view.gearToggleTarget('autoUnlockAc', true), { x: 865, y: 1380 });
    assert.deepEqual(view.preferredNavTarget(), { x: 350, y: 1610 });
    invalid(() => view.gearToggleTarget('socLimit', true));
    invalid(() => view.gearToggleTarget('__proto__', false));
    invalid(() => view.gearToggleTarget('autoUnlockAc', 1));
    const gesture = view.scrollTarget('down');
    assert.deepEqual(gesture, { x1: 500, y1: 1400, x2: 500, y2: 600, durationMs: 400 });
    assert.deepEqual(view.scrollTarget('up'), { x1: 500, y1: 600, x2: 500, y2: 1400, durationMs: 400 });
});

test('a gear name partially covered by the sticky header is omitted, while duplicate names or switches remain errors', () => {
    const fixture = gear(); fixture.name.attrs.bounds = '[50,150][950,270]';
    assert.equal(screen(fixture).gearSettings().name, null);
    for (const edit of [
        f => { f.body.children.push(f.name); },
        f => { f.reduced.inner.attrs.checked = 'false'; },
        f => { f.preferred.children.push(text('Bevorzugte Zeiten', '[50,1580][650,1640]')); },
    ]) {
        const changed = gear(); edit(changed);
        invalid(() => screen(changed).gearSettings());
    }
    invalid(() => screen(gear({ preferred: false })).preferredNavTarget());
});

test('four preferred ranges are paired to their adjacent switches and remain read-only time windows', () => {
    const view = screen(preferred());
    assert.deepEqual(view.preferredTimes(), { windows: [
        { id: '1', start: '20:15', end: '05:45', enabled: true, editable: false },
        { id: '2', start: '06:20', end: '08:50', enabled: false, editable: false },
        { id: '3', start: '11:10', end: '13:40', enabled: true, editable: false },
        { id: '4', start: '16:05', end: '19:30', enabled: false, editable: false },
    ], notice: null, canSave: false });
    assert.deepEqual(view.preferredToggleTarget('4', true), { x: 865, y: 1300 });
    for (const id of ['0', '5', 1, '__proto__']) invalid(() => view.preferredToggleTarget(id, true));
    invalid(() => view.preferredToggleTarget('1', 'true'));
    invalid(() => view.wheelTarget('hour'));
});

test('preferred ranges reject missing pairs, overlapping assignments, unexpected editors and malformed times', () => {
    for (const edit of [
        f => { f.container.children.pop(); },
        f => { f.slots[0].inner.attrs.checked = 'false'; },
        f => { f.slots[0].label.attrs.text = '24:00 - 05:45'; },
        f => { f.slots[0].label.attrs.clickable = 'true'; },
        f => { f.container.children.reverse(); },
        f => { f.slots[1].outer.attrs.bounds = '[800,550][930,670]'; },
        f => { f.container.children.push(f.slots[0].label, f.slots[0].outer); },
    ]) {
        const fixture = preferred(); edit(fixture);
        invalid(() => screen(fixture).preferredTimes());
    }
});

test('partial departure pages omit incomplete climate cards while retaining complete location rows and rich scroll directions', () => {
    const fixture = overview();
    fixture.climate.attrs.bounds = '[50,0][950,950]';
    fixture.body.attrs['a11y-actions'] = '[64,8192]';
    const view = screen(fixture);
    assert.deepEqual(view.departuresOverview({ allowPartial: true }), {
        climateTimers: null, locations: [{ name: 'Testort Alpha', activeCount: 0 }],
        scrollState: { forward: false, backward: true },
    });
    assert.deepEqual(view.locationOpen('Testort Alpha'), { x: 265, y: 1275 });
    invalid(() => view.departuresOverview());
    fixture.body.attrs['a11y-actions'] = '[64,4096]';
    assert.deepEqual(screen(fixture).departuresOverview({ allowPartial: true }).scrollState, { forward: true, backward: false });
    fixture.body.attrs['a11y-actions'] = '[]';
    assert.deepEqual(screen(fixture).departuresOverview({ allowPartial: true }).scrollState, { forward: false, backward: false });
});

test('partial lists emit only fully visible location cards and never make clipped names tappable', () => {
    const fixture = overview();
    function translate(tree) {
        const match = /^\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]$/.exec(tree.attrs.bounds);
        const [x1, y1, x2, y2] = match.slice(1).map(Number);
        tree.attrs.bounds = '[' + x1 + ',' + (y1 + 500) + '][' + x2 + ',' + (y2 + 500) + ']';
        tree.children.forEach(translate);
    }
    translate(fixture.places[0].row);
    const view = screen(fixture);
    assert.deepEqual(view.departuresOverview({ allowPartial: true }).locations, []);
    invalid(() => view.locationOpen('Testort Alpha'));
    invalid(() => view.departuresOverview());
    for (const field of ['label', 'summary']) {
        const hidden = overview(); hidden.places[0][field].attrs['visible-to-user'] = 'false';
        assert.deepEqual(screen(hidden).departuresOverview({ allowPartial: true }).locations, []);
        invalid(() => screen(hidden).locationOpen('Testort Alpha'));
    }
});

test('partial mode still rejects duplicate timers, malformed scroll actions and multiple content scrollers', () => {
    for (const edit of [
        f => { f.climate.children.push(timerRow(400, '12:00', 'Montag').row); },
        f => { f.body.attrs['a11y-actions'] = '[4096,"8192"]'; },
        f => { f.body.attrs['a11y-actions'] = '[4096,4096]'; },
        f => { f.body.attrs['a11y-actions'] = 'not-json'; },
        f => { f.body.children.push(node({ class: 'android.widget.ScrollView', scrollable: 'true', bounds: '[0,200][1000,1800]' })); },
    ]) {
        const fixture = overview(); edit(fixture);
        invalid(() => screen(fixture).departuresOverview({ allowPartial: true }));
    }
    invalid(() => screen(overview()).departuresOverview({ allowPartial: 'true' }));
});

test('only the observed anonymous non-important invisible wrapper can surround the visible time wheels', () => {
    const fixture = editor({ wrapped: true });
    const view = screen(fixture);
    assert.equal(view.timerEditor().time, '07:25');
    assert.equal(view.wheelTarget('hour').state, 7);
    for (const edit of [
        f => { f.wheelWrapper.attrs.bounds = '[51,480][950,840]'; },
        f => { f.wheelContent.attrs.bounds = '[50,481][950,840]'; },
        f => { f.wheelWrapper.attrs.clickable = 'true'; },
        f => { f.wheelWrapper.attrs.checkable = 'true'; },
        f => { f.wheelWrapper.attrs.focusable = 'true'; },
        f => { f.wheelWrapper.attrs['important-for-accessibility'] = 'true'; },
        f => { f.wheelWrapper.attrs['a11y-actions'] = '[64,16]'; },
        f => { f.wheelWrapper.attrs['resource-id'] = 'unknown_wrapper'; },
        f => { f.wheelWrapper.attrs.enabled = 'false'; },
        f => { f.wheelContent.attrs['visible-to-user'] = 'false'; },
        f => { f.wheelWrapper.children.push(node({ bounds: '[50,480][950,840]' })); },
        f => { f.body.children[0] = node({ 'visible-to-user': 'false', bounds: '[50,480][950,840]' }, [f.wheelWrapper]); },
        f => { f.wheelContent.children.push(f.wheels[0]); },
        f => { f.wheels[0].attrs['a11y-actions'] = '[4096,16908349]'; },
    ]) {
        const changed = editor({ wrapped: true }); edit(changed);
        invalid(() => screen(changed).timerEditor());
        invalid(() => screen(changed).wheelTarget('hour'));
    }
});
