## What this is

The TypeScript language implementation of weivel. It binds the C core (`weivel/core`) and the C
standard (`weivel/standard`) through koffi and decides nothing itself: compatibility, order, reach,
waiting, revocation and constraints are the core's answers, and the manifest format is the
standard's. It is held to the vectors in `weivel/conformance`.

## Modules

`src/` holds the modules every language implementation of weivel holds, in the order the core's
`MODULES` list names them: `core`, `handles`, `timer`, `context`, `host`, `standard`, `conformance`
and `benchmarks`, and `program`, the host program, which that list does not name yet. Each is a subpath of the
package, `@weivel/typescript/<module>`.

## A plugin's entry

In TypeScript a plugin's entry is an object with an `activate(context)` and an optional `deactivate()`, either
of which may answer a promise. The host takes it beside the manifest value, as `host.register(manifest, entry)`,
and never needs the standard. The `standard` module feeds it from disk: `registrationOf(discovered, exportName)`
turns a plugin the standard discovered into its manifest and an entry whose `activate` imports the module and
activates the export named `exportName`. The caller names that export; the layer assumes none, `default` included.
The entry may also carry `actions`, a record of name to function taking a run's arguments as a value tree and
answering one, or nothing, at once or as a promise: what a host program's ACTION run calls.

An activate settles at once when it returns something other than a promise, or throws. A promise is read when it
settles, since its state cannot be read sooner, so an `async` activate is verified after the plan has started.

## How TypeScript reads the contract

- `host.activate` starts the plan as one step of a dispatch: as the dispatcher when no dispatch runs, so what the
  activates' own calls queue is dispatched once every activate of the plan has been called, and as a call made inside
  the dispatch that runs otherwise. An activate that settled at once is verified, and quarantined if the core refuses,
  before the next plugin starts. A plan the core refuses is answered as `{ refusal }`, with no plan and no outcomes,
  never thrown.
- An outcome's `refusal` is the one that decided it: the core's refusal of the open for `refused`, the core's refusal
  of the verification for a `quarantined` plugin that refusal quarantined, and none for a plugin quarantined for a
  reason of the host's, such as an activate that failed, whose reason its ledger row keeps.
- `host.ledger()` answers the core's ledger, every plugin's row as the core keeps it, and `onTimerMove` in the host's
  options hears each move of its timer, the deadline it arms or `undefined` when it disarms. The host hands its caller
  nothing of the wrapper: the core, the contexts and the wrapper's dispatch, clock and deadline hooks are reached only
  by this package's own modules, never through its exports.
- A host given no `scheduler` arms `setTimeout`, through `createSystemScheduler`.
- A want answers a promise with a `withdraw()`: it withdraws a want the core still holds waiting, which then never
  settles, and answers `true`; for a want that has settled already, its settlement still delivered, or one withdrawn
  already or never made, it answers `false` and withdraws nothing.
- A text the caller hands that crosses into C as a `const char *` (an id, every text of a manifest, a reason, an
  option, a path or a symbol) and holds a NUL is refused before the core or the standard is called: it throws, or for
  `want` rejects, an `EmbeddedNulError`, reported to no sink. A text the standard takes by its length, such as an
  identity or a JSON document, crosses whole and is not refused. The host's own reason for a plugin whose activate
  threw writes each NUL of what it quotes as `\0`.
- A `Scheduler` is handed the time a wait ends at, on the clock's scale, not a delay, so the timer reads the clock
  only when its callback runs and when it schedules on a scheduler that declares a `maximumWaitMilliseconds`. The
  default scheduler, `createSystemScheduler(clock)`, can wait any time: it chains `setTimeout`s past its longest delay,
  and reads the clock as it schedules, to turn the time into a delay. A scheduler whose `schedule` or `cancel` throws
  is reported to the error sink, and the timer counts itself disarmed.
- A context reads the clock for a want only when it has a timeout, a budget or a poll interval, and for each capacity
  answer it reports, since `weivel_report_capacity` always takes the time.
- An event the wrapper could not copy whole is still dispatched, with `incomplete: true`: every handle, code and
  number exact, each text the core gave `TEXT_NOT_COPIED`, and a capacity question's constraints left out. The error
  sink is told once, and an incomplete capacity question is left unanswered.
- `WEIVEL_STATUS_MALFORMED` is reported to the error sink as a defect of the layer only for a call the layer built
  whole. A call carrying what its caller made (a manifest, an edge source, options, a reason, an id, a time or a
  capacity answer) is answered with the core's refusal and reported nowhere.
- A listener, a plugin's event listener or a capacity answerer that throws is reported to the error sink, never to a
  plugin's log.
- A context is built before its plugin is first opened, and no event the wrapper drained before it was built reaches
  it. A plugin opened again, by `open` or `activate`, keeps the context it has: an open the core refuses, of a plugin
  open or activating, is answered with that refusal and builds nothing, and a quarantined plugin opened again keeps
  its context.
  Once the core has forgotten the plugin the context is detached: a call that would reach the core throws, or for
  `want` rejects, a `DetachedError`, which is not a `RefusalError`, and reaches nothing. A want still pending then is
  settled by the core's own settlement of it, already queued.
- `services.get` answers undefined only when nothing is registered under the id. A refused `get`, `services.ids`,
  `services.watch`, `capabilities.all` and `capabilities.watch` throw the core's `RefusalError`, or an `Error` naming
  the status alone where the core queued no refusal, as for a refusal of reach already reported once. A refusal of
  reach also reaches the plugin's event listeners.
- A want the core settles with a registration the layer holds no object for is rejected with an `Error` that carries
  no refusal, and that error is reported to the error sink as a defect of the layer.
- `host.register` registers, keeps and answers a frozen copy of the manifest it is handed.
- `host.verify` of a plugin the host holds nothing of open answers the core's answer, `active` or `refused`, and
  quarantines nothing; for a handle it never registered the outcome's `importName` is undefined.
- `host.release` answers `true` once the release has run, and `false` at once, doing nothing, for a plugin the host
  has not opened: one registered only, or one already forgotten.
- `host.destroy` makes the host quiet the moment it is called, starts no plugin of a plan not yet started (each
  answered `released`), and waits for every release under way, however long its deactivate takes.
- `host.loadLibrary` throws, reporting to no sink, for an id declared twice or already registered; and
  `registerHostService` throws for an id a live library declares. A load the core refuses partway is undone as an
  unload before it throws: what it registered is unregistered and its binary closed.
- A definition service that declares no description is registered as a frozen `LibraryDefinition`,
  `{ library, pointer }`: the import name it came from and koffi's pointer to the very struct its symbol answered,
  never a copy. A definition that answers NULL, or a struct whose `size` is below `2 * sizeof(void *)`, makes
  `loadLibrary` throw, as the caller's mistake, before anything is registered.
  `LoadedLibrary.definitions` hands its caller the same raw addresses, and that caller holds no registration of
  them, so its use keeps nothing open: each address dies with the binary.
- A definition service that declares a `description` is registered as its `BoundDefinition`, built from the
  description alone (`src/host/description/`): no file of this package names a type of any library it binds. The
  host never loads the standard, so its caller hands it the standard's check as `descriptionCheck`
  (`(description) => standard.checkDescription(description)`); a host given none refuses a library that declares a
  description, and a check answering OUT_OF_MEMORY makes `loadLibrary` throw an `OutOfMemoryError`, never the
  caller's mistake. At the load each description is checked, then read, and every struct it names is built as a koffi
  struct from its members in order, each member's offset and size and the struct's size compared with what koffi
  computes, and a definition's operations laid among its members by offset; any difference, or a kind this binding
  does not know, refuses the load as the caller's mistake. Which kinds each role takes, the shape of a refusal and a
  release, and where the context lies are the check's rules, which this binding does not repeat. The layouts and every
  operation's prototype are built once there, never on a call. Beside each struct's layout the load builds the struct
  koffi writes from a JavaScript value, its texts, arrays and the structs they reach typed, so a call hands koffi one
  checked image per input and koffi writes it during the call; only a value tree, and a struct reached through a
  cycle of two or more structs, which no koffi struct can name, are written into the call's own memory. Each
  operation keeps one answer block per answer and one refusal block, emptied before every call, and reads them through
  a view of their memory, so a scalar costs no call into koffi. The one hand layout is `description.h`'s, beside the
  standard module's layout of `value.h`, and both are checked against the standard's `layouts` program.
- A `BoundDefinition` is a frozen object with no prototype holding one async method per operation that answers a
  status, named as the operation; the releases are not methods, since the binding calls them. `boundDefinitionOf`
  answers the `{ library, pointer }` it stands for. A method takes one object keyed by its input parameters' names,
  a left-out input its kind's zero (0, NULL, or an empty array, bytes or texts): a number for a u32 or an f64; a number
  that is a safe integer or a bigint for a u64, an i64 or a size, refused beyond the kind's range; a string or null for
  a text; an array of strings and nulls for texts; a `Uint8Array` for bytes; an array for a counted array; a plain
  object for a struct, held or pointed at, keyed by member name; a native value (null, boolean, finite number, string,
  array, plain object) for a value tree, `undefined` standing for NONE only at its root, and for a pointer to a value
  `none`, a value of kind NONE where `undefined` is NULL; and a handle object for a
  handle. Every `size` and every count the binding fills itself, and a caller writing one, or naming anything the
  operation or struct does not take, is refused with a `TypeError` before the call, as is a value its kind does not
  hold; a text holding a NUL is refused with an `EmbeddedNulError`. Structs nest at most 1000 levels below the one
  a call takes, `WEIVEL_STANDARD_VALUE_DEPTH_LIMIT` as for a value tree, and a deeper input is refused with a
  `TypeError` before the call.
- A method resolves on OK with the answer copied into JavaScript values: a single answer parameter as its value, more
  than one as an object keyed by parameter name, none as `undefined`. A struct answers every member but its leading
  `size`, its counts, its context and storage, a NULL pointer, a NULL handle and a value of kind NONE; an integer of
  64 bits answers as a number within 2^53 and a bigint beyond; a NULL counted array, texts or bytes answers empty. On
  NONE it resolves with `none`, a symbol of the host module. On any other status it rejects with a
  `DescribedCallError` carrying the `operation`, the `status`, and the refusal's `detail` and `fix` for REFUSED, both
  null otherwise. Every answer and the refusal are released in a `finally` through the release the description names
  for them, a struct or a tree through the answer handed in; an answer naming no release, as a text the provider
  keeps, is released by no one. An answer nesting structs deeper than 1000 levels, or a value tree holding a key twice
  in one record, is the provider's fault and rejects with an `Error`, its answer released all the same.
- A handle answer becomes a frozen object whose only member is `release()`, handed back as an input of an operation
  taking that handle type. `release()` frees it once through the release its description names; a second call, or one
  after the unload, does nothing, and a released handle handed as an input is refused with a `TypeError`. The unload
  releases every handle of the library still held, while the binary is still open.
- The call itself runs on the calling thread when the method is called; the promise is the method's shape, not a
  worker. A holding outlives the unload, so a bound method stays callable until the binary closes, and rejects with a
  `LibraryUnloadedError` from then on. An operation named `then` refuses the load, since it would make the bound
  object a thenable that every `await` calls.
- An operation whose pointer lies past the `size` its definition answered, or is NULL there, is not offered: its
  method rejects with an `OperationNotOfferedError`, the caller's mistake, before anything is called. An element of a
  pointer or an array this binding does not know, or a struct element the description does not describe, refuses
  the load. The walks that write and read structs keep their own stack rather than recursing, so the depth limit is
  reached on any stack.
- A holder lets go of a revoked definition by calling the `release()` of the `revoked` event it was handed, once it
  has released everything the definition gave it; for any other revocation `release()` does nothing. A holding a
  watch made counts the same. The event object grants the release: whoever the plugin hands it to can end the
  plugin's holding. A call through the definition after the release is the holder's defect and undefined, as any use
  of memory after its free is. The binary is closed once every definition service of the library has had every
  holding released since the unload, a holder the host released, quarantined or forgot counting as released, or
  once the host's destroy has destroyed the core, after which every address a definition answered is invalid. A bytes answer is copied and released before its call answers, so no held bytes keep
  the binary open.
- A plugin registers with `{ awaitReleases: true }` to keep each holding of its service past its revocation, and
  hears a `holdings-released` event, carrying the id and the object it registered, once every holding has ended.
  An owner hears the event its own release or quarantine call queued, as when nothing held the registration then;
  one queued after those events, or after it was forgotten, reaches no one.
- The definition row of the `library-call` benchmark samples in shorter rounds than the same-language pair: 100000
  warm-up calls, then 201 rounds of 200 calls per path, against the pair's 2000000 warm-up calls and 301 rounds of
  10000. Each path is handed the struct's address itself and reads its operations out of it once, before the timed
  loop.
- The `described-call` benchmark times the standard's `described` mirror's `reflect`, a sample holding a text and a
  counted array of three texts, through the bound object a consumer resolved, over the same operation through a bare
  koffi binding of the fixture's structs declared by hand in the benchmark, the one file that declares them. Both
  release the answer and the refusal after every call; the hand path keeps one answer and one refusal block across
  calls. It samples as the `library-call` rows do, with the echo library's bytes call in the same rounds for its time
  beside theirs, and the bound method's promise is not awaited in the timed loop.
- A library function that answers a status other than 0 throws a `LibraryCallError` carrying the status and the body
  as bytes, and the body's `text` only where it is UTF-8.
- The core's and the standard's library paths default to the package's own `native/`, which the package's build
  fills; a caller passes any other path. The default names the package's layout, never a file of its user's.

## The host program

`program` runs any C library serving the standard's `weivel.host` (`weivel/host.h`): `runHost(options)` answers a
promise of the exit code, and `node dist/program/bin.js <host library> <arguments...>` (the package's `weivel-host`)
is the same run from a command line, SIGINT and SIGTERM, or SIGINT and SIGBREAK on Windows, its stop request. The
library's declaration is the `library.json` beside its binary. The program loads it, asks `start` for the plan, loads
the plan's libraries and activates its plugins one at a time in the plan's order, each entry's export `default`
unless `entryExport` names another, tells `started`, then ticks in a SERVE run or calls the named action in an
ACTION run and tells `finished`, releases every plugin, and calls `stop` last, exiting with its code. It reads the
clock and passes it in; every other decision is the library's. A plugin that cannot be registered, its manifest
unreadable or refused, is told as `refused` with why; an activation that throws, as `failed` with the reason its
quarantine carries. Once `start` answered OK, whatever ends the run early, a refusal or a library that will not load,
is logged and `stop` is still called; a stop request takes effect at the next step, once the call under way returns.
The core plans each activation over capabilities, under which a consumed one is always optional, so the plan's order
is the library's alone.

## Siblings and native libraries

`repo.json` pins `core`, `standard` and `conformance` by commit under `siblings/`. CI checks
them out there; locally, link or clone each checkout into `siblings/`. `scripts/native.ts` builds
the core and the standard as shared libraries with CMake and copies them into `native/`, which git
ignores, and the tests' fixtures into `native/test/`: the core's `echo`, the standard's
`weivel_standard_described`, which the description vectors bind, the standard's `layouts` program, which the
hand layouts are checked against, and the kit's `stub-host` into `native/test/stub-host/` beside its `library.json`,
which the host vectors run. `npm run build` and `npm test` both run it first, so CMake and a C compiler are needed.

Node runs the build scripts through its own type stripping, which needs Node 22.18 or later.

The package is private and unpublished.
