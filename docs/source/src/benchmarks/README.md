The `benchmarks` module: each path this language times against its pair, sampled in alternating batches, and the bounds the conformance kit sets for TypeScript, read from its budget file. How the rows reaching C sample is in [benchmarks.md](../../../modules/benchmarks.md).

<!-- generated: source-children -->
- [benchmarks.ts](../../../../src/benchmarks/benchmarks.ts) - every benchmark: the same-language call, the control call, the library, definition, described and blocking calls
- [budgets.ts](../../../../src/benchmarks/budgets.ts) - reading the kit's `benchmarks/typescript.txt`: each ratio gate's highest ratio, margin and noise per platform
- [index.ts](../../../../src/benchmarks/index.ts) - the module's exports
- [measure.ts](../../../../src/benchmarks/measure.ts) - sampling a path in warm-up calls and timed batches, and summarising the samples
<!-- end generated -->
