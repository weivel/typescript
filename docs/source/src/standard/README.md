The `standard` module: the standard's library loaded through koffi, its declarations laid out by hand and checked against its `layouts` program, and what it answers copied into values, so the host never needs it. It feeds the host from disk, as [host.md](../../../modules/host.md) says.

<!-- generated: source-children -->
- [answers.ts](../../../../src/standard/answers.ts) - the standard's answers as values: refusals, manifests, identities, discovered plugins, library declarations
- [constants.ts](../../../../src/standard/constants.ts) - the standard's refusal, identity and function kind codes
- [declarations.ts](../../../../src/standard/declarations.ts) - the standard's structs and function signatures for koffi
- [entry.ts](../../../../src/standard/entry.ts) - `registrationOf`: a discovered plugin's manifest and an entry that imports its module and activates the export named
- [index.ts](../../../../src/standard/index.ts) - the module's exports
- [manifest.ts](../../../../src/standard/manifest.ts) - copying a manifest the standard answered into a value
- [services.ts](../../../../src/standard/services.ts) - the config, secrets and paths services as TypeScript types
- [standard.ts](../../../../src/standard/standard.ts) - `loadStandard`: every default the standard ships, through one loaded library
<!-- end generated -->
