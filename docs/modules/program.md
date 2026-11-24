# The `program` module: the host program

How this package reads the core's `docs/contract/program.md`, and how to run the host program. The code is in
[src/program/](../source/src/program/README.md).

`program` runs any C library serving the standard's `weivel.host` (`weivel/host.h`): `runHost(options)` answers a
promise of the exit code, and `node dist/program/bin.js <host library> <arguments...>` (the package's `weivel-host`)
is the same run from a command line, SIGINT and SIGTERM, or SIGINT and SIGBREAK on Windows, its stop request.
`startHost(options)` is the same run hosted by a process that goes on doing its own work: it answers a `RunningHost`
once `started` has been told, or once the run ended before that, whose `service(plugin, id)` answers the object the
plugin of that `importName` itself registered under `id` and still has registered, whose `stop()` requests the stop
and answers the exit code, every call the same one, and whose `ended` settles with that code however the run ends;
`runHost` is `startHost` waiting for `ended`. The
library's declaration is the `library.json` beside its binary. The program loads it, asks `start` for the plan, loads
the plan's libraries and activates its plugins one at a time in the plan's order, each entry's export `default`
unless `entryExport` names another, tells `started`, then ticks in a SERVE run or calls the named action in an
ACTION run and tells `finished`, releases every plugin and then its scope, and calls `stop` last, exiting with its
code. It withholds `weivel.host` and `weivel.scope` of every library it loads from every plugin. Immediately before
each activation it opens the plugin's scope from the first loaded library serving a described `weivel.scope`, the
host library first, and offers that plugin alone each definition the scope answers under the standard's ids
(`weivel.config`, `weivel.secrets`, `weivel.paths`, `weivel.log`), bound by its description; with no such library it
offers nothing, and a refused scope tells the plugin as `refused`, never activated. It reads the
clock and passes it in; every other decision is the library's. A plugin that cannot be registered, its manifest
unreadable or refused, is told as `refused` with why; an activation that throws, as `failed` with the reason its
quarantine carries. Once `start` answered OK, whatever ends the run early, a refusal or a library that will not load,
is logged and `stop` is still called. A tick answering a `has_next` other than 0 or 1 is malformed and ends the run
the same way. A scope whose definitions cannot be offered, as when a loaded library declares one of the standard ids,
tells that plugin as `refused` with why, every definition already offered withdrawn and the scope released, and the
next plugin is attempted. A NUL inside an outcome's detail or an
action's failure is written as `\0`. A stop request during an ACTION run's action takes effect once `finished` was
told. An ACTION plan naming both `action_service` and `action_method` calls that method of the object the action's
plugin itself registered under that service id, never an entry's action: a method is a function-valued property of
that object, called on it with the action's arguments and answering as an action does. A plan naming only one of the
two, or either as an empty text, ends the run as a malformed answer, before any library is loaded. A library that
will not load ends the run there, no plugin activated. Loading and activating is one phase: a stop requested during
it, or before `start` answered, takes effect once `started` was told every plugin's outcome, and the run then calls
`stop` with no tick and no action; one during a later call takes effect once that call returns.
The `default` export is this language's convention for an entry, not the standard's.
The core plans each activation over capabilities, under which a consumed one is always optional, so the plan's order
is the library's alone.
