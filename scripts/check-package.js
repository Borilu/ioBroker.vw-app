'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const io = require(path.join(root, 'io-package.json'));
const ui = require(path.join(root, 'admin/jsonConfig.json'));
const lock = require(path.join(root, 'package-lock.json'));
const { normalizeConfig } = require(path.join(root, 'lib/config'));
assert.equal(pkg.name, 'iobroker.' + io.common.name);
assert.equal(pkg.version, io.common.version);
assert.equal(pkg.version, lock.version);
assert.equal(pkg.version, lock.packages[''].version);
assert.equal(io.common.mode, 'daemon');
assert.equal(io.common.compact, false);
assert.equal(io.common.messagebox, true);
assert.equal(io.common.adminUI.config, 'json');
assert.deepEqual(io.common.os, ['linux']);
for (const file of ['main.js','README.md','LICENSE','NOTICE','admin/vw-app.svg','lib/runtime.js','lib/adapter.js']) assert(fs.statSync(path.join(root,file)).isFile());
for (const key of ['_pairCode','_pairPort','_acceptRuntimeLicense']) {
    assert.equal(ui.items[key].doNotSave, true);
    assert(!(key in io.native));
}
for (const key of Object.keys(io.native)) assert(!/^_/.test(key));
for (const key of Object.keys(ui.items).filter(k => !k.startsWith('_'))) assert(key in io.native, 'UI/native mismatch: ' + key);
assert.equal(io.native.allowWrites, false);
assert.equal(io.native.pollIntervalSeconds, 15);
assert.equal(ui.items.pollIntervalSeconds.default, 15);
assert.equal(ui.items.pollIntervalSeconds.min, 0);
assert.equal(ui.items.pollIntervalSeconds.max, 86400);
assert.equal(io.native.refreshMaxAgeSeconds, 0);
assert.equal(ui.items.refreshMaxAgeSeconds.default, 0);
assert.equal(ui.items.refreshMaxAgeSeconds.min, 0);
assert.equal(ui.items.refreshMaxAgeSeconds.max, 86400);
assert.equal(normalizeConfig().pollIntervalSeconds, 0, 'Missing legacy polling must stay disabled.');
assert.equal(normalizeConfig(io.native).pollIntervalSeconds, 15);
assert.equal(normalizeConfig({ refreshMaxAgeSeconds: 30 }).refreshMaxAgeSeconds, 30);
for (const config of [{ pollIntervalSeconds: 14 }, { pollIntervalSeconds: 86401 },
    { refreshMaxAgeSeconds: 29 }, { refreshMaxAgeSeconds: 86401 }]) {
    assert.throws(() => normalizeConfig(config), error => error.code === 'invalid_config');
}
for (const [name, minimum] of [['pollIntervalSeconds', 15], ['refreshMaxAgeSeconds', 30]]) {
    const validate = new Function('data', 'return (' + ui.items[name].validator + ');');
    for (const value of [0, minimum, 86400]) assert.equal(validate({ [name]: value }), true);
    for (const value of [1, minimum - 1, minimum + 0.5, 86401, true]) assert.equal(validate({ [name]: value }), false);
}
assert.equal(ui.items.commandTimeoutSeconds.min, 30);
assert.equal(ui.items.commandTimeoutSeconds.max, 360);
assert(!pkg.files.some(s => /node_modules|adb-home|runtime\//.test(s)));
const androidRoot = path.join(root, 'lib/android');
const payload = JSON.parse(fs.readFileSync(path.join(androidRoot, 'manifest.json'), 'utf8'));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
assert.equal(payload.format, 'vw-app-android-ui-v1');
assert.equal(payload.jar, 'vw-ui.jar');
assert.equal(payload.minAndroidApi, 30);
assert.equal(payload.d8Version, '9.5.28');
assert.equal(payload.d8Sha256, '38a9ffaaebbd17d1514e3ecbff5a85b989bb13c551b9e224c7409514eea84ff5');
const sourcePaths = [
    'compile-only/android/os/Bundle.java',
    'compile-only/com/android/uiautomator/testrunner/UiAutomatorTestRunner.java',
    'src/vw/app/bridge/AccessibilityActionRunner.java',
    'src/vw/app/bridge/ExtendedUiDumpRunner.java',
];
assert.deepEqual(payload.sources.map(item => item.path).sort(), sourcePaths);
for (const source of payload.sources) assert.equal(sha(fs.readFileSync(path.join(androidRoot, source.path))), source.sha256);
const jar = fs.readFileSync(path.join(androidRoot, 'vw-ui.jar'));
assert.equal(jar.length, payload.bytes);
assert.equal(sha(jar), payload.sha256);
assert(!fs.existsSync(path.join(androidRoot, 'src/vw/app/bridge/ExplorationUiDumpRunner.java')));
console.log('Adapter metadata, setup inputs and package boundaries are consistent.');
