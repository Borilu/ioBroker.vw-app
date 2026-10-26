'use strict';

// Independently constructed test views. No phone dump or personal vehicle data.
const PACKAGE = 'com.volkswagen.weconnect';
const POINTS = Object.freeze({ range: { x: 250, y: 400 }, vehicleSettings: { x: 500, y: 900 },
    back: { x: 80, y: 680 }, vehicleSettingsBack: { x: 60, y: 50 }, saveCharging: { x: 890, y: 50 },
    synchronize: { x: 300, y: 830 },
    reducedAcCurrent: { x: 890, y: 760 }, autoUnlockAc: { x: 890, y: 1010 }, optimizedBatteryUse: { x: 890, y: 1260 } });

function escape(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function node(id = '', attrs = {}, children = []) {
    const values = { package: PACKAGE, class: 'android.view.View', enabled: 'true', clickable: 'false',
        bounds: '[0,0][1000,1400]', ...(id ? { 'resource-id': id } : {}), ...attrs };
    return '<node ' + Object.entries(values).map(([key, value]) => key + '="' + escape(value) + '"').join(' ') + '>' + children.join('') + '</node>';
}
function hierarchy(children = []) { return '<hierarchy>' + children.join('') + '</hierarchy>'; }

function overviewChargingScreen({ rangeKm = 205, lower = false, includeRange = true, charging = false, nativeHiddenRange = false } = {}) {
    const rangeBounds = lower ? '[50,100][450,150]' : '[50,200][450,600]';
    const climateBounds = lower ? '[550,100][950,150]' : '[550,200][950,600]';
    const chargingFlags = charging ? { selected: 'false', checkable: 'false', checked: 'false' } : {};
    const native = charging && nativeHiddenRange;
    const nativeAttrs = (suffix, actions) => native ? { ...chargingFlags,
        'a11y-path': '0.0.0.1' + suffix, 'a11y-actions': JSON.stringify(actions) } : chargingFlags;
    const hiddenAttrs = (suffix, actions) => ({ ...nativeAttrs(suffix, actions),
        'visible-to-user': suffix === '.1' ? 'false' : 'true', 'long-clickable': 'false', scrollable: 'false' });
    const [left, top, right, bottom] = rangeBounds.match(/[0-9]+/g).map(Number);
    const box = (x1, y1, x2, y2) => '[' + (left + Math.floor((right - left) * x1)) + ',' +
        (top + Math.floor((bottom - top) * y1)) + '][' + (left + Math.floor((right - left) * x2)) + ',' +
        (top + Math.floor((bottom - top) * y2)) + ']';
    const hiddenBranch = native ? node('', { bounds: rangeBounds, clickable: 'true', ...hiddenAttrs('.1', [1, 64, 16]) }, [
        node('', { bounds: box(.12, .12, .88, .88), ...hiddenAttrs('.1.0', [64]) }, [
            node('', { bounds: box(.72, .12, .88, .28), ...hiddenAttrs('.1.0.0', [64]) }),
            node('synthetic_range_km', { class: 'android.widget.TextView', text: rangeKm + ' km',
                bounds: box(.12, .46, .68, .72), ...hiddenAttrs('.1.0.1', [256, 512, 64, 131072]) }),
            node('electricSocText', { class: 'android.widget.TextView', text: 'Batterie 52%',
                bounds: box(.12, .77, .68, .88), ...hiddenAttrs('.1.0.2', [256, 512, 64, 131072]) }),
        ]),
    ]) : null;
    return hierarchy([node('composeView', { class: 'androidx.compose.ui.platform.ComposeView' }, [
        node('', { class: 'android.widget.ScrollView', scrollable: 'true', bounds: '[20,100][980,1300]' }, [
            node('', { 'content-desc': 'Ihr Fahrzeug: Testwagen. Gerade synchronisiert', bounds: '[50,100][950,150]' }),
            ...(includeRange ? [node('rangeTile', { bounds: rangeBounds, ...nativeAttrs('', [256, 512, 64, 131072]) }, [
                node('', { 'content-desc': `Übersicht Reichweite. ${charging ? 'Lädt gerade. ' : ''}Batteriereichweite: ${rangeKm} Kilometer. Details öffnen`, bounds: rangeBounds,
                    ...nativeAttrs('.0', [256, 512, 64, 131072]) }),
                ...(hiddenBranch ? [hiddenBranch] : []),
                node('', { class: 'android.widget.Button', bounds: rangeBounds, ...nativeAttrs(native ? '.2' : '.1', [64]) }),
            ])] : []),
            node('climateTile', { bounds: climateBounds }, [
                node('', { 'content-desc': 'Vorklimatisierung. Aus. Details öffnen', bounds: climateBounds }),
            ]),
            ...(lower ? [node('', { clickable: 'true', bounds: '[50,800][950,1000]' }, [
                node('', { 'content-desc': 'Einstellungen. Details öffnen', bounds: '[50,800][950,1000]' }),
                node('', { class: 'android.widget.Button', bounds: '[50,800][950,1000]' }),
            ])] : []),
        ]),
    ])]);
}

function rangeScreen({ soc = 52, rangeKm = 205, activeCharging = false } = {}) {
    return hierarchy([node('', {}, [
        node('', { bounds: '[0,600][1000,1400]' }, [
            node('', { clickable: 'true', bounds: '[30,630][130,730]' }, [
                node('', { 'content-desc': 'Schließen', bounds: '[50,650][110,710]' }),
                node('', { class: 'android.widget.Button', bounds: '[50,650][110,710]' }),
            ]),
            node('', { class: 'android.widget.ScrollView', bounds: '[0,750][1000,1250]' }, [
                node('', { bounds: '[50,750][950,1250]' }, [
                    node('', { bounds: '[200,770][800,1050]' }, [
                        node('', { 'content-desc': `Übersicht Reichweite. Batteriereichweite: ${rangeKm} Kilometer`, bounds: '[200,770][800,1050]' }),
                        node('rangeArcRangeAndUnit', { bounds: '[350,850][650,1000]' }),
                    ]),
                    node('', { bounds: '[100,1100][900,1230]' }, [
                        node('rangeArcBatterySoc', { class: 'android.widget.TextView',
                            text: activeCharging ? `${soc} %\u00a0•\u00a0Probe` : `Batterie ${soc} %\u00a0•\u00a0Ladekabel verbinden`,
                            'content-desc': `Ladestatus. Batterieladung: ${soc} Prozent. ${activeCharging ? 'Lädt gerade' : 'Ladekabel verbinden'}`,
                            bounds: '[150,1120][850,1200]' }),
                    ]),
                ]),
            ]),
            node('', { clickable: 'true', enabled: 'false', bounds: '[100,1270][900,1390]' }, [
                node('', { 'content-desc': 'Laden starten. Ladestatus prüfen', bounds: '[100,1270][900,1390]' }),
            ]),
        ]),
    ])]);
}

function chargingSettingsScreen({ socLimit = 100, reducedAcCurrent = true, autoUnlockAc = false,
    optimizedBatteryUse = true, vehicleName = 'Testwagen', dirty = false } = {}) {
    const text = (id, value, bounds) => node(id, { class: 'android.widget.TextView', text: value, bounds });
    const toggle = (label, checked, top) => {
        const rowBounds = `[40,${top}][960,${top + 120}]`;
        const switchBounds = `[820,${top}][960,${top + 120}]`;
        return node('compose_view_menu_multi_lines_toggle_with_warning', { class: 'androidx.compose.ui.platform.ComposeView',
            bounds: `[0,${top - 20}][1000,${top + 140}]` }, [
            node('', { checkable: 'true', checked: String(checked), clickable: 'true', bounds: rowBounds }, [
                text('', label, `[40,${top + 20}][800,${top + 80}]`),
                node('', { checkable: 'true', checked: String(checked), clickable: 'true', bounds: switchBounds }, [
                    node('', { checkable: 'true', checked: String(checked), clickable: 'true', bounds: switchBounds }),
                ]),
            ]),
        ]);
    };
    return hierarchy([node('container', { class: 'android.widget.ScrollView' }, [
        node('toolbar', { class: 'android.widget.FrameLayout', bounds: '[0,0][1000,100]' }, [
            node('vwd_navigation_button', { class: 'android.widget.Button', clickable: 'true', bounds: '[20,10][100,90]' }),
            ...(!dirty ? [text('vwd_title', 'Einstellungen', '[300,20][700,80]')] : []),
            ...(dirty ? [node('vwd_save_button', { class: 'android.widget.Button', text: 'Speichern', clickable: 'true', bounds: '[800,10][980,90]' })] : []),
        ]),
        node('recycler_view', { class: 'androidx.recyclerview.widget.RecyclerView', scrollable: 'true', bounds: '[0,100][1000,1400]' }, [
            text('category_name', 'Fahrzeugname', '[20,110][980,180]'),
            node('vehicle_name', { class: 'android.view.ViewGroup', bounds: '[50,200][950,300]' }, [
                node('inputText', { class: 'android.widget.EditText', text: vehicleName, clickable: 'true', bounds: '[50,220][900,280]' }),
            ]),
            text('category_name', 'Laden', '[20,320][980,380]'),
            node('', { class: 'android.view.ViewGroup', bounds: '[50,400][950,650]' }, [
                text('subtitle', 'Laden bis (50-100 %)', '[100,410][900,470]'),
                text('value', String(socLimit) + '%', '[800,500][920,560]'),
                text('info', 'Information zum Ladeziel', '[100,570][900,630]'),
            ]),
            toggle('Reduzierter AC-Ladestrom', reducedAcCurrent, 700),
            toggle('AC-Stecker automatisch entriegeln', autoUnlockAc, 950),
            toggle('Optimierte Batterienutzung', optimizedBatteryUse, 1200),
        ]),
    ])]);
}

function chargingFooterScreen({ busy = false } = {}) {
    return hierarchy([node('container', { class: 'android.widget.ScrollView' }, [
        node('toolbar', { class: 'android.widget.FrameLayout', bounds: '[0,0][1000,100]' }, [
            node('vwd_navigation_button', { class: 'android.widget.Button', clickable: 'true', bounds: '[20,10][100,90]' }),
            node('vwd_title', { class: 'android.widget.TextView', text: 'Einstellungen', bounds: '[300,20][700,80]' }),
        ]),
        node('recycler_view', { class: 'androidx.recyclerview.widget.RecyclerView', scrollable: 'true', bounds: '[0,100][1000,1400]' }, [
            node('category_name', { class: 'android.widget.TextView', text: 'Fahrzeugdaten', bounds: '[20,110][980,180]' }),
            node('', { class: 'android.view.ViewGroup', bounds: '[0,750][1000,1100]' }, [
                node('subtitle_cta', { class: 'android.widget.TextView', text: 'Jetzt synchronisieren', clickable: 'true', enabled: String(!busy), bounds: '[50,800][550,860]' }),
                node('info', { class: 'android.widget.TextView', text: 'Fahrzeug und App synchronisieren sich regelmäßig automatisch. Falls notwendig, können Sie dies hier manuell anstoßen. Der Vorgang kann einige Minuten dauern.',
                    bounds: '[50,900][950,1050]' }),
            ]),
        ]),
    ])]);
}

module.exports = { overviewChargingScreen, rangeScreen, chargingSettingsScreen, chargingFooterScreen, POINTS, node, hierarchy };
