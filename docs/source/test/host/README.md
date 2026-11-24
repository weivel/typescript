Tests of the `host` module against the real core, the standard and their test libraries.

<!-- generated: source-children -->
- [activation-step.test.ts](../../../../test/host/activation-step.test.ts) - activation as one step of a dispatch, a refused plan, and what an outcome carries
- [contract.test.ts](../../../../test/host/contract.test.ts) - registration, verification and release as the core's contract states them
- [definitions.test.ts](../../../../test/host/definitions.test.ts) - a definition service registered without a description, when its binary closes, and a registration awaiting releases
- [description-bind.test.ts](../../../../test/host/description-bind.test.ts) - binding a description, and every way a changed description refuses the load
- [description-blocking.test.ts](../../../../test/host/description-blocking.test.ts) - an operation marked blocking running on the worker thread with the event loop free
- [description-carried-lifetime.test.ts](../../../../test/host/description-carried-lifetime.test.ts) - a definition an answer carried, once that answer is released
- [description-cycle.test.ts](../../../../test/host/description-cycle.test.ts) - a struct pointing at itself, or through a cycle, in either order
- [description-definitions.test.ts](../../../../test/host/description-definitions.test.ts) - a definition an answer carries, and one a host got some other way
- [description-limits.test.ts](../../../../test/host/description-limits.test.ts) - the depth limit, reached on any stack
- [description-unload.test.ts](../../../../test/host/description-unload.test.ts) - unloading a library while a blocking call runs in it
- [description.test.ts](../../../../test/host/description.test.ts) - a described definition loaded through the host and called
- [host.test.ts](../../../../test/host/host.test.ts) - registration, plugins the standard discovers, and activation in the core's order
- [libraries.test.ts](../../../../test/host/libraries.test.ts) - a C library loaded as host services
- [lifecycle.test.ts](../../../../test/host/lifecycle.test.ts) - activate, deactivate, release, quarantine and destroy in order
- [plugin-services.test.ts](../../../../test/host/plugin-services.test.ts) - a service the host offers one plugin
- [records.test.ts](../../../../test/host/records.test.ts) - the host's record of a plugin, and a plugin's context
- [surface.test.ts](../../../../test/host/surface.test.ts) - what the host hands its caller, and the core's public surface
- [without-standard.test.ts](../../../../test/host/without-standard.test.ts) - a host created without the standard loads no standard library
- [world.ts](../../../../test/host/world.ts) - the test libraries' paths and the plugins the tests generate
<!-- end generated -->
