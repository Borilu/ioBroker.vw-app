'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { discoverGuardianPort } = require('../../../lib/guardian-port');

// Java class files are produced by compiling PortInteropServer and PortProtocol.
// This is a loopback-only test with deliberately synthetic credentials.
const java = path.join(process.env.TEMP, 'vwandroid-build-cache', 'jdk-17.0.20.1+1', 'bin', 'java.exe');
const classes = path.resolve(__dirname, '../build/protocol-tests');
const child = spawn(java, ['-cp', classes, 'de.borilu.wirelessguardian.PortInteropServer'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const lines = createInterface({ input: child.stdout });
let started = false;
child.on('error', () => { process.exitCode = 1; });
lines.once('line', async line => {
    started = true;
    try {
        const port = Number(line);
        assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
        const result = await discoverGuardianPort('127.0.0.1', { port, getSecret: () => 'ab'.repeat(32), timeoutMs: 4000 });
        assert.equal(result, 49122);
        process.stdout.write('Java/Node UDP interoperability passed\n');
    } catch (_) { process.stderr.write('Java/Node UDP interoperability failed\n'); process.exitCode = 1; }
    finally { lines.close(); child.kill(); }
});
child.on('exit', code => { if (!started || code && code !== null) process.exitCode = 1; });
