'use strict';

const { node, hierarchy } = require('./charging-fixtures.cjs');

// Synthetic geometry; no recorded Android XML or real vehicle profile data.
function lockSheet({ locked = true, lower = !locked, offset = 0, scale = 1 } = {}) {
    const b = (x1, y1, x2, y2) => `[${Math.round(x1 * scale)},${Math.round((y1 + offset) * scale)}][${Math.round(x2 * scale)},${Math.round((y2 + offset) * scale)}]`;
    const outer = b(380, 800, 620, 1420);
    const thumb = lower ? b(400, 1110, 600, 1400) : b(400, 820, 600, 1110);
    return hierarchy([node('', { class: 'android.widget.FrameLayout', bounds: b(0, 0, 1000, 1460) }, [
        node('design_bottom_sheet', { class: 'android.widget.FrameLayout', bounds: b(0, 600, 1000, 1460) }, [
            node('compose_view', { class: 'androidx.compose.ui.platform.ComposeView', bounds: b(0, 600, 1000, 1460) }, [
                node('', { bounds: b(0, 600, 1000, 1460) }, [
                    node('', { class: 'android.widget.Button', clickable: 'true', bounds: b(20, 620, 120, 730) }),
                    node('', { class: 'android.widget.TextView', text: 'Fahrzeug', bounds: b(160, 640, 840, 700) }),
                    node('', { class: 'android.widget.TextView', text: locked ? 'Verriegelt' : 'Entriegelt', bounds: b(400, 740, 600, 780) }),
                    node('', { bounds: outer }, [node('', { bounds: thumb })]),
                ]),
            ]),
        ]),
    ])]);
}

module.exports = { lockSheet, node, hierarchy };
