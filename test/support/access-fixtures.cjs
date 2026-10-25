'use strict';

// Independently constructed views. No recorded app XML or personal vehicle data.
const { node, hierarchy } = require('./charging-fixtures.cjs');
const COMPONENTS = ['Kofferraum', 'Tür hinten rechts', 'Tür hinten links', 'Tür vorne rechts', 'Tür vorne links',
    'Fenster vorne links', 'Fenster vorne rechts', 'Fenster hinten links', 'Fenster hinten rechts'];

function vehicleAccessScreen({ locked = true, open = [], warning,
    synchronizationText = 'Gerade synchronisiert' } = {}) {
    const status = locked ? 'Verriegelt' : 'Entriegelt';
    const description = warning === undefined ? (open.length
        ? `Fahrzeug ist ${status.toLowerCase()}. Etwas ist noch offen oder eingeschaltet:. ${open.join('. ')}. ` : '') : warning;
    const tile = (id, bounds, description) => node(id, { bounds }, [node('', { bounds, 'content-desc': description })]);
    const wrapperBounds = '[0,0][1000,1440]';
    return hierarchy([node('composeView', { class: 'androidx.compose.ui.platform.ComposeView', bounds: '[0,0][1000,1500]' }, [
        node('', { bounds: wrapperBounds }, [
            node('', { class: 'android.widget.ScrollView', scrollable: 'true', bounds: '[0,40][1000,1440]' }, [
                ...(description ? [node('', { class: 'android.widget.ImageView',
                    'content-desc': description, bounds: '[0,500][1000,580]' })] : []),
                node('', { class: 'android.view.View', bounds: '[0,500][1000,580]' }),
                node('', { class: 'androidx.compose.ui.viewinterop.ViewFactoryHolder', bounds: '[0,100][1000,500]' }, [
                    node('', { bounds: '[0,100][1000,500]' }),
                ]),
                tile('rangeTile', '[50,515][450,850]', 'Übersicht Reichweite. Batteriereichweite: 210 Kilometer. Details öffnen'),
                tile('climateTile', '[550,515][950,850]', 'Vorklimatisierung. Aus. Details öffnen'),
                node('', { bounds: '[50,900][950,1050]' }, [
                    node('', { 'content-desc': `Fahrzeug. ${status}. Details öffnen`, bounds: '[50,900][950,1050]' }),
                    node('', { class: 'android.widget.TextView', text: status, bounds: '[700,940][900,1000]' }),
                    node('', { class: 'android.widget.Button', bounds: '[50,900][950,1050]' }),
                ]),
            ]),
            node('', { bounds: '[0,40][1000,170]' }, [
                node('', { 'content-desc': 'Ihr Fahrzeug: Testwagen. ' + synchronizationText, bounds: '[100,80][900,140]' }),
            ]),
        ]),
    ])]);
}

module.exports = { vehicleAccessScreen, COMPONENTS, node, hierarchy };
