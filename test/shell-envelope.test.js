'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { AdbRuntime } = require('../lib/runtime');
const { Phone } = require('../lib/phone');
const { AndroidUi } = require('../lib/android-ui');

test('completion framing preserves exact shell arguments and stdin without leaking marker',
    {skip: process.platform === 'win32'}, async () => {
        let held = false;
        const executionFence = {
            async assertClear() { if (held) throw Error('held'); },
            async acquire() { if (held) throw Error('held'); held = true; return 'a'.repeat(32); },
            async release() { held = false; },
        };
        const runtime = new AdbRuntime({dataDir: path.resolve('.'), executionFence,
            spawnImpl: (_file, args) => spawn('/bin/sh', ['-c', args.at(-1)], {stdio: ['pipe','pipe','pipe']})});
        runtime._ready = true; runtime._binary = 'synthetic'; runtime._port = 12345; runtime._env = {};
        runtime._server = new EventEmitter(); runtime._server.exitCode = 0;
        await runtime.beginJob();
        const text = "literal 'quotes' ; $(printf unsafe) $HOME\nend";
        assert.equal(await runtime.run(['-s','192.0.2.1:1234','shell','printf','%s', text]), text);
        const input = 'synthetic private input\n';
        assert.equal(await runtime.run(['-s','192.0.2.1:1234','shell','cat'], {input}), input);
        assert.equal(await runtime.run(['-s','192.0.2.1:1234','shell','sh','-c', "printf '%s' 'nested quote' "]), 'nested quote');
        await assert.rejects(runtime.run(['-s','192.0.2.1:1234','shell','sh','-c','exit 7']), {code:'adb_command_failed'});
        await runtime.endJob();
        assert.equal(held, false);
    });

test('real runtime and AndroidUi install and re-check helper through nested quoted shells',
    {skip: process.platform === 'win32'}, async t => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-shell-ui-test-'));
        t.after(() => fs.rm(dir, {recursive: true, force: true}));
        const bin = path.join(dir, 'bin'); await fs.mkdir(bin);
        const checksum = path.join(bin, 'sha256sum');
        await fs.writeFile(checksum, '#!/bin/sh\nsum=$(/usr/bin/sha256sum "$1") || exit 1\nprintf "%s  /data/local/tmp/%s\\n" "${sum%% *}" "${1##*/}"\n');
        await fs.chmod(checksum, 0o700);
        let held = false, pushes = 0;
        const executionFence = {
            async assertClear() { if (held) throw Error('held'); },
            async acquire() { if (held) throw Error('held'); held = true; return 'a'.repeat(32); },
            async release() { held = false; },
        };
        const spawnImpl = (_file, args) => {
            const push = args.indexOf('push');
            if (push !== -1) {
                pushes++;
                const destination = path.join(dir, path.basename(args[push + 2]));
                return spawn('/bin/cp', [args[push + 1], destination], {stdio:['pipe','pipe','pipe']});
            }
            const script = args.at(-1).replaceAll('/data/local/tmp/', dir + '/');
            return spawn('/bin/sh', ['-c', script], {stdio:['pipe','pipe','pipe'], env:{PATH: bin + ':/usr/bin:/bin'}});
        };
        const runtime = new AdbRuntime({dataDir: dir, executionFence, spawnImpl});
        runtime._ready = true; runtime._binary = 'synthetic'; runtime._port = 12345; runtime._env = {};
        runtime._server = new EventEmitter(); runtime._server.exitCode = 0;
        const phone = new Phone({runtime, endpoint:'192.0.2.1:1234'});
        const ui = new AndroidUi(phone);
        await runtime.beginJob();
        const remote = await ui.payload();
        assert.match(remote, /^\/data\/local\/tmp\/vw-app-ui-[a-f0-9]{64}\.jar$/);
        assert.equal(pushes, 1);
        assert.equal(await ui.payload(), remote);
        assert.equal(pushes, 1);
        await fs.writeFile(path.join(dir, path.basename(remote)), 'synthetic corrupt file');
        assert.equal(await ui.payload(), remote);
        assert.equal(pushes, 2);
        await runtime.endJob();
    });
