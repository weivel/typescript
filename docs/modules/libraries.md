# C libraries as host services

How the `host` module loads a C library and offers its functions to plugins as host services: what a load refuses, a
definition with no description, the contracts a library publishes, how a revoked definition is let go, and what a bytes
function's failure throws. A definition that declares a description is bound as [descriptions.md](descriptions.md) says.
The code is in [src/host/](../source/src/host/README.md), mostly `libraries.ts`.

A plugin reaches a definition service as it reaches any service, through [its context](context.md). For a definition
bound from a description, the whole call is:

```ts
import type { BoundDefinition } from "@weivel/typescript/host";

const files = context.services.get(context.service<BoundDefinition>("example.files"));
const contents = await files?.read({ path: "notes.txt" });
```

`get` answers the bound object, `read` is the operation of that name, and its promise resolves with the operation's
answer or rejects as [descriptions.md](descriptions.md) says.

- `host.loadLibrary` throws, reporting to no sink, for an id declared twice or already registered; and
  `registerHostService` throws for an id a live library declares. An id `loadLibrary`'s `withheld` names is bound and
  registered for no plugin, reached through the loaded library alone. A load the core refuses partway is undone as an
  unload before it throws: what it registered is unregistered and its binary closed.
- A definition service that declares no description is registered as a frozen `LibraryDefinition`,
  `{ library, pointer }`: the import name it came from and koffi's pointer to the very struct its symbol answered,
  never a copy. A definition that answers NULL, or a struct whose `size` is below `2 * sizeof(void *)`, makes
  `loadLibrary` throw, as the caller's mistake, before anything is registered.
  `LoadedLibrary.definitions` hands its caller the same raw addresses, and that caller holds no registration of
  them, so its use keeps nothing open: each address dies with the binary.
- A library's `contracts`, read by the standard beside its services, are each checked by `descriptionCheck` and read
  at the load as the operations of its description that answer a status, in its order; the releases, which answer
  nothing, are not among them. Until the unload, `context.provide` of that capability throws a
  `ContractMismatchError` (`code` `contract-mismatch`, `subject` the first of those operations the object does not
  offer as a function) before the core is asked, so a refused implementation is never provided; an object offering
  more, a release or an operation the description does not list, is accepted. A capability no loaded library
  publishes a contract for is provided unchecked, and a second live library publishing one for the same capability
  makes `loadLibrary` throw as the caller's mistake. The check runs on every provide, which is a call of activation
  and never of a hot path: it adds about 300 ns to a provide of about 3.6 us, measured on Windows under Node 26.
- A holder lets go of a revoked definition by calling the `release()` of the `revoked` event it was handed, once it
  has released everything the definition gave it; for any other revocation `release()` does nothing. A holding a
  watch made counts the same. The event object grants the release: whoever the plugin hands it to can end the
  plugin's holding. A call through the definition after the release is the holder's defect and undefined, as any use
  of memory after its free is. The binary is closed once every definition service of the library has had every
  holding released since the unload, a holder the host released, quarantined or forgot counting as released, or
  once the host's destroy has destroyed the core, after which every address a definition answered is invalid. A bytes answer is copied and released before its call answers, so no held bytes keep
  the binary open.
- A library function that answers a status other than 0 throws a `LibraryCallError` carrying the status and the body
  as bytes, and the body's `text` only where it is UTF-8.
