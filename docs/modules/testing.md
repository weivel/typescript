# The `testing` module: the test helper

How this package reads the core's `docs/contract/testing.md`. The code is in
[src/testing/](../source/src/testing/README.md).

`@weivel/typescript/testing` is for the tests of a program that hosts plugins, and names nothing of any one project.
`scratchHome(layout)` makes a fresh folder under the temporary directory, named by its real path, copies each of
`layout.libraries` (a source directory holding one binary and a `library.json`) to `<base>/libraries/<name>`, writes
`layout.files(base, libraries)` (a string `content` as it is, anything else as JSON, or a `copyFrom` file byte for byte)
and sets `layout.environment(base)`. `remove()` puts every variable back, deleting one that was unset, and deletes the
folder; a layout that throws partway does the same before the error is rethrown. A library source holding no binary is
an `Error` naming the directory. `freePort()` answers a port nothing listens on at that moment.
