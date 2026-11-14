## What this is

The TypeScript language implementation of weivel. It binds the C core (`weivel/core`) and the C
standard (`weivel/standard`) through koffi and decides nothing itself: compatibility, order, reach,
waiting, revocation and constraints are the core's answers, and the manifest format is the
standard's. It is held to the vectors in `weivel/conformance`.

## Modules

`src/` holds the modules every language implementation of weivel holds, in the order the core's
`MODULES` list names them: `core`, `handles`, `timer`, `context`, `host`, `standard`, `conformance`
and `benchmarks`. Each is a subpath of the package, `@weivel/typescript/<module>`.

## A plugin's entry

In TypeScript a plugin's entry is an object with an `activate(context)` and an optional `deactivate()`, either
of which may answer a promise. The host takes it beside the manifest value, as `host.register(manifest, entry)`,
and never needs the standard. The `standard` module feeds it from disk: `registrationOf` turns a plugin the
standard discovered into its manifest and an entry whose `activate` imports the module's default export.

## How TypeScript reads the contract

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
- A library function that answers a status other than 0 throws a `LibraryCallError` carrying the status and the body
  as bytes, and the body's `text` only where it is UTF-8.
- The core's and the standard's library paths default to the package's own `native/`, which the package's build
  fills; a caller passes any other path. The default names the package's layout, never a file of its user's.

## Siblings and native libraries

`.weivel/repo.json` pins `core`, `standard` and `conformance` by commit under `siblings/`. CI checks
them out there; locally, link or clone each checkout into `siblings/`. `scripts/native.ts` builds
the core and the standard as shared libraries with CMake and copies them into `native/`, which git
ignores. `npm run build` and `npm test` both run it first, so CMake and a C compiler are needed.

Node runs the build scripts through its own type stripping, which needs Node 22.18 or later.

The package is private and unpublished.
