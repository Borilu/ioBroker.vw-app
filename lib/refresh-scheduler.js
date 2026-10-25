'use strict';

const DOMAINS = Object.freeze(['climate', 'charging', 'vehicleReport']);
const BUSY_RETRY_MS = 5000;
const MAX_BACKOFF_MS = 300000;
const INITIAL_ESTIMATE_MS = 30000;
const SKIPPED = Symbol('stopped before execution');

function domainList(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new TypeError('Invalid scheduler domains.');
    const domains = [...value];
    const seen = new Set();
    for (const domain of domains) {
        if (typeof domain !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(domain)
            || ['constructor', 'prototype'].includes(domain) || seen.has(domain)) {
            throw new TypeError('Invalid scheduler domain.');
        }
        seen.add(domain);
    }
    return domains;
}

function initialState(autoDueAt = null) {
    return { lastDurationMs: null, estimatedDurationMs: INITIAL_ESTIMATE_MS,
        autoDueAt, requestedAt: null, cooldownUntil: 0, failures: 0, priority: false };
}

function milliseconds(value, minimum, label) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError('Invalid scheduler ' + label + '.');
    return value;
}

class RefreshScheduler {
    constructor({ run, canRun, intervalMs, domains = DOMAINS, gapMs = 5000, now = () => Date.now(),
        setTimer = (callback, delay) => setTimeout(callback, delay),
        clearTimer = timer => clearTimeout(timer), onUpdate } = {}) {
        if (typeof run !== 'function' || typeof canRun !== 'function' || typeof now !== 'function'
            || typeof setTimer !== 'function' || typeof clearTimer !== 'function'
            || onUpdate !== undefined && typeof onUpdate !== 'function') {
            throw new TypeError('Invalid scheduler callback.');
        }
        this._run = run;
        this._canRun = canRun;
        this._intervalMs = milliseconds(intervalMs, 15000, 'interval');
        this._gapMs = milliseconds(gapMs, 0, 'gap');
        this._now = now;
        this._setTimer = setTimer;
        this._clearTimer = clearTimer;
        this._onUpdate = onUpdate;
        this._domains = domainList(domains);
        this._rotation = [...this._domains];
        this._states = Object.fromEntries(this._domains.map(domain => [domain, initialState()]));
        this._started = false;
        this._generation = 0;
        this._timerRevision = 0;
        this._timer = null;
        this._timerAt = null;
        this._inflight = null;
        this._cursor = 0;
        this._priorityUsed = false;
        this._nextStartAt = 0;
        this._busyUntil = 0;
    }

    setDomains(domains) {
        const next = domainList(domains);
        if (next.length === this._domains.length && next.every((domain, index) => domain === this._domains[index])) return;
        const previousOrder = this._rotation.map((_, index) => this._rotation[(this._cursor + index) % this._rotation.length]);
        const now = this._now();
        const states = Object.fromEntries(next.map(domain => [domain,
            Object.hasOwn(this._states, domain) ? this._states[domain] : initialState(this._started ? now : null)]));
        // Discovery order can change on every read. Preserve the entire pending
        // rotation so repeated reorders cannot starve a surviving area.
        this._rotation = [...previousOrder.filter(domain => next.includes(domain)),
            ...next.filter(domain => !this._domains.includes(domain))];
        this._domains = next;
        this._states = states;
        this._cursor = 0;
        this._emit();
        this._plan();
    }

    start() {
        if (this._started) return;
        this._started = true;
        this._generation++;
        this._cursor = 0;
        this._priorityUsed = false;
        this._nextStartAt = this._now();
        this._busyUntil = 0;
        for (const state of Object.values(this._states)) {
            state.autoDueAt = this._nextStartAt;
            state.requestedAt = null;
            state.cooldownUntil = 0;
            state.failures = 0;
            state.priority = false;
        }
        this._emit();
        this._plan();
    }

    stop() {
        this._started = false;
        this._generation++;
        this._cancelTimer();
        for (const state of Object.values(this._states)) {
            state.autoDueAt = null;
            state.requestedAt = null;
            state.priority = false;
        }
        this._emit();
    }

    notifyAvailable() {
        if (!this._started) return;
        this._busyUntil = 0;
        this._plan();
    }

    request(domain, { delayMs = 0, priority = false } = {}) {
        if (!this._domains.includes(domain)) throw new TypeError('Invalid scheduler domain.');
        milliseconds(delayMs, 0, 'request delay');
        if (typeof priority !== 'boolean') throw new TypeError('Invalid scheduler request priority.');
        if (!this._started) return false;
        const state = this._states[domain];
        const dueAt = this._now() + delayMs;
        state.requestedAt = state.requestedAt === null ? dueAt : Math.min(state.requestedAt, dueAt);
        state.priority ||= priority;
        this._emit();
        this._plan();
        return true;
    }

    snapshot() {
        const domains = {};
        let estimatedCycleMs = 0;
        for (const domain of this._domains) {
            const state = this._states[domain];
            const dueAt = this._dueAt(state);
            domains[domain] = {
                lastDurationMs: state.lastDurationMs,
                estimatedDurationMs: state.estimatedDurationMs,
                nextDueAt: Number.isFinite(dueAt) ? dueAt : 0,
                failures: state.failures,
            };
            estimatedCycleMs += state.estimatedDurationMs + this._pause(state.estimatedDurationMs);
        }
        return { runningDomain: this._inflight?.domain ?? null, estimatedCycleMs, domains };
    }

    _pause(duration) { return Math.max(this._gapMs, Math.ceil(duration * 0.25)); }

    _dueAt(state) {
        if (!this._started) return Infinity;
        return Math.max(state.cooldownUntil,
            Math.min(state.autoDueAt ?? Infinity, state.requestedAt ?? Infinity));
    }

    _emit() {
        if (!this._onUpdate) return;
        try {
            // Never await an observer: it cannot delay a read or break its pump.
            Promise.resolve(this._onUpdate(this.snapshot())).catch(() => {});
        } catch (_) { /* Observer failures do not affect scheduling. */ }
    }

    _cancelTimer() {
        this._timerRevision++;
        if (this._timer !== null) {
            try { this._clearTimer(this._timer); } catch (_) { /* The generation guard still rejects the callback. */ }
        }
        this._timer = null;
        this._timerAt = null;
    }

    _scheduleAt(at) {
        if (!this._started || this._timer !== null && this._timerAt === at) return;
        this._cancelTimer();
        const generation = this._generation;
        const revision = this._timerRevision;
        this._timerAt = at;
        try {
            this._timer = this._setTimer(() => {
                if (!this._started || generation !== this._generation || revision !== this._timerRevision) return;
                this._timer = null;
                this._timerAt = null;
                try { this._pump(); } catch (_) {
                    // No rejected timer promise or immediate error loop escapes.
                    if (this._started) this._scheduleAt(this._now() + BUSY_RETRY_MS);
                }
            }, Math.min(2147483647, Math.max(0, Math.ceil(at - this._now()))));
        } catch (_) {
            this._timer = null;
            this._timerAt = null;
        }
    }

    _plan() {
        if (!this._started) return;
        if (this._inflight) {
            // A stopped generation can still be unwinding; restarting must not
            // overlap it. Its eventual completion never restarts this pump.
            if (this._inflight.generation !== this._generation) this._scheduleAt(this._now() + BUSY_RETRY_MS);
            else this._cancelTimer();
            return;
        }
        const earliest = Math.min(...this._domains.map(domain => this._dueAt(this._states[domain])));
        if (!Number.isFinite(earliest)) { this._cancelTimer(); return; }
        this._scheduleAt(Math.max(this._now(), earliest, this._nextStartAt, this._busyUntil));
    }

    _select(now) {
        const order = this._rotation.map((_, index) => (this._cursor + index) % this._rotation.length);
        const due = order.filter(index => this._dueAt(this._states[this._rotation[index]]) <= now);
        if (!due.length) return null;
        const priority = !this._priorityUsed && due.find(index => this._states[this._rotation[index]].priority);
        if (priority !== false && priority !== undefined) {
            this._priorityUsed = true;
            return this._rotation[priority];
        }
        const selected = due[0];
        this._cursor = (selected + 1) % this._rotation.length;
        this._priorityUsed = false;
        return this._rotation[selected];
    }

    _pump() {
        if (!this._started) return;
        if (this._inflight) { this._plan(); return; }
        const now = this._now();
        if (now < this._nextStartAt || now < this._busyUntil) { this._plan(); return; }
        if (!this._domains.some(domain => this._dueAt(this._states[domain]) <= now)) { this._plan(); return; }
        let available = false;
        try { available = this._canRun() === true; } catch (_) { /* Busy until notified or retried. */ }
        if (!available) {
            this._busyUntil = now + BUSY_RETRY_MS;
            this._plan();
            return;
        }
        this._busyUntil = 0;
        const previousTurn = this._rotation[this._cursor];
        const previousPriorityUsed = this._priorityUsed;
        const domain = this._select(now);
        if (domain === null) { this._plan(); return; }
        const state = this._states[domain];
        const operation = {
            domain, state, generation: this._generation, startedAt: now,
            previousTurn, previousPriorityUsed,
            autoDueAt: state.autoDueAt, requestedAt: state.requestedAt, priority: state.priority,
        };
        state.autoDueAt = null;
        state.requestedAt = null;
        state.priority = false;
        this._inflight = operation;
        this._emit();
        Promise.resolve().then(() => {
            if (!this._started || this._generation !== operation.generation) return SKIPPED;
            if (this._states[domain] !== operation.state) return SKIPPED;
            // A manual command can reserve the adapter after timer dispatch but
            // before this microtask. Give it priority without counting a read failure.
            let stillAvailable = false;
            try { stillAvailable = this._canRun() === true; } catch (_) { /* Treat as busy. */ }
            if (this._states[domain] !== operation.state) return SKIPPED;
            if (!stillAvailable) { this._deferBusy(operation); return SKIPPED; }
            return this._run(domain);
        }).then(result => this._complete(operation, false, result === SKIPPED),
            () => this._complete(operation, true, false)).catch(() => {});
    }

    _deferBusy(operation) {
        if (this._inflight !== operation || !this._started || operation.generation !== this._generation) return;
        this._inflight = null;
        const state = this._states[operation.domain];
        if (state !== operation.state) { this._emit(); this._plan(); return; }
        state.autoDueAt = operation.autoDueAt;
        if (operation.requestedAt !== null) state.requestedAt = Math.min(state.requestedAt ?? Infinity, operation.requestedAt);
        state.priority ||= operation.priority;
        const previousCursor = this._rotation.indexOf(operation.previousTurn);
        if (previousCursor !== -1) this._cursor = previousCursor;
        this._priorityUsed = operation.previousPriorityUsed;
        this._busyUntil = this._now() + BUSY_RETRY_MS;
        this._emit();
        this._plan();
    }

    _complete(operation, failed, skipped) {
        if (this._inflight !== operation) return;
        this._inflight = null;
        if (!this._started || operation.generation !== this._generation) return;
        if (skipped) { this._emit(); this._plan(); return; }
        const completedAt = this._now();
        const duration = Math.max(0, Math.ceil(completedAt - operation.startedAt));
        const state = this._states[operation.domain];
        this._nextStartAt = completedAt + this._pause(duration);
        // A removed area's read still owns the phone until it finishes. Its
        // result must never update a replacement area with the same identifier.
        if (state !== operation.state) { this._emit(); this._plan(); return; }
        state.lastDurationMs = duration;
        state.estimatedDurationMs = Math.max(1000, Math.round((state.estimatedDurationMs + duration) / 2));
        state.failures = failed ? Math.min(state.failures + 1, 31) : 0;
        if (failed) {
            const backoff = Math.max(this._intervalMs,
                Math.min(MAX_BACKOFF_MS, Math.max(this._intervalMs, 15000) * 2 ** state.failures));
            state.cooldownUntil = completedAt + backoff;
            state.autoDueAt = state.cooldownUntil;
        } else {
            state.cooldownUntil = 0;
            state.autoDueAt = completedAt + this._intervalMs;
        }
        this._emit();
        this._plan();
    }
}

module.exports = { RefreshScheduler, DOMAINS };
