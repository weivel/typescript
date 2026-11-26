The bundler's tests: that only the bundle module imports esbuild, and that what it writes runs.

<!-- generated: source-children -->
- [bundle.test.ts](../../../../test/bundle/bundle.test.ts) - esbuild imported from `bundle` and never loaded by `host` or `program`, and plugins and the program bundled
- [command-line.test.ts](../../../../test/bundle/command-line.test.ts) - `weivel-bundle program` and `plugin` writing their files and paths, refusing a lone `--core` or `--standard`, and the built `bin.js` run under node
- [in-process-bundle.test.ts](../../../../test/bundle/in-process-bundle.test.ts) - the in-process bundle exporting `startHost` and running nothing on import
<!-- end generated -->
