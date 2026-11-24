The `core` module: the core's C declarations laid out for koffi, the binary loaded once per path, and one wrapper every call goes through, which makes the call, drains the event queue, copies each event out and dispatches it in the core's order, so the dispatcher is never re-entered. How it reads the contract is in [core.md](../../../modules/core.md).

<!-- generated: source-children -->
- [answers.ts](../../../../src/core/answers.ts) - the answers the core's calls give, as values: plans, edges, implementations, ledger rows
- [constants.ts](../../../../src/core/constants.ts) - the core's status, refusal and log level codes, a code a newer core adds arriving as its number
- [core.ts](../../../../src/core/core.ts) - loading the binary and the wrapper: each call, its drain and dispatch, the deadline and clock hooks, the error sink
- [declarations.ts](../../../../src/core/declarations.ts) - the core's structs and function signatures for koffi, every type anonymous
- [deferred-step.ts](../../../../src/core/deferred-step.ts) - a step queued among events, run when handling reaches it
- [events.ts](../../../../src/core/events.ts) - the core's events as values, and what an event the layer could not copy whole carries
- [index.ts](../../../../src/core/index.ts) - the module's exports
- [library-file.ts](../../../../src/core/library-file.ts) - the file name CMake gives a shared library or a program on each platform
- [memory.ts](../../../../src/core/memory.ts) - reading and writing the core's memory: sized structs, decoded fields, refusals and lists
- [text.ts](../../../../src/core/text.ts) - a text handed to C, refused with `EmbeddedNulError` when it holds a NUL
- [values.ts](../../../../src/core/values.ts) - what a caller hands the core and what it answers: manifests, offers, wants, constraints, refusals
<!-- end generated -->
