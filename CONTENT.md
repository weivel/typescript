## What this is

The plugin engine written natively in TypeScript. It reads the one schema in `weivel/model` and is
held to the vectors in `weivel/conformance`, exactly as `weivel/java` is.

## Layout

- `.` and `./engine`: the contract and the engine. Neither reaches a Node builtin, which a test
  proves by walking the module graph. Neither generates code at run time either: the manifest
  validator is precompiled at build time, so the engine runs under a CSP without `unsafe-eval` or a
  Workers-style eval ban, which a test proves in a Node that forbids it.
- `./host`: the Node host. It may use builtins.
- `./conformance`: the driver the conformance runner launches.
- `scripts/`: sibling resolution and schema embedding.

## Siblings

`model`, `conformance` and `java` are found inside the repository first (CI checks them out there)
and beside it second (a local workspace). The manifest schema is compiled at build time into a
gitignored validator module, so no copy of it is committed.

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

CI sits the whole kit on every push, in its own job, through `intisy/workflows`' shared
`conformance.yml`: the kit and its runner stay outside this repository, which supplies only how
to build and start its driver. Only `passed` counts: any `failed`, `errored` or `unwitnessed`
vector fails the job. To sit it locally, build here and run the runner from a kit checkout:

```bash
npm ci && npm run build
cd ../conformance && npm ci
npx tsx runner/src/cli.ts run --driver "node ../typescript/dist/conformance/driver.js"
```
