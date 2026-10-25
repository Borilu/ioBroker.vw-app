'use strict';

const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Keep the official package/schema checks separate from the node:test suite.
tests.packageFiles(path.join(__dirname, '..'));
