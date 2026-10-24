# ioBroker.vw-app

Control the **official Volkswagen Android app over Wi-Fi** from ioBroker.

**Experimental community adapter.** The source has been tested with synthetic Android views. The initial real-device reference is a Galaxy A31 with Android 12, Volkswagen app 4.8.1 and an ID.7 GTX Tourer. This does not establish compatibility with every Volkswagen model, region or future app version. Only the selected vehicle in one phone app is controlled by an instance.

Der Adapter bedient die offizielle Volkswagen-App auf einem Android-Handy. Kopplung, Einrichtung, Klimabefehle und Ladeeinstellungen werden direkt im ioBroker-Adapter verwaltet. Die Volkswagen-Anmeldung bleibt auf dem Handy.

## What runs where

- One ioBroker adapter handles configuration, pairing, device verification, climate controls and charging settings.
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
7. Read the climate and charging status and compare them with the app. Enable **Klimastart, Stopp und Änderungen der Fahrzeugeinstellungen erlauben** when ready to change app settings.

Pairing code and pairing port are temporary setup inputs and are not saved in the native instance configuration. The adapter never logs the code or puts it in a state. Clear the input or close the configuration page after pairing.

An Android 12 connection port may change after restarting the phone or toggling Wireless debugging. Update that port in the adapter settings and save. Automatic discovery of a new port is not promised, particularly in VM/NAT networks. A saved device identity prevents silently switching to another paired phone at a reused address.

## States

All IDs are relative to `vw-app.0` (replace `0` with the instance number).

| State | Meaning |
|---|---|
| `commands.start` | Write `true`, `ack=false` to start climate control |
| `commands.stop` | Write `true`, `ack=false` to stop the shown climate operation |
| `commands.refresh` | Write `true`, `ack=false` to read climate status only |
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
| `climate.targetSettingsError` | Per-field feedback about an invalid or unsaved climate preference; separate from the current phone job |
| `climate.mode` | Mode last read from the app |
| `climate.climateOnUnlock` | Climate-on-unlock setting last read from the app |
| `climate.autoWindowHeating` | Automatic window-heating setting last read from the app |
| `climate.zones` | `frontLeft`, `frontRight`, `both` or the observed empty selection `none`; `null` with invalid quality when unreadable |
| `climate.confirmationSource` | `none`, `app_controls` (climate controls) or `app_overview` (the exact active-climate description in the vehicle overview) |
| `climate.active` | Boolean observation; invalid quality on a failed read |
| `climate.vehicleConfirmed` | Always `false`; no independent vehicle telemetry confirmation |
| `operation.busy` | One operation is running |
| `operation.lastResult` | `running`, `succeeded` or `failed` |
| `operation.lastError` | Fixed diagnostic guidance |
| `operation.lastErrorCode` | Machine-readable error code |
| `operation.lastUpdated` | Last successful climate app-state observation; charging has a separate timestamp |
| `info.connection` | Last operation could reach and verify the configured phone/app |
| `info.runtimeReady` | Private ADB runtime is running |
| `info.appVersion` | Observed Volkswagen app version |
| `info.status` | Setup/runtime/operation status |

Buttons reset automatically. Without a selected target temperature, the app's existing temperature is preserved. Stop ends the climate operation exposed by the app's single Stop button, which may include window heating. With `climate.targetMode=null`, Start keeps the existing requirement for a recognized air-conditioning mode. An explicit `windowHeating` preference selects the separate window-heating operation; a staged temperature is ignored for that mode.

Status is read on request by default: `commands.refresh` reads climate status only, while `commands.refreshCharging` separately reads battery and charging values. Optional automatic polling is disabled with `pollIntervalSeconds=0`; when enabled, its minimum interval is 300 seconds. Each cycle reads climate status first and then battery/charging status only if the phone is still free between jobs. It does not queue a charging read behind another accepted phone operation and never requests synchronization automatically. Values can become stale between reads; `operation.lastUpdated` and `battery.observedAt` record app-reading times.

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

An invalid or unsaved preference restores its last accepted value and identifies the affected field in `climate.targetSettingsError`. A new Start or Apply Settings is then blocked with `settings_selection_failed` until that field is explicitly selected again with a valid value, or `commands.clearSettings` clears all four wishes. Successfully editing another field does not clear the failed field's error. Selection errors do not overwrite a concurrent phone job's result or diagnostic messages, and Status and Stop remain available.

Press `commands.applySettings` with `true`, `ack=false` to apply only these four preferences. Write permission must be enabled before changing app settings. This command does not apply a staged temperature and does not press Start or Stop. Press `commands.clearSettings` to set only these four preferences back to `null`, without phone access; the separate temperature preference is retained.

When the Volkswagen app offers **Save** after changes, the adapter presses it once and reopens the settings to verify the saved values before reporting success. It does not save or discard a preexisting manual draft. If a job reports `unsaved_settings`, open the phone and explicitly save or discard the unfinished changes, leave the zone editor, then retry. Android Back is not a substitute for saving: it can discard an app draft.

Start uses the saved preferences before starting the selected operation. Mode changes require an explicit `climate.targetMode` and an inactive climate operation. The adapter rejects a requested mode change while climate control is active; it does not stop and restart the operation to force the change. With `targetMode=null`, Start does not select another mode and retains its previous air-conditioning-only behavior.

The two Boolean options and the zone selection are also available in the app's window-heating settings. The app describes zones as: “Zonen im Innenraum Ihres Fahrzeugs, in denen zusätzliche temperaturbeeinflussende Funktionen während der Klimatisierung aktiviert werden sollen.” `frontLeft`, `frontRight` and `both` therefore select the front zones for these additional functions. They do not represent separate temperature targets or independent air-distribution controls.

The read-only `climate.zones` may report `none` when neither front zone is selected in the app. This is a valid observation, not a supported desired selection: writing `none` to `climate.targetZones` is rejected. An unreadable setting is represented separately as `null` with invalid quality.

The reference app can return its mode picker to air conditioning when the vehicle overview or settings are reopened. The adapter's saved mode preference remains unchanged. It saves and verifies the other preferences first, then selects the requested mode, and checks it again before Start. `climate.mode` describes the current app view, not independent vehicle telemetry.

Version 0.3.0 passed 220 automated tests on Linux. Live checks on the reference Galaxy A31 covered both modes, both Boolean options in each position, all three front-zone choices, saving and reopening the app settings, a combined four-preference job, persistence across an adapter restart, and clearing the preferences. The original app settings were restored afterward. No physical climate start was issued for these settings checks; climate remained off. Start integration is covered by regression tests; the earlier real start/stop confirmations apply to version 0.1.1.

## Battery and charging settings

All IDs below are relative to `vw-app.0`. Read the displayed or cached app values with `commands.refreshCharging`; this command does not change charging settings or explicitly request vehicle synchronization.

| State | Meaning |
|---|---|
| `commands.refreshCharging` | Write `true`, `ack=false` to read battery and charging settings |
| `commands.synchronize` | Write `true`, `ack=false` to request synchronization through the app once, then read the displayed battery/charging values; does not confirm completed vehicle synchronization |
| `commands.applyChargingSettings` | Apply only the four saved charging wishes, then read back the saved app values |
| `commands.clearChargingSettings` | Set only the four charging wishes to `null`, without phone access |
| `battery.soc` | Battery charge level read from the app, in %; `null` with invalid quality when unreadable |
| `battery.rangeKm` | Remaining range shown by the app in km; `null` with invalid quality when no unambiguous km reading is available |
| `battery.observedAt` | Time the adapter read the battery values from the app; not a vehicle telemetry timestamp |
| `battery.lastSyncRequestAt` | Read-only ISO timestamp of the last evidenced synchronization request sent to the app; not a completed-sync or vehicle measurement time |
| `charging.socLimit` | Charge limit read from the app, in % |
| `charging.reducedAcCurrent` | Reduced AC charging current setting read from the app |
| `charging.autoUnlockAc` | Automatic AC charging-plug unlocking setting read from the app |
| `charging.optimizedBatteryUse` | Optimized battery use setting read from the app |
| `charging.targetSoc` | Saved desired charge limit: `null` or numeric `50`, `60`, `70`, `80`, `90`, `100` % |
| `charging.targetReducedAcCurrent` | Saved desired reduced AC current setting: `null`, `true` or `false` |
| `charging.targetAutoUnlockAc` | Saved desired automatic AC plug unlocking setting: `null`, `true` or `false` |
| `charging.targetOptimizedBatteryUse` | Saved desired optimized battery use setting: `null`, `true` or `false` |
| `charging.targetSettingsError` | Per-field feedback about an invalid or unsaved charging wish |

Battery charge level is read from the app's range details. A fallback to the vehicle overview provides only an explicitly labelled km range; it does not invent a battery percentage. Unreadable values are `null` with invalid quality. `battery.observedAt` records an app read, not when the vehicle measured or transmitted the values. The app itself may still show older data.

Use `commands.synchronize` explicitly when you want the adapter to request **Jetzt synchronisieren** in the Volkswagen app. It taps the recognized link once and uses the subsequently disabled app link to acknowledge the request. The command then reads the displayed battery and charging settings; these can still be older values. The app says synchronization may take a few minutes. The adapter does not automatically wait for a proven new vehicle value or report the vehicle synchronization as completed. Read the app again later with `commands.refreshCharging` if needed.

This synchronization request is available without the permission to change vehicle settings. It does not apply staged wishes or wait for the temperature, climate or charging preference queues. The same single-phone-operation rule still applies. Normal refreshes and automatic polling never press **Jetzt synchronisieren**.

`battery.lastSyncRequestAt` is updated only when a valid request timestamp is available in the result. A subsequent read with no valid new request timestamp preserves that history. It records an explicit app request; `battery.observedAt` instead records the time of the latest battery read. Neither timestamp establishes when the vehicle measured its values.

Stage a charging wish with `ack=false`. An `ack=true` response means **saved privately**, not applied to the app. The wishes survive adapter restarts. `null` keeps the corresponding app setting; Boolean `false` explicitly switches an option off. The verified charge-limit slider supports **50 to 100 % in 10-% steps**. Intermediate values such as `55`, numeric strings such as `"80"` and text Boolean values are rejected without operating the phone.

Press `commands.applyChargingSettings` with `true`, `ack=false` to apply only the charging wishes. The write permission must be enabled, and at least one wish must be selected. The adapter derives a charge-limit tap from the current native slider geometry and verifies the exact resulting value. It presses **Save** once when offered and reopens the settings to verify the saved values before reporting success. It does not save or discard a manual draft that was already open; finish that draft directly on the phone first. A visible Volkswagen activity is reused so a draft is not bypassed by launching another app view.

Charging preferences have their own persistence queue and errors. An invalid or unsaved field restores its last accepted value and is named in `charging.targetSettingsError`; a new Apply Charging Settings is blocked until that field is explicitly selected again with a valid value or `commands.clearChargingSettings` clears all four wishes. A successful selection of another field does not clear that error. A running job keeps the snapshot accepted for that job; later wishes apply to the next job. Climate commands and charging refresh do not wait for a pending charging preference save, and applying charging settings does not wait for climate or temperature preference saves. The phone still handles only one operation at a time.

Charging reads and failures leave the climate observations intact. Climate reads and failures likewise leave battery and charging observations intact. Clearing charging wishes changes neither climate wishes nor the separate temperature wish. These commands do not start or stop charging or climate control.

According to the app, **optimized battery use** permits use of the high-voltage battery for app remote functions and can affect range. This option is separate from an 80-% battery-care charging limit. The app also states that the selected charge limit does not apply at predefined charging locations. Check the descriptions in the app for the selected vehicle.

Version 0.4.0 passed **332 automated tests on Linux**. Live checks read battery percentage and km range from the real app, saved charge limits of 50 and 100 % and verified them after reopening, and exercised all three Boolean options in both positions. Charging wishes survived an adapter restart. The original app settings were restored and all four wishes were cleared; climate control remained off and unchanged. A live `commands.synchronize` check sent exactly one request, observed the disabled app link, recorded `battery.lastSyncRequestAt` and then read battery/charging values without changing settings. This confirms the app request, not a completed vehicle synchronization. These new battery and charging functions have only been checked with the **German Volkswagen app 4.8.1 on a Galaxy A31 running Android 12**.

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

#### 0.4.0

- Read the battery percentage and remaining range in km from the app, with an explicit app-reading timestamp.
- Explicitly request app synchronization once and retain its request timestamp separately from app reads; no completed vehicle synchronization is claimed.
- When optional polling is enabled, read climate first and charging only if the phone remains free; never synchronize automatically.
- Stage, persist, apply or clear the charge limit, reduced AC charging current, automatic AC plug unlocking and optimized battery use preferences.
- Validate the charge limit against the six native slider positions from 50 to 100 %, save changes once and verify the saved app settings after reopening.
- Keep charging preferences, selection errors and observations separate from climate control; no charging Start/Stop command is provided.

#### 0.3.0

- Stage and persist mode, climate-on-unlock, automatic window heating and front-zone preferences separately from observed app settings.
- Apply or clear those four preferences without pressing Start/Stop or applying temperature.
- Use the accepted preferences for Start, preserve the previous air-conditioning-only behavior when no mode is selected, and reject mode changes during an active operation.
- Save app drafts once, verify them after reopening, then select the final mode using its exact label.
- Verify the settings flow with 220 Linux tests and real-device app checks while climate remains off.

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
