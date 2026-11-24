The repo root of the TypeScript implementation: one private npm package whose `src/` compiles with `tsc` to `dist/` (`tsconfig.json`), each module a subpath of its exports, and whose `test/` is type-checked together with `src/` and `scripts/` (`tsconfig.test.json`) and run by vitest. `scripts/` builds the native libraries the package loads through koffi. Where the native libraries come from, and how to build, test and run under Node or Bun, is answered in [building.md](../building.md); what each module does is in [modules/](../modules/).

<!-- generated: source-children -->
- [scripts/](scripts/) - the script that builds the core, the standard and the test fixtures from the siblings into `native/`
- [src/](src/) - the package's modules, one folder each, in the order the core's `MODULES` names them
- [test/](test/) - the suite, one folder per module, the kit's vectors among them, and the fixtures every folder shares
- [vitest.config.ts](../../vitest.config.ts) - the test runner's configuration: every `*.test.ts` under `src/` and `test/`
<!-- end generated -->
