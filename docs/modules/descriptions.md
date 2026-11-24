# Definitions bound from a description

How the `host` module binds a definition service from the description its library answers, so that no file of this
package names a type of any library it binds: the load, the bound object's methods, what they take and answer, handles,
which thread a call runs on, and an operation the provider does not offer.

- A definition service that declares a `description` is registered as its `BoundDefinition`, built from the
  description alone (`src/host/description/`): no file of this package names a type of any library it binds. The
  host never loads the standard, so its caller hands it the standard's check as `descriptionCheck`
  (`(description) => standard.checkDescription(description)`); a host given none refuses a library that declares a
  description, and a check answering OUT_OF_MEMORY makes `loadLibrary` throw an `OutOfMemoryError`, never the
  caller's mistake. At the load each description is checked, then read, and every struct it names is built as a koffi
  struct from its members in order, each member's offset and size and the struct's size compared with what koffi
  computes, and a definition's operations laid among its members by offset; any difference, or a kind this binding
  does not know, refuses the load as the caller's mistake. Which kinds each role takes, the shape of a refusal and a
  release, and where the context lies are the check's rules, which this binding does not repeat. The layouts and every
  operation's prototype are built once there, never on a call. Beside each struct's layout the load builds the struct
  koffi writes from a JavaScript value, its texts, arrays and the structs they reach typed, so a call hands koffi one
  checked image per input and koffi writes it during the call; only a value tree, and a struct reached through a
  cycle of two or more structs, which no koffi struct can name, are written into the call's own memory. Each
  operation keeps one answer block per answer and one refusal block, emptied before every call, and reads them through
  a view of their memory, so a scalar costs no call into koffi. The one hand layout is `description.h`'s, beside the
  standard module's layout of `value.h`, and both are checked against the standard's `layouts` program.
- A `BoundDefinition` is a frozen object with no prototype holding one async method per operation that answers a
  status, named as the operation; the releases are not methods, since the binding calls them. `boundDefinitionOf`
  answers the `{ library, pointer }` it stands for. A method takes one object keyed by its input parameters' names,
  a left-out input its kind's zero (0, NULL, or an empty array, bytes or texts): a number for a u32 or an f64; a number
  that is a safe integer or a bigint for a u64, an i64 or a size, refused beyond the kind's range; a string or null for
  a text; an array of strings and nulls for texts; a `Uint8Array` for bytes; an array for a counted array; a plain
  object for a struct, held or pointed at, keyed by member name; a native value (null, boolean, finite number, string,
  array, plain object) for a value tree, `undefined` standing for NONE only at its root, and for a pointer to a value
  `none`, a value of kind NONE where `undefined` is NULL; and a handle object for a
  handle. Every `size` and every count the binding fills itself, and a caller writing one, or naming anything the
  operation or struct does not take, is refused with a `TypeError` before the call, as is a value its kind does not
  hold; a text holding a NUL is refused with an `EmbeddedNulError`. Structs nest at most 1000 levels below the one
  a call takes, `WEIVEL_STANDARD_VALUE_DEPTH_LIMIT` as for a value tree, and a deeper input is refused with a
  `TypeError` before the call.
- A method resolves on OK with the answer copied into JavaScript values: a single answer parameter as its value, more
  than one as an object keyed by parameter name, none as `undefined`. A struct answers every member but its leading
  `size`, its counts, its context and storage, a NULL pointer, a NULL handle and a value of kind NONE; an integer of
  64 bits answers as a number within 2^53 and a bigint beyond; a NULL counted array, texts or bytes answers empty. On
  NONE it resolves with `none`, a symbol of the host module. On any other status it rejects with a
  `DescribedCallError` carrying the `operation`, the `status`, and the refusal's `detail` and `fix` for REFUSED, both
  null otherwise. Every answer and the refusal are released in a `finally` through the release the description names
  for them, a struct or a tree through the answer handed in; an answer naming no release, as a text the provider
  keeps, is released by no one. An answer nesting structs deeper than 1000 levels, or a value tree holding a key twice
  in one record, is the provider's fault and rejects with an `Error`, its answer released all the same.
- A handle answer becomes a frozen object whose only member is `release()`, handed back as an input of an operation
  taking that handle type. `release()` frees it once through the release its description names; a second call, or one
  after the unload, does nothing, and a released handle handed as an input is refused with a `TypeError`. The unload
  releases every handle of the library still held, while the binary is still open.
- An operation its description does not mark blocking runs on the calling thread when the method is called; the
  promise is the method's shape, not a worker. An operation it marks blocking runs on koffi's worker thread, so the
  event loop stays free while the C function waits, and its blocks are allocated per call, since such calls may
  overlap; `blockingOperationsOf(bound)` names those operations. A holding outlives the unload, so a bound method
  stays callable until the binary closes, and rejects with a `LibraryUnloadedError` from then on; a blocking call
  still running then keeps the binary mapped until it returns. An operation named `then` refuses the load, since it
  would make the bound object a thenable that every `await` calls.
- An operation whose pointer lies past the `size` its definition answered, or is NULL there, is not offered: its
  method rejects with an `OperationNotOfferedError`, the caller's mistake, before anything is called. An element of a
  pointer or an array this binding does not know, or a struct element the description does not describe, refuses
  the load. The walks that write and read structs keep their own stack rather than recursing, so the depth limit is
  reached on any stack.
