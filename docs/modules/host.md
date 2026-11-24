# The `host` module

How this package reads the core's `docs/contract/host.md` for a plugin's entry and its registration, activation, release
and destroy. C libraries as host services are in [libraries.md](libraries.md), and the definitions bound from a
description in [descriptions.md](descriptions.md). The code is in [src/host/](../source/src/host/README.md).

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

## Registration, activation, release and destroy

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
- `host.register` registers, keeps and answers a frozen copy of the manifest it is handed.
- `host.verify` of a plugin the host holds nothing of open answers the core's answer, `active` or `refused`, and
  quarantines nothing; for a handle it never registered the outcome's `importName` is undefined.
- `host.release` answers `true` once the release has run, and `false` at once, doing nothing, for a plugin the host
  has not opened: one registered only, or one already forgotten.
- `host.destroy` makes the host quiet the moment it is called, starts no plugin of a plan not yet started (each
  answered `released`), and waits for every release under way, however long its deactivate takes.
- `host.registerPluginService(plugin, type, service)` offers a service to one plugin alone. The core has one
  registration per id, so every plugin offered an id shares one registration under the host, made with the first
  offer and unregistered with the last withdrawal: the core decides reach as for any host service, and each plugin
  that reaches it gets its own object, a plugin offered nothing under that id nothing. The core announces the
  registration once, when the first offer makes it, so a want or a watch of a plugin offered the id later, or never,
  settles or hears `register` with nothing: a plugin whose scope left an id out and that wants or watches it while it
  activates is answered nothing once a later plugin's offer makes the shared registration. An id can be offered one
  by one or registered for every plugin, never both.
