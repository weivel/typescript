The `context` module: one context per plugin, built once the core has opened it and detached once the core has forgotten it, holding the tables every context of one core shares. Events the core queued during a call are held until that call has recorded its answer, then handled in the core's order. How it reads the contract is in [context.md](../../../modules/context.md).

<!-- generated: source-children -->
- [capabilities.ts](../../../../src/context/capabilities.ts) - `capabilities`: providing an implementation, checked against its contract, and listing and watching the verified ones
- [capacity.ts](../../../../src/context/capacity.ts) - answering the core's capacity questions with a registration's capacity provider
- [contexts.ts](../../../../src/context/contexts.ts) - `PluginContexts`: every plugin's context on one core, the events routed to them, and services offered plugin by plugin
- [deferred-events.ts](../../../../src/context/deferred-events.ts) - holding the core's events until the call that drained them has recorded its answer
- [event-handlers.ts](../../../../src/context/event-handlers.ts) - what each core event does to the contexts: settled wants, watches, revocations and refusals
- [index.ts](../../../../src/context/index.ts) - the module's exports
- [model.ts](../../../../src/context/model.ts) - the types a plugin sees: service and capability keys, options, the logger and events
- [refusal.ts](../../../../src/context/refusal.ts) - `RefusalError`, `ContractMismatchError` and `DetachedError`, and the error a refused call becomes
- [services.ts](../../../../src/context/services.ts) - `services`: registering, getting, wanting and watching services, and releasing a holding
- [state.ts](../../../../src/context/state.ts) - the shared tables and the attachment that tells whether a context still reaches the core
<!-- end generated -->
