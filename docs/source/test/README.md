The suite vitest runs, one folder per module, plus the conformance kit's vectors in `conformance/`. Most tests run against the real core and standard built into `native/` by `scripts/native.ts`, which these root files reach. How to run it, under Node and Bun, is in [building.md](../../building.md).

<!-- generated: source-children -->
- [benchmarks/](benchmarks/) - the benchmark gates against the kit's budgets, and proofs that a slowed path turns them red
- [bundle/](bundle/) - the bundler: its one dependency, bundled plugins, and the in-process bundle
- [conformance/](conformance/) - the kit's layer, description and host vectors, the driver, and that every vector is witnessed
- [context/](context/) - a plugin's context: services, wants and their withdrawal, and contracts on provide
- [core/](core/) - loading the core, the wrapper, its declarations, embedded NULs and failures inside a call
- [handles/](handles/) - the handle and holding tables
- [host/](host/) - the host: registration, activation, lifecycle, records, libraries, plugin services and described definitions
- [native.test.ts](../../../test/native.test.ts) - that the native libraries built from the pinned siblings load and answer
- [program/](program/) - the host program, in process and as a child process, and the helpers that run and kill it
- [real-core.ts](../../../test/real-core.ts) - a core from `native/`, every event it dispatches recorded
- [real-standard.ts](../../../test/real-standard.ts) - the standard from `native/`, and a fresh directory of files for it to read
- [standard/](standard/) - the standard module: declarations against its layouts, defaults, entries, manifests and services
- [testing/](testing/) - `scratchHome`, `setVariables`, `describedLibrary` and `freePort`
- [timer/](timer/) - the core timer: arming, re-arming and the scheduler
<!-- end generated -->
