'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chargingSliderGeometry, chargingSliderTarget } = require('../lib/native-ui');
const { BridgeError } = require('../lib/errors');

const PACKAGE = 'com.volkswagen.weconnect';
const SLIDER = PACKAGE + '.resources.views.slider.GradientSlider';
const TEXT = 'androidx.appcompat.widget.AppCompatTextView';
const SECRET = 'PRIVATE-NATIVE-FIXTURE';

// Independently generated view trees. These dimensions, tokens and process IDs
// are synthetic, and no private device dump is included in the public tests.
function view(className, bounds, children = [], extra = {}) {
    return { className, bounds, children, flags: 'V.E......', id: '', ...extra };
}

function fixture(edit = () => {}, options = {}) {
    const subtitle = view(TEXT, [30, 0, 990, 60], [], { id: 'subtitle' });
    const slider = view(SLIDER, [20, 100, 780, 240], [], { id: 'slider', flags: 'VFED..C..' });
    const value = view(TEXT, [800, 130, 990, 200], [], { id: 'value' });
    const info = view(TEXT, [30, 270, 990, 610], [], { id: 'info' });
    const row = view('androidx.constraintlayout.widget.ConstraintLayout', [0, 40, 1020, 650], [subtitle, slider, value, info]);
    const card = view('androidx.cardview.widget.CardView', [30, 200, 1050, 900], [row], { tail: ' aid=42' });
    const scope = view('androidx.recyclerview.widget.RecyclerView', [10, 150, 1130, 1800], [card], { id: 'recycler_view' });
    const container = view('com.volkswagen.lib.ui.WindowCoordinatorLayout', [8, 22, 1180, 1940], [scope], { id: 'container' });
    const offset = view('android.widget.FrameLayout', [12, 18, 1188, 1988], [container]);
    const root = view('android.widget.LinearLayout', [0, 0, 1200, 2000], [offset]);
    const refs = { subtitle, slider, value, info, row, card, scope, container, offset, root };
    edit(refs);
    let counter = 256;
    function render(node, depth) {
        const bounds = node.bounds;
        const id = node.id ? ' #' + (0x7f000000 + counter).toString(16) + ' '
            + (node.id.includes(':id/') ? node.id : 'app:id/' + node.id) : '';
        const line = ' '.repeat(depth) + node.className + '{' + (++counter).toString(16) + ' '
            + node.flags + ' ........ ' + bounds[0] + ',' + bounds[1] + '-' + bounds[2] + ',' + bounds[3]
            + id + (node.tail || '') + '}';
        return [line, ...node.children.flatMap(child => render(child, depth + 2))];
    }
    const dump = [
        '  ACTIVITY ' + (options.package || PACKAGE) + '/' + (options.activity || '.SingleActivity') + ' a1 pid=4321',
        '    Local Activity a2 State:',
        '      mResumed=' + (options.resumed ?? true) + ' mStopped=' + (options.stopped ?? false) + ' mFinished=' + (options.finished ?? false),
        '    View Hierarchy:',
        '      DecorView@a3[SingleActivity]',
        ...render(root, 8),
    ].join('\n');
    const context = {
        scopeBounds: [30, 190, 1150, 1840],
        subtitleBounds: [90, 430, 1050, 490],
        valueBounds: [860, 560, 1050, 630],
    };
    return { dump, context, refs };
}

function rejects(dump, context) {
    for (const operation of [chargingSliderGeometry, chargingSliderTarget]) {
        assert.throws(() => operation(dump, context), error => error instanceof BridgeError
            && error.code === 'charging_slider_unavailable'
            && !error.message.includes(SECRET)
            && !JSON.stringify(error.toJSON()).includes(SECRET));
    }
}

test('geometry accumulates every ancestor offset and center target contains no SOC mapping', () => {
    const { dump, context } = fixture();
    assert.deepEqual(chargingSliderGeometry(dump, context), {
        bounds: [80, 530, 840, 670], rowBounds: [60, 430, 1080, 1040],
    });
    assert.deepEqual(chargingSliderTarget(dump, context), { x: 460, y: 600 });
});

test('CRLF, strict UTF-8 buffers and fully qualified activity/resource names preserve the same geometry', () => {
    const { dump, context } = fixture(refs => {
        for (const key of ['subtitle', 'slider', 'value', 'info', 'scope', 'container']) {
            refs[key].id = PACKAGE + ':id/' + refs[key].id;
        }
    }, { activity: PACKAGE + '.SingleActivity' });
    assert.deepEqual(chargingSliderTarget(Buffer.from(dump.replaceAll('\n', '\r\n')), context), { x: 460, y: 600 });
});

test('a new matching accessibility context is required after a translated ancestor', () => {
    const { dump, context } = fixture(({ offset }) => {
        offset.bounds = offset.bounds.map((coordinate, index) => coordinate + (index % 2 ? 11 : 7));
    });
    rejects(dump, context);
    const moved = Object.fromEntries(Object.entries(context).map(([key, bounds]) => [key,
        bounds.map((coordinate, index) => coordinate + (index % 2 ? 11 : 7))]));
    assert.deepEqual(chargingSliderGeometry(dump, moved), {
        bounds: [87, 541, 847, 681], rowBounds: [67, 441, 1087, 1051],
    });
    assert.deepEqual(chargingSliderTarget(dump, moved), { x: 467, y: 611 });
});

test('signed relative offsets can be accepted only when all cross-checked screen bounds still match', () => {
    const { dump, context } = fixture(({ offset }) => {
        offset.bounds[0] -= 17;
        offset.bounds[2] -= 17;
    });
    const moved = Object.fromEntries(Object.entries(context).map(([key, bounds]) => [key,
        bounds.map((coordinate, index) => coordinate - (index % 2 ? 0 : 17))]));
    assert.deepEqual(chargingSliderTarget(dump, moved), { x: 443, y: 600 });
});

test('input and returned bounds are independent and no coordinates are cached', () => {
    const { dump, context } = fixture();
    const before = structuredClone(context);
    for (const bounds of Object.values(context)) Object.freeze(bounds);
    Object.freeze(context);
    const first = chargingSliderGeometry(dump, context);
    first.bounds[0] = 9999;
    first.rowBounds[0] = 9999;
    assert.deepEqual(chargingSliderGeometry(dump, context), {
        bounds: [80, 530, 840, 670], rowBounds: [60, 430, 1080, 1040],
    });
    assert.deepEqual(context, before);
});

test('a whole multi-activity dump is rejected rather than choosing its last or resumed activity', () => {
    const valid = fixture();
    rejects(valid.dump + '\n' + valid.dump, valid.context);
    const historical = fixture(() => {}, { resumed: false, stopped: true });
    rejects(historical.dump + '\n' + valid.dump, valid.context);
    rejects(fixture(() => {}, { package: 'other.example' }).dump + '\n' + valid.dump, valid.context);
});

test('the activity must be exactly the foreground-capable VW SingleActivity', () => {
    for (const options of [
        { package: 'other.example' }, { activity: '.OtherActivity' },
        { activity: 'other.example.SingleActivity' }, { resumed: false },
        { stopped: true }, { finished: true },
    ]) {
        const { dump, context } = fixture(() => {}, options);
        rejects(dump, context);
    }
    const { dump, context } = fixture();
    rejects(dump.replace(' a1 pid=4321', ' ' + SECRET + ' pid=4321'), context);
    rejects(dump.replace('pid=4321', 'pid=0'), context);
    rejects(dump.replace('[SingleActivity]', '[OtherActivity]'), context);
});

test('missing or duplicate activity, state, view-tree and decorator markers are not guessed', () => {
    const { dump, context } = fixture();
    for (const changed of [
        dump.split('\n').slice(1).join('\n'),
        dump.replace(/ +mResumed=.*\n/, ''),
        dump.replace('    View Hierarchy:\n', ''),
        dump.replace('      DecorView@a3[SingleActivity]\n', ''),
        dump + '\n    View Hierarchy:\n',
        dump.replace('    View Hierarchy:', '      mResumed=true mStopped=false mFinished=false\n    View Hierarchy:'),
        dump.replace('      DecorView@a3[SingleActivity]', '      DecorView@a3[SingleActivity]\n      DecorView@a4[SingleActivity]'),
        'Unscoped log prefix ' + SECRET + '\n' + dump,
    ]) rejects(changed, context);
});

test('one exact GradientSlider with the local slider resource, focusability and clickability is required', () => {
    for (const edit of [
        refs => { refs.slider.className = 'android.widget.SeekBar'; },
        refs => { refs.slider.id = 'otherSlider'; },
        refs => { refs.slider.id = 'foreign.example:id/slider'; },
        refs => { refs.slider.flags = 'V.ED..C..'; },
        refs => { refs.slider.flags = 'VFED.....'; },
        refs => { refs.row.children.splice(1, 1); },
    ]) {
        const { dump, context } = fixture(edit);
        rejects(dump, context);
    }
});

test('additional sliders are ambiguous even when hidden or outside the matched row', () => {
    for (const flags of ['VFED..C..', 'GFED..C..']) {
        const { dump, context } = fixture(refs => {
            refs.container.children.push(view(SLIDER, [0, 0, 100, 100], [], { id: 'slider', flags }));
        });
        rejects(dump, context);
    }
});

test('native row, card, recycler and container classes and resource ownership must match', () => {
    for (const edit of [
        refs => { refs.row.className = 'android.widget.FrameLayout'; },
        refs => { refs.row.id = 'unrelated'; },
        refs => { refs.card.className = 'android.widget.FrameLayout'; },
        refs => { refs.card.id = 'unrelated'; },
        refs => { refs.scope.className = 'android.widget.ScrollView'; },
        refs => { refs.scope.id = 'otherRecycler'; },
        refs => { refs.scope.id = 'foreign.example:id/recycler_view'; },
        refs => { refs.container.className = 'android.widget.FrameLayout'; },
        refs => { refs.container.id = 'otherContainer'; },
    ]) {
        const { dump, context } = fixture(edit);
        rejects(dump, context);
    }
});

test('subtitle, value and info are unique direct TextView siblings of the slider', () => {
    for (const edit of [
        refs => { refs.subtitle.id = 'otherSubtitle'; },
        refs => { refs.value.id = 'foreign.example:id/value'; },
        refs => { refs.info.id = 'otherInfo'; },
        refs => { refs.value.className = 'android.widget.TextView'; },
        refs => { refs.row.children.push(view(TEXT, [0, 0, 10, 10], [], { id: 'subtitle' })); },
        refs => { refs.row.children.splice(3, 1); },
        refs => { refs.row.children[2] = view('android.widget.FrameLayout', [0, 0, 1000, 650], [refs.value]); },
    ]) {
        const { dump, context } = fixture(edit);
        rejects(dump, context);
    }
});

test('visibility and enabled flags must hold on every slider and label ancestor', () => {
    for (const key of ['root', 'offset', 'container', 'scope', 'card', 'row', 'slider', 'subtitle', 'value', 'info']) {
        for (const kind of ['hidden', 'invisible', 'disabled']) {
            const { dump, context } = fixture(refs => {
                const flags = [...refs[key].flags];
                if (kind === 'disabled') flags[2] = '.';
                else flags[0] = kind === 'hidden' ? 'G' : 'I';
                refs[key].flags = flags.join('');
            });
            rejects(dump, context);
        }
    }
});

test('A11y scope, subtitle and value must each exactly match the corresponding native rectangle', () => {
    const { dump, context } = fixture();
    for (const key of Object.keys(context)) {
        const changed = structuredClone(context);
        changed[key][2] -= 1;
        rejects(dump, changed);
    }
    const swapped = { ...context, subtitleBounds: context.valueBounds, valueBounds: context.subtitleBounds };
    rejects(dump, swapped);
});

test('context rejects malformed, empty, negative, noninteger, nonfinite, oversized and out-of-scope bounds', () => {
    const { dump, context } = fixture();
    for (const input of [null, [], {}, { ...context, extra: SECRET }]) rejects(dump, input);
    for (const bounds of [null, '0,0,1,1', [0, 0, 1], [0, 0, 1, 1, 2], [0, 0, 0, 1],
        [-1, 0, 10, 10], [0, 0.5, 10, 10], [0, 0, Infinity, 10], [0, 0, 20001, 10],
        [0, 0, '10', 10], [0, 0, NaN, 10], [0, 0, Number.MAX_SAFE_INTEGER + 1, 10]]) {
        rejects(dump, { ...context, valueBounds: bounds });
    }
    rejects(dump, { ...context, scopeBounds: [0, 0, 100, 100] });
});

test('geometry must remain inside the verified row and retain the observed label relationships', () => {
    for (const edit of [
        refs => { refs.slider.bounds[0] = -1; },
        refs => { refs.slider.bounds[2] = 1021; },
        refs => { refs.slider.bounds[3] = 651; },
        refs => { refs.slider.bounds[1] = 40; },
        refs => { refs.slider.bounds[2] = 810; },
        refs => { refs.slider.bounds[1] = 150; },
        refs => { refs.slider.bounds[3] = 190; },
        refs => { refs.slider.bounds[3] = 280; },
        refs => { refs.card.bounds[3] = 800; refs.row.bounds[3] = 801; },
    ]) {
        const { dump, context } = fixture(edit);
        rejects(dump, context);
    }
});

test('native coordinates and indentation must be well-formed rather than partially parsed', () => {
    for (const edit of [
        refs => { refs.slider.bounds = [20, 100, 20, 240]; },
        refs => { refs.slider.bounds = [20, 240, 780, 100]; },
        refs => { refs.slider.bounds = [20, 100, 1000001, 240]; },
        refs => { refs.offset.bounds[0] = Number.MAX_SAFE_INTEGER + 1; },
    ]) {
        const { dump, context } = fixture(edit);
        rejects(dump, context);
    }
    const { dump, context } = fixture();
    rejects(dump.replace('20,100-780,240', '20,100-780,240junk'), context);
    rejects(dump.replace('20,100-780,240', '20.5,100-780,240'), context);
    rejects(dump.replace(/ +com\.volkswagen\.weconnect\.resources\.views\.slider\.GradientSlider/, ' '.repeat(31) + SLIDER), context);
    rejects(dump.replace('V.E......', 'V.E.....'), context);
    rejects(dump.replace('aid=42', SECRET), context);
});

test('binary, malformed Unicode, unsupported controls, huge input and excessive lines are redacted', () => {
    const { dump, context } = fixture();
    for (const input of [null, undefined, {}, [], '', Buffer.from([0xff]), '\0' + SECRET,
        '\ud800' + SECRET, dump.replace('  ACTIVITY', '\tACTIVITY'),
        'X'.repeat(2 * 1024 * 1024 + 1), dump + '\n'.repeat(40001)]) rejects(input, context);
    const throwing = { ...context };
    Object.defineProperty(throwing, 'valueBounds', { enumerable: true, get() { throw new Error(SECRET); } });
    rejects(dump, throwing);
});

test('deep synthetic hierarchies are rejected before unbounded ancestor traversal', () => {
    const { dump, context } = fixture(refs => {
        let child = refs.container;
        for (let index = 0; index < 260; index++) child = view('android.widget.FrameLayout', [0, 0, 1200, 2000], [child]);
        refs.offset.children = [child];
    });
    rejects(dump, context);
});
