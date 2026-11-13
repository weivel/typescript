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

## Siblings and native libraries

`.weivel/repo.json` pins `core`, `standard` and `conformance` by commit under `siblings/`. CI checks
them out there; locally, link or clone each checkout into `siblings/`. `scripts/native.ts` builds
the core and the standard as shared libraries with CMake and copies them into `native/`, which git
ignores. `npm run build` and `npm test` both run it first, so CMake and a C compiler are needed.

Node runs the build scripts through its own type stripping, which needs Node 22.18 or later.

The package is private and unpublished.
