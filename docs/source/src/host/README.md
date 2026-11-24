The `host` module: one host per core registers, activates, releases and forgets plugins and offers its own services and C libraries to them; every decision is the core's, and once destroyed every call answers `hostDestroyed` as a value. It never needs the standard. How it reads the contract is in [host.md](../../../modules/host.md) and [libraries.md](../../../modules/libraries.md).

<!-- generated: source-children -->
- [activation-failure.ts](../../../../src/host/activation-failure.ts) - `ActivationFailure`, the reason a quarantine carries when an activate fails
- [core-log.ts](../../../../src/host/core-log.ts) - writing a log the core queued to the host's logger at its level
- [description/](description/) - binding a definition from the description its library answers
- [frozen-copy.ts](../../../../src/host/frozen-copy.ts) - a deep, frozen copy of a plain value, as `register` keeps a manifest
- [host.ts](../../../../src/host/host.ts) - `Host`: registration, activation as a step of a dispatch, verify, release, destroy, the ledger and loaded libraries
- [index.ts](../../../../src/host/index.ts) - the module's exports
- [libraries.ts](../../../../src/host/libraries.ts) - loading a C library's functions as host services, its contracts, the errors a call throws, and closing the binary once every holding ends
- [model.ts](../../../../src/host/model.ts) - the types a host's caller uses: a plugin's entry, options, outcomes and the destroyed answer
- [settling.ts](../../../../src/host/settling.ts) - running a continuation once a value settles, at once when it is no promise
<!-- end generated -->
