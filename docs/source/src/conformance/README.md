The `conformance` module: the driver that reads the kit's layer vectors and witnesses each through this package, one file per op, answering what it saw in the shape of the vector's `then`. What a vector must show is the conformance kit's `docs/vectors/layer/`; the suites that run it are in `test/conformance/`.

<!-- generated: source-children -->
- [consume.ts](../../../../src/conformance/consume.ts) - the `consume` op: plugins providing and consuming, with what each heard
- [description.ts](../../../../src/conformance/description.ts) - the `description` op: a described library loaded, bound and called, its holders, blocking operations and refusals
- [driver.ts](../../../../src/conformance/driver.ts) - `witnessLayerVector`: runs one vector by its op and answers what it observed, the logs and the error sink
- [expectations.ts](../../../../src/conformance/expectations.ts) - matching each `then` field to the observer that answers it, refusing a field no observer knows
- [host-plugins.ts](../../../../src/conformance/host-plugins.ts) - the manifests and generated entries of a `host` vector's plugins, and the interpreter of their steps
- [host.ts](../../../../src/conformance/host.ts) - `witnessHostVector`: lays a `host` vector out, runs the host program over it under the 30-second bound, and answers its record and exit code
- [index.ts](../../../../src/conformance/index.ts) - the module's exports
- [library.ts](../../../../src/conformance/library.ts) - the `library` op: the echo library loaded as host services, its definitions held and released
- [lifecycle.ts](../../../../src/conformance/lifecycle.ts) - the `lifecycle` op: an activation plan over an edge source, and each plugin's outcome
- [refusals.ts](../../../../src/conformance/refusals.ts) - a refusal in the kit's terms, its code by its kit name
- [vectors.ts](../../../../src/conformance/vectors.ts) - reading the kit's layer vectors, and naming those no test witnesses
- [want.ts](../../../../src/conformance/want.ts) - the `want` op: a want against virtual time and its settlement
- [world.ts](../../../../src/conformance/world.ts) - what every op shares: virtual time as both clock and scheduler, recorded logs and plugins built from steps
<!-- end generated -->
