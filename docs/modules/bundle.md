# The `bundle` module: the bundler

How this package reads the core's `docs/contract/bundle.md`. How the tests run a bundle is in
[../building.md](../building.md). The code is in [src/bundle/](../source/src/bundle/README.md).

`bundle` writes one ES module file with esbuild, which is an optional peer dependency of this package: only `bundle`
loads it, so a consumer of `host` or `program` never installs it, and this repository pins it as a dev dependency for
its own build and tests. `bundlePlugin(entry, outputDirectory)` bundles a plugin entry and what it imports into
`<entry name>.mjs`; `bundleProgram(outputDirectory, options?)` bundles the command line into `weivel-host.mjs`, run as
`node weivel-host.mjs <host library> <arguments...>`, and the program in process into `weivel-host-in-process.mjs`,
which exports `startHost` alone and runs nothing on import. koffi, a native addon, stays the bare import `koffi`, which
Node resolves from a `node_modules/koffi` at or above the bundle. The core's and the standard's shared libraries are
found at run time beside the bundle, under the file names CMake gives them on that platform, unless `nativeLibraries`
gives two absolute paths instead, or a caller of the in-process `startHost` names its own. A directory holding the bundle, those two libraries and a `node_modules/koffi` therefore
runs wherever it is moved.

The package's `weivel-bundle` command runs both: `weivel-bundle program <output directory> [--core <path> --standard <path>]` writes the two program files and `weivel-bundle plugin <entry> <output directory>` the plugin's one, each path printed on a line of its own. `--core` and `--standard` come together or not at all. It exits 0, 2 with the usage line on a misuse, or 1 with the error when bundling fails.
