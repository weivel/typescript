import { homedir } from "node:os";
import { pluginError } from "../../engine/index.js";
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

const FACT_SHAPES: Record<ContextFact, string> = {
  environment: "an object whose values are all strings",
  home: "a string",
  arguments: "an array of strings",
};

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

function areStrings(values: readonly unknown[]): boolean {
  return values.every((value) => typeof value === "string");
}

function malformedFact(context: unknown): ContextFact | undefined {
  const facts = (typeof context === "object" && context !== null ? context : {}) as Partial<Record<ContextFact, unknown>>;
  const { environment, home, arguments: args } = facts;
  if (typeof environment !== "object" || environment === null || !areStrings(Object.values(environment))) return "environment";
  if (typeof home !== "string") return "home";
  if (!Array.isArray(args) || !areStrings(args)) return "arguments";
  return undefined;
}

function gatherContext(libraryId: string, label: string, provider: LibraryContextProvider): LibraryContext {
  let context: LibraryContext;
  try {
    context = provider();
  } catch (error) {
    throw pluginError(libraryId, `${label} needs the host's context, and gathering it failed: ${(error as Error).message}`, "fix the host's libraryContext provider so it returns the facts");
  }
  const malformed = malformedFact(context);
  if (malformed) {
    throw pluginError(libraryId, `${label} was given a context whose ${malformed} is malformed`, `make the host's libraryContext provider return ${malformed} as ${FACT_SHAPES[malformed]}`);
  }
  return context;
}

/** A function declaring no facts gets its argument unchanged; one declaring some gets `{argument, context}`. */
export function withDeclaredContext(libraryId: string, label: string, fn: Pick<LibraryFunction, "context">, argument: unknown, provider: LibraryContextProvider): unknown {
  if (!fn.context || fn.context.length === 0) return argument;
  return { argument: argument ?? null, context: declaredFacts(fn.context, gatherContext(libraryId, label, provider)) };
}
