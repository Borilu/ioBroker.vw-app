'use strict';
// Conservative single observation. This is evidence, not an atomic OS transaction.
function isStoppedObservation({state,processCount,listeners,beforeListeners,stopRequestedAt,portFree}) {
    if (!state || state.val !== false || state.ack !== true || (state.q && state.q !== 0)
        || !Number.isFinite(Number(state.ts)) || Number(state.ts) < stopRequestedAt
        || processCount !== 0 || portFree !== true
        || !Array.isArray(listeners) || !Array.isArray(beforeListeners) || !beforeListeners.length) return false;
    const before=new Set(beforeListeners);
    return listeners.every(hash=>before.has(hash));
}
module.exports={isStoppedObservation};
