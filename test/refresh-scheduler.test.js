'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RefreshScheduler, DOMAINS } = require('../lib/refresh-scheduler');

async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
class Clock {
    constructor() { this.time = 1000000; this.nextId = 1; this.timers = new Map(); }
    now = () => this.time;
    setTimer = (callback, delay) => {
        const id = this.nextId++;
        this.timers.set(id, { callback, at: this.time + delay, delay });
        return id;
    };
    clearTimer = id => { this.timers.delete(id); };
    next() { return [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]; }
    async advance(milliseconds) {
        const until = this.time + milliseconds;
        let count = 0;
        while (this.next()?.[1].at <= until) {
            if (++count > 2000) throw new Error('Timer spin detected');
            const [id, timer] = this.next();
            this.timers.delete(id);
            this.time = timer.at;
            timer.callback();
            await flush();
        }
        this.time = until;
        await flush();
    }
    async until(predicate, maximumTimers = 2000) {
        for (let index = 0; !predicate(); index++) {
            if (index >= maximumTimers || !this.next()) throw new Error('Expected scheduled work was not reached');
            await this.advance(this.next()[1].at - this.time);
        }
    }
}
function fixture(overrides = {}) {
    const clock = new Clock();
    const calls = [];
    const updates = [];
    const scheduler = new RefreshScheduler({
        run: async domain => { calls.push({ domain, at: clock.time }); }, canRun: () => true,
        intervalMs: 15000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
        onUpdate: snapshot => updates.push(snapshot), ...overrides,
    });
    return { scheduler, clock, calls, updates };
}

test('constructor validates callbacks and timing without coercion', () => {
    const valid = { run: async () => {}, canRun: () => true, intervalMs: 15000 };
    assert.deepEqual(DOMAINS, ['climate', 'charging', 'vehicleReport']);
    assert.equal(Object.isFrozen(DOMAINS), true);
    for (const intervalMs of [undefined, null, '15000', 14999, -1, NaN, Infinity, 15000.5]) {
        assert.throws(() => new RefreshScheduler({ ...valid, intervalMs }), TypeError);
    }
    for (const gapMs of [-1, '5000', null, Infinity, 0.5]) {
        assert.throws(() => new RefreshScheduler({ ...valid, gapMs }), TypeError);
    }
    for (const key of ['run', 'canRun', 'now', 'setTimer', 'clearTimer', 'onUpdate']) {
        assert.throws(() => new RefreshScheduler({ ...valid, [key]: true }), TypeError);
    }
    const { scheduler } = fixture();
    for (const domain of ['start', 'synchronize', '__proto__', null, 0]) assert.throws(() => scheduler.request(domain), TypeError);
    for (const options of [{ delayMs: -1 }, { delayMs: '0' }, { priority: 1 }]) {
        assert.throws(() => scheduler.request('climate', options), TypeError);
    }
});

test('snapshot is independent serializable data with conservative estimates before start', () => {
    const { scheduler, clock } = fixture();
    const snapshot = scheduler.snapshot();
    assert.equal(snapshot.runningDomain, null);
    assert.equal(snapshot.estimatedCycleMs, 112500);
    for (const domain of DOMAINS) assert.deepEqual(snapshot.domains[domain], {
        lastDurationMs: null, estimatedDurationMs: 30000, nextDueAt: 0, failures: 0,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
    snapshot.domains.climate.failures = 100;
    assert.equal(scheduler.snapshot().domains.climate.failures, 0);
    assert.equal(scheduler.request('climate'), false);
    scheduler.notifyAvailable();
    assert.equal(clock.timers.size, 0);
});

test('start makes all domains due immediately and repeated starts do not duplicate timers', async () => {
    const { scheduler, clock, calls, updates } = fixture();
    scheduler.start();
    scheduler.start();
    assert.equal(clock.timers.size, 1);
    for (const domain of DOMAINS) assert.equal(scheduler.snapshot().domains[domain].nextDueAt, clock.time);
    await clock.advance(0);
    assert.deepEqual(calls.map(row => row.domain), ['climate']);
    assert.equal(scheduler.snapshot().domains.climate.lastDurationMs, 0);
    assert.equal(scheduler.snapshot().domains.climate.estimatedDurationMs, 15000);
    assert.equal(scheduler.snapshot().estimatedCycleMs, 95000);
    assert.deepEqual(updates.at(-1), scheduler.snapshot());
    scheduler.stop();
});

test('automatic reads use fair round robin with a completion pause and no accumulated interval queue', async () => {
    const { scheduler, clock, calls } = fixture();
    scheduler.start();
    await clock.advance(30000);
    assert.deepEqual(calls.map(row => row.domain), ['climate', 'charging', 'vehicleReport', 'climate', 'charging', 'vehicleReport', 'climate']);
    assert.deepEqual(calls.map(row => row.at - calls[0].at), [0, 5000, 10000, 15000, 20000, 25000, 30000]);
    assert.equal(clock.timers.size, 1);
    scheduler.stop();
});

test('a long read cannot overlap another job and increases the global pause to a quarter of its real duration', async () => {
    const pending = deferred();
    const { scheduler, clock, calls } = fixture();
    scheduler._run = async domain => { calls.push({ domain, at: clock.time }); if (calls.length === 1) await pending.promise; };
    scheduler.start();
    await clock.advance(60000);
    assert.equal(calls.length, 1);
    assert.equal(scheduler.snapshot().runningDomain, 'climate');
    assert.equal(clock.timers.size, 0);
    pending.resolve();
    await flush();
    const state = scheduler.snapshot().domains.climate;
    assert.equal(state.lastDurationMs, 60000);
    assert.equal(state.estimatedDurationMs, 45000);
    assert.equal(state.nextDueAt, clock.time + 15000);
    assert.equal(scheduler.snapshot().estimatedCycleMs, 131250);
    await clock.advance(14999);
    assert.equal(calls.length, 1);
    await clock.advance(1);
    assert.deepEqual(calls.map(row => row.domain), ['climate', 'charging']);
    scheduler.stop();
});

test('success interval begins at completion rather than at the preceding start time', async () => {
    const pending = deferred();
    const { scheduler, clock } = fixture({ run: () => pending.promise, intervalMs: 60000 });
    const startedAt = clock.time;
    scheduler.start();
    await clock.advance(10000);
    pending.resolve();
    await flush();
    assert.equal(scheduler.snapshot().domains.climate.nextDueAt, startedAt + 10000 + 60000);
    scheduler.stop();
});

test('repeated requests during a running read coalesce into at most one later read', async () => {
    const pending = deferred();
    const { scheduler, clock, calls } = fixture({ intervalMs: 60000 });
    scheduler._run = async domain => { calls.push({ domain, at: clock.time }); if (calls.length === 1) await pending.promise; };
    scheduler.start();
    await clock.advance(0);
    for (let index = 0; index < 1000; index++) scheduler.request('climate', { priority: true });
    assert.equal(clock.timers.size, 0);
    assert.equal(calls.length, 1);
    pending.resolve();
    await flush();
    await clock.advance(20000);
    assert.deepEqual(calls.map(row => row.domain), ['climate', 'climate', 'charging', 'vehicleReport']);
    assert.equal(clock.timers.size, 1);
    scheduler.stop();
});

test('priority request spam cannot starve the fair round-robin return', async () => {
    const { scheduler, clock, calls } = fixture({ intervalMs: 60000 });
    scheduler.start();
    await clock.advance(0);
    for (let step = 0; step < 4; step++) {
        for (let index = 0; index < 50; index++) scheduler.request('climate', { priority: true });
        await clock.advance(5000);
    }
    assert.deepEqual(calls.map(row => row.domain), ['climate', 'climate', 'charging', 'climate', 'vehicleReport']);
    scheduler.stop();
});

test('requested delays coalesce to their earliest time without postponing automatic due work', async () => {
    const { scheduler, clock, calls } = fixture({ intervalMs: 60000 });
    scheduler.start();
    await clock.advance(10000);
    scheduler.request('climate', { delayMs: 30000, priority: true });
    scheduler.request('climate', { delayMs: 20000, priority: true });
    scheduler.request('climate', { delayMs: 40000, priority: true });
    assert.equal(scheduler.snapshot().domains.climate.nextDueAt, clock.time + 20000);
    await clock.advance(19999);
    assert.equal(calls.length, 3);
    await clock.advance(1);
    assert.equal(calls.at(-1).domain, 'climate');
    scheduler.request('climate', { delayMs: 120000 });
    assert.equal(scheduler.snapshot().domains.climate.nextDueAt, clock.time + 60000);
    scheduler.stop();
});

test('busy checks wait five seconds rather than spin, and availability notification accelerates that wait', async () => {
    let available = false;
    let checks = 0;
    const { scheduler, clock, calls } = fixture({ canRun: () => { checks++; return available; } });
    scheduler.start();
    await clock.advance(4999);
    assert.equal(checks, 1);
    assert.equal(calls.length, 0);
    await clock.advance(1);
    assert.equal(checks, 2);
    available = true;
    scheduler.notifyAvailable();
    await clock.advance(0);
    assert.equal(calls[0].domain, 'climate');
    scheduler.stop();
});

test('manual availability is rechecked before each next read and cannot bypass the global pause', async () => {
    let available = true;
    const { scheduler, clock, calls } = fixture({ canRun: () => available });
    scheduler.start();
    await clock.advance(0);
    available = false;
    await clock.advance(5000);
    assert.equal(calls.length, 1);
    available = true;
    scheduler.notifyAvailable();
    await clock.advance(0);
    assert.equal(calls.at(-1).domain, 'charging');
    scheduler.request('climate', { priority: true });
    scheduler.notifyAvailable();
    await clock.advance(4999);
    assert.equal(calls.length, 2);
    await clock.advance(1);
    assert.equal(calls.at(-1).domain, 'climate');
    scheduler.stop();
});

test('throwing availability checks are treated as busy without failures or escaped timer errors', async () => {
    const { scheduler, clock, calls } = fixture({ canRun: () => { throw new Error('BUSY'); } });
    scheduler.start();
    await clock.advance(15000);
    assert.equal(calls.length, 0);
    assert.equal(scheduler.snapshot().domains.climate.failures, 0);
    assert.equal(clock.timers.size, 1);
    scheduler.stop();
});

test('a manual reservation after timer dispatch defers the unstarted read without failures or loss of its fair turn', async () => {
    let available = true;
    const { scheduler, clock, calls } = fixture({ canRun: () => available });
    scheduler.start();
    const [id, timer] = clock.next();
    clock.timers.delete(id);
    timer.callback();
    available = false;
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(scheduler.snapshot().runningDomain, null);
    assert.equal(scheduler.snapshot().domains.climate.failures, 0);
    assert.equal(scheduler.snapshot().domains.climate.lastDurationMs, null);
    assert.equal(clock.next()[1].at, clock.time + 5000);
    available = true;
    scheduler.notifyAvailable();
    await clock.advance(0);
    assert.equal(calls[0].domain, 'climate');
    scheduler.stop();
});

test('domain errors back off exponentially, cannot be shortened by requests and leave other domains available', async () => {
    const { scheduler, clock, calls } = fixture();
    let climateAttempts = 0;
    scheduler._run = domain => {
        calls.push({ domain, at: clock.time });
        if (domain === 'climate') { climateAttempts++; throw new Error('READ_FAILED'); }
    };
    scheduler.start();
    const delays = [30000, 60000, 120000, 240000, 300000, 300000];
    for (let index = 0; index < delays.length; index++) {
        await clock.until(() => climateAttempts === index + 1);
        const state = scheduler.snapshot().domains.climate;
        assert.equal(state.failures, index + 1);
        assert.equal(state.nextDueAt, clock.time + delays[index]);
        for (let count = 0; count < 10; count++) scheduler.request('climate', { priority: true });
        assert.equal(scheduler.snapshot().domains.climate.nextDueAt, state.nextDueAt);
        scheduler.notifyAvailable();
    }
    assert.ok(calls.some(row => row.domain === 'charging'));
    assert.ok(calls.some(row => row.domain === 'vehicleReport'));
    assert.equal(scheduler.snapshot().domains.charging.failures, 0);
    scheduler.stop();
});

test('backoff cap never shortens a configured interval longer than five minutes', async () => {
    const intervalMs = 86400 * 1000;
    const { scheduler, clock } = fixture({ intervalMs, run: () => { throw new Error('READ_FAILED'); } });
    scheduler.start();
    await clock.advance(0);
    const expected = clock.time + intervalMs;
    assert.equal(scheduler.snapshot().domains.climate.nextDueAt, expected);
    scheduler.request('climate', { priority: true });
    assert.equal(scheduler.snapshot().domains.climate.nextDueAt, expected);
    scheduler.stop();
});

test('successful retries reset failures and any normal return value counts as success', async () => {
    const { scheduler, clock, calls } = fixture();
    let fail = true;
    scheduler._run = domain => {
        calls.push({ domain, at: clock.time });
        if (domain === 'climate' && fail) throw new Error('READ_FAILED');
        return false;
    };
    scheduler.start();
    await clock.advance(0);
    assert.equal(scheduler.snapshot().domains.climate.failures, 1);
    fail = false;
    scheduler.request('climate', { priority: true });
    await clock.until(() => calls.filter(row => row.domain === 'climate').length === 2);
    const state = scheduler.snapshot().domains.climate;
    assert.equal(state.failures, 0);
    assert.equal(state.nextDueAt, clock.time + 15000);
    assert.ok(state.estimatedDurationMs >= 1000);
    scheduler.stop();
});

test('observer exceptions, rejected promises and unresolved promises cannot delay or break reads', async () => {
    for (const onUpdate of [() => { throw new Error('OBSERVER'); }, () => Promise.reject(new Error('OBSERVER')),
        () => new Promise(() => {})]) {
        const { scheduler, clock, calls } = fixture({ onUpdate });
        scheduler.start();
        await clock.advance(10000);
        assert.deepEqual(calls.map(row => row.domain), ['climate', 'charging', 'vehicleReport']);
        scheduler.stop();
    }
});

test('stop clears pending timers and ignores already captured stale callbacks', async () => {
    const { scheduler, clock, calls } = fixture();
    scheduler.start();
    const callback = clock.next()[1].callback;
    scheduler.stop();
    callback();
    scheduler.notifyAvailable();
    assert.equal(scheduler.request('climate', { priority: true }), false);
    await clock.advance(60000);
    assert.equal(calls.length, 0);
    assert.equal(clock.timers.size, 0);
    for (const domain of DOMAINS) assert.equal(scheduler.snapshot().domains[domain].nextDueAt, 0);
});

test('stop during an active read prevents late metadata updates and every continuation', async () => {
    const pending = deferred();
    const { scheduler, clock, calls, updates } = fixture();
    scheduler._run = domain => { calls.push({ domain, at: clock.time }); return pending.promise; };
    scheduler.start();
    await clock.advance(0);
    scheduler.request('charging', { priority: true });
    scheduler.stop();
    const statesAtStop = scheduler.snapshot().domains;
    const updateCount = updates.length;
    await clock.advance(100000);
    pending.reject(new Error('LATE_FAILURE'));
    await flush();
    assert.deepEqual(scheduler.snapshot().domains, statesAtStop);
    assert.equal(scheduler.snapshot().runningDomain, null);
    assert.equal(updates.length, updateCount);
    assert.equal(calls.length, 1);
    assert.equal(clock.timers.size, 0);
});

test('stop between timer dispatch and its promise microtask prevents the read itself', async () => {
    const { scheduler, clock, calls } = fixture();
    scheduler.start();
    const [id, timer] = clock.next();
    clock.timers.delete(id);
    timer.callback();
    scheduler.stop();
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(clock.timers.size, 0);
});

test('restart cannot overlap an unfinished previous generation and stale completion cannot launch a job', async () => {
    const pending = deferred();
    const { scheduler, clock, calls } = fixture();
    scheduler._run = domain => { calls.push({ domain, at: clock.time }); return calls.length === 1 ? pending.promise : undefined; };
    scheduler.start();
    await clock.advance(0);
    scheduler.stop();
    scheduler.start();
    await clock.advance(10000);
    assert.equal(calls.length, 1);
    pending.resolve();
    await flush();
    assert.equal(calls.length, 1);
    await clock.advance(5000);
    assert.equal(calls.length, 2);
    scheduler.stop();
});
