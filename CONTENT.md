## What this is

The TypeScript language implementation of weivel. It binds the C core (`weivel/core`) and the C standard
(`weivel/standard`) through koffi, so a plugin written in TypeScript or JavaScript can be hosted, and it is held to the
vectors in `weivel/conformance`.

## What this is not

It is not the core, the standard or the conformance kit, and it decides nothing itself: compatibility, order, reach,
waiting, revocation and constraints are the core's answers, and the manifest format is the standard's.

## Where to read on

Start at [docs/README.md](docs/README.md), this implementation's architecture, and descend to a module or a source
folder.
