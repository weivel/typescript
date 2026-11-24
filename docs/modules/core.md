# The `core` module

How this package reads the core's `docs/contract/core.md` and `docs/contract/cross-cutting.md`: what crosses into C,
what an event the wrapper could not copy becomes, which failures reach the error sink, and where the native libraries
are loaded from. The code is in [src/core/](../source/src/core/README.md).

- A text the caller hands that crosses into C as a `const char *` (an id, every text of a manifest, a reason, an
  option, a path or a symbol) and holds a NUL is refused before the core or the standard is called: it throws, or for
  `want` rejects, an `EmbeddedNulError`, reported to no sink. A text the standard takes by its length, such as an
  identity or a JSON document, crosses whole and is not refused. The host's own reason for a plugin whose activate
  threw writes each NUL of what it quotes as `\0`.
- An event the wrapper could not copy whole is still dispatched, with `incomplete: true`: every handle, code and
  number exact, each text the core gave `TEXT_NOT_COPIED`, and a capacity question's constraints left out. The error
  sink is told once, and an incomplete capacity question is left unanswered.
- `WEIVEL_STATUS_MALFORMED` is reported to the error sink as a defect of the layer only for a call the layer built
  whole. A call carrying what its caller made (a manifest, an edge source, options, a reason, an id, a time or a
  capacity answer) is answered with the core's refusal and reported nowhere.
- The core's and the standard's library paths default to the package's own `native/`, which the package's build
  fills; a caller passes any other path. The default names the package's layout, never a file of its user's.
