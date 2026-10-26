# Repository review notes

This file explains the repository-checker findings reviewed for 0.11.2. A warning is not evidence that a vehicle command failed. Catalog admission remains a separate manual review: [LATEST request #7006](https://github.com/ioBroker/ioBroker.repositories/pull/7006).

## Corrections

- **W2004:** remove the unpublished 0.9.0 entry from `common.news`. Its historical description remains in `CHANGELOG_OLD.md`; it is not retroactively published to npm.
- **W5015 / W5617:** enable Admin resource-based i18n and supply all configuration texts, including validation, connection status and setup results, in all eleven supported languages.
- **W5057 / W5058:** list the masked `_pairCode` field in both top-level protection declarations as defense in depth. It still has `doNotSave: true`, no native default and is only supplied to the explicit pairing request. This does not turn the one-time code into a saved setting. The persistent Volkswagen S-PIN remains separately encrypted and protected.
- **W5051:** give the departure-navigation helper the descriptive name `waitForScreen`. It polls for a validated screen with the controller's existing deadline, cancellation and pause handling; it does not implement another sleep function. Its behavior is unchanged.
- **W6020:** move older historical entries to `CHANGELOG_OLD.md` and retain a link from the current changelog.
- **S0065 / S4036 / S5026 / S5601 / S8901:** add Node 22 editor typings, official ioBroker JSON schema associations, the release tool's manual-review plugin, short-format Admin translation files and weekly Dependabot checks for npm dependencies and GitHub Actions. The translation format is already supported by the minimum Admin 7.6.20. Dependency updates create reviewable pull requests; they do not merge or publish automatically.

## Findings retained deliberately

- **W4001:** the adapter cannot be present in LATEST before its [existing admission request](https://github.com/ioBroker/ioBroker.repositories/pull/7006) is accepted. Do not add a second request or claim admission prematurely.
- **W5042:** `@iobroker/testing` is already a **devDependency**. Only `testing/integration.cjs` and the package test harness use it; neither is included in the npm runtime package. The checker classifies the `testing/` directory as production source and looks only in `dependencies`. Moving the test framework into production dependencies would be incorrect; moving files only to evade this heuristic would not improve the adapter. The official package and integration checks exercise the real dependency declaration.
- **W5049:** `lib/runtime.js` reads and copies the inherited process environment for the ADB **child process**. It never changes `process.env`. The copy removes inherited Android overrides and sets this instance's private Android home and server socket. This is needed to isolate its keys and ADB server from other tools while retaining normal child-process startup variables. Runtime tests verify that the global environment remains unchanged and the child receives only the intended Android overrides.
- **W1095 (newer checkers):** `_pairCode` is intentionally listed for protection without adding a `native._pairCode` default. It is a transient `doNotSave` input. The protection declarations do not create a stored value; adding a persistent setting only to satisfy the check would contradict that design. Tests verify both the declaration and the absence of a native default.
- **S1039:** compact mode remains disabled. The adapter manages a private ADB child process, filesystem lock and connection lifecycle. Shared-process compatibility requires explicit lifecycle and isolation tests before support can be claimed.
- **S3031:** only Linux hosts are currently supported and tested. The managed runtime uses Linux-specific ADB binaries and filesystem behavior. Windows and macOS must not be advertised as supported without their own implementation and integration checks. This does not restrict the user's browser or Android phone.
- **S0085 / S0087:** this is a JavaScript project. A full JavaScript type-check migration needs useful annotations and a complete check in CI; adding an empty or unchecked TypeScript configuration merely to silence a suggestion would not provide that. Node typings support editor feedback; the current executable checks are the unit, package and integration suites plus ESLint.
- **S8913 (newer checkers):** Dependabot updates require review and passing tests. Automatic merging is deliberately not enabled for an adapter that can operate a vehicle.

## Unchanged operational boundaries

These maintenance changes add no vehicle commands or data points. Regular reading, per-observation timestamps, stale/error quality, explicit wishes, command serialization and one-attempt S-PIN authentication retain their existing behavior. The temporary pairing code must never be copied into `native`, logs or published artifacts. The S-PIN must continue to be entered by the user only in the masked Admin field. Privileged host access and the documented upstream Admin-console limitation still apply; protection declarations are not a promise of absolute secrecy.
