'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { BridgeError } = require('./errors');
const { extendedViewToXml } = require('./accessibility-view');
const { DepartureScreen } = require('./departures-ui');

const ROOT = path.join(__dirname, 'android');
const MAX_BYTES = 2 * 1024 * 1024;
const RUNNERS = Object.freeze({ read: 'vw.app.bridge.ExtendedUiDumpRunner', action: 'vw.app.bridge.AccessibilityActionRunner' });
const ACTION_IDS = Object.freeze({ setProgress: 16908349, setText: 2097152, click: 16, scrollForward: 4096, scrollBackward: 8192 });
const fail = (code = 'extended_ui_unavailable') => new BridgeError(code, code === 'departure_action_uncertain'
    ? 'Die App-Eingabe ist nicht eindeutig bestätigt. Keine automatische Wiederholung; Ansicht am Handy prüfen.'
    : 'Die erweiterte Android-Bedienansicht ist nicht eindeutig verfügbar.');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
function requireValue(value, code) { if (!value) throw fail(code); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function freezeTree(value) {
    if (value && typeof value === 'object') { for (const item of Object.values(value)) freezeTree(item); Object.freeze(value); }
    return value;
}
function nodes(root, result = [], nodePath = '0', ancestors = []) {
    result.push({ node: root, nodePath, ancestors });
    root.children.forEach((child, index) => nodes(child, result, nodePath + '.' + index, [...ancestors, root]));
    return result;
}
function selector(entry) {
    return { id: entry.node.id, description: entry.node.description, class: entry.node.class,
        bounds: [...entry.node.bounds], text: entry.node.text, stateDescription: entry.node.stateDescription,
        rangeInfo: entry.node.rangeInfo === null ? null : { ...entry.node.rangeInfo }, nodePath: entry.nodePath };
}
function targetFrom(entries, query, permitted = () => true) {
    requireValue(query && typeof query === 'object' && !Array.isArray(query), 'invalid_target');
    const keys = Object.keys(query);
    const allowed = ['id', 'description', 'class', 'bounds', 'text', 'stateDescription', 'rangeInfo', 'nodePath'];
    requireValue(keys.length && keys.every(key => allowed.includes(key)), 'invalid_target');
    requireValue(keys.some(key => ['id', 'description', 'text', 'nodePath'].includes(key))
        || keys.includes('class') && keys.includes('bounds'), 'invalid_target');
    const found = entries.filter(entry => entry.node.visible && entry.node.enabled && !entry.node.password && permitted(entry)
        && keys.every(key => same(key === 'nodePath' ? entry.nodePath : entry.node[key], query[key])));
    requireValue(found.length === 1, 'invalid_target');
    return found[0];
}

/** Own DEX helper, run only inside a bounded foreground VW UI operation. */
class AndroidUi {
    constructor(phone, { payloadRoot = ROOT, now = () => performance.now() } = {}) {
        this.phone = phone; this.payloadRoot = payloadRoot; this.now = now;
        this.observations = new WeakMap();
    }
    async payload() {
        let manifest, jar;
        try {
            manifest = JSON.parse(await fs.readFile(path.join(this.payloadRoot, 'manifest.json'), 'utf8'));
            requireValue(manifest.format === 'vw-app-android-ui-v1' && manifest.jar === 'vw-ui.jar'
                && /^[a-f0-9]{64}$/.test(manifest.sha256) && Number.isInteger(manifest.bytes)
                && manifest.bytes > 0 && manifest.bytes < MAX_BYTES && Array.isArray(manifest.sources)
                && manifest.sources.length === 4, 'android_payload_invalid');
            for (const source of manifest.sources) {
                requireValue(source && /^(?:src|compile-only)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.java$/.test(source.path)
                    && /^[a-f0-9]{64}$/.test(source.sha256), 'android_payload_invalid');
                requireValue(digest(await fs.readFile(path.join(this.payloadRoot, ...source.path.split('/')))) === source.sha256,
                    'android_payload_invalid');
            }
            jar = await fs.readFile(path.join(this.payloadRoot, manifest.jar));
            requireValue(jar.length === manifest.bytes && digest(jar) === manifest.sha256, 'android_payload_invalid');
        } catch (_) { throw fail('android_payload_invalid'); }
        this.phone.check();
        const remote = '/data/local/tmp/vw-app-ui-' + manifest.sha256 + '.jar';
        const hash = async () => (await this.phone.run(['shell', 'sha256sum', remote], 5000)).trim().split(/\s/)[0];
        let present = false;
        try { present = await hash() === manifest.sha256; }
        catch (error) { this.phone.check(); if (['cancelled', 'phone_timeout'].includes(error.code)) throw error; }
        if (!present) {
            await this.phone.run(['push', path.join(this.payloadRoot, manifest.jar), remote], 15000);
            requireValue(await hash() === manifest.sha256, 'android_payload_invalid');
        }
        return remote;
    }
    accept(raw) {
        const xml = extendedViewToXml(raw);
        const observation = freezeTree(JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw));
        this.observations.set(observation, this.now());
        return { xml, observation };
    }
    async cleanup(...remote) {
        for (const file of remote) if (file) {
            await this.phone.runtime.run(['-s', this.phone.endpoint, 'shell', 'rm', '-f', file],
                { timeoutMs: 1500, maxOutputBytes: 4096 }).catch(() => {});
        }
    }
    async read() {
        await this.phone.foreground();
        const payload = await this.payload();
        const out = '/data/local/tmp/vw-app-read-' + crypto.randomUUID() + '.json';
        try {
            const text = await this.phone.run(['shell', 'uiautomator', 'runtest', payload,
                '-c', RUNNERS.read, '-e', 'runner', RUNNERS.read, '-e', 'out', out], 20000);
            requireValue(/^VW_UI_DUMP_OK\s*$/m.test(text));
            const raw = await this.phone.run(['shell', 'cat', out], 5000);
            await this.phone.foreground(); this.phone.check();
            return this.accept(raw);
        } finally { await this.cleanup(out); }
    }
    async requestFile(request) {
        requireValue(typeof this.phone.runtime.dataDir === 'string' && path.isAbsolute(this.phone.runtime.dataDir), 'invalid_target');
        const folder = path.join(this.phone.runtime.dataDir, 'ui-requests');
        await fs.mkdir(folder, { recursive: true, mode: 0o700 });
        requireValue((await fs.lstat(folder)).isDirectory() && !(await fs.lstat(folder)).isSymbolicLink(), 'invalid_target');
        await fs.chmod(folder, 0o700);
        const file = path.join(folder, crypto.randomUUID() + '.json');
        const data = JSON.stringify(request);
        requireValue(Buffer.byteLength(data) <= 32768, 'invalid_target');
        const handle = await fs.open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
        try { await handle.writeFile(data, 'utf8'); }
        catch (error) { await fs.unlink(file).catch(() => {}); throw error; }
        finally { await handle.close(); }
        return file;
    }
    async action({ snapshot, header, target, action, value = null } = {}) {
        requireValue(snapshot && this.observations.has(snapshot) && typeof header === 'string'
            && header.length > 0 && header.length <= 128 && Object.hasOwn(ACTION_IDS, action), 'invalid_target');
        const captured = this.observations.get(snapshot);
        requireValue(this.now() >= captured && this.now() - captured <= 15000, 'invalid_target');
        const entries = nodes(snapshot.root);
        const window = snapshot.windowsBefore.vwWindows.find(item => item.id === snapshot.windowId);
        const inside = node => node.bounds[0] >= window.bounds[0] && node.bounds[1] >= window.bounds[1]
            && node.bounds[2] <= window.bounds[2] && node.bounds[3] <= window.bounds[3]
            && node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1];
        const strict = entry => [entry.node, ...entry.ancestors].every(node => node.visible && node.enabled && inside(node));
        const head = targetFrom(entries, { description: header }, strict);
        const permitted = entry => {
            if (strict(entry)) return true;
            if (action !== 'setProgress' || header !== 'Zeit einstellen' || !['Hour', 'Minute'].includes(entry.node.description)
                || ![entry.node, ...entry.ancestors].every(node => node.enabled && inside(node))) return false;
            try {
                // Reuse the UI parser's narrow known Compose wrapper exception;
                // do not relax generic ancestor visibility for other actions.
                const screen = new DepartureScreen(extendedViewToXml(JSON.stringify(snapshot)));
                const wheel = screen.wheelTarget(entry.node.description === 'Hour' ? 'hour' : 'minute');
                return same(wheel.bounds, entry.node.bounds);
            } catch (_) { return false; }
        };
        const selected = targetFrom(entries, target, permitted);
        requireValue(head !== selected && selected.node.actions.some(item => item.id === ACTION_IDS[action]), 'invalid_target');
        if (action === 'setProgress') requireValue(typeof value === 'number' && Number.isFinite(value)
            && selected.node.rangeInfo !== null && value >= selected.node.rangeInfo.min && value <= selected.node.rangeInfo.max, 'invalid_target');
        else if (action === 'setText') requireValue(typeof value === 'string' && value.length <= 5000
            && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) && !/[\ud800-\udfff]/u.test(value), 'invalid_target');
        else requireValue(value === null, 'invalid_target');
        const nonce = crypto.randomUUID();
        const request = { schemaVersion: 1, nonce, action, target: selector(selected),
            context: { windowId: null, header: selector(head) }, value };
        // An observation can authorize only one invocation, including failures.
        this.observations.delete(snapshot);
        await this.phone.foreground();
        const payload = await this.payload();
        const file = await this.requestFile(request);
        const remote = '/data/local/tmp/vw-app-request-' + nonce + '.json';
        const out = '/data/local/tmp/vw-app-action-' + crypto.randomUUID() + '.json';
        let invoked = false;
        try {
            await this.phone.run(['push', file, remote], 5000);
            await this.phone.foreground(); this.phone.check();
            requireValue(this.now() >= captured && this.now() - captured <= 15000, 'invalid_target');
            invoked = true;
            const text = await this.phone.run(['shell', 'uiautomator', 'runtest', payload, '-c', RUNNERS.action,
                '-e', 'runner', RUNNERS.action, '-e', 'request', remote, '-e', 'out', out], 35000);
            requireValue(/^VW_UI_ACTION_RESULT\s*$/m.test(text), 'departure_action_uncertain');
            const raw = await this.phone.run(['shell', 'cat', out], 5000);
            requireValue(Buffer.byteLength(raw) <= MAX_BYTES, 'departure_action_uncertain');
            const result = JSON.parse(raw);
            requireValue(result && result.format === 'vw-app-accessibility-action-v1' && result.requestNonce === nonce
                && result.action === action && result.actionId === ACTION_IDS[action]
                && result.nativeContextVerifiedByRunner === false
                && ['beforeMatched', 'actionAttempted', 'success'].every(key => typeof result[key] === 'boolean')
                && (result.actionAccepted === null || typeof result.actionAccepted === 'boolean')
                && (result.actionAttempted || result.actionAccepted === null)
                && (!result.actionAttempted || result.beforeMatched)
                && (!result.success || result.actionAccepted === true && result.errorCode === null && result.postRead !== null),
                'departure_action_uncertain');
            const errorCode = result.errorCode === null ? null : /^[A-Z_]{1,64}$/.test(result.errorCode) ? result.errorCode : 'ACTION_OUTCOME_UNKNOWN';
            const postReadError = result.postReadError === null ? null : 'POST_READ_UNAVAILABLE';
            const postRead = result.postRead === null ? null : this.accept(JSON.stringify(result.postRead));
            await this.phone.foreground(); this.phone.check();
            return { beforeMatched: result.beforeMatched, actionAttempted: result.actionAttempted,
                actionAccepted: result.actionAccepted, success: result.success, errorCode, postReadError, postRead };
        } catch (error) {
            if (['cancelled', 'phone_timeout'].includes(error.code)) throw error;
            if (invoked) throw fail('departure_action_uncertain');
            if (error instanceof BridgeError) throw error;
            throw fail();
        } finally { await fs.unlink(file).catch(() => {}); await this.cleanup(remote, out); }
    }
}

module.exports = { AndroidUi, RUNNERS };
