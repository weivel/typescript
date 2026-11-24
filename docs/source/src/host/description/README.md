Binding a definition from the description its library answers: the description read once at the load, every struct it names laid out as a koffi struct and checked against it, and one method per operation. The walks that write and read structs keep their own stack rather than recursing. What a bound method takes, answers and refuses is in [descriptions.md](../../../../modules/descriptions.md).

<!-- generated: source-children -->
- [arena.ts](../../../../../src/host/description/arena.ts) - the native memory one call writes into, freed together once the call is done
- [definition.ts](../../../../../src/host/description/definition.ts) - `bindDescribed`: the bound object of one method per operation, and the blocking operations it names
- [enums.ts](../../../../../src/host/description/enums.ts) - a description's enums by name, `weivel_status` beside them
- [handles.ts](../../../../../src/host/description/handles.ts) - a handle an operation answered, and the holdings released by `release()`, the unload or the carrying answer
- [layout.ts](../../../../../src/host/description/layout.ts) - the hand layout of `description.h`: its structs, kinds, roles and returns
- [layouts.ts](../../../../../src/host/description/layouts.ts) - each described struct built as a koffi struct and checked member by member against the description
- [operations.ts](../../../../../src/host/description/operations.ts) - one operation and one release: inputs prepared, the call on the calling or the worker thread, answers copied out
- [outcome.ts](../../../../../src/host/description/outcome.ts) - `none`, `DescribedCallError` and `OperationNotOfferedError`
- [reader.ts](../../../../../src/host/description/reader.ts) - reading a description out of the struct the library answered into JavaScript values
- [scalars.ts](../../../../../src/host/description/scalars.ts) - the integer and f64 kinds, each checked against its range on the way in and read on the way out
- [structs.ts](../../../../../src/host/description/structs.ts) - writing a struct from a JavaScript value and reading one back, handles and carried definitions included
- [values.ts](../../../../../src/host/description/values.ts) - a value tree written into and read out of the standard's `value.h` layout, to the depth limit
<!-- end generated -->
