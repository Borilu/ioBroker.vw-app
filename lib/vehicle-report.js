'use strict';

const { BridgeError } = require('./errors');

const REPORT_CATEGORIES = Object.freeze({
    engine: 'Antrieb', assistance: 'Assistenten', brakes: 'Bremsen',
    lighting: 'Fahrlicht', comfort: 'Komfort', tires: 'Reifen', other: 'Sonstige',
});
const CATEGORY_KEYS = Object.keys(REPORT_CATEGORIES);
const PAGE_KEYS = ['atTop', 'atBottom', 'odometerText', 'nextServiceText', 'summary',
    'synchronizationText', 'categories', 'notice', 'additionalTexts'];
const MODEL_KEYS = ['odometerText', 'odometerKm', 'nextServiceText', 'nextServiceDays',
    'nextServiceKm', 'summary', 'hasMessages', 'messageCount', 'synchronizationText',
    'categories', 'notice', 'additionalTexts'];
const MAX_TEXT_LENGTH = 2000;
const MAX_CATEGORY_TEXTS = 32;
const MAX_ADDITIONAL_TEXTS = 64;
const OWN_ERRORS = new WeakSet();
const MESSAGES = Object.freeze({
    invalid_report: 'The vehicle report has an invalid or excessive data format.',
    report_incomplete: 'The vehicle report was not read completely from top to bottom.',
    report_changed: 'The vehicle report changed while it was being read.',
});

function fail(code = 'invalid_report') {
    const error = new BridgeError(code, MESSAGES[code]);
    OWN_ERRORS.add(error);
    throw error;
}

function guarded(operation) {
    try { return operation(); }
    catch (error) {
        if (error && OWN_ERRORS.has(error)) throw error;
        return fail();
    }
}

// Read data descriptors only: getters, hidden properties and non-plain objects
// are outside the public data contract and cannot inject text into errors.
function record(value, keys, required = keys) {
    if (value === null || typeof value !== 'object') fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string' || !keys.includes(key)) fail();
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        result[key] = descriptor.value;
    }
    if (required.some(key => !Object.hasOwn(result, key))) fail();
    return result;
}

function boundedArray(value, maximum, minimum = 0) {
    if (!Array.isArray(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length && descriptors.length.value;
    if (!Number.isInteger(length) || length < minimum || length > maximum) fail();
    if (Reflect.ownKeys(descriptors).length !== length + 1) fail();
    const result = [];
    for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        result.push(descriptor.value);
    }
    return result;
}

function text(value, nullable = false) {
    if (nullable && value === null) return null;
    if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH || value.trim().length === 0
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail();
    return value;
}

function texts(value, maximum) {
    return boundedArray(value, maximum).map(item => text(item));
}

function categoryValues(value, complete = false, withStatus = false) {
    const input = record(value, CATEGORY_KEYS, complete ? CATEGORY_KEYS : []);
    const result = {};
    for (const key of CATEGORY_KEYS) {
        if (!Object.hasOwn(input, key)) continue;
        const category = record(input[key], withStatus ? ['label', 'status', 'texts'] : ['label', 'texts']);
        const normalized = { label: text(category.label), texts: texts(category.texts, MAX_CATEGORY_TEXTS) };
        if (withStatus) {
            if (!['no_messages', 'unknown'].includes(category.status)) fail();
            normalized.status = category.status;
        }
        result[key] = normalized;
    }
    return result;
}

function page(value) {
    const input = record(value, PAGE_KEYS);
    if (typeof input.atTop !== 'boolean' || typeof input.atBottom !== 'boolean') fail();
    return {
        atTop: input.atTop, atBottom: input.atBottom,
        odometerText: text(input.odometerText, true), nextServiceText: text(input.nextServiceText, true),
        summary: text(input.summary, true), synchronizationText: text(input.synchronizationText, true),
        categories: categoryValues(input.categories), notice: text(input.notice, true),
        additionalTexts: texts(input.additionalTexts, MAX_ADDITIONAL_TEXTS),
    };
}

function relativeMinutes(value) {
    const match = /^Synchronisiert: Vor (.+)$/u.exec(value);
    if (!match) return null;
    const units = { Tag: [0, 1440], Tage: [0, 1440], d: [0, 1440], h: [1, 60], min: [2, 1] };
    const tokens = match[1].split(' ');
    if (tokens.length < 2 || tokens.length > 6 || tokens.length % 2) return null;
    let lastUnit = -1;
    let total = 0;
    for (let index = 0; index < tokens.length; index += 2) {
        if (!/^(?:0|[1-9][0-9]*)$/u.test(tokens[index])) return null;
        const count = Number(tokens[index]);
        const unit = Object.hasOwn(units, tokens[index + 1]) ? units[tokens[index + 1]] : null;
        if (!Number.isSafeInteger(count) || !unit || unit[0] <= lastUnit) return null;
        if (lastUnit >= 0 && ((unit[0] === 1 && count >= 24) || (unit[0] === 2 && count >= 60))) return null;
        if ((tokens[index + 1] === 'Tag' && count !== 1)
            || (tokens[index + 1] === 'Tage' && count === 1)) return null;
        total += count * unit[1];
        if (!Number.isSafeInteger(total)) return null;
        lastUnit = unit[0];
    }
    return total;
}

// Missing fields on partial pages are neutral. An unchanged unknown app text is
// retained; changed relative ages may advance by at most this job's five minutes.
function compatibleSynchronizationText(previous, current) {
    try {
        text(previous, true);
        text(current, true);
        if (previous === null || current === null || previous === current) return true;
        const before = relativeMinutes(previous);
        const after = relativeMinutes(current);
        return before !== null && after !== null && after >= before && after - before <= 5;
    } catch { return false; }
}

const GERMAN_INTEGER = '(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:\\.[0-9]{3})+)';
function integer(raw) {
    const result = Number(raw.replaceAll('.', '').replace('\u2212', '-'));
    return Number.isSafeInteger(result) ? (result === 0 ? 0 : result) : null;
}

function odometerKm(raw) {
    const match = new RegExp(`^\\s*(?:Gesamtstrecke:\\s*|Kilometerstand:\\s*)?(${GERMAN_INTEGER})\\s+km\\s*$`, 'u').exec(raw);
    return match ? integer(match[1]) : null;
}

function serviceNumbers(raw) {
    const normalized = raw.trim().replace(/^(?:Nächster Service|Service):\s*/u, '').replace(/^[Ii]n\s+/u, '');
    const quantity = `([+\u2212-]?${GERMAN_INTEGER})\\s+(Tage|Tagen|Tag|km)`;
    const match = new RegExp(`^${quantity}(?:\\s*(?:/|,|oder|und)\\s*${quantity})?$`, 'u').exec(normalized);
    if (!match) return { nextServiceDays: null, nextServiceKm: null };
    const values = { nextServiceDays: null, nextServiceKm: null };
    for (const offset of [1, 3]) {
        if (match[offset] === undefined) continue;
        const key = match[offset + 1] === 'km' ? 'nextServiceKm' : 'nextServiceDays';
        if (values[key] !== null) return { nextServiceDays: null, nextServiceKm: null };
        const value = integer(match[offset]);
        if (value === null) return { nextServiceDays: null, nextServiceKm: null };
        values[key] = value;
    }
    return values;
}

function messageNumbers(raw) {
    if (raw === 'Keine Meldungen') return { hasMessages: false, messageCount: 0 };
    const match = /^(0|[1-9][0-9]*) (Meldung|Meldungen)$/u.exec(raw);
    if (!match) return { hasMessages: null, messageCount: null };
    const count = Number(match[1]);
    if (!Number.isSafeInteger(count) || (count === 1 ? match[2] !== 'Meldung' : match[2] !== 'Meldungen')) {
        return { hasMessages: null, messageCount: null };
    }
    return { hasMessages: count > 0, messageCount: count };
}

function modelFromRaw(raw) {
    const counts = messageNumbers(raw.summary);
    const categories = {};
    for (const key of CATEGORY_KEYS) {
        const category = raw.categories[key];
        categories[key] = {
            label: REPORT_CATEGORIES[key],
            status: counts.hasMessages === false && category.texts.length === 0 ? 'no_messages' : 'unknown',
            texts: [...category.texts],
        };
    }
    return {
        odometerText: raw.odometerText, odometerKm: odometerKm(raw.odometerText),
        nextServiceText: raw.nextServiceText, ...serviceNumbers(raw.nextServiceText),
        summary: raw.summary, ...counts, synchronizationText: raw.synchronizationText,
        categories, notice: raw.notice, additionalTexts: [...raw.additionalTexts],
    };
}

function mergeReportPages(pages) {
    return guarded(() => {
        const input = boundedArray(pages, 8, 1).map(page);
        if (!input[0].atTop || !input[input.length - 1].atBottom) fail('report_incomplete');
        const merged = {
            odometerText: null, nextServiceText: null, summary: null,
            synchronizationText: null, categories: {}, notice: null, additionalTexts: [],
        };
        const additional = new Set();
        let firstSynchronizationText = null;
        for (const item of input) {
            for (const key of ['odometerText', 'nextServiceText', 'summary', 'notice']) {
                if (item[key] === null) continue;
                if (merged[key] !== null && merged[key] !== item[key]) fail('report_changed');
                merged[key] = item[key];
            }
            if (item.synchronizationText !== null) {
                if (!compatibleSynchronizationText(merged.synchronizationText, item.synchronizationText)
                    || !compatibleSynchronizationText(firstSynchronizationText, item.synchronizationText)) fail('report_changed');
                if (firstSynchronizationText === null) firstSynchronizationText = item.synchronizationText;
                merged.synchronizationText = item.synchronizationText;
            }
            for (const key of CATEGORY_KEYS) {
                const value = item.categories[key];
                if (!value) continue;
                const old = merged.categories[key];
                if (old && (old.label !== value.label || old.texts.length !== value.texts.length
                    || old.texts.some((entry, index) => entry !== value.texts[index]))) fail('report_changed');
                if (value.label !== REPORT_CATEGORIES[key]) fail();
                merged.categories[key] = value;
            }
            for (const value of item.additionalTexts) {
                if (additional.has(value)) continue;
                additional.add(value);
                if (additional.size > MAX_ADDITIONAL_TEXTS) fail();
                merged.additionalTexts.push(value);
            }
        }
        if (['odometerText', 'nextServiceText', 'summary', 'synchronizationText', 'notice'].some(key => merged[key] === null)
            || CATEGORY_KEYS.some(key => !Object.hasOwn(merged.categories, key))) fail('report_incomplete');
        return modelFromRaw(merged);
    });
}

// The result is a fresh, ordinary serializable object. Derived values are
// checked against their raw app texts, rather than accepted from stored input.
function validateVehicleReport(value) {
    return guarded(() => {
        const input = record(value, MODEL_KEYS);
        const raw = {
            odometerText: text(input.odometerText), nextServiceText: text(input.nextServiceText),
            summary: text(input.summary), synchronizationText: text(input.synchronizationText),
            categories: categoryValues(input.categories, true, true), notice: text(input.notice),
            additionalTexts: texts(input.additionalTexts, MAX_ADDITIONAL_TEXTS),
        };
        if (new Set(raw.additionalTexts).size !== raw.additionalTexts.length) fail();
        for (const key of CATEGORY_KEYS) if (raw.categories[key].label !== REPORT_CATEGORIES[key]) fail();
        for (const key of ['odometerKm', 'nextServiceDays', 'nextServiceKm', 'messageCount']) {
            const number = input[key];
            if (number !== null && (!Number.isSafeInteger(number) || Object.is(number, -0))) fail();
        }
        if (input.odometerKm !== null && input.odometerKm < 0) fail();
        if (input.messageCount !== null && input.messageCount < 0) fail();
        if (input.hasMessages !== null && typeof input.hasMessages !== 'boolean') fail();
        const normalized = modelFromRaw(raw);
        for (const key of ['odometerKm', 'nextServiceDays', 'nextServiceKm', 'hasMessages', 'messageCount']) {
            if (input[key] !== normalized[key]) fail();
        }
        for (const key of CATEGORY_KEYS) if (raw.categories[key].status !== normalized.categories[key].status) fail();
        return normalized;
    });
}

module.exports = {
    REPORT_CATEGORIES, mergeReportPages, validateVehicleReport, compatibleSynchronizationText,
};
