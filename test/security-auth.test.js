'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../lib/store');
const { BridgeError } = require('../lib/errors');
const { readSecurityAuth, blockSecurityAuth, clearSecurityAuth, validateSecurityAuthState,
    sanitizeSecurityError, fixedSecurityError, SECURITY_AUTH_REASONS, withSecurityDiagnostic, securityErrorDiagnostic } = require('../lib/security-auth');

const CLEAR = { blocked: false, reason: null, blockedAt: null };
const DATE = '2024-01-02T03:04:05.000Z';
const BLOCKED = { blocked: true, reason: 'attempt_pending', blockedAt: DATE };
const SECRET = 'PRIVATE_CREDENTIAL_PAYLOAD';
const rejects = (operation, code) => assert.rejects(operation, error => error instanceof BridgeError
    && error.code === code && !JSON.stringify(error).includes(SECRET));

test('missing security state is explicitly unblocked and returned as independent data', async () => {
    const store = { async read(name, fallback) { assert.equal(name, 'security-auth-state'); return fallback; } };
    const state = await readSecurityAuth(store);
    assert.deepEqual(state, CLEAR); state.blocked = true;
    assert.deepEqual(await readSecurityAuth(store), CLEAR);
});

test('auth schema admits only blocked flag, fixed reason and an exact ISO history time', () => {
    for (const reason of SECURITY_AUTH_REASONS) assert.deepEqual(validateSecurityAuthState({ ...BLOCKED, reason }), { ...BLOCKED, reason });
    assert.deepEqual(validateSecurityAuthState(Object.assign(Object.create(null), CLEAR)), CLEAR);
    for (const bad of [null, [], { ...CLEAR, blocked: 0 }, { ...CLEAR, sPin: SECRET },
        { blocked: true, reason: null, blockedAt: DATE }, { ...BLOCKED, reason: SECRET },
        { ...BLOCKED, blockedAt: '2024-02-31T03:04:05.000Z' }, { ...BLOCKED, blockedAt: DATE.replace('.000Z', 'Z') },
        { ...CLEAR, reason: 'pin_rejected' }, { ...CLEAR, blockedAt: DATE }, Object.create({ ...CLEAR })]) {
        assert.throws(() => validateSecurityAuthState(bad), error => error.code === 'security_auth_invalid'
            && !JSON.stringify(error).includes(SECRET));
    }
});

test('state validation does not execute accessors or serialize untrusted errors', () => {
    let calls = 0;
    const bad = { ...CLEAR };
    Object.defineProperty(bad, 'blocked', { enumerable: true, get() { calls++; throw Error(SECRET); } });
    assert.throws(() => validateSecurityAuthState(bad), error => error.code === 'security_auth_invalid');
    assert.equal(calls, 0);
    const symbolic = { ...CLEAR, [Symbol(SECRET)]: true };
    assert.throws(() => validateSecurityAuthState(symbolic), error => error.code === 'security_auth_invalid');
});

test('read failures and malformed persisted state fail closed with fixed redacted errors', async () => {
    await rejects(readSecurityAuth({ async read() { throw new BridgeError('anything', SECRET); } }), 'security_auth_unavailable');
    await rejects(readSecurityAuth({ async read() { return { ...BLOCKED, sPin: SECRET }; } }), 'security_auth_invalid');
});

test('blocking persists before resolution and contains no credential, action payload or profile', async () => {
    const writes = [];
    const store = { async write(name, value) { writes.push([name, structuredClone(value)]); } };
    const result = await blockSecurityAuth(store, 'attempt_pending', Date.parse(DATE));
    assert.deepEqual(result, BLOCKED);
    assert.deepEqual(writes, [['security-auth-state', BLOCKED]]);
    result.blocked = false;
    assert.equal(writes[0][1].blocked, true);
    await blockSecurityAuth(store, 'pin_rejected', Date.parse(DATE));
    await blockSecurityAuth(store, 'pin_locked', Date.parse(DATE));
    await blockSecurityAuth(store, 'outcome_unknown', Date.parse(DATE));
    assert.equal(writes.length, 4);
});

test('invalid latch metadata cannot reach the store', async () => {
    const store = { async write() { throw Error('Must not write'); } };
    for (const [reason, now] of [[SECRET, 0], ['attempt_pending', -1], ['attempt_pending', NaN],
        ['attempt_pending', Infinity], ['attempt_pending', 1.5], ['attempt_pending', Number.MAX_SAFE_INTEGER]]) {
        await rejects(blockSecurityAuth(store, reason, now), 'security_auth_invalid');
    }
});

test('clearing is an explicit persisted operation and write failure does not report success', async () => {
    let written;
    assert.deepEqual(await clearSecurityAuth({ async write(name, state) { written = [name, state]; } }), CLEAR);
    assert.deepEqual(written, ['security-auth-state', CLEAR]);
    await rejects(clearSecurityAuth({ async write() { throw Error(SECRET); } }), 'security_auth_not_saved');
    await rejects(blockSecurityAuth({ async write() { throw Error(SECRET); } }, 'attempt_pending', Date.parse(DATE)), 'security_auth_not_saved');
});

test('security error sanitization ignores even a foreign BridgeError message and accessors', () => {
    const foreign = new BridgeError('security_pin_rejected', SECRET);
    assert.equal(sanitizeSecurityError(foreign).code, 'security_pin_rejected');
    assert.ok(!JSON.stringify(sanitizeSecurityError(foreign)).includes(SECRET));
    assert.equal(sanitizeSecurityError(new Error(SECRET)).code, 'internal_error');
    assert.equal(sanitizeSecurityError({ code: SECRET }).code, 'internal_error');
    let getters = 0;
    const hostile = { get code() { getters++; throw Error(SECRET); }, toJSON() { throw Error(SECRET); } };
    assert.equal(sanitizeSecurityError(hostile).code, 'internal_error'); assert.equal(getters, 0);
    assert.equal(fixedSecurityError({ toString() { throw Error(SECRET); } }).code, 'internal_error');
});

test('persistent rejected state survives store restart and explicit clear stores only the fixed schema', async t => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-security-auth-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const first = new StateStore(folder);
    await blockSecurityAuth(first, 'pin_rejected', Date.parse(DATE));
    const restarted = new StateStore(folder);
    assert.deepEqual(await readSecurityAuth(restarted), { ...BLOCKED, reason: 'pin_rejected' });
    await clearSecurityAuth(restarted);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder, 'security-auth-state.json'), 'utf8')), CLEAR);
    assert.deepEqual(await readSecurityAuth(new StateStore(folder)), CLEAR);
});

test('only internally branded diagnostics survive sanitization and their stage/cause are fixed allowlists', () => {
    const original = withSecurityDiagnostic(new BridgeError('outcome_unknown', SECRET), 'pin_entry', 'security_entry_uncertain');
    const sanitized = sanitizeSecurityError(sanitizeSecurityError(original));
    assert.deepEqual(securityErrorDiagnostic(sanitized), { stage: 'pin_entry', cause: 'security_entry_uncertain' });
    assert.equal(JSON.stringify(sanitized).includes('pin_entry'), false);
    const details = securityErrorDiagnostic(sanitized); details.stage = SECRET;
    assert.equal(securityErrorDiagnostic(sanitized).stage, 'pin_entry');
    assert.equal(securityErrorDiagnostic(withSecurityDiagnostic(new BridgeError('outcome_unknown', SECRET), SECRET, SECRET)), null);
    assert.deepEqual(securityErrorDiagnostic(withSecurityDiagnostic(new Error(SECRET), 'pin_entry', SECRET)),
        { stage: 'pin_entry', cause: 'internal_error' });
    let reads = 0;
    const foreign = new BridgeError('outcome_unknown', SECRET);
    for (const key of ['stage', 'cause', 'diagnostic', 'details']) Object.defineProperty(foreign, key, {
        enumerable: true, get() { reads++; throw new Error(SECRET); },
    });
    assert.equal(securityErrorDiagnostic(foreign), null);
    assert.equal(securityErrorDiagnostic(sanitizeSecurityError(foreign)), null); assert.equal(reads, 0);
    assert.equal(securityErrorDiagnostic(new Proxy({}, { get() { throw new Error(SECRET); } })), null);
});
