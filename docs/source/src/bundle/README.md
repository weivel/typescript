The `bundle` module: esbuild, an optional peer dependency, is imported here and nowhere else, so a consumer of any other module never installs it. What it writes is in [bundle.md](../../../modules/bundle.md).

<!-- generated: source-children -->
- [bin.ts](../../../../src/bundle/bin.ts) - the `weivel-bundle` command, exiting with `bundleCommandLine`'s code
- [bundle.ts](../../../../src/bundle/bundle.ts) - `bundlePlugin` and `bundleProgram`: one ES module per entry, koffi left a bare import, the native libraries found beside the bundle
- [command-line.ts](../../../../src/bundle/command-line.ts) - `bundleCommandLine`: `program` and `plugin` over the two bundler functions, a path per line
- [index.ts](../../../../src/bundle/index.ts) - the module's exports
<!-- end generated -->
