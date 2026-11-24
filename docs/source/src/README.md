The package's modules, one folder each, every one a subpath `@weivel/typescript/<module>` reached through its `index.ts`. Each folder's doc says what its files hold; what the module does, as this package reads the core's contract, is in [modules/](../../modules/).

<!-- generated: source-children -->
- [benchmarks/](benchmarks/) - the language's half of the platform's benchmarks: the measured paths, the sampling and the kit's budgets
- [bundle/](bundle/) - the bundler of plugin entries and the host program, over esbuild
- [conformance/](conformance/) - the driver that runs the kit's layer vectors through this package and reports what it saw
- [context/](context/) - what a plugin sees of the core: services, capabilities, events, wants and its log
- [core/](core/) - loading the core's binary through koffi, its declarations, and the one wrapper every call goes through
- [handles/](handles/) - the tables from the core's handles to this package's objects
- [host/](host/) - registration, activation, release and destroy, and C libraries offered as host services
- [program/](program/) - the host program that runs a C library serving `weivel.host`, in process or from a command line
- [standard/](standard/) - the standard's defaults: manifests, discovery, identities, library declarations and its services
- [testing/](testing/) - helpers for the tests of a program that hosts plugins
- [timer/](timer/) - the clock and the scheduler, and the timer that arms the core's next deadline
<!-- end generated -->
