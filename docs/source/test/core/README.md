Tests of the `core` module: loading, the wrapper and its drain, and calls that fail.

<!-- generated: source-children -->
- [core.test.ts](../../../../test/core/core.test.ts) - loading the core, every bound call, events of an unknown kind, and answers
- [declarations.test.ts](../../../../test/core/declarations.test.ts) - the declarations of `core.h`
- [embedded-nul.test.ts](../../../../test/core/embedded-nul.test.ts) - a text with an embedded NUL refused before the core is called
- [failures.test.ts](../../../../test/core/failures.test.ts) - an answer whose read throws, a call that throws, and a failing drain
- [wrapper.test.ts](../../../../test/core/wrapper.test.ts) - the core's creation, and an event the layer cannot copy whole
<!-- end generated -->
