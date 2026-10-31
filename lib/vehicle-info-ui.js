'use strict';

const { BridgeError } = require('./errors');
const { isVin, validateVehicleInfo } = require('./vehicle-info');

function unavailable(code = 'vehicle_info_unavailable') {
    return new BridgeError(code, 'Die Fahrzeugverwaltung und die FIN sind nicht eindeutig lesbar.');
}

function visible(screen, node) {
    return screen._package(node) === screen.package && screen._visible(node)
        && Boolean(screen._bounds(node)) && screen._enabledPath(node);
}

function clear(screen) {
    screen.checkClear();
    if (screen.nodes.some(node => screen._visible(node) && (node.attrs.password === 'true'
        || /EditText|CheckBox|Switch/.test(node.attrs.class || '')
        || ['Speichern', 'S-PIN eingeben'].includes(node.attrs.text)))) throw unavailable();
}

function page(screen) {
    const backs = screen._find('garageBack');
    const titles = screen.nodes.filter(node => screen._package(node) === screen.package
        && node.attrs['content-desc'] === 'Meine Fahrzeuge');
    if (!backs.length && !titles.length) return null;
    clear(screen);
    if (backs.length !== 1 || titles.length !== 1 || !visible(screen, backs[0]) || !visible(screen, titles[0])
        || backs[0].attrs.class !== 'android.widget.Button' || backs[0].attrs.clickable !== 'true'
        || titles[0].attrs.class !== 'android.view.View'
        || screen._find('climateTile').some(node => visible(screen, node))) throw unavailable();
    return { back: backs[0], title: titles[0] };
}

function vehicleInfoPage(screen) {
    return Boolean(page(screen));
}

function vehicleInfoEntryTarget(screen) {
    clear(screen);
    if (screen.kind() !== 'overview') throw unavailable('unexpected_screen');
    const candidates = screen._find('vehicleCarPlus');
    if (candidates.length !== 1 || candidates[0].attrs.class !== 'android.view.View'
        || !visible(screen, candidates[0])) throw unavailable();
    const labels = screen._scopeNodes(candidates[0]).filter(node => node.attrs['content-desc'] === 'Fahrzeuge verwalten');
    if (labels.length !== 1 || !visible(screen, labels[0])) throw unavailable();
    return screen._point(candidates[0]);
}

function vehicleInfoBackTarget(screen) {
    const current = page(screen);
    if (!current) throw unavailable('unexpected_screen');
    return screen._point(current.back);
}

function nameFromMarker(marker) {
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) throw unavailable('wrong_vehicle');
    const keys = Reflect.ownKeys(marker);
    const descriptor = Object.getOwnPropertyDescriptor(marker, 'contentDescPrefix');
    if (keys.length !== 1 || keys[0] !== 'contentDescPrefix' || !descriptor || !Object.hasOwn(descriptor, 'value')
        || typeof descriptor.value !== 'string' || descriptor.value.length > 512) throw unavailable('wrong_vehicle');
    const match = /^(?:Ihr Fahrzeug: |Your vehicle: )([^\r\n]+)\. $/.exec(descriptor.value);
    if (!match || !match[1].trim() || match[1].trim() !== match[1]) throw unavailable('wrong_vehicle');
    return match[1];
}

function readVehicleInfo(screen, marker) {
    if (!page(screen)) throw unavailable('unexpected_screen');
    const name = nameFromMarker(marker);
    const active = screen.nodes.filter(node => visible(screen, node)
        && node.attrs.class === 'android.widget.TextView' && node.attrs.text === 'Aktiv');
    if (active.length !== 1) throw unavailable('ambiguous_ui');
    // The native tree has four direct text fields and one activeBadge in each
    // selected card. A clickable list or flattened collection is not a card.
    const badge = active[0].parent;
    const card = badge?.parent;
    if (!badge || screen._resource(badge) !== 'activeBadge' || badge.attrs.class !== 'android.view.View'
        || badge.attrs.clickable !== 'false' || badge.children.length !== 1 || badge.children[0] !== active[0]
        || !card || card.attrs.class !== 'android.view.View' || card.attrs.clickable !== 'true'
        || card.children.length !== 5 || card.children[4] !== badge
        || card.parent?.attrs.clickable !== 'false' || !visible(screen, card)) throw unavailable();
    const fields = card.children.slice(0, 4);
    const contained = screen._scopeNodes(card);
    if (![...fields, badge, active[0]].every(node => visible(screen, node) && contained.includes(node))
        || !fields.every(node => node.attrs.class === 'android.widget.TextView'
            && node.attrs.clickable === 'false' && node.children.length === 0)) throw unavailable('invalid_vehicle_info');
    const [model, value, role, additional] = fields;
    if (model.attrs.text !== name) throw unavailable('wrong_vehicle');
    const [modelBox, valueBox, roleBox, additionalBox, badgeBox] = [...fields, badge].map(node => screen._bounds(node));
    if (badgeBox[0] < modelBox[2] || badgeBox[1] < modelBox[1] || badgeBox[3] > modelBox[3]
        || valueBox[1] < modelBox[3] || roleBox[1] < valueBox[3] || additionalBox[1] < roleBox[3]
        || typeof role.attrs.text !== 'string' || !role.attrs.text.trim() || role.attrs.text.length > 100
        || isVin(role.attrs.text) || ['Aktiv', name].includes(role.attrs.text)
        || typeof additional.attrs.text !== 'string' || additional.attrs.text.length > 128
        || isVin(additional.attrs.text)) throw unavailable('invalid_vehicle_info');
    // Calibration currently binds the complete model name. Identical names in
    // two visible cards cannot be distinguished by that binding, even if one is active.
    if (screen.nodes.filter(node => visible(screen, node) && node.attrs.class === 'android.widget.TextView'
        && node.attrs.text === name).length !== 1) throw unavailable('ambiguous_ui');
    if (!isVin(value.attrs.text)) throw unavailable('invalid_vehicle_info');
    return validateVehicleInfo({ vin: value.attrs.text });
}

module.exports = { vehicleInfoEntryTarget, vehicleInfoPage, vehicleInfoBackTarget, readVehicleInfo };
