Tests of the host program, in process and as a child process, and the helpers that bundle, run and stop a child on each platform.

<!-- generated: source-children -->
- [child.ts](../../../../test/program/child.ts) - a relocated bundle of the program, a child run of it, its stop request, and killing every child left
- [console-relay.ts](../../../../test/program/console-relay.ts) - on Windows, a child run in a console of its own that is sent CTRL_BREAK_EVENT
- [in-process.test.ts](../../../../test/program/in-process.test.ts) - `startHost`: the running host, its services and its stop
- [process-tree.ts](../../../../test/program/process-tree.ts) - a process and every process descended from it
- [program.test.ts](../../../../test/program/program.test.ts) - the host program's start, serve run and command line
- [provider.test.ts](../../../../test/program/provider.test.ts) - the provider's tick: the next time for `has_next` 1, none for 0, and any other a malformed answer
- [scopes.test.ts](../../../../test/program/scopes.test.ts) - a plugin's scope that cannot be offered in full
- [stop-request.test.ts](../../../../test/program/stop-request.test.ts) - a run's wait for its next tick
- [world.ts](../../../../test/program/world.ts) - the kit's `stub-host`, a host vector laid out, run and judged, and its bound
<!-- end generated -->
