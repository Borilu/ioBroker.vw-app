'use strict';

// Independently constructed UI fixtures; no phone dump or personal data.
const PACKAGE = 'com.volkswagen.weconnect';
const POINTS = Object.freeze({
    back: { x: 60, y: 50 }, mode: { x: 500, y: 550 }, settings: { x: 500, y: 700 },
    saveSettings: { x: 890, y: 50 },
    zones: { x: 875, y: 800 }, zonesDirectional: { x: 825, y: 800 },
    climate: { x: 500, y: 300 }, windowHeating: { x: 500, y: 700 },
    climateOnUnlock: { x: 900, y: 210 }, autoWindowHeating: { x: 900, y: 510 },
    frontLeft: { x: 900, y: 510 }, frontRight: { x: 900, y: 810 },
    temperatureLeft: { x: 100, y: 240 }, temperatureCurrent: { x: 500, y: 240 },
    temperatureRight: { x: 900, y: 240 }, cta: { x: 500, y: 1200 },
});

function escape(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function node(id = '', attrs = {}, children = []) {
    const values = { package: PACKAGE, class: 'android.view.View', enabled: 'true', clickable: 'false',
        checkable: 'false', checked: 'false', bounds: '[0,0][1000,1400]', ...(id ? { 'resource-id': id } : {}), ...attrs };
    return '<node ' + Object.entries(values).map(([key, value]) => key + '="' + escape(value) + '"').join(' ') + '>' + children.join('') + '</node>';
}
function hierarchy(children = []) { return '<hierarchy>' + children.join('') + '</hierarchy>'; }
function text(label, bounds, id = '') { return node(id, { class: 'android.widget.TextView', text: label, bounds }); }
function modeLabel(value) { return value === 'climate' ? 'Klimatisierung' : value === 'windowHeating' ? 'Scheibenheizung' : value; }
function back(id = '') { return node(id, { class: 'android.widget.Button', clickable: 'true', bounds: '[20,10][100,90]' }); }
function header(label, leadingId, dirty = false) {
    return node('', { bounds: '[0,0][1000,100]' }, [back(leadingId), node('', { 'content-desc': label, bounds: '[120,20][880,70]' }),
        ...(dirty ? [node('climatisationSettingsTrailing', { class: 'android.widget.Button', text: 'Speichern', clickable: 'true', bounds: '[800,10][980,90]' })] : []),
    ]);
}
function temperatureOption(value, x1, x2) {
    const special = value === 'LO' || value === 'HI';
    return node('', { clickable: 'true', bounds: `[${x1},140][${x2},340]` }, [
        text(String(value), `[${x1},140][${special ? x2 : x2 - 30},340]`),
        ...(!special ? [text('°', `[${x2 - 30},140][${x2},260]`)] : []),
    ]);
}
function completeDemoClimate(state = 'off', mode = 'climate', temperature = 22) {
    const choices = typeof temperature === 'number' && Number.isFinite(temperature) ? [
        temperatureOption(temperature === 16 ? 'LO' : temperature - 0.5, 0, 200),
        temperatureOption(temperature, 400, 600),
        temperatureOption(temperature === 29.5 ? 'HI' : temperature + 0.5, 800, 1000),
    ] : [];
    return hierarchy([node('design_bottom_sheet', { class: 'android.widget.FrameLayout' }, [
        back('vwd_navigation_button'), text('Klimatisierung', '[200,20][800,70]', 'vwd_title'),
        node('clima_compose_view', { class: 'androidx.compose.ui.platform.ComposeView', bounds: '[0,100][1000,400]' }, [
            node('', { scrollable: 'true', bounds: '[0,100][1000,400]' }, choices),
        ]),
        node('clima_air_conditioning_pick', { class: 'android.view.ViewGroup', clickable: 'true', bounds: '[50,500][950,600]' }, [
            text(modeLabel(mode), '[220,520][780,570]', 'title'),
        ]),
        node('clima_settings_compose_view', { class: 'androidx.compose.ui.platform.ComposeView', bounds: '[50,650][950,750]' }, [
            node('', { clickable: 'true', bounds: '[50,650][950,750]' }, [text('Einstellungen', '[220,670][780,720]')]),
        ]),
        node(state === 'on' ? 'cta_stop' : 'cta_start', { class: 'android.widget.Button', clickable: 'true', bounds: '[100,1150][900,1250]' }),
    ])]);
}
function modeScreen(current = 'climate') {
    const option = (value, bounds, labelBounds) => node('', { clickable: 'true', checkable: 'true',
        checked: String(current === value), bounds }, [text(modeLabel(value), labelBounds)]);
    return hierarchy([node('design_bottom_sheet', { class: 'android.widget.FrameLayout' }, [
        back('vwd_navigation_button'), text('Modus wählen', '[200,20][800,70]', 'vwd_title'),
        node('ventilation_layout', { class: 'androidx.compose.ui.platform.ComposeView', bounds: '[0,100][1000,1000]' }, [
            option('climate', '[50,150][950,450]', '[200,180][700,230]'),
            option('windowHeating', '[50,550][950,850]', '[200,580][700,630]'),
        ]),
    ])]);
}
function toggle(id, value, bounds) {
    return node('', { checkable: 'true', checked: String(value), clickable: 'true', bounds }, [
        node(id, { checkable: 'true', checked: String(value), clickable: 'true', bounds }),
    ]);
}
function settingsScreen(climateOnUnlock = true, autoWindowHeating = true, zonesSummary = '2 Zonen', dirty = false) {
    const summaryLeft = ['Vorne links', 'Vorne rechts'].includes(zonesSummary) ? 700 : 800;
    return hierarchy([node('compose_view', { class: 'androidx.compose.ui.platform.ComposeView' }, [
        header('Einstellungen', 'climatisationSettingsLeading', dirty),
        node('', { clickable: 'true', bounds: '[0,150][1000,400]' }, [
            text('Standklimatisierung', '[50,170][700,220]'),
            toggle('ClimatisationAtUnlockEnabled', climateOnUnlock, '[850,170][950,250]'),
        ]),
        node('', { clickable: 'true', bounds: '[0,450][1000,700]' }, [
            text('Automatische Scheibenheizung', '[50,470][700,520]'),
            toggle('WindowHeatingEnabled', autoWindowHeating, '[850,470][950,550]'),
        ]),
        node('', { clickable: 'true', bounds: '[0,750][1000,1000]' }, [
            text('Zonen', '[50,770][500,820]'),
            node('', { clickable: 'true', bounds: `[${summaryLeft},760][950,840]` }, [text(zonesSummary, `[${summaryLeft + 10},780][940,820]`),
                node('', { class: 'android.widget.Button', bounds: `[${summaryLeft + 10},780][950,820]` })]),
            text('Beschreibung der ausgewählten Innenraumzonen', '[50,860][950,980]'),
        ]),
    ])]);
}
function zonesScreen(frontLeft = true, frontRight = true) {
    return hierarchy([node('compose_view', { class: 'androidx.compose.ui.platform.ComposeView' }, [
        header('Zonen', ''),
        node('', { clickable: 'true', bounds: '[0,450][1000,650]' }, [text('Vorne links', '[50,470][700,520]'),
            toggle('', frontLeft, '[850,470][950,550]')]),
        node('', { clickable: 'true', bounds: '[0,750][1000,950]' }, [text('Vorne rechts', '[50,770][700,820]'),
            toggle('', frontRight, '[850,770][950,850]')]),
    ])]);
}

module.exports = { completeDemoClimate, modeScreen, settingsScreen, zonesScreen, POINTS, node, hierarchy };
