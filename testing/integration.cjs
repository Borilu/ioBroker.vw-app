'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { tests } = require('@iobroker/testing');
const { EXIT_CODES } = require('@iobroker/adapter-core/exitCodes');

const adapterDir = path.join(__dirname, '..');

async function waitForState(harness, id, expected) {
    const deadline = Date.now() + 20000;
    do {
        const state = await harness.states.getStateAsync(`vw-app.0.${id}`);
        if (state?.val === expected && state.ack === true) return state;
        await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`The fresh adapter did not publish the expected acknowledged ${id} state.`);
}

// The official harness installs a fresh controller and this adapter's npm
// archive in a temporary test environment. No phone, PIN, downloaded Android
// runtime or saved installation configuration is supplied to these tests.
tests.integration(adapterDir, {
    defineAdditionalTests({ suite, it }) {
        suite('Fresh installation without Android setup', getHarness => {
            it('stays offline for explicit setup and stops cleanly', async function () {
                this.timeout(60000);
                const harness = getHarness();
                await harness.startAdapterAndWait();

                // Downloading Android tools requires the user's explicit
                // agreement. A new instance must stay alive without them.
                await waitForState(harness, 'info.status', 'runtime_missing');
                await waitForState(harness, 'info.connection', false);
                await waitForState(harness, 'info.runtimeReady', false);
                await waitForState(harness, 'operation.busy', false);
                await waitForState(harness, 'refresh.autoBusy', false);
                for (const command of ['start', 'stop', 'synchronize', 'lockVehicle', 'unlockVehicle']) {
                    await waitForState(harness, `commands.${command}`, false);
                }
                assert.equal(harness.isAdapterRunning(), true);
                assert.equal(harness.getLogs('error').length, 0);

                await harness.stopAdapter();
                assert.equal(harness.isAdapterRunning(), false);
                // The harness requests shutdown through the controller's
                // sigKill state. This is an explicit requested termination.
                assert.equal(harness.adapterExit, EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                await waitForState(harness, 'info.connection', false);
                await waitForState(harness, 'info.runtimeReady', false);
                await waitForState(harness, 'refresh.autoBusy', false);
            });
        });
    },
});
