The `bundle` module: esbuild, an optional peer dependency, is imported here and nowhere else, so a consumer of any other module never installs it. What it writes is in [bundle.md](../../../modules/bundle.md).

<!-- generated: source-children -->
- [bundle.ts](../../../../src/bundle/bundle.ts) - `bundlePlugin` and `bundleProgram`: one ES module per entry, koffi left a bare import, the native libraries found beside the bundle
- [index.ts](../../../../src/bundle/index.ts) - the module's exports
<!-- end generated -->
