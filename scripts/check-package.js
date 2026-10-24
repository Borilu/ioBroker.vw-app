'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const io = require(path.join(root, 'io-package.json'));
const ui = require(path.join(root, 'admin/jsonConfig.json'));
assert.equal(pkg.name, 'iobroker.' + io.common.name);
assert.equal(pkg.version, io.common.version);
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
assert.equal(io.native.pollIntervalSeconds, 0);
assert.equal(ui.items.commandTimeoutSeconds.min, 30);
assert.equal(ui.items.commandTimeoutSeconds.max, 360);
assert(!pkg.files.some(s => /node_modules|adb-home|runtime\//.test(s)));
console.log('Adapter metadata, setup inputs and package boundaries are consistent.');
