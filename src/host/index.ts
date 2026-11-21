export { Host } from "./host.js";
export { ActivationFailure } from "./activation-failure.js";
export { hostDestroyed, isHostDestroyed } from "./model.js";
export {
  LibraryCallError,
  LibraryUnloadedError,
  OutOfMemoryError,
  definitionSizeFloor,
  type DescriptionCheck,
  type DescriptionCheckAnswer,
  type LibraryDefinition,
} from "./libraries.js";
export { bindDefinition, blockingOperationsOf, boundDefinitionOf, type BoundDefinition } from "./description/definition.js";
export type { DescribedHandle } from "./description/handles.js";
export { DescribedCallError, OperationNotOfferedError, none } from "./description/outcome.js";
export type { NativeValue } from "./description/values.js";
export type {
  ActivationOutcome,
  ActivationStart,
  ActivationState,
  HostDestroyed,
  HostedPlugin,
  HostOptions,
  LibraryFunction,
  LibraryService,
  LoadedLibrary,
  LoadLibraryOptions,
  Plugin,
  PluginAction,
  RegisterAnswer,
} from "./model.js";
