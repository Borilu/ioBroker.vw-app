'use strict';

const { fixedSecurityError } = require('./security-auth');

function need(value) { if (!value) throw fixedSecurityError('lock_ui_unsupported'); }
function same(a, b) { return a && b && a.length === b.length && a.every((value, index) => value === b[index]); }
function contains(a, b) { return a && b && b[0] >= a[0] && b[1] >= a[1] && b[2] <= a[2] && b[3] <= a[3]; }
function complete(screen, node) {
    const bounds = screen._bounds(node);
    return !!bounds && screen._package(node) === screen.package && screen._visible(node) && screen._enabledPath(node)
        && [...screen._ancestors(node)].every(parent => contains(screen._bounds(parent), bounds));
}
function unique(nodes) { need(nodes.length === 1); return nodes[0]; }
function blank(node) { return !(node.attrs['resource-id'] || node.attrs.text || node.attrs['content-desc']); }
function point(bounds) { return { x: Math.floor((bounds[0] + bounds[2]) / 2), y: Math.floor((bounds[1] + bounds[3]) / 2) }; }

function vehicleLockNavigationTarget(screen, expectedLocked) {
    screen.checkClear();
    need(typeof expectedLocked === 'boolean' && screen.kind() === 'overview');
    need(screen.vehicleAccess().locked === expectedLocked);
    const label = unique(screen.nodes.filter(node => node.attrs['content-desc'] ===
        'Fahrzeug. ' + (expectedLocked ? 'Verriegelt' : 'Entriegelt') + '. Details öffnen'));
    const row = label.parent;
    need(row && complete(screen, row) && complete(screen, label));
    const bounds = screen._bounds(label);
    const buttons = row.children.filter(node => node.attrs.class === 'android.widget.Button' && blank(node));
    const button = unique(buttons);
    need(complete(screen, button) && same(screen._bounds(button), bounds) && contains(screen._bounds(row), bounds));
    // Opening this exact vehicle-details row has been observed separately from
    // the central-locking action. It does not press the unlabeled lock pill.
    return point(bounds);
}

function vehicleLockSheet(screen) {
    screen.checkClear();
    const all = screen.nodes.filter(node => screen._package(node) === screen.package);
    const titles = all.filter(node => node.attrs.class === 'android.widget.TextView' && node.attrs.text === 'Fahrzeug');
    if (!titles.length) return null;
    const title = unique(titles);
    const sheet = unique(screen._find('design_bottom_sheet'));
    const compose = unique(screen._find('compose_view').filter(node => screen._within(node, sheet)));
    need(compose.attrs.class === 'androidx.compose.ui.platform.ComposeView' && complete(screen, sheet)
        && complete(screen, compose) && screen._within(title, compose) && complete(screen, title));
    const container = title.parent;
    need(container && screen._within(container, compose) && complete(screen, container));
    need(!all.some(node => /EditText/.test(node.attrs.class || '')));
    const status = unique(container.children.filter(node => node.attrs.class === 'android.widget.TextView'
        && ['Verriegelt', 'Entriegelt'].includes(node.attrs.text)));
    need(complete(screen, status));
    const locked = status.attrs.text === 'Verriegelt';
    const backs = container.children.filter(node => node.attrs.class === 'android.widget.Button' && blank(node));
    const back = unique(backs);
    need(complete(screen, back) && back.attrs.clickable === 'true');
    const titleBounds = screen._bounds(title), statusBounds = screen._bounds(status), backBounds = screen._bounds(back);
    need(backBounds[2] <= titleBounds[0] && backBounds[1] <= titleBounds[1] && backBounds[3] >= titleBounds[3]
        && statusBounds[1] >= titleBounds[3]);
    const candidates = container.children.filter(node => node.attrs.class === 'android.view.View' && blank(node)
        && node.attrs.clickable === 'false' && node.children.length === 1
        && node.children[0].attrs.class === 'android.view.View' && blank(node.children[0])
        && node.children[0].attrs.clickable === 'false' && !node.children[0].children.length);
    const pill = unique(candidates), thumb = pill.children[0];
    need(complete(screen, pill) && complete(screen, thumb));
    const outer = screen._bounds(pill), inner = screen._bounds(thumb);
    const width = outer[2] - outer[0], height = outer[3] - outer[1];
    const thumbWidth = inner[2] - inner[0], thumbHeight = inner[3] - inner[1];
    const top = inner[1] - outer[1], bottom = outer[3] - inner[3];
    need(outer[1] > statusBounds[3] && height >= 2 * width && height <= 4 * width
        && thumbWidth >= width * 0.7 && thumbWidth <= width * 0.95
        && thumbHeight >= height * 0.35 && thumbHeight <= height * 0.6
        && Math.abs((inner[0] - outer[0]) - (outer[2] - inner[2])) <= Math.ceil(width * 0.02));
    const upper = top >= 0 && top < thumbHeight * 0.15 && bottom > thumbHeight * 0.85;
    const lower = bottom >= 0 && bottom < thumbHeight * 0.15 && top > thumbHeight * 0.85;
    need(upper !== lower && locked === upper);
    // Only the observed header, current state and anonymous geometry may be
    // present in this narrow control container. Unknown additions fail closed.
    need(container.children.length === 4 && container.children.every(node => [title, status, back, pill].includes(node)));
    return { locked, position: upper ? 'upper' : 'lower', outer, inner, back: point(backBounds) };
}

function vehicleLockActionTarget(screen, operation) {
    if (!['lock', 'unlock'].includes(operation)) throw fixedSecurityError('invalid_action');
    const sheet = vehicleLockSheet(screen);
    need(sheet && sheet.locked === (operation === 'unlock'));
    // Each direction was separately verified on the reference device: the
    // empty half of the pill opens its matching S-PIN form. Use only current
    // geometry, never saved device-specific screen coordinates.
    const upper = operation === 'lock';
    need(sheet.position === (upper ? 'lower' : 'upper'));
    return { x: Math.floor((sheet.outer[0] + sheet.outer[2]) / 2),
        y: Math.floor(upper ? (sheet.outer[1] + sheet.inner[1]) / 2 : (sheet.inner[3] + sheet.outer[3]) / 2) };
}

module.exports = { vehicleLockNavigationTarget, vehicleLockSheet, vehicleLockActionTarget };
