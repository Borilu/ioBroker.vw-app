'use strict';

// Synthetic public views. No private vehicle dump or vehicle-specific values.
const { node, hierarchy, overviewChargingScreen } = require('./charging-fixtures.cjs');
const NOTICE = 'Nur die Warn- und Kontrollleuchten geben verlässliche Hinweise auf mögliche Probleme. Die App zeigt lediglich einen ersten Überblick. Weitere Erläuterungen finden Sie in der Betriebsanleitung.';
const LABELS = Object.freeze({ engine: ['Engine', 'Antrieb'], assistance: ['Assistance', 'Assistenten'], brakes: ['Brake', 'Bremsen'],
    lighting: ['Lighting', 'Fahrlicht'], comfort: ['Comfort', 'Komfort'], tires: ['Tire', 'Reifen'], other: ['Other', 'Sonstige'] });
const POINTS = Object.freeze({ open: { x: 500, y: 1000 }, back: { x: 60, y: 50 } });
function text(value, bounds, id = '') { return node(id, { class: 'android.widget.TextView', text: value, bounds }); }

function overviewReportScreen({ lower = false } = {}) {
    const row = node('', { clickable: 'true', bounds: '[50,900][950,1100]' }, [
        node('', { 'content-desc': 'Fahrzeugzustandsbericht. Details öffnen', bounds: '[50,900][950,1100]' }),
        node('', { class: 'android.widget.Button', bounds: '[50,900][950,1100]' }),
    ]);
    return overviewChargingScreen({ lower }).replace('</node></node></hierarchy>', (lower ? row : '') + '</node></node></hierarchy>');
}

function reportScreen({ position = 'top', odometerText = '12.345 km', nextServiceText = '321 Tage', summary = 'Keine Meldungen',
    synchronizationText = 'Synchronisiert: Vor 2 h 15 min', categories = Object.fromEntries(Object.entries(LABELS).map(([key, [, label]]) => [key, { label, texts: [] }])),
    additionalTexts = [], notice = NOTICE } = {}) {
    const bottom = position === 'bottom';
    const card = (id, label, value, top) => node(id, { bounds: `[0,${top}][1000,${top + 130}]` }, [
        text(label, `[50,${top + 10}][650,${top + 50}]`), text(value, `[50,${top + 65}][650,${top + 110}]`),
    ]);
    const rowsTop = bottom ? 260 : 540;
    const rows = Object.entries(categories).map(([key, value], index) => {
        const [suffix, expected] = LABELS[key] || [key, key];
        const top = rowsTop + index * 100;
        return node('', { bounds: `[100,${top}][900,${top + 100}]` }, [
            text(value.label ?? expected, `[220,${top + 10}][700,${top + 45}]`, 'warningName' + suffix),
            node('warningLeadingIcon' + suffix, { bounds: `[110,${top + 20}][170,${top + 80}]` }),
            node('warningTrailingIcon' + suffix, { bounds: `[820,${top + 20}][880,${top + 80}]` }),
            ...(value.texts || []).map(valueText => text(valueText, `[220,${top + 50}][800,${top + 90}]`)),
        ]);
    });
    const warningTop = bottom ? 120 : 420;
    const noticeBounds = bottom ? '[50,1250][950,1420]' : '[50,1485][950,1500]';
    return hierarchy([node('vehicle_health_compose_view', { class: 'androidx.compose.ui.platform.ComposeView', bounds: '[0,0][1000,1500]' }, [
        node('', { bounds: '[0,0][1000,100]' }, [
            node('vehicleHealthBack', { class: 'android.widget.Button', clickable: 'true', bounds: '[20,10][100,90]' }),
            node('', { 'content-desc': 'Fahrzeugzustandsbericht', bounds: '[120,20][900,80]' }),
        ]),
        node('', { class: 'android.widget.ScrollView', scrollable: 'true', bounds: '[0,100][1000,1500]' }, [
            ...(!bottom && odometerText !== null ? [card('totalDistance', 'Gesamtstrecke', odometerText, 120)] : []),
            ...(!bottom && nextServiceText !== null ? [card('nextInspection', 'Nächster Service', nextServiceText, 250)] : []),
            ...(summary !== null ? [text(summary, `[50,${warningTop}][850,${warningTop + 45}]`, 'warningHeaderTitle')] : []),
            ...(synchronizationText !== null ? [text(synchronizationText, `[50,${warningTop + 50}][950,${warningTop + 95}]`, 'warningHeaderSubtitle')] : []),
            ...rows,
            ...additionalTexts.map(value => text(value, '[50,1160][950,1220]')),
            ...(notice !== null ? [text(notice, noticeBounds)] : []),
        ]),
    ])]);
}

module.exports = { overviewReportScreen, reportScreen, POINTS, NOTICE, LABELS, node, hierarchy };
