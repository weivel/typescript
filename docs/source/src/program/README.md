The `program` module: the host program, which runs a C library serving the standard's `weivel.host` from `start` to `stop`, in process (`startHost`, `runHost`) or as the `weivel-host` command. What a run does, step by step, is in [program.md](../../../modules/program.md).

<!-- generated: source-children -->
- [alive.ts](../../../../src/program/alive.ts) - the answer of a call on the run's host, which the run destroys only once it has ended
- [bin.ts](../../../../src/program/bin.ts) - the `weivel-host` command, exiting with `main`'s code
- [index.ts](../../../../src/program/index.ts) - the module's exports
- [libraries.ts](../../../../src/program/libraries.ts) - loading the host library and every library of the plan from the `library.json` beside it
- [main.ts](../../../../src/program/main.ts) - the command line: its arguments, and the signals each platform stops a run with
- [model.ts](../../../../src/program/model.ts) - a run's options, the running host, and the planned libraries and plugins
- [plugins.ts](../../../../src/program/plugins.ts) - `PluginRun`: each plugin of the plan registered, scoped and activated alone, in order, and released on the way out
- [provider.ts](../../../../src/program/provider.ts) - `HostProvider`: the host library's `weivel.host` bound by its description
- [run.ts](../../../../src/program/run.ts) - `startHost` and `runHost`: one run from `start` through ticks or an action to `stop`
- [scopes.ts](../../../../src/program/scopes.ts) - opening a plugin's scope and offering it alone the definitions the scope answers
- [stop-request.ts](../../../../src/program/stop-request.ts) - a run's stop request, read from an abort signal, and the wait for the next tick
<!-- end generated -->
