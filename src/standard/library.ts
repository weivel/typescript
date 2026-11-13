import { StandardRefusalCode, FunctionKind } from "./constants.js";
import type { LibraryDeclaration, StandardRefusal } from "./answers.js";

function jsonFunctionRefusal(serviceIndex: number, functionIndex: number): StandardRefusal {
  return {
    code: StandardRefusalCode.InvalidValue,
    detail: 'is "json", and a json function would carry JSON across the C boundary',
    fix: "declare the function with a kind that passes C values, once the library ABI defines one",
    path: `services[${serviceIndex}].functions[${functionIndex}].kind`,
  };
}

/**
 * The layer's refusal of a declaration it cannot bind, naming the first function whose kind is json; undefined when
 * every function can be bound.
 *
 * @remarks The one refusal the layer makes itself: the standard accepts a json function, and no JSON crosses a C
 * boundary from this layer.
 */
export function libraryBindingRefusal(declaration: LibraryDeclaration): StandardRefusal | undefined {
  for (const [serviceIndex, service] of declaration.services.entries()) {
    const functionIndex = service.functions.findIndex((libraryFunction) => libraryFunction.kind === FunctionKind.Json);
    if (functionIndex !== -1) {
      return jsonFunctionRefusal(serviceIndex, functionIndex);
    }
  }
  return undefined;
}
