# ioBroker.vw-app

Control the **official Volkswagen Android app over Wi-Fi** from ioBroker.

**Experimental community adapter.** The source has been tested with synthetic Android views. The initial real-device reference is a Galaxy A31 with Android 12, Volkswagen app 4.8.1 and an ID.7 GTX Tourer. This does not establish compatibility with every Volkswagen model, region or future app version. Only the selected vehicle in one phone app is controlled by an instance.

Der Adapter bedient die offizielle Volkswagen-App auf einem Android-Handy. Kopplung, Einrichtung und Klimabefehle werden direkt im ioBroker-Adapter verwaltet. Die Volkswagen-Anmeldung bleibt auf dem Handy.

## What runs where

- One ioBroker adapter handles configuration, pairing, device verification and climate controls.
- No Python bridge, separate HTTP server, systemd service or JavaScript-adapter script is needed.
- The adapter manages a private native ADB child process. It starts and stops that process with the adapter instance. ADB remains a technical runtime requirement, not an additional service users must configure.
- No VW cloud password or cloud token is entered in ioBroker.
- Android SDK binaries are not shipped in this GitHub repository or npm package. The setup interface offers an explicit download from Google after acceptance of the linked terms.

## Requirements

| Component | Initial supported configuration |
|---|---|
| ioBroker host | Linux x64 (Intel/AMD), Node.js 20 or later, js-controller 6 or later |
| Admin | ioBroker Admin 7 or later |
| Phone | Android 11 or later with **Wireless debugging** available |
| App | Official Volkswagen app, signed in, vehicle selected, manual remote climate control working |
| Network | Phone reachable from the ioBroker host over the home network |

The included-runtime download supports **Linux x64 only**. Linux ARM64 with an externally provided compatible `adb` is an advanced, unverified configuration. Windows and macOS hosts are not supported by this first release. Docker users need a persistent ioBroker data volume and network access to the phone; no USB passthrough is required.

The phone must stay unlocked while app automation runs. The explicit keep-awake setup action can keep its display on while charging. It does not unlock the phone. After a phone reboot, manual unlocking and checking wireless debugging may be necessary.

## Install from GitHub

This adapter is initially distributed as a GitHub beta, not as an approved ioBroker stable-repository adapter.

1. In ioBroker Admin, enable expert mode if necessary.
2. Choose the custom adapter installation from a URL.
3. Use `https://github.com/Borilu/ioBroker.vw-app`.
4. Add a `vw-app` instance and open its configuration.

Alternatively, download the npm archive from a GitHub release and install it through your ioBroker installation tools. Installation via GitHub does not require publishing to npm first. Follow your ioBroker version's custom-install interface; the exact label can vary.

## Setup in ioBroker Admin

Detailed German instructions: [Einrichtung im Admin](docs/ADMIN-SETUP.md).

1. Start the adapter instance. Install the Android tools with the setup button after reviewing the linked terms. An alternative existing absolute `adb` path can be selected.
2. On the phone, enable developer options and **Wireless debugging**. Open **Pair device with pairing code**.
3. In the adapter setup, enter the phone IP, pairing port and current six-digit code. Pair while the phone dialog remains open.
4. Close only the pairing-code dialog. Enter the **connection port** shown on the main Wireless debugging page. It differs from the pairing port. Save the configuration.
5. Run **Check connection and app version**. The phone identity is stored privately by the adapter.
6. Open the vehicle overview in the Volkswagen app, then run **Adopt app and vehicle**. Review the detected app version and complete fixed vehicle label; save.
7. Read status and compare it with the app. Enable **Allow climate start and stop** when ready.

Pairing code and pairing port are temporary setup inputs and are not saved in the native instance configuration. The adapter never logs the code or puts it in a state. Clear the input or close the configuration page after pairing.

An Android 12 connection port may change after restarting the phone or toggling Wireless debugging. Update that port in the adapter settings and save. Automatic discovery of a new port is not promised, particularly in VM/NAT networks. A saved device identity prevents silently switching to another paired phone at a reused address.

## States

All IDs are relative to `vw-app.0` (replace `0` with the instance number).

| State | Meaning |
|---|---|
| `commands.start` | Write `true`, `ack=false` to start climate control |
| `commands.stop` | Write `true`, `ack=false` to stop the shown climate operation |
| `commands.refresh` | Write `true`, `ack=false` to read the app state |
| `climate.appState` | `on`, `off` or `unknown` as observed in the VW app |
| `climate.confirmationSource` | `none`, `app_controls` (climate controls) or `app_overview` (the exact active-climate description in the vehicle overview) |
| `climate.active` | Boolean observation; invalid quality on a failed read |
| `climate.vehicleConfirmed` | Always `false`; no independent vehicle telemetry confirmation |
| `operation.busy` | One operation is running |
| `operation.lastResult` | `running`, `succeeded` or `failed` |
| `operation.lastError` | Fixed diagnostic guidance |
| `operation.lastErrorCode` | Machine-readable error code |
| `operation.lastUpdated` | Last successful app-state observation |
| `info.connection` | Last operation could reach and verify the configured phone/app |
| `info.runtimeReady` | Private ADB runtime is running |
| `info.appVersion` | Observed Volkswagen app version |
| `info.status` | Setup/runtime/operation status |

Buttons reset automatically. Temperature stays at the value already selected in the Volkswagen app. Stop ends the climate operation exposed by the app's single Stop button, which may include window heating. Start requires a recognized air-conditioning mode.

Status is read on request by default. Optional automatic polling is limited to one read every five minutes or slower. Status can become stale between reads; check `operation.lastUpdated`.

The confirmation source describes evidence from the app. Both `app_controls` and `app_overview` remain app observations; `climate.vehicleConfirmed` stays `false`. The inspected Android UI hierarchy did not expose the visible 30-minute countdown, so the adapter does not estimate or publish remaining minutes.

## Command behavior

- App controls are identified from the current Android UI hierarchy, not saved screen coordinates.
- A device identity, calibrated vehicle label and approved app version are checked before switching.
- An already satisfied command does not send another switching request.
- Only one operation runs at a time; additional commands are rejected rather than queued.
- A private command journal enforces at least 60 seconds between switching attempts, including after adapter restarts.
- Unknown dialogs, missing controls, unexpected modes or a changed app version stop the operation.
- After a switching attempt, an unclear outcome is reported as `outcome_unknown`; the adapter does not repeat the command automatically.

Volkswagen's app may acknowledge a start with a delay. New instances allow up to **120 seconds** after a switching attempt for the app confirmation (`outcomeTimeoutSeconds`, configurable from 30 to 150 seconds), within a **180-second** overall job deadline (`commandTimeoutSeconds`, configurable from 30 to 180 seconds). Connection and navigation also consume that overall budget; a shorter overall limit can therefore end the wait earlier. Existing instances retain their saved overall limit. If it is still 125 seconds, change it to 180 seconds in expert settings to use the longer default budget.

An exact active-climate description in the selected vehicle's overview can provide additional app confirmation. A successful read of that description is reported as `app_overview`; observations from the climate controls are reported as `app_controls`. An uncertain result clears the source to `none` rather than claiming vehicle telemetry.

On **24 October 2026**, the user confirmed a real climate start on an ID.7. The app acknowledged it after an earlier adapter request had already reported `outcome_unknown`. This update allows more time for that delayed response and recognizes the observed overview description as another app signal. The on-screen countdown is not available through the inspected UI hierarchy and is not used as a fabricated confirmation source.

These checks cannot guarantee compatibility with a future app UI. Check the official app after any uncertain result. Recalibrate after app updates.

## Migration from the Python prototype

Stop and disable the previous Python bridge service and its JavaScript-adapter script before this adapter operates the phone. Do not run two app controllers against the same phone.

The adapter supports an optional `legacyStatePrefix` under `0_userdata.0` for installations migrating existing buttons and feedback states. With this option, the adapter itself handles those existing objects; a separate forwarding script is not required. New installations should use the adapter's own namespace.

ADB keys, pairing records and enrollment are private instance data. They are never part of a release. A migration can copy the existing phone pairing into the new private instance home under administrator control; other users perform normal setup pairing through the adapter.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run check
npm pack
```

Tests simulate phone views, ADB processes and adapter lifecycle behavior. Native process startup, real Wi-Fi connectivity and real app behavior additionally need a Linux/device smoke test. Report the phone model, Android version, app version and fixed error code in an issue; do not upload pairing codes, keys, enrollment files, full private UI dumps or VINs.

## License and project status

Adapter source: [MIT](LICENSE). Third-party components retain their licenses; see [NOTICE](NOTICE).

Independent community project, not provided or endorsed by Volkswagen, Google or ioBroker. Volkswagen and Android are trademarks of their respective owners.

### Changelog

#### 0.1.1

- Wait up to 120 seconds for a delayed app response within a 180-second overall job budget.
- Read the active climate description on the vehicle overview and expose the app confirmation source.
- Keep waiting when the overview does not yet confirm the active detail screen; never repeat a start automatically.

#### 0.1.0

- Initial native ioBroker adapter with private managed ADB runtime, WLAN setup, calibrated start/stop/status and persistent command cooldown.
