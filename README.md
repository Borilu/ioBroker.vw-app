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
| `commands.setTemperature` | Write `true`, `ack=false` to apply the saved target temperature without starting climate control |
| `commands.clearTemperature` | Write `true`, `ack=false` to select “keep the app temperature”, without operating the phone |
| `commands.applySettings` | Apply the four saved mode, unlock, automatic window-heating and zone preferences; does not apply temperature or press Start/Stop |
| `commands.clearSettings` | Clear only those four preferences to `null`, without operating the phone |
| `climate.appState` | `on`, `off` or `unknown` as observed in the VW app |
| `climate.targetTemperature` | Writable saved target in °C; `null` keeps the existing app temperature. Acknowledgment means saved, not applied |
| `climate.targetTemperatureError` | Fixed feedback about an invalid or unsaved target selection; separate from the current phone job |
| `climate.temperature` | Read-only temperature observed in the app, or `null` with invalid quality if unreadable |
| `climate.targetMode` | Saved preference: `null`, `climate` or `windowHeating` |
| `climate.targetClimateOnUnlock` | Saved preference: `null`, `true` or `false` for climate control on unlocking |
| `climate.targetAutoWindowHeating` | Saved preference: `null`, `true` or `false` for automatic window heating |
| `climate.targetZones` | Saved preference: `null`, `frontLeft`, `frontRight` or `both` for additional temperature-related functions in the front zones |
| `climate.mode` | Mode last read from the app |
| `climate.climateOnUnlock` | Climate-on-unlock setting last read from the app |
| `climate.autoWindowHeating` | Automatic window-heating setting last read from the app |
| `climate.zones` | Front-zone selection last read from the app |
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

Buttons reset automatically. Without a selected target temperature, the app's existing temperature is preserved. Stop ends the climate operation exposed by the app's single Stop button, which may include window heating. With `climate.targetMode=null`, Start keeps the existing requirement for a recognized air-conditioning mode. An explicit `windowHeating` preference selects the separate window-heating operation; a staged temperature is ignored for that mode.

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

Volkswagen's app may acknowledge a start with a delay. New instances allow up to **120 seconds** after a switching attempt for the app confirmation (`outcomeTimeoutSeconds`, configurable from 30 to 150 seconds), within a **300-second** overall job deadline (`commandTimeoutSeconds`, configurable from 30 to 360 seconds). Connection, navigation and temperature selection also consume that overall budget; a shorter overall limit can therefore end the wait earlier. Existing instances retain their saved overall limit. If it is still 125 or 180 seconds, change it to 300 seconds in expert settings to allow the full budget for temperature selection and starting.

An exact active-climate description in the selected vehicle's overview can provide additional app confirmation. A successful read of that description is reported as `app_overview`; observations from the climate controls are reported as `app_controls`. An uncertain result clears the source to `none` rather than claiming vehicle telemetry.

On **24 October 2026**, the user confirmed a real climate start on an ID.7. The app acknowledged it after an earlier adapter request had already reported `outcome_unknown`. This update allows more time for that delayed response and recognizes the observed overview description as another app signal. The on-screen countdown is not available through the inspected UI hierarchy and is not used as a fabricated confirmation source.

These checks cannot guarantee compatibility with a future app UI. Check the official app after any uncertain result. Recalibrate after app updates.

## Select the target temperature

Write a supported numeric °C value, for example `22.5`, to `climate.targetTemperature` with `ack=false`. The verified numeric range is **16.0 to 29.5 °C in 0.5 °C steps**; the adjacent `LO` and `HI` modes are not supported. Numeric strings such as `"22.5"` are rejected. A successful `ack=true` means the selection was saved privately for future use; this write does not touch the phone. Invalid input restores the last accepted selection and reports `invalid_temperature` in `climate.targetTemperatureError`. A valid selection clears that selection error without changing a concurrent phone job's error or result.

After an invalid or unsaved temperature selection, a new temperature-applying job is blocked with `temperature_selection_failed`, even though the previous value is displayed again. Explicitly select a valid value again or press `commands.clearTemperature` to resolve it. `commands.applySettings` does not apply temperature. Status and Stop remain available. A failed selection made after a job was accepted does not alter that job's saved target.

Use `commands.setTemperature` to apply the saved selection in air-conditioning mode without pressing Start or Stop, or use `commands.start` to set it before an air-conditioning start. Temperature selection is supported only for `climate`; a `windowHeating` start ignores the saved temperature and leaves that preference available for a later air-conditioning job. Write permission must be enabled for either operation to change the app temperature. `climate.temperature` is updated only from an actual app reading and remains separate from the saved target. An app reading still does not set `climate.vehicleConfirmed` to `true`.

The saved selection survives adapter restarts. Press `commands.clearTemperature` to keep the existing app temperature on later starts. Alternatively, write the actual null value (`null`, not the text `"null"`) to the target. This choice only changes the saved preference. Applying a null selection with `commands.setTemperature` is rejected before any phone access. A new selection made during a running job is saved for the next job; it does not alter the target already chosen for the active job.

The app picker is operated through freshly read individual 0.5 °C steps, so a large temperature change can take additional time. Check the resulting `climate.temperature`; if feedback is uncertain, inspect the Volkswagen app before issuing another command.

## Select mode and additional climate settings

Write the four `climate.target…` preferences listed above with `ack=false`. A successful acknowledgment means the value was **saved**, not applied to the phone. All four preferences survive adapter restarts. `null` keeps the corresponding app setting; Boolean `false` explicitly requests that the option be switched off. A later preference change applies to the next accepted job and does not change a running job's snapshot.

Press `commands.applySettings` with `true`, `ack=false` to apply only these four preferences. Write permission must be enabled before changing app settings. This command does not apply a staged temperature and does not press Start or Stop. Press `commands.clearSettings` to set only these four preferences back to `null`, without phone access; the separate temperature preference is retained.

Start uses the saved preferences before starting the selected operation. Mode changes require an explicit `climate.targetMode` and an inactive climate operation. The adapter rejects a requested mode change while climate control is active; it does not stop and restart the operation to force the change. With `targetMode=null`, Start does not select another mode and retains its previous air-conditioning-only behavior.

The two Boolean options and the zone selection are also available in the app's window-heating settings. The app describes zones as: “Zonen im Innenraum Ihres Fahrzeugs, in denen zusätzliche temperaturbeeinflussende Funktionen während der Klimatisierung aktiviert werden sollen.” `frontLeft`, `frontRight` and `both` therefore select the front zones for these additional functions. They do not represent separate temperature targets or independent air-distribution controls.

Version 0.3.0 is currently being prepared. The new settings have been inspected in the app; final tests and validation results are pending. No physical climate start with this new version is claimed.

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

#### 0.3.0 (draft)

- Stage and persist mode, climate-on-unlock, automatic window heating and front-zone preferences separately from observed app settings.
- Apply or clear those four preferences without pressing Start/Stop or applying temperature.
- Use the accepted preferences for Start, preserve the previous air-conditioning-only behavior when no mode is selected, and reject mode changes during an active operation.
- Final tests and live validation for this version are pending.

#### 0.2.0

- Persist a selected target temperature from 16 to 29.5 °C in 0.5 °C steps and apply it before the next start.
- Apply a temperature without starting climate control, read the selected app temperature, or clear the staged selection.
- Verify each picker step and preserve the last accepted target across adapter restarts.
- Allow a 300-second overall job budget for temperature selection and delayed app confirmation.

#### 0.1.1

- Wait up to 120 seconds for a delayed app response within a 180-second overall job budget.
- Read the active climate description on the vehicle overview and expose the app confirmation source.
- Keep waiting when the overview does not yet confirm the active detail screen; never repeat a start automatically.

#### 0.1.0

- Initial native ioBroker adapter with private managed ADB runtime, WLAN setup, calibrated start/stop/status and persistent command cooldown.
