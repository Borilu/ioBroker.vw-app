'use strict';
const utils = require('@iobroker/adapter-core');
const { createAdapterClass } = require('./lib/adapter');
const VwApp = createAdapterClass(utils);
if (module.parent) module.exports = options => new VwApp(options);
else new VwApp();
