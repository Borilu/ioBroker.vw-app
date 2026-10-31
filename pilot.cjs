'use strict';
// Experimental Linux-only pilot runner; DO NOT run on production until independently
// reviewed and an operator has reserved the certificate store maintenance window.
// Usage: node pilot.cjs stage|start|lan|stop /absolute/config.json --execute
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stage, startLoopback, startLan, stopPilot, Stop } = require('./provision.cjs');
const { createCliDriver } = require('./cli-driver.cjs');

function privateDirectory(dir) {
    if (!path.isAbsolute(dir) || fs.realpathSync(dir) !== dir) throw new Stop('unsafe_journal_directory');
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) || st.uid !== process.getuid()) throw new Stop('unsafe_journal_directory');
}
function syncDirectory(dir) {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function journalAt(dir) {
    const name = path.join(dir, 'pilot-journal.json');
    return {
        read: async () => {
            let st;
            try { st = fs.lstatSync(name); } catch (e) { if (e.code === 'ENOENT') return null; throw new Stop('journal_read_failed'); }
            if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || st.uid !== process.getuid()) throw new Stop('journal_unsafe');
            try { return JSON.parse(fs.readFileSync(name, 'utf8')); } catch { throw new Stop('journal_invalid'); }
        },
        save: async obj => {
            const tmp = path.join(dir, '.new-' + crypto.randomBytes(16).toString('hex'));
            let fd;
            try {
                fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
                fs.writeFileSync(fd, JSON.stringify(obj));
                fs.fsyncSync(fd);
                fs.closeSync(fd); fd = undefined;
                fs.renameSync(tmp, name); syncDirectory(dir);
            } catch { if (fd !== undefined) fs.closeSync(fd); throw new Stop('journal_write_uncertain'); }
        },
    };
}
async function main() {
    const [operation, configPath, explicit] = process.argv.slice(2);
    if (!['stage','start','lan','stop'].includes(operation) || !configPath || explicit !== '--execute' || process.argv.length !== 5)
        throw new Stop('usage');
    if (!path.isAbsolute(configPath)) throw new Stop('config_path');
    let config;
    try {
        if (fs.realpathSync(configPath) !== configPath) throw new Error('path');
        const st=fs.lstatSync(configPath);
        if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || st.uid !== process.getuid()) throw new Error('owner');
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch { throw new Stop('config_read_failed'); }
    privateDirectory(config.journalDir);
    const lock = path.join(config.journalDir, 'pilot.lock');
    try { fs.mkdirSync(lock, {mode:0o700}); syncDirectory(config.journalDir); } catch { throw new Stop('lock_exists_or_failed'); }
    let finished = false;
    try {
        const driver = createCliDriver(), journal = journalAt(config.journalDir);
        const action = {stage, start:startLoopback, lan:startLan, stop:stopPilot}[operation];
        const result = await action(driver, journal, config.pilot);
        process.stdout.write(result + '\n');
        finished = true;
    } finally {
        // Preserve lock after *any* uncertain failure; do not automatically retry.
        if (finished) { fs.rmdirSync(lock); syncDirectory(config.journalDir); }
    }
}
main().catch(e => { process.stderr.write('Pilot gestoppt: ' + (e instanceof Stop ? e.code : 'unexpected_error') + '\n'); process.exitCode = 1; });
