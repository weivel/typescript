import { StandardRefusalCode, FunctionKind } from "./constants.js";
import type { LibraryDeclaration, LibraryFunction, StandardRefusal } from "./answers.js";

function kindRefusal(libraryFunction: LibraryFunction, path: string): StandardRefusal {
  const detail =
    libraryFunction.kind === FunctionKind.Json
      ? 'is "json", and a json function would carry JSON across the C boundary'
      : `is kind ${libraryFunction.kind}, which this layer does not bind`;
  return {
    code: StandardRefusalCode.InvalidValue,
    detail,
    fix: 'declare the function with kind "bytes", which passes opaque bytes',
    path,
  };
}

/**
 * The layer's refusal of a declaration it cannot bind, naming the first function whose kind is not bytes; undefined
 * when every function can be bound.
 *
 * @remarks The one refusal the layer makes itself: the standard accepts a json function, and no JSON crosses a C
 * boundary from this layer.
 */
export function libraryBindingRefusal(declaration: LibraryDeclaration): StandardRefusal | undefined {
  for (const [serviceIndex, service] of declaration.services.entries()) {
    const functionIndex = service.functions.findIndex((libraryFunction) => libraryFunction.kind !== FunctionKind.Bytes);
    if (functionIndex !== -1) {
      return kindRefusal(service.functions[functionIndex]!, `services[${serviceIndex}].functions[${functionIndex}].kind`);
    }
  }
  return undefined;
}
