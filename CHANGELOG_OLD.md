# Older changelog

Historical releases before npm distribution. These entries are documentation, not published npm-version announcements.

### 0.9.0

- Add explicit lock/unlock buttons with a separate opt-in permission and a masked S-PIN setting using ioBroker's encrypted/protected native configuration.
- Limit authentication to one attempt per accepted command; persist a conservative block across restarts after rejection or an uncertain result, with an explicit Admin-only reset.
- Keep locking observations in the existing regularly refreshed `vehicleAccess` area, with read-only follow-ups and no automatic command replay or target reconciliation.
- Keep the PIN out of adapter states, results, journals and logs; document the trusted-host boundary and upstream Admin browser-console limitation.

### 0.8.0

- Read each of four doors, four windows, the trunk and the separate lock state from the app overview.
- Add a read-only refresh command and regular updates with independent age, validity and error metadata.
- Keep unavailable observations unknown and preserve historical values with invalid quality after read failures or expiry.

### 0.7.0

- Read, stage and explicitly apply the two climate departure timers and three timers per existing charging location.
- Discover up to five vehicle-created locations with stable native bindings and separate refresh/age metadata.
- Support location names, reduced AC current, AC plug unlocking and preferred-window enable switches; preserve unavailable Canvas SOC values as unknown.
- Keep preferred start/end windows read-only, preserve manual drafts and verify saved timer changes after reopening.
- Include an own Android UI helper inside the existing adapter/ADB lifecycle, with no additional daemon or phone APK installation.

### 0.6.0

- Refresh climate, battery/charging and the vehicle report fairly with completion-based scheduling and recovery pauses.
- Give manual commands priority over automatic reads and prioritize a read after a control command without repeating writes.
- Publish separate per-area read-age, duration and error metadata; distinguish app-read freshness from vehicle telemetry freshness.
- Enable a 15-second minimum completion interval for new instances while retaining existing disabled polling settings.

### 0.5.0

- Read the Volkswagen app's vehicle status report on request through one read-only report command.
- Publish odometer and service texts, safely derived numeric values, the summary, all seven categories, notices and additional texts, plus the normalized JSON report.
- Keep app synchronization hints separate from the report-reading timestamp and preserve unknown texts without inventing icon colors, severity or diagnoses.
- Isolate report failures from climate and charging observations; no report writes or automatic synchronization are added.

### 0.4.0

- Read the battery percentage and remaining range in km from the app, with an explicit app-reading timestamp.
- Explicitly request app synchronization once and retain its request timestamp separately from app reads; no completed vehicle synchronization is claimed.
- When optional polling is enabled, read climate first and charging only if the phone remains free; never synchronize automatically.
- Stage, persist, apply or clear the charge limit, reduced AC charging current, automatic AC plug unlocking and optimized battery use preferences.
- Validate the charge limit against the six native slider positions from 50 to 100 %, save changes once and verify the saved app settings after reopening.
- Keep charging preferences, selection errors and observations separate from climate control; no charging Start/Stop command is provided.

### 0.3.0

- Stage and persist mode, climate-on-unlock, automatic window heating and front-zone preferences separately from observed app settings.
- Apply or clear those four preferences without pressing Start/Stop or applying temperature.
- Use the accepted preferences for Start, preserve the previous air-conditioning-only behavior when no mode is selected, and reject mode changes during an active operation.
- Save app drafts once, verify them after reopening, then select the final mode using its exact label.
- Verify the settings flow with 220 Linux tests and real-device app checks while climate remains off.

### 0.2.0

- Persist a selected target temperature from 16 to 29.5 °C in 0.5 °C steps and apply it before the next start.
- Apply a temperature without starting climate control, read the selected app temperature, or clear the staged selection.
- Verify each picker step and preserve the last accepted target across adapter restarts.
- Allow a 300-second overall job budget for temperature selection and delayed app confirmation.

### 0.1.1

- Wait up to 120 seconds for a delayed app response within a 180-second overall job budget.
- Read the active climate description on the vehicle overview and expose the app confirmation source.
- Keep waiting when the overview does not yet confirm the active detail screen; never repeat a start automatically.

### 0.1.0

- Initial native ioBroker adapter with private managed ADB runtime, WLAN setup, calibrated start/stop/status and persistent command cooldown.
