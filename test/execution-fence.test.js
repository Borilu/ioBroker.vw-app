'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ExecutionFence } = require('../lib/execution-fence');

test('durable runtime fence blocks another instance after restart and only its owner can finish',
    {skip: process.platform === 'win32'}, async t => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-fence-test-'));
        t.after(() => fs.rm(dir, {recursive: true, force: true}));
        const first = new ExecutionFence(dir);
        const token = await first.acquire();
        const second = new ExecutionFence(dir);
        await assert.rejects(second.assertClear(), {code: 'adb_execution_fenced'});
        await assert.rejects(second.acquire(), {code: 'adb_execution_fenced'});
        await assert.rejects(second.release('b'.repeat(32)), {code: 'adb_execution_fenced'});
        await assert.rejects(second.assertClear(), {code: 'adb_execution_fenced'});
        await first.release(token);
        await second.assertClear();
    });
