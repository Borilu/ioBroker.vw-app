# ioBroker.vw-app

Control the **official Volkswagen Android app over Wi-Fi** from ioBroker.

**Experimental community adapter.** The source has been tested with synthetic Android views. The initial real-device reference is a Galaxy A31 with Android 12, Volkswagen app 4.8.1 and an ID.7 GTX Tourer. This does not establish compatibility with every Volkswagen model, region or future app version. Only the selected vehicle in one phone app is controlled by an instance.

Pairing, setup, climate controls, charging settings, departures, existing charging locations and explicit lock/unlock commands are managed by the adapter. App observations can be read automatically or on request. Volkswagen sign-in stays on the phone; the optional S-PIN is configured in the adapter settings.

Manufacturer information: [Volkswagen app and digital services](https://www.volkswagen.de/de/besitzer-und-service/digitale-extras/volkswagen-apps-login-und-shop.html). Start with the [illustrated German installation and phone pairing guide](docs/INSTALLATION.de.md), also available as a [PDF for 0.9.2 with the same pairing steps](https://github.com/Borilu/ioBroker.vw-app/releases/download/v0.9.2/VW-App-Installation-und-Kopplung.pdf). The [German user manual](docs/BEDIENUNG.de.md) explains everyday operation, all data point paths and the order of steps for changing settings. Its [PDF for 0.10.0](https://github.com/Borilu/ioBroker.vw-app/releases/download/v0.10.0/VW-App-Bedienungsanleitung.pdf) predates the command-button clarification and the charging-mode controls in 0.11.0; use the current online manual for those features. The [detailed German setup reference](docs/ADMIN-SETUP.md) describes the adapter configuration.

## What runs where

- One ioBroker adapter handles configuration, pairing, device verification, climate controls, charging settings and explicit vehicle lock/unlock commands.
- No Python bridge, separate HTTP server, systemd service or JavaScript-adapter script is needed.
- The adapter manages a private native ADB child process. It starts and stops that process with the adapter instance. ADB remains a technical runtime requirement, not an additional service users must configure.
- Departure controls use the included small Android UI helper through that same ADB connection. No separate VM daemon, phone APK installation, Python process or JDK is required to run it.
- No VW cloud password or cloud token is entered in ioBroker.
- Android SDK binaries are not shipped in this GitHub repository or npm package. The setup interface offers an explicit download from Google after acceptance of the linked terms.

## Requirements

| Component | Initial supported configuration |
|---|---|
| ioBroker host | Linux x64 (Intel/AMD), Node.js 22.19.0 or later, js-controller 6.0.11 or later |
| Admin | ioBroker Admin 7.6.20 or later |
| Phone | Android 11 or later with **Wireless debugging** available |
| App | Official Volkswagen app, signed in, vehicle selected, manual remote climate control working |
| Network | Phone reachable from the ioBroker host over the home network |

The included-runtime download supports **Linux x64 only**. Linux ARM64 with an externally provided compatible `adb` is an advanced, unverified configuration. Windows and macOS hosts are not supported by this first release. Docker users need a persistent ioBroker data volume and network access to the phone; no USB passthrough is required.

The phone must stay unlocked while app automation runs. The explicit keep-awake setup action can keep its display on while charging. It does not unlock the phone. After a phone reboot, manual unlocking and checking wireless debugging may be necessary.

## Installation and updates

The package name is **`iobroker.vw-app`**. npm publication and inclusion in ioBroker's adapter catalog are separate steps. This adapter has not yet been accepted into the beta/latest or stable catalog. An npm release does not by itself make it appear in either catalog.

After the package is available on [npm](https://www.npmjs.com/package/iobroker.vw-app), it can be installed with ioBroker Admin's own installer:

1. Open **Adapters** in Admin and enable expert mode if necessary.
2. Open **Install from your own source** using the Octocat button and select **From npm**.
3. Enter `iobroker.vw-app`, select the published version and run the installation.
4. Add a `vw-app` instance if the installer has not created one, then open its configuration.

This method uses the ioBroker installer rather than a manual package-manager installation. Check the requirements above first: installing from your own source bypasses repository dependency checks. The dialog and labels can vary with Admin versions; see the [official Admin installation documentation](https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/admin/adapter.md#install-from-your-own-source).

Until catalog acceptance, later published versions can be selected through the same **From npm** dialog. After acceptance, users of the relevant repository can install `vw-app` and receive available updates through the normal adapter catalog. A stable listing requires a separate review and testing phase after beta/latest acceptance.

## Setup in ioBroker Admin

Detailed instructions are also available in the [German setup guide](docs/ADMIN-SETUP.md).

1. Start the adapter instance. Install the Android tools with the setup button after reviewing the linked terms. An alternative existing absolute `adb` path can be selected.
2. On the phone, enable developer options and **Wireless debugging**. Open **Pair device with pairing code**.
3. In the adapter setup, enter the phone IP, pairing port and current six-digit code. Pair while the phone dialog remains open.
4. Close only the pairing-code dialog. Enter the **connection port** shown on the main Wireless debugging page. It differs from the pairing port. Save the configuration.
5. Run **Check connection and app version**. The phone identity is stored privately by the adapter.
6. Open the vehicle overview in the Volkswagen app, then run **Adopt app and vehicle**. Review the detected app version and complete fixed vehicle label; save.
7. Read the climate and charging status and compare them with the app. Enable the permission for climate Start/Stop and vehicle-setting changes when ready to change app settings.
8. For optional locking and unlocking, first check both functions manually in the Volkswagen app. Enter the four-digit **Volkswagen S-PIN** only in its masked Admin field, save, and separately enable the vehicle lock/unlock permission. Read the [locking behavior and security notes](#lock-and-unlock-the-vehicle) before issuing a command.

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
| `commands.lockVehicle` | Write `true`, `ack=false` for one explicit vehicle-locking command; separate permission and S-PIN required |
| `commands.unlockVehicle` | Write `true`, `ack=false` for one explicit vehicle-unlocking command; separate permission and S-PIN required |
| `security.blocked` | Read-only local block on further authentication attempts; separate from the vehicle lock state |
| `security.reason` | Read-only fixed reason for that local block, or an empty string when clear |
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
| `operation.busy` | A manual phone/setup operation is running; automatic reads use `refresh.autoBusy` |
| `operation.lastResult` | `running`, `succeeded` or `failed` |
| `operation.lastError` | Fixed diagnostic guidance |
| `operation.lastErrorCode` | Machine-readable error code |
| `operation.lastUpdated` | Last successful climate app-state observation; charging has a separate timestamp |
| `info.connection` | Last operation could reach and verify the configured phone/app |
| `info.runtimeReady` | Private ADB runtime is running |
| `info.appVersion` | Observed Volkswagen app version |
| `info.status` | Setup/runtime/operation status |
| `commands.refreshVehicleInfo` | Write `true`, `ack=false` to read the selected vehicle's VIN from the app |
| `vehicleInfo.vin` | Read-only vehicle identification number (VIN/FIN) observed in the app |
| `vehicleInfo.observedAt` | Last successful vehicle-information app read |

Buttons are write-only (`common.read=false`, `common.write=true`): write `true`, `ack=false` once. The adapter acknowledges the event, but a button value or its reset is not command feedback. Check `operation.busy`, `operation.lastResult`, `operation.lastErrorCode` and the observed values; local wish-clearing commands instead confirm the saved wishes and their selection-error fields. Without a selected target temperature, the app's existing temperature is preserved. Stop ends the climate operation exposed by the app's single Stop button, which may include window heating. With `climate.targetMode=null`, Start keeps the existing requirement for a recognized air-conditioning mode. An explicit `windowHeating` preference selects the separate window-heating operation; a staged temperature is ignored for that mode.

Manual reads remain separate: `commands.refresh` reads climate status, `commands.refreshCharging` reads battery and charging values, `commands.refreshVehicleReport` reads the vehicle report, and `commands.refreshVehicleInfo` reads the selected vehicle's VIN. Automatic reads use the same validated app views and do not apply saved preferences.

The confirmation source describes evidence from the app. Both `app_controls` and `app_overview` remain app observations; `climate.vehicleConfirmed` stays `false`. The inspected Android UI hierarchy did not expose the visible 30-minute countdown, so the adapter does not estimate or publish remaining minutes.

## Automatic app reads and read age

New instances use `pollIntervalSeconds=15`. Existing instances retain their saved setting: `0` stays disabled, and a missing legacy value also remains disabled. Use `0` for manual reads only, or a whole number from **15 to 86400** to enable automatic reads of **climate, battery/charging, the vehicle report, doors/windows/trunk/locking, the selected vehicle's VIN, climate departures, the charging-location list and each present charging location**. No write permission is needed for these reads.

This setting is the minimum wait **from a completed read until that same area becomes due again**. It does not promise a full update every 15 seconds. All areas share one phone and run fairly, one after another. Each newly discovered present charging location adds its own read area, up to five locations. Their timer editors, settings and preferred windows require extra app navigation, so the complete cycle grows with the number of locations. The adapter also rests between automatic jobs for at least **5 seconds or 25% of the last job's duration**, whichever is longer. There is no overlapping work or catch-up queue. A failing area receives a progressively longer retry wait, with error backoff limited to five minutes while respecting the configured minimum interval.

Manual commands take priority. An automatic read stops at a safe step boundary before a manual command takes over; it does not interrupt an unfinished vehicle-setting change. After a control command, a read of the affected area receives priority. That follow-up only reads: it never repeats a Start, Stop, Save or other write. Automatic ticks never press **Jetzt synchronisieren** and never apply temperature, climate, charging, departure or location wishes.

The following metadata is read-only. Replace `<area>` with `climate`, `charging`, `vehicleReport`, `vehicleAccess`, `vehicleInfo`, `departureClimate`, `departureLocations` or `departureLocation_loc_<24hex>` for an individually discovered location:

| State | Meaning |
|---|---|
| `refresh.<area>.status` | `fresh`, `stale`, `error` or `unknown` for that area's app read |
| `refresh.<area>.lastReadAt` | Time of its last successful app read |
| `refresh.<area>.ageSeconds` | Age of that successful read |
| `refresh.<area>.lastErrorCode` | Fixed code for its latest read error |
| `refresh.<area>.lastDurationSeconds` | Duration of its latest read |
| `refresh.<area>.maxAgeSeconds` | Read-age threshold currently in use |
| `refresh.autoBusy` | An automatic app read is running |

`fresh` means that a successful **app read** is still within its age threshold. `stale` marks an aged observation, `error` a failed read, and `unknown` the absence of a successful observation. None of these labels establishes when the vehicle measured or transmitted its data. The app's raw synchronization hint remains separate in `vehicleReport.synchronizationText`.

Set `refreshMaxAgeSeconds` to **0** for an adaptive threshold, or a whole number from **30 to 86400** for an explicit read-age threshold. Automatic mode uses the greater of **90 seconds** and **twice the larger of the configured minimum interval and the estimated full cycle time**. Changing this threshold changes the age classification, not how often the phone is read or when it synchronizes with the vehicle. `operation.lastUpdated`, `battery.observedAt`, `vehicleReport.observedAt` and `vehicleInfo.observedAt` remain the separate app-reading timestamps.

Version 0.6.0 passed **437 automated tests on Linux**. In the preceding RC1 live check on the reference Galaxy A31, a configured 15-second minimum produced repeat reads of each area about **90–92 seconds** apart. With polling disabled and a 30-second age limit, expired observations retained their last values with invalid quality; preferences and synchronization-request history remained unchanged. A manual report request took over the phone from an automatic read in about **1.75 seconds**; that is the handoff time, not the time to finish reading the report. Automatic reads preserved the manual operation feedback. These live checks did not start or stop climate control, save vehicle preferences or request synchronization. Six additional simulated regression tests cover cooperative handoff through the zones page, hard cancellation, deadlines and preservation of manual drafts; they do not represent an additional physical Start/Stop test.

That version 0.6.0 cycle measurement covered the three original areas, before departure and location reads were added. It does not predict the longer version 0.7.0 cycle.

## Command behavior

- App controls are identified from the current Android UI hierarchy, not saved screen coordinates.
- A device identity, calibrated vehicle label and approved app version are checked before switching.
- An already satisfied command does not send another switching request.
- Only one phone operation runs at a time. Manual commands can take over from an automatic read at a safe step boundary; additional manual commands still receive a busy response.
- A private command journal enforces at least 60 seconds between switching attempts, including after adapter restarts.
- Unknown dialogs, missing controls, unexpected modes or a changed app version stop the operation.
- After a switching attempt, an unclear outcome is reported as `outcome_unknown`; the adapter does not repeat the command automatically.

Volkswagen's app may acknowledge a start with a delay. New instances allow up to **120 seconds** after a switching attempt for the app confirmation (`outcomeTimeoutSeconds`, configurable from 30 to 150 seconds), within a **300-second** overall job deadline (`commandTimeoutSeconds`, configurable from 30 to 360 seconds). Connection, navigation and temperature selection also consume that overall budget; a shorter overall limit can therefore end the wait earlier. Existing instances retain their saved overall limit. If it is still 125 or 180 seconds, change it to 300 seconds in expert settings to allow the full budget for temperature selection and starting.

An exact active-climate description in the selected vehicle's overview can provide additional app confirmation. A successful read of that description is reported as `app_overview`; observations from the climate controls are reported as `app_controls`. An uncertain result retains the last known source with invalid quality and an error in `refresh.climate.status`; that historical value does not confirm the current outcome. No source claims independent vehicle telemetry.

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

The two Boolean options and the zone selection are also available in the app's window-heating settings. The app describes zones as areas of the vehicle interior where additional temperature-related functions should be activated during climate control. `frontLeft`, `frontRight` and `both` therefore select the front zones for these additional functions. They do not represent separate temperature targets or independent air-distribution controls.

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

Charging reads and failures leave the climate observations intact. Climate reads and failures likewise leave battery and charging observations intact. Clearing charging wishes changes neither climate wishes nor the separate temperature wish. The four charging-setting controls do not select a charging mode; the explicit mode control below is separate.

According to the app, **optimized battery use** permits use of the high-voltage battery for app remote functions and can affect range. This option is separate from an 80-% battery-care charging limit. The app also states that the selected charge limit does not apply at predefined charging locations. Check the descriptions in the app for the selected vehicle.

Version 0.4.0 passed **332 automated tests on Linux**. Live checks read battery percentage and km range from the real app, saved charge limits of 50 and 100 % and verified them after reopening, and exercised all three Boolean options in both positions. Charging wishes survived an adapter restart. The original app settings were restored and all four wishes were cleared; climate control remained off and unchanged. A live `commands.synchronize` check sent exactly one request, observed the disabled app link, recorded `battery.lastSyncRequestAt` and then read battery/charging values without changing settings. This confirms the app request, not a completed vehicle synchronization. These new battery and charging functions have only been checked with the **German Volkswagen app 4.8.1 on a Galaxy A31 running Android 12**.

## Charging mode

Version 0.11.0 adds a separate charging-mode wish and explicit command. The app applies a mode selection immediately, without **Save**. A mode change can therefore start charging; the adapter never presses an additional charging Start control.

Version 0.11.1 also recognizes the supported picker layout with an additional empty, noninteractive Compose wrapper. In 0.11.0 this layout could fail with `unknown_state` before a mode-option tap. The exact three-choice, selection, geometry and overlay checks remain required; updating does not automatically submit a mode command.

App confirmation may lag behind an accepted selection. Within the configured confirmation window and overall command deadline, the adapter waits using read-only observations and, when needed, safely reopens the range details from the confirmed vehicle overview. A picker return uses one native header action followed by read-only waiting. The mode selection and header action are never repeated to obtain confirmation. An unknown result can therefore follow an effective selection: read the mode with `commands.refreshCharging` before considering another command.

| State relative to `vw-app.0` | Access and meaning |
|---|---|
| `charging.mode` | Read-only: `immediate` (charge immediately), `departure` (charge for departure), `departureClimate` (charge and climate for departure), or `null` before a known observation; check quality |
| `charging.modeObservedAt` | Read-only: ISO UTC time of the last successful mode-reading snapshot, or empty; neither battery-read time nor vehicle telemetry time |
| `charging.targetMode` | Saved wish: one of the three exact strings, or `null` to keep the app mode; write with `ack=false` |
| `charging.targetModeError` | Read-only: fixed selection/save error, empty after a valid saved selection or clear |
| `commands.applyChargingMode` | Write-only: write `true`, `ack=false` once to apply the saved mode; actual changes require vehicle-setting write permission |
| `commands.clearChargingMode` | Write-only: write `true`, `ack=false` to clear only this wish without phone access |

The enum list contains the three named modes. A real `null` clears the wish; it is neither a fourth mode nor the string `"null"`. If the UI does not offer a null selection, use `commands.clearChargingMode`.

Select `charging.targetMode`, wait for `ack=true` and an empty `charging.targetModeError`, then trigger `commands.applyChargingMode` once. Check `operation.lastResult` and `operation.lastErrorCode`, followed by a valid `charging.mode` and a fresh `charging.modeObservedAt`. The configured common switching-attempt cooldown is **60–3600 seconds**, default **60**, and is reserved before a potentially effective mode tap. After an unknown result, inspect the app and request a read before deciding what to do; do not automatically retry. No S-PIN is needed.

With write permission disabled, this mode command can only confirm an already fulfilled wish from fresh app readings; a different mode is rejected before opening the picker, reserving a switching attempt or selecting a mode.

The mode wish persists separately from the four charge-limit/charging-option wishes. `commands.applyChargingSettings` never applies a mode wish; its clear command never clears one. A mode selection or save error blocks only mode apply until a valid reselect or mode clear. Later changes cannot alter an accepted command's snapshot. Startup, reconnect and automatic reads never apply the wish or repeat the mode change.

`commands.refreshCharging` and the existing automatic `charging` read domain also read the mode. An unreadable mode or missing valid snapshot time preserves the previous mode/time as history and marks the mode invalid (`q=0x82`); battery readings and the domain may still be fresh. The mode also expires according to its own snapshot time. Its timestamp remains the last successful observation after an error, expiry or restart.

**Planned charging at a charging location requires `departure` or `departureClimate`.** Configure and enable the desired location timer first, then explicitly choose and apply the appropriate charging mode and verify its fresh observed value. A timer can be edited while `immediate` is selected. Timer apply never changes the charging mode, and `enabled=true` alone does not prove that planned charging will execute.

## Read the vehicle status report

Write `true` with `ack=false` to **`commands.refreshVehicleReport`** to read the Volkswagen app's **vehicle status report**. Check the separate operation and freshness states for its result. This is the only report control: every state under `vehicleReport` is read-only. There are no report wishes or apply/save commands, and reading the report does not request synchronization or start or stop a vehicle function. The permission to change vehicle settings is not needed; the calibrated phone, vehicle and app checks still apply.

The report can be read on request or as part of automatic app updates. `commands.refresh` remains a climate read. A report read does not wait for temperature, climate or charging preference saves; only one phone operation can run at a time.

All IDs below are relative to `vw-app.0`.

| State | Meaning |
|---|---|
| `vehicleReport.odometerText` | Odometer text displayed by the app |
| `vehicleReport.odometerKm` | Unambiguously derived odometer value in km, or `null` with invalid quality |
| `vehicleReport.nextServiceText` | Service information displayed by the app |
| `vehicleReport.nextServiceDays` | Unambiguously derived service interval in days, or `null` with invalid quality |
| `vehicleReport.nextServiceKm` | Unambiguously derived service interval in km, or `null` with invalid quality |
| `vehicleReport.summary` | Report summary text displayed by the app |
| `vehicleReport.hasMessages` | Message indication derived from a recognized summary, or `null` with invalid quality |
| `vehicleReport.messageCount` | Unambiguously derived message count, or `null` with invalid quality |
| `vehicleReport.synchronizationText` | Unchanged synchronization hint displayed inside the app report |
| `vehicleReport.notice` | Report notice text displayed by the app |
| `vehicleReport.additionalTexts` | JSON array string containing additional captured report texts |
| `vehicleReport.json` | Complete normalized report as a JSON string |
| `vehicleReport.observedAt` | ISO timestamp when the adapter read the report from the app |

Each category has `vehicleReport.<category>.status` and `vehicleReport.<category>.texts`. The latter is a JSON array string containing the captured category texts.

| Category | App label |
|---|---|
| `engine` | Antrieb |
| `assistance` | Assistenten |
| `brakes` | Bremsen |
| `lighting` | Fahrlicht |
| `comfort` | Komfort |
| `tires` | Reifen |
| `other` | Sonstige |

`no_messages` means the app reports no messages for that category. It is not a diagnosis or an independent statement that the vehicle is healthy. Unrecognized texts are preserved and reported as `unknown`; unnamed icons do not provide an invented color or severity. Warning configurations have not yet been checked live, so they are not promoted to a confirmed interpretation.

`vehicleReport.synchronizationText` is the app's own displayed hint. It is separate from `vehicleReport.observedAt`, which records the adapter's app-reading time; neither creates a new synchronization request or independently establishes when the vehicle measured the values. If the full report cannot be read or validated, its last known values are retained with invalid quality and `refresh.vehicleReport.status=error`. An aged app read is marked `stale` with invalid quality. Retained values are historical observations, not a fresh report; the last successful reading time does not advance on failure. Climate and charging observations are retained independently.

Version 0.5.0 passed **391 automated tests on Linux**. Real top and bottom report views were also merged locally into a complete validated model. Two live report reads on a **Galaxy A31 with Android 12 and the German Volkswagen app 4.8.1** correctly captured odometer, service information, summary, synchronization text, all seven categories, the footer and normalized JSON; the second read updated `observedAt`. All 27 actual ioBroker report objects were verified as read-only, matching the automated schema checks. On both reads, 23 monitored climate, charging, preference and synchronization-request values remained exactly unchanged. No vehicle action, Save or synchronization was triggered, and climate control remained off. Active warning configurations were neither created nor checked live.

## Vehicle identification number

Version 0.10.0 adds the read-only **VIN** (German **FIN**) of the selected vehicle. The adapter reads it from the app's vehicle management, reached through the vehicle icon at the top right of the overview. It does not add, select or remove another vehicle.

| State | Meaning |
|---|---|
| `vehicleInfo.vin` | Vehicle identification number observed for the enrolled selected vehicle |
| `vehicleInfo.observedAt` | ISO timestamp of the last successful vehicle-information app read |
| `commands.refreshVehicleInfo` | Write `true`, `ack=false` for an immediate read-only query |
| `refresh.vehicleInfo.*` | Read age, status, error, duration and validity threshold for this separate area |

Automatic refresh includes `vehicleInfo` in the same fair queue and uses the configured minimum interval. The additional navigation lengthens the full cycle; it does not delay a manual command beyond the existing safe handoff rules. No permission for vehicle-setting changes or S-PIN is needed. Reading does not apply preferences, switch vehicles or request synchronization.

A missing, ambiguous or invalid VIN is not guessed. On failed or aged reads, the last successfully observed VIN remains as a historical value with invalid quality; its successful reading timestamp is retained. After a restart, retained vehicle information is also invalid until the next successful read. Problems in this area do not invalidate the independently observed door and window states. A successful read confirms the selected app view, not new vehicle telemetry.

## Doors, windows, trunk and locking

Version 0.8.0 reads the individual opening states and the lock state from the vehicle overview. All IDs below are relative to `vw-app.0` and are read-only except the refresh button.

| State | Meaning |
|---|---|
| `vehicleAccess.doors.frontLeftOpen`, `frontRightOpen`, `rearLeftOpen`, `rearRightOpen` | Each door: `true` open, `false` closed, `null` unknown |
| `vehicleAccess.windows.frontLeftOpen`, `frontRightOpen`, `rearLeftOpen`, `rearRightOpen` | Each window: `true` open, `false` closed, `null` unknown |
| `vehicleAccess.trunkOpen` | Trunk: `true` open, `false` closed, `null` unknown |
| `vehicleAccess.locked` | `true` locked, `false` unlocked, `null` unknown; independent of whether openings are closed |
| `vehicleAccess.warningText` | Opening/status warning exposed by the app, empty when no warning is shown |
| `vehicleAccess.synchronizationText` | Synchronization hint displayed on the overview |
| `vehicleAccess.observedAt` | Time of the successful app read |
| `commands.refreshVehicleAccess` | Write `true` with `ack=false` to read this area now |

Automatic refresh includes the separate `vehicleAccess` area and publishes the usual `refresh.vehicleAccess.*` read age, validity, duration and error states. The configured minimum interval still applies; it does not promise a complete phone-navigation cycle in that interval. Manual reads receive the existing priority and use the same single-phone queue. They do not require permission to change settings, apply saved wishes, synchronize the car, unlock it or operate a door, window or trunk.

The app lists open components and can omit the entire warning when everything is closed. The parser interprets omissions only in the complete recognized overview layout, including its status slot. Incomplete, clipped, contradictory or unsupported descriptions do not become guessed closed values. Unknown values have invalid quality. Failed or aged reads retain the last observation with invalid quality; their last successful reading time does not advance on failure. App-reading time and the app's synchronization hint are separate from a vehicle measurement timestamp.

The reference-device discovery recorded all openings open and the vehicle unlocked, then individually closed the driver door, driver window and trunk. Each exact label disappeared independently. It also recorded all openings closed with both lock states. Real app recordings remain private; public tests use synthetic views.

## Lock and unlock the vehicle

Version 0.9.0 adds the explicit buttons **`commands.lockVehicle`** and **`commands.unlockVehicle`**. Write `true` with `ack=false` to the chosen button. It submits at most one switching attempt for that accepted command; check the separate operation and observed lock-state feedback. An already satisfied command only reads and reports the app state; it does not enter a PIN or clear a previous authentication block. There is no writable `targetLocked` preference, no automatic reconciliation and no locking or unlocking during startup, ordinary reads or polling.

Locking and unlocking use the independent vehicle lock/unlock permission (`allowVehicleLocking`, default `false`). The existing climate/vehicle-settings permission does not enable these commands. Both actual switching directions require a saved S-PIN consisting of exactly four digits; leading zeroes are preserved. A missing or invalid PIN does not disable climate functions or read-only updates. The adapter also requires the calibrated phone, selected vehicle, approved app version and an unambiguous supported control layout. Unexpected views or an unsupported layout stop the command.

Enter the real S-PIN only in the masked **Volkswagen S-PIN** field in normal ioBroker Admin, then save. Never send it in chat, a GitHub issue, a state, a script, a diagnostic log or a screenshot. There is no PIN data point. The adapter passes the PIN only to the dedicated authentication input; it excludes it from ordinary controller configuration, command options, results, the command journal and adapter log messages. In the inspected app, entering the **fourth digit submits immediately**. The adapter does not enter a second PIN or press another confirmation button after that submission.

The native `sPin` field is declared in both top-level `encryptedNative` and `protectedNative`. With the supported ioBroker installation and Admin save flow, it is encrypted in the stored instance configuration and automatically decrypted for the owning adapter at startup. Normal ioBroker upgrades also copy these declarations to existing local instances; after updating, reload Admin settings before entering a PIN. A password mask alone is not encryption. `protectedNative` restricts ordinary foreign adapters; privileged components such as Admin, cloud and iot, and administrators with host/configuration access, remain trusted. Protect configuration backups and the ioBroker system secret accordingly.

There is also an upstream Admin limitation: some JSON-config versions log the decrypted native configuration to the **browser console** after Save, including [version 10.1.2](https://github.com/ioBroker/json-config/blob/v10.1.2/src/JsonConfig.tsx#L664-L682) from the Admin 8 generation. This is outside the adapter logger and means the masked field is not a guarantee of secrecy throughout the Admin environment. Do not collect or share browser-console output or configuration exports containing credentials. The adapter does not add such logging, but cannot suppress it in an independently installed Admin version.

Before a potentially dispatching gesture, the adapter persists its command cooldown and a separate authentication block. An uncertain result leaves further attempts blocked, including after an adapter restart. The current transport does not classify individual wrong-PIN or Volkswagen-lockout messages: an unrecognized authentication view is treated conservatively as an unknown outcome, without guessing a diagnosis or entering the PIN again. `security.blocked=true` describes this **local authentication block**, not whether the car is locked. `security.reason` reports a fixed reason such as `attempt_pending` or `outcome_unknown`; an unreadable or invalid stored block instead reports a fixed `security_auth_…` diagnostic and blocks switching conservatively. Reading and other existing functions remain available. A positively observed result of an actual switching attempt clears the local block; an already satisfied read does not.

After a failure, check the Volkswagen app and the correct S-PIN before trying again. Save any PIN correction in Admin, then use the **Reset security block after correcting the S-PIN** action in the adapter settings. Only an Admin sender can perform this reset, it is serialized with phone jobs, and it sends no phone or vehicle command. Resetting the adapter block does not cancel a Volkswagen lockout or shorten the app's waiting period. A restart, polling cycle or an automation writing a state cannot clear the block. Do not automate resets or repeated authentication attempts.

After an accepted command, a prioritized **read-only** `vehicleAccess` follow-up is requested. It never repeats the lock/unlock action. Existing regular `vehicleAccess` reads keep doors, windows, trunk and `vehicleAccess.locked` updated with the same age, error and invalid-quality handling; no extra polling domain or secret access is needed. The result confirms only the lock state displayed by the selected app overview. It is not independent vehicle telemetry or proof of physical locking; `vehicleConfirmed` remains `false`. Check the vehicle during initial function testing and inspect the app after any uncertain result.

Reference testing on 25 October 2026 covered both control directions and their empty, operation-specific authentication screens on a Galaxy A31 with Android 12 and Volkswagen app 4.8.1. The corrected adapter completed one unlock and one lock command, each with a valid matching app observation, no error and a cleared local authentication block. The user independently confirmed both actions at the vehicle. The keyboard was verified hidden after each action. These checks cover the reference setup; other layouts still require validation.

After an accepted PIN submission, the adapter can hide a still-visible keyboard once, after checking the Volkswagen foreground view and keyboard visibility. An already hidden keyboard needs no Back action. Feedback handling waits through temporary screen transitions within the configured confirmation timeout; it never repeats PIN entry or the vehicle command. Unconfirmed results retain the authentication block.

A partly scrolled Home screen is restored through the app's native scroll action, without a touch-drag fallback that could pull to refresh. Opening states are published only from the complete, recognized car graphic and warning/status area. The known Vehicle details sheet can be closed through its header return; authentication forms remain protected.

## Departure times and charging locations

All state IDs below are relative to `vw-app.0`. Version 0.7.0 reads the app's **two climate departure timers** and **up to five charging locations already created in the vehicle**, each with three departure timers. It does not create or delete charging locations.

| State or command | Meaning |
|---|---|
| `commands.refreshDepartureClimate` | Read the two climate departure timers |
| `commands.refreshDepartureLocations` | Discover the current charging-location list and bindings |
| `departures.climate.observedAt` | Time of the last successful climate-departure app read |
| `departures.climate.timer1` / `timer2` | Observations and saved wishes for each climate timer |
| `chargingLocations.observedAt` | Time of the last successful location-list app read |
| `chargingLocations.loc_<24hex>` | Stable adapter key for a location's confirmed vehicle profile and native app identity |
| `chargingLocations.loc_<24hex>.commands.refresh` | Read that location's three timers, settings and preferred windows |

Each location publishes `name`, `present`, `activeTimerCount`, `bindingStatus` and `observedAt`. Its key follows the native location identity, rather than its display name or list position. A rename, removal or reappearance retains saved wishes and historical values but invalidates their previous bindings. This also applies after a successful rename through the adapter: every existing non-null wish from the previous binding generation, including the just-used name wish, must be explicitly selected again or cleared before another Apply. Check the current name, presence and binding feedback before applying changes. A rename requires a new complete location-list read; the previous inventory remains stale until that read succeeds.

Each climate timer and each location's `timer1`, `timer2` and `timer3` uses the same fields:

| Field under a timer | Meaning |
|---|---|
| `enabled`, `time`, `days`, `repeat` | Read-only app settings; time is `HH:mm`, days is a JSON array of `mon` through `sun` |
| `date` | Read-only local calendar date of a one-off timer; `null` for a recurring timer |
| `vehicleOffset`, `isLocalVehicleTime`, `source` | App timing metadata and observation source |
| `daysSummary`, `daysSummaryRecognized` | Original overview day label and whether its meaning was recognized |
| `targetEnabled`, `targetTime`, `targetDays`, `targetRepeat` | Saved desired settings; `null` keeps the corresponding app value |
| `targetError` | Feedback about an invalid or unsaved wish |
| `commands.apply` | Explicitly apply this timer's saved wishes and verify the saved app result |
| `commands.clear` | Clear only this timer's wishes without changing the app timer |

Write wishes with `ack=false`. For example, select `targetTime="07:30"`, `targetDays='["mon","wed","fri"]'`, `targetRepeat=true` and the desired Boolean `targetEnabled`, then write `true`, `ack=false` to that timer's `commands.apply`. Supported time changes use **five-minute steps**. A one-off timer (`repeat=false`) requires exactly one selected weekday; its calendar date is determined and reported by the app. The adapter does not convert these times through the ioBroker host's time zone or advance an old one-off date merely by reading it.

Acknowledging a wish only means it was saved privately in the adapter. The separate Apply command requires write permission, keeps a fixed snapshot of its accepted wishes, saves app changes explicitly and reopens the timer for readback. It never presses an immediate climate or charging Start/Stop button. Enabling a scheduled timer does authorize the future operation described by the app. A changed editor's initial native arguments are not treated as its current draft, and an accepted Android input is not a persistence confirmation. Existing manual drafts are neither saved nor discarded automatically. If confirmation is uncertain, inspect the app before explicitly trying another command; writes are never automatically repeated.

The app may switch a timer on when saving it. The adapter then checks the desired enabled state and adjusts it if necessary. With `targetEnabled=null`, the desired final state is the timer's initial enabled state; the app may still enable it temporarily between Save and the subsequent correction.

After Save and directly persisted switch changes, the adapter allows **20 seconds** for the app to settle before reopening and checking the saved result. Together with navigation and full readback, this can make a write take several minutes. This wait supports app stability; it does not establish fresh vehicle telemetry.

Charging timers additionally publish read-only `climatisation`, `profileId` and `isPreferredTimesAvailable`. Applying the four timer wishes preserves those additional settings.

Under each location's `settings`, the supported wishes are `targetName`, `targetReducedAcCurrent` and `targetAutoUnlockAc`. Their read-only counterparts are `name`, `reducedAcCurrent` and `autoUnlockAc`; use that settings group's `commands.apply` or `commands.clear`. In the observed app, the **Direct charge limit** and **Charge limit** are drawn without readable numeric values. Consequently, `settings.directSoc` and `settings.socLimit` remain `null` with unavailable quality, and `settings.socReadCapability` reports `not_exposed_by_app`. These location limits have no writable SOC wishes. The separately verified global `charging.targetSoc` and `commands.applyChargingSettings` remain available and retain their existing meaning; the app states that the global limit does not apply at predefined charging locations.

Under `preferredTimes`, `window1` through `window4` publish read-only `start`, `end`, `enabled` and `editable`. Only each window's nullable `targetEnabled` can be staged; the shared `preferredTimes.commands.apply` and `.commands.clear` apply or clear those four switch wishes. `preferredTimes.targetError` reports selection errors. Start/end times remain read-only: the app instructs owners to configure the exact windows in the vehicle's infotainment system. The raw instruction is available as `preferredTimes.notice`.

Automatic reads include the new areas and use the same age, error and invalid-quality rules described above. Successful app reads do not prove newly transmitted vehicle data, and polling never applies saved wishes or requests synchronization.

### Version 0.7.0 verification

The Linux RC2 validation passed **642/642 tests**, including the POSIX checks. Byte comparisons covered **73 public source files and 42 npm-package files**. Live checks used a **Galaxy A31, Android 12 and the German Volkswagen app 4.8.1**:

| Read-only app operation | Measured duration |
|---|---|
| Both climate departure timers | 30.056 s |
| Inventory of the one existing charging location | 19.833 s |
| That location's three timers, settings and four preferred windows | 62.688 s |

Each read returned to the vehicle overview without changing app settings. The production controller also changed a disabled one-off charging timer from **Saturday 08:30 to Monday 08:35**, saved it, waited, corrected the app's automatic activation and verified the final disabled state by reopening and fully reading it. This took **152.533 s**; restoring the original timer took **151.817 s**. The restored location, timer, settings and preferred-window contents matched the baseline exactly. A Unicode location-name change together with both reduced-AC-current and automatic-AC-unlock options took **164.472 s**; restoring them took **167.846 s**, again with an exact full-model baseline match.

Enabling preferred window 1 with the production controller took **155.772 s** and was confirmed by a full location read; all other model values remained at baseline. Restoring it to `false` through the **installed version 0.7 adapter**, using `targetEnabled` and `commands.apply`, succeeded in **160.559 s**. All **62 ioBroker observation states** matched the restored baseline; both intentionally unavailable location-SOC values remained `null` with invalid quality. Acknowledgment, quality and app-reading timestamps were checked. The preferred group's `commands.clear` then cleared its four wishes without a phone job. Other wishes and synchronization-request history remained unchanged.

No climate Start/Stop or Synchronize command was issued in these checks. Five-location coverage is synthetic; the live device had one location. The one-off timer test observed Repeat changing within the draft and confirmed a final saved one-off timer; a directly saved recurring-timer scenario was not checked live. The timings above measure individual operations, not a full automatic refresh cycle, and must not be presented as a measured full-cycle duration.

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

Tests simulate phone views, ADB processes and adapter lifecycle behavior. Native process startup, real Wi-Fi connectivity and real app behavior additionally need a Linux/device smoke test. Report the phone model, Android version, app version and fixed error code in an issue; do not upload S-PINs, pairing codes, keys, enrollment files, full private UI dumps or VINs. Do not record authentication screens or export native configuration/browser-console output while credentials are present.

The release includes the adapter's own Android helper and source hashes under `lib/android`; users do not need a Java toolchain. Rebuilding that helper is a developer task requiring Python 3.9+, JDK 17 and the pinned Google R8/D8 artifact identified in `lib/android/manifest.json`:

```sh
python scripts/build-android-ui.py --jdk-home /path/to/jdk17 --d8-jar /path/to/r8.jar
```

The script checks the tool checksum, compiles only the two listed implementation sources and excludes compile-only Android API signatures from the DEX payload. R8/D8 is a build dependency and is not distributed with the adapter. The Java helper implementation is part of this project's MIT-licensed source.

Repository-checker findings and supported-platform decisions are documented in [Repository review notes](docs/REPOSITORY-REVIEW.md).

### Publishing a version

UI regression fixtures must cover the accessibility transport used by the production read. Native observations can contain hidden rendering nodes that a standard Android UI dump omits. Keep navigation checks for unknown controls and contradictory observations when adding a confirmed layout.

Keep the version in `package.json`, `io-package.json` and `package-lock.json` synchronized, add a dated changelog entry and update the translated adapter news. Merge the release commit into `main` after its checks pass, then create a matching GitHub tag such as `v0.11.3` on that commit.

The tag triggers `.github/workflows/test-and-release.yml`. Package, lint and Linux integration checks must pass before deployment. The deployment job checks that the tag matches the package version and that the commit belongs to `main`; an existing npm version is retained without another publication attempt. For a new version, the job is configured to publish to npm using GitHub OIDC trusted publishing with provenance. npm's trusted-publisher binding must match this public repository and workflow file. No npm access token is stored in the repository.

## Changelog

### 0.11.4 (2026-10-26)

- Support the additional native battery-status wrapper in the active-charging overview while preserving the visible navigation card and action guards.

### 0.11.3 (2026-10-26)

- Recognize the explicit active-charging range summary on the vehicle overview, so regular battery and charging reads can reach their existing detail view.
- Support the confirmed native accessibility layout with its hidden range display while retaining the strict visible navigation card.
- Accept the alternative SOC text only with the exact active-charging accessibility description and a matching valid percentage.
- Guard the newly supported tile against additional controls, overlapping content and changed geometry; retain existing vehicle, selection and overlay checks.
- Keep data points, permissions, saved wishes, observation validity and polling intervals unchanged.

### 0.11.2 (2026-10-26)

- Use Admin translation resources for every configuration message and declare protection for the transient, unsaved pairing code.
- Remove the unpublished 0.9.0 npm-news entry and archive older changelog entries.
- Add dependency-update and editor support, a manual release-review step and explicit review notes for intentional platform and runtime choices.
- Preserve vehicle permissions, one-attempt commands, regular reads and stored settings.

### 0.11.1 (2026-10-25)

- Recognize the verified empty, inert Compose wrapper around the charging-mode picker that 0.11.0 rejected before tapping a mode option.
- Handle delayed app confirmation within the configured outcome window through bounded reads, safe overview-to-range observation and read-only waiting after one native header return; do not repeat switching commands.
- Retain the exact three mode cards, consistent selection, geometry and overlay guards; keep data points, permissions and explicit command behavior unchanged.

### 0.11.0 (2026-10-25)

- Read the three charging modes in regular charging queries and publish a separate successful mode-observation timestamp with historical-value and quality handling.
- Add a separately persisted nullable mode wish, explicit apply/clear commands, selection-error isolation and the common switching cooldown before a mode change that may start charging.
- Keep the four existing charging settings and timer controls independent; document the departure-mode requirement for planned charging at charging locations.

### 0.10.1 (2026-10-25)

- Correct the 43 object-structure findings in the reference installation: mark command buttons write-only and use valid sensor roles for doors, windows, trunk and lock observations.
- Migrate only the affected button read flags and vehicle-access roles on existing objects, preserving their names, permissions, native fields and state values.
- Keep opening and lock Boolean meanings unchanged; update the operation manual to distinguish command buttons from separate job feedback. The metadata migration sends no phone or vehicle command.

### 0.10.0 (2026-10-25)

- Read the selected vehicle's VIN from the app's vehicle management.
- Add a separate automatic and manual vehicle-information read with freshness, error handling and historical-value preservation.
- Keep VIN observation read-only and independent of vehicle-setting and locking permissions.

### 0.9.2 (2026-10-25)

- Enable token-free npm publishing with provenance through the checked GitHub release workflow.
- Document version synchronization, the required Main checks and the matching release tag.
- Keep vehicle functions, permissions, S-PIN handling and automatic observation refresh unchanged.

### 0.9.1 (2026-10-25)

- Prepare npm distribution and submission to ioBroker's beta/latest adapter catalog.
- Update package requirements, metadata, configuration translations and standard package/integration checks for the repository review.
- Document installation and updates through ioBroker Admin, with catalog acceptance tracked separately from npm publication.
- Retain the existing vehicle controls, separate write permissions, one-attempt S-PIN handling and regular observation refresh behavior.

Older entries are in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License

Copyright (c) 2026 Borilu <borilu@fn.de>

Adapter source: [MIT](LICENSE). Third-party components retain their licenses; see [NOTICE](NOTICE).

Independent community project, not provided or endorsed by Volkswagen, Google or ioBroker. Volkswagen and Android are trademarks of their respective owners.
