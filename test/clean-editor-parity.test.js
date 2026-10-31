'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { editorDigest } = require('../lib/android-ui');

const jdk = process.env.VW_EDITOR_JDK_HOME;
const exe = name => path.join(jdk || '', 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const node = (cls, id, text, description, stateDescription, visible, enabled, clickable, checkable, checked, selected, bounds, children = []) =>
    ({ class: cls, id, text, description, stateDescription, visible, enabled, clickable, checkable, checked, selected, bounds, rangeInfo: null, children });
function syntheticTree() {
    return node('android.view.View', null, null, null, null, true, true, false, false, false, false, [0,0,1000,2000], [
        node('android.widget.Button', null, null, null, null, true, true, true, false, false, false, [20,90,160,190]),
        node('android.view.View', null, null, 'Zeit einstellen', null, true, true, false, false, false, false, [170,110,830,170]),
        { ...node('android.widget.SeekBar', null, null, 'Hour', '08', true, true, true, false, false, false, [380,500,460,820]), rangeInfo: { type: 1, min: 0, max: 229999, current: 115001 } },
        { ...node('android.widget.SeekBar', null, null, 'Minute', '30', true, true, true, false, false, false, [580,500,660,820]), rangeInfo: { type: 1, min: 0, max: 229999, current: 60001 } },
        ...['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'].map((day, index) =>
            node('android.view.View', 'cta_' + day, null, null, null, true, true, true, false, false, false,
                [40 + index * 135, 900, 160 + index * 135, 1030])),
        node('android.widget.Switch', null, null, null, null, true, true, true, true, true, false, [800,1110,930,1230]),
    ]);
}
test('native clean-editor guard matches the JS fingerprint and blocks changed or dirty synthetic trees', { skip: !jdk }, t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-editor-parity-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(folder).startsWith('vw-editor-parity-'));
        fs.rmSync(folder, { recursive: true, force: true });
    });
    const root = path.resolve(__dirname, '..');
    const java = (...parts) => path.join(root, ...parts);
    const result = spawnSync(exe('javac'), ['--release', '8', '-encoding', 'UTF-8', '-d', folder,
        java('lib','android','compile-only','android','os','Bundle.java'),
        java('lib','android','compile-only','com','android','uiautomator','testrunner','UiAutomatorTestRunner.java'),
        java('lib','android','src','vw','app','bridge','ExtendedUiDumpRunner.java'),
        java('lib','android','src','vw','app','bridge','AccessibilityActionRunner.java'),
        java('test','support','editor-java','android','graphics','Rect.java'),
        java('test','support','editor-java','vw','app','bridge','EditorGuardHarness.java')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const digest = editorDigest(syntheticTree());
    for (const [mode, expected] of [['clean','OK'], ['time','EDITOR_CHANGED'], ['minute','EDITOR_CHANGED'], ['progress','EDITOR_CHANGED'],
        ['day','EDITOR_CHANGED'], ['repeat','EDITOR_CHANGED'], ['foreign','EDITOR_CHANGED'],
        ['geometry','EDITOR_CHANGED'], ['dirty','EDITOR_DIRTY'], ['dirtyUpper','EDITOR_DIRTY'],
        ['dirtyMixed','EDITOR_DIRTY'], ['dirtyEnglish','EDITOR_DIRTY'], ['dirtyDescription','EDITOR_DIRTY'], ['dirtyHidden','EDITOR_DIRTY'],
        ['dirtyState','EDITOR_DIRTY'], ['dirtyResource','EDITOR_DIRTY']]) {
        const run = spawnSync(exe('java'), ['-cp', folder, 'vw.app.bridge.EditorGuardHarness', digest, mode], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout, expected);
    }
});
