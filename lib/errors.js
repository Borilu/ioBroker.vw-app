'use strict';

class BridgeError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BridgeError';
        this.code = code;
    }
    toJSON() { return { code: this.code, message: this.message }; }
}

function publicError(error) {
    return error instanceof BridgeError ? error.toJSON() : {
        code: 'internal_error', message: 'An internal error occurred. Check the configuration and phone.',
    };
}

module.exports = { BridgeError, publicError };
