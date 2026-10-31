'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { BridgeError } = require('./errors');
const { extendedViewToXml } = require('./accessibility-view');
const { DepartureScreen } = require('./departures-ui');
const { validateSecurityPin } = require('./config');

const ROOT = path.join(__dirname, 'android');
const MAX_BYTES = 2 * 1024 * 1024;
const RUNNERS = Object.freeze({ read: 'vw.app.bridge.ExtendedUiDumpRunner', action: 'vw.app.bridge.AccessibilityActionRunner' });
const ACTION_IDS = Object.freeze({ setProgress: 16908349, setText: 2097152, click: 16, cleanEditorBack: 16,
    timerEditorBack: 16, scrollForward: 4096, scrollBackward: 8192 });
const fail = (code = 'extended_ui_unavailable') => new BridgeError(code, code === 'departure_action_uncertain'
    ? 'Die App-Eingabe ist nicht eindeutig bestätigt. Keine automatische Wiederholung; Ansicht am Handy prüfen.'
    : 'Die erweiterte Android-Bedienansicht ist nicht eindeutig verfügbar.');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
// Only this module can mint proof for a parsed, nonce-bound guarded action.
// Raw caller-created objects and errors can never authorize a follow-up read.
const cleanBackReads = new WeakMap();
function claimCleanBackReadPermit(phone, outcome) {
    if (!outcome || typeof outcome !== 'object') return null;
    const proof = cleanBackReads.get(outcome);
    cleanBackReads.delete(outcome);
    if (!proof || proof.phone !== phone) return null;
    let valid = true;
    const check = () => {
        const runtime = proof.runtime, job = proof.job;
        if (valid && (phone.runtime !== runtime || runtime._job !== job || job.failureEpoch !== proof.epoch || job.ending ||
            job.uncertain || runtime._blocked || runtime._stopping || !runtime._ready || runtime._clients?.size !== 0)) valid = false;
        return valid;
    };
    return check() ? check : null;
}
function requireValue(value, code) { if (!value) throw fail(code); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
// Digest only locally observable accessibility fields. An identical digest
// is NOT proof of hidden app state: the clean Save invariant is checked too.
function editorDigest(root) {
    const hash = crypto.createHash('sha256');
    let count = 0;
    const add = value => {
        const bytes = value === null ? null : Buffer.from(String(value), 'utf8');
        const length = Buffer.alloc(4); length.writeInt32BE(bytes === null ? -1 : bytes.length);
        hash.update(length); if (bytes) hash.update(bytes);
    };
    const visit = (node, depth) => {
        requireValue(node && depth <= 40 && ++count <= 2000 && Array.isArray(node.children), 'invalid_target');
        for (const key of ['class', 'id', 'text', 'description', 'stateDescription']) add(node[key]);
        for (const key of ['visible', 'enabled', 'clickable', 'checkable', 'checked', 'selected']) {
            requireValue(typeof node[key] === 'boolean', 'invalid_target'); add(String(node[key]));
        }
        requireValue(Array.isArray(node.bounds) && node.bounds.length === 4 && node.bounds.every(Number.isInteger), 'invalid_target');
        for (const value of node.bounds) add(String(value));
        if (node.rangeInfo === null) add(null);
        else {
            requireValue(node.rangeInfo && Number.isInteger(node.rangeInfo.type), 'invalid_target');
            add(String(node.rangeInfo.type));
            for (const key of ['min', 'max', 'current']) {
                requireValue(Number.isFinite(node.rangeInfo[key]), 'invalid_target');
                const bytes = Buffer.alloc(4); bytes.writeFloatBE(node.rangeInfo[key]); add(String(bytes.readInt32BE()));
            }
        }
        add(String(node.children.length));
        for (const child of node.children) visit(child, depth + 1);
    };
    visit(root, 0);
    return hash.digest('hex');
}
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
const securityFail = code => new BridgeError(code, code === 'security_entry_uncertain'
    ? 'Die geschützte App-Eingabe ist nicht eindeutig bestätigt. Nicht wiederholen; App und Fahrzeug prüfen.'
    : 'Die geschützte S-PIN-Eingabe ist in dieser App-Ansicht nicht freigegeben.');
function securityFrame(raw, prefix, nonce, keys) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8192) throw securityFail('security_status_unavailable');
    const frames = [...raw.matchAll(new RegExp('^' + prefix + ' ([^\\r\\n]+)\\r?$', 'gm'))];
    if (frames.length !== 1) throw securityFail('security_status_unavailable');
    let frame;
    try { frame = JSON.parse(frames[0][1]); } catch (_) { throw securityFail('security_status_unavailable'); }
    if (!frame || Array.isArray(frame) || Object.keys(frame).sort().join(',') !== [...keys].sort().join(',')
        || frame.nonce !== nonce || JSON.stringify(frame) !== frames[0][1]) throw securityFail('security_status_unavailable');
    return frame;
}
function sensitiveTree(root) {
    return nodes(root).some(({ node }) => node.password || [node.text, node.description].some(value =>
        typeof value === 'string' && value.includes('S-PIN eingeben')));
}

/** Own DEX helper, run only inside a bounded foreground VW UI operation. */
class AndroidUi {
    constructor(phone, { payloadRoot = ROOT, now = () => performance.now() } = {}) {
        this.phone = phone; this.payloadRoot = payloadRoot; this.now = now;
        this.observations = new WeakMap();
        this.securityObservations = new WeakMap();
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
        // An absent helper is an expected first-install state, not a failed
        // ADB command: a failed transport must remain distinguishable and
        // fence later commands. `remote` is built solely from verified SHA-256.
        const hash = async () => {
            const output = (await this.phone.run(['shell', 'sh', '-c',
                `if [ -f ${remote} ]; then sha256sum ${remote}; else printf '%s\\n' absent; fi`], 5000)).trim();
            if (output === 'absent') return '';
            const match = /^([a-f0-9]{64}) {1,2}(\/data\/local\/tmp\/vw-app-ui-[a-f0-9]{64}\.jar)$/.exec(output);
            requireValue(match && match[2] === remote, 'android_payload_invalid');
            return match[1];
        };
        const present = await hash() === manifest.sha256;
        if (!present) {
            await this.phone.run(['push', path.join(this.payloadRoot, manifest.jar), remote], 15000);
            requireValue(await hash() === manifest.sha256, 'android_payload_invalid');
        }
        return remote;
    }
    accept(raw) {
        const xml = extendedViewToXml(raw);
        const observation = freezeTree(JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw));
        if (sensitiveTree(observation.root)) throw securityFail('security_ui_active');
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
        if (sensitiveTree(snapshot.root)) throw securityFail('security_ui_active');
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
        else if (action === 'cleanEditorBack' || action === 'timerEditorBack') {
            requireValue(header === 'Zeit einstellen' && selected.node.class === 'android.widget.Button'
                && value === null, 'invalid_target');
            const view = new DepartureScreen(extendedViewToXml(JSON.stringify(snapshot)));
            requireValue(view.kind() === 'timerEditor', 'invalid_target');
            if (action === 'cleanEditorBack') requireValue(view.timerEditor().canSave === false, 'invalid_target');
            else view.timerEditor(); // Validate the complete known editor, including a visible Save control.
            const back = view._base().back;
            requireValue(same(view._bounds(back), selected.node.bounds), 'invalid_target');
            value = editorDigest(snapshot.root);
        } else requireValue(value === null, 'invalid_target');
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
            const outcome = { beforeMatched: result.beforeMatched, actionAttempted: result.actionAttempted,
                actionAccepted: result.actionAccepted, success: result.success, errorCode, postReadError, postRead };
            const runtime = this.phone.runtime, job = runtime?._job;
            if ((action === 'cleanEditorBack' || action === 'timerEditorBack') && result.beforeMatched === true && result.actionAttempted === true
                && result.actionAccepted === true && result.success === false && result.errorCode === null
                && result.postRead === null && result.postReadError === 'POST_READ_UNAVAILABLE'
                && job && !job.ending && !job.uncertain && !runtime._blocked && !runtime._stopping
                && runtime._ready && runtime._clients?.size === 0) {
                Object.freeze(outcome);
                cleanBackReads.set(outcome, { phone: this.phone, runtime, job, epoch: job.failureEpoch });
            }
            return outcome;
        } catch (error) {
            if (['cancelled', 'phone_timeout'].includes(error.code)) throw error;
            if (invoked) throw fail('departure_action_uncertain');
            if (error instanceof BridgeError) throw error;
            throw fail();
        } finally { await fs.unlink(file).catch(() => {}); await this.cleanup(remote, out); }
    }
    async securityStatus() {
        // Status is a dedicated minimal native scan: no UI tree or request file.
        this.securityObservations = new WeakMap();
        this.observations = new WeakMap();
        try {
            await this.phone.foreground();
            const payload = await this.payload(), nonce = crypto.randomUUID();
            const raw = await this.phone.run(['shell', '-T', 'uiautomator', 'runtest', payload, '-c', RUNNERS.action,
                '-e', 'runner', RUNNERS.action, '-e', 'securityMode', 'probe', '-e', 'nonce', nonce], 20000);
            const frame = securityFrame(raw, 'VW_SECURITY_STATUS_RESULT', nonce,
                ['format', 'nonce', 'kind', 'operation', 'contextDigest', 'errorCode']);
            const kinds = ['pinEmpty', 'pinNonEmpty', 'pinUnsupported', 'home', 'other'];
            const errors = [null, 'SECURITY_CONTEXT_UNAVAILABLE', 'SECURITY_CONTEXT_UNSUPPORTED', 'SECURITY_SESSION_CLEANUP'];
            if (frame.format !== 'vw-app-security-status-v1' || !kinds.includes(frame.kind) || !errors.includes(frame.errorCode)
                || ![null, 'lock', 'unlock'].includes(frame.operation)
                || (frame.kind === 'pinEmpty' ? !['lock', 'unlock'].includes(frame.operation) || frame.errorCode !== null
                    || !/^[a-f0-9]{64}$/.test(frame.contextDigest) : frame.contextDigest !== null)
                || ['home', 'other'].includes(frame.kind) && frame.operation !== null) throw securityFail('security_status_unavailable');
            await this.phone.foreground(); this.phone.check();
            const result = { kind: frame.kind, errorCode: frame.errorCode };
            if (frame.operation) result.operation = frame.operation;
            if (frame.kind === 'pinEmpty') {
                const token = Object.freeze({});
                this.securityObservations.set(token, { captured: this.now(), operation: frame.operation, digest: frame.contextDigest });
                result.token = token;
            }
            return result;
        } catch (error) {
            if (['cancelled', 'phone_timeout'].includes(error.code)) throw error;
            throw securityFail('security_status_unavailable');
        }
    }
    async secretPinEntry(token, { operation } = {}, getSecurityPin) {
        const captured = token && this.securityObservations.get(token);
        if (!captured || captured.operation !== operation || !['lock', 'unlock'].includes(operation)
            || typeof getSecurityPin !== 'function') throw securityFail('security_context_invalid');
        // Consume before any await/getter, including pre-entry failures.
        this.securityObservations = new WeakMap();
        this.observations = new WeakMap();
        const fresh = () => {
            if (this.now() < captured.captured || this.now() - captured.captured > 15000) throw securityFail('security_context_stale');
        };
        fresh();
        await this.phone.foreground();
        const payload = await this.payload();
        this.phone.check(); fresh();
        let pin, input, invoked = false;
        const nonce = crypto.randomUUID();
        try {
            try { pin = validateSecurityPin(await getSecurityPin()); }
            catch (error) {
                if (['security_pin_required', 'security_pin_invalid'].includes(error?.code)) throw securityFail(error.code);
                throw securityFail('security_pin_unavailable');
            }
            input = Buffer.from(JSON.stringify({ schemaVersion: 1, nonce, operation, contextDigest: captured.digest, pin }) + '\n', 'utf8');
            pin = undefined;
            this.phone.check(); fresh();
            invoked = true;
            const raw = await this.phone.runSensitive(['shell', '-T', 'uiautomator', 'runtest', payload, '-c', RUNNERS.action,
                '-e', 'runner', RUNNERS.action, '-e', 'securityMode', 'entry'], input, 20000);
            const result = securityFrame(raw, 'VW_SECURITY_ENTRY_RESULT', nonce,
                ['format', 'nonce', 'beforeMatched', 'actionAttempted', 'actionAccepted', 'errorCode']);
            const errors = [null, 'SECURITY_CONTEXT_MISMATCH', 'SECURITY_ACTION_UNAVAILABLE', 'SECURITY_ACTION_NOT_ACCEPTED',
                'SECURITY_ACTION_OUTCOME_UNKNOWN', 'SECURITY_SESSION_CLEANUP', 'SECURITY_INVALID_REQUEST'];
            if (result.format !== 'vw-app-security-entry-v1' || !['beforeMatched', 'actionAttempted'].every(key => typeof result[key] === 'boolean')
                || result.actionAccepted !== null && typeof result.actionAccepted !== 'boolean' || !errors.includes(result.errorCode)
                || !result.actionAttempted && result.actionAccepted !== null || result.actionAttempted && !result.beforeMatched
                || result.actionAccepted === true && result.errorCode !== null) throw securityFail('security_entry_uncertain');
            // Never read the input or request a post-action tree. The controller
            // observes only securityStatus until the PIN form has disappeared.
            return { beforeMatched: result.beforeMatched, actionAttempted: result.actionAttempted,
                actionAccepted: result.actionAccepted, errorCode: result.errorCode };
        } catch (error) {
            if (invoked) throw securityFail('security_entry_uncertain');
            if (error instanceof BridgeError) throw error;
            throw securityFail('security_pin_unavailable');
        } finally { pin = undefined; if (input) input.fill(0); }
    }
}

module.exports = { AndroidUi, RUNNERS, editorDigest, claimCleanBackReadPermit };
