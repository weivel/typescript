## What this is

The plugin engine written natively in TypeScript. It reads the one schema in `weivel/model` and is
held to the vectors in `weivel/conformance`, exactly as `weivel/java` is.

## Layout

- `.` and `./engine`: the contract and the engine. Neither reaches a Node builtin, which a test
  proves by walking the module graph.
- `./host`: the Node host. It may use builtins.
- `./conformance`: the driver the conformance runner launches.
- `scripts/`: sibling resolution, schema embedding and the conformance run.

## Siblings

`model`, `conformance` and `java` are found inside the repository first (CI checks them out there)
and beside it second (a local workspace). The manifest schema is embedded at build time into a
gitignored module, so no copy of it is committed.
