# The `context` module

How this package reads the core's `docs/contract/context.md`: wants and their withdrawal, the clock, listeners that
throw, a context's life, how a plugin names a service or capability, and services as a plugin reaches them. The code
is in [src/context/](../source/src/context/README.md).

- A want answers a promise with a `withdraw()`: it withdraws a want the core still holds waiting, which then never
  settles, and answers `true`; for a want that has settled already, its settlement still delivered, or one withdrawn
  already or never made, it answers `false` and withdraws nothing.
- A context reads the clock for a want only when it has a timeout, a budget or a poll interval, and for each capacity
  answer it reports, since `weivel_report_capacity` always takes the time.
- A listener, a plugin's event listener or a capacity answerer that throws is reported to the error sink, never to a
  plugin's log.
- A context is built before its plugin is first opened, and no event the wrapper drained before it was built reaches
  it. A plugin opened again, by `open` or `activate`, keeps the context it has: an open the core refuses, of a plugin
  open or activating, is answered with that refusal and builds nothing, and a quarantined plugin opened again keeps
  its context.
  Once the core has forgotten the plugin the context is detached: a call that would reach the core throws, or for
  `want` rejects, a `DetachedError`, which is not a `RefusalError`, and reaches nothing. A want still pending then is
  settled by the core's own settlement of it, already queued.
- A plugin names a service with `context.service<T>(id)` and a capability with `context.capability<T>(id)`, each
  answering a type token, a `ServiceType<T>` or a `CapabilityType<T>`, that holds the id and pairs it with `T` in the
  type system only. `services.get`, `services.register`, `services.want` and `services.watch` take the `ServiceType`,
  and `capabilities.all`, `capabilities.watch` and `provide` the `CapabilityType`, never the id as a string:
  `context.services.get(context.service<Files>("example.files"))` answers the provider's object typed as `Files`.
- `services.get` answers undefined only when nothing is registered under the id. A refused `get`, `services.ids`,
  `services.watch`, `capabilities.all` and `capabilities.watch` throw the core's `RefusalError`, or an `Error` naming
  the status alone where the core queued no refusal, as for a refusal of reach already reported once. A refusal of
  reach also reaches the plugin's event listeners.
- A want the core settles with a registration the layer holds no object for is rejected with an `Error` that carries
  no refusal, and that error is reported to the error sink as a defect of the layer.
- A plugin registers with `{ awaitReleases: true }` to keep each holding of its service past its revocation, and
  hears a `holdings-released` event, carrying the id and the object it registered, once every holding has ended.
  An owner hears the event its own release or quarantine call queued, as when nothing held the registration then;
  one queued after those events, or after it was forgotten, reaches no one.
