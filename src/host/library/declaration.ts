import { pluginError, schemaIssues } from "../../engine/index.js";
import { validateLibraryDeclaration } from "./declaration.generated.js";

/** One exported function of the `json` kind: UTF-8 JSON in, UTF-8 JSON out. */
export interface LibraryFunction {
  name: string;
  symbol: string;
  kind: "json";
  argument: object | boolean;
  result: object | boolean;
}

/** One service a library offers, and the functions it is made of. */
export interface LibraryService {
  id: string;
  functions: LibraryFunction[];
}

/** A library's `library.json`, as `library.schema.json` in `weivel/model` defines it. */
export interface LibraryDeclaration {
  id: string;
  version: string;
  binary: string;
  release: string;
  services: LibraryService[];
}

const DECLARATION_FILE = "library.json";

function declaredId(candidate: unknown): string {
  const id = typeof candidate === "object" && candidate !== null ? (candidate as { id?: unknown }).id : undefined;
  return typeof id === "string" && id ? id : "library";
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw pluginError("library", `${DECLARATION_FILE} is not JSON: ${(error as Error).message}`, "publish a library.json that parses as JSON");
  }
}

/** Reads a declaration, refusing it with every schema violation named in the detail and the first one's fix. */
export function parseDeclaration(text: string): LibraryDeclaration {
  const candidate = parsedJson(text);
  if (validateLibraryDeclaration(candidate)) return candidate as LibraryDeclaration;
  const issues = schemaIssues(validateLibraryDeclaration.errors ?? []);
  const detail = issues.map((issue) => issue.message).join("; ");
  throw pluginError(declaredId(candidate), `${DECLARATION_FILE}: ${detail}`, issues[0]?.fix ?? "correct library.json against library.schema.json");
}
