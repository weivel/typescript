The conformance kit's vectors run against this package, each `describe` named by the vector's id so the coverage test can find it; the host vectors run twice, as [building.md](../../../building.md) says.

<!-- generated: source-children -->
- [coverage.test.ts](../../../../test/conformance/coverage.test.ts) - that every layer vector of the kit has a test named for it
- [description-vectors.test.ts](../../../../test/conformance/description-vectors.test.ts) - the `description` vectors against the real core and standard and the described library
- [driver.test.ts](../../../../test/conformance/driver.test.ts) - the layer driver itself
- [host-vectors-child.test.ts](../../../../test/conformance/host-vectors-child.test.ts) - the `host` vectors run as a child process of the relocated bundle
- [host-vectors.test.ts](../../../../test/conformance/host-vectors.test.ts) - the `host` vectors run in process against `stub-host`
- [kit.ts](../../../../test/conformance/kit.ts) - where the kit's layer vectors are, and every name a `describe` gives
- [layer-vectors.test.ts](../../../../test/conformance/layer-vectors.test.ts) - the `consume`, `want`, `lifecycle` and `library` vectors
<!-- end generated -->
