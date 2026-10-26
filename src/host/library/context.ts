import { homedir } from "node:os";
import type { LibraryFunction } from "./declaration.js";

/** The ambient facts a library cannot read itself, gathered by the host. */
export interface LibraryContext {
  environment: Record<string, string>;
  home: string;
  arguments: string[];
}

/** Supplies the facts afresh, and is called once per call to a function that declares any. */
export type LibraryContextProvider = () => LibraryContext;

export type ContextFact = keyof LibraryContext;

/** The facts of the running process. */
export function processLibraryContext(): LibraryContext {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  return { environment, home: homedir(), arguments: [...process.argv] };
}

/** The slice of the facts a function declared, in the declaration's order. */
export function declaredFacts(declared: readonly ContextFact[], context: LibraryContext): Partial<LibraryContext> {
  const facts: Partial<LibraryContext> = {};
  for (const fact of declared) Object.assign(facts, { [fact]: context[fact] });
  return facts;
}

/** A function declaring no facts gets its argument unchanged; one declaring some gets `{argument, context}`. */
export function withDeclaredContext(fn: Pick<LibraryFunction, "context">, argument: unknown, provider: LibraryContextProvider): unknown {
  if (!fn.context || fn.context.length === 0) return argument;
  return { argument: argument ?? null, context: declaredFacts(fn.context, provider()) };
}
