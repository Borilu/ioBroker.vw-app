# Disposable timer-fix CI branch

This branch is for an isolated validation run of the exact timer fix only. It deliberately removes the normal release workflow so no release or npm-publishing job can start on this test branch. **Do not merge this branch or its workflow deletion into the adapter source.** Use the separately reviewed timer-fix commit for any later integration.

The job uses a GitHub-hosted Linux runner, read-only repository permission, pinned official checkout/Node/Java actions, and no supplied credentials or host/phone access. It installs locked dependencies, tests Java/JavaScript timer-editor parity, runs the Node suite and official ioBroker package and fresh-installation harness. The latter installs a temporary synthetic ioBroker environment; it does not configure a phone or send a vehicle command. Dependency installation and the official package checks use npm; there is no registry publication or release step.

The crash test creates a private synthetic temporary directory, starts one child that persists the real execution fence, kills only that child, and checks that a new process refuses to start its runtime before any spawn. It does not claim to test Android-side completion or recover a real installation. Cleanup removes only the test's own temporary directory after the fixture has exited.
