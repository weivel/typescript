## What this is

The plugin engine written natively in TypeScript. It reads the one schema in `weivel/model` and is
held to the vectors in `weivel/conformance`, exactly as `weivel/java` is.

## Layout

- `.` and `./engine`: the contract and the engine. Neither reaches a Node builtin, which a test
  proves by walking the module graph. Manifest validation compiles the schema at first use and so
  needs a host that permits runtime code generation (no CSP without `unsafe-eval`, no Workers-style
  eval ban); everything else in `./engine` does not.
- `./host`: the Node host. It may use builtins.
- `./conformance`: the driver the conformance runner launches.
- `scripts/`: sibling resolution, schema embedding and the conformance run.

## Siblings

`model`, `conformance` and `java` are found inside the repository first (CI checks them out there)
and beside it second (a local workspace). The manifest schema is embedded at build time into a
gitignored module, so no copy of it is committed.

## Subpaths

| subpath | holds | node builtins |
| --- | --- | --- |
| `.` | the plugin contract: types, manifest shapes, `PluginError` | none |
| `./engine` | the engine: manifest validation, ordering, activation, handles, the scheduler, `pluginError` | none |
| `./host` | the Node host: reads deployed manifests, imports plugin entries, `startPlugins` | yes |
| `./conformance` | the driver the conformance runner launches | yes |

The package is `@weivel/typescript`, private, and unpublished until the npm publishing blocker
clears.

## Running the conformance kit

```bash
npm ci
npm run build
npm test
npm run conformance
```

`npm run conformance` runs the whole kit from `weivel/conformance` against `./conformance` and
prints one row per operation. Only `passed` counts: any `failed`, `errored` or `unwitnessed`
vector makes the run exit non-zero. CI runs the same command after the unit tests.
