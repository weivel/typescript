The build script `npm run build` and `npm test` run first. It builds three CMake projects from `siblings/` and copies what they built into `native/`, as [building.md](../../building.md) says; it is run by Node's own type stripping, never compiled.

<!-- generated: source-children -->
- [native.ts](../../../scripts/native.ts) - builds the core, the standard and the kit's stub host in Release and copies each binary and companion file into `native/`
<!-- end generated -->
