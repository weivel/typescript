# Building and testing

How to build this package and run its tests: the siblings it builds against, the native libraries it builds from them,
the runtimes it runs under, and how the host vectors run. The build script is in [scripts/](source/scripts/README.md),
the suite in [test/](source/test/README.md), and the child run's helpers in
[test/program/](source/test/program/README.md).

## Siblings and native libraries

`repo.json` pins `core`, `standard` and `conformance` by commit under `siblings/`. CI checks
them out there; locally, link or clone each checkout into `siblings/`. `scripts/native.ts` builds
the core and the standard as shared libraries with CMake and copies them into `native/`, which git
ignores, and the tests' fixtures into `native/test/`: the core's `echo`, the standard's
`weivel_standard_described`, which the description vectors bind, the standard's `layouts` program, which the
hand layouts are checked against, and the kit's `stub-host` into `native/test/stub-host/` beside its `library.json`,
which the host vectors run. `npm run build` and `npm test` both run it first, so CMake and a C compiler are needed.
It builds each project in Release under `build/<name>` (`core`, `standard` and, kept short since MSBuild's paths below
it are long, `sh` for the stub host) and takes each binary from `bin/Release` under it, where a multi-configuration
generator such as MSVC puts it, or else from `bin`. `test/native.test.ts` checks that what was built loads.

## Runtimes

Node runs the build scripts through its own type stripping, which needs Node 22.18 or later.

The suite also runs under Bun 1.4.4, `npm run test:bun`, after `npm run build`. Two of its tests read the runtime:
the same-language benchmark gate runs under Node alone, since under Bun two identical direct paths of one run differ
by 25 to 57 percent and leave the pair nothing quiet to judge against; and a blocking call's test asserts that an
immediate fires among a run of calls rather than before one answer, since Bun delivers a worker's answer ahead of its
immediates where Node delivers it in its poll phase.

## The host vectors, in process and as a bundle

The kit's host vectors run twice: in process through `runHost`, and as a child process of a bundle written to a
temporary directory laid out that way, its `node_modules/koffi` a link to this package's koffi and every plugin entry
bundled first. A POSIX child is sent SIGTERM as its stop request. Node's `kill` on Windows ends a child outright for
every signal, so there the child runs under `test/program/console-relay.ts`, which gives it a console of its own and
sends that console CTRL_BREAK_EVENT, which the program receives as SIGBREAK; a child left running by a failed test is
killed with its whole tree.
