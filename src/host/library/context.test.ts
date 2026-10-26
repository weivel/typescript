import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ECHO_PIN } from "../__fixtures__/echo-pin.js";
import { acquireLibrary, openLibrary } from "./index.js";
import type { LibraryContext, LibraryDeclaration, LoadedLibrary } from "./index.js";

const NETWORK_TIMEOUT_MS = 60000;

const FACTS: LibraryContext = { environment: { X: "1" }, home: "/h", arguments: ["node", "x"] };

type DeclaredFact = "environment" | "home" | "arguments";

function declaringContext(declaration: LibraryDeclaration, context: DeclaredFact[]): LibraryDeclaration {
  const [service] = declaration.services;
  const contextual = { ...service.functions[0], name: "contextual", symbol: "echo_echo", context };
  return { ...declaration, services: [{ ...service, functions: [...service.functions, contextual] }] };
}

describe("a library function's declared context", () => {
  let binaryPath: string;
  let declaration: LibraryDeclaration;
  const opened: LoadedLibrary[] = [];

  beforeAll(async () => {
    ({ binaryPath, declaration } = await acquireLibrary(ECHO_PIN, mkdtempSync(join(tmpdir(), "weivel-context-"))));
  }, NETWORK_TIMEOUT_MS);

  afterAll(() => opened.forEach((library) => library.close()));

  function open(context: DeclaredFact[], provider?: () => LibraryContext): LoadedLibrary {
    const library = openLibrary(binaryPath, declaringContext(declaration, context), provider);
    opened.push(library);
    return library;
  }

  it("wraps a contextual call in the argument and the declared facts", () => {
    const library = open(["environment", "home", "arguments"], () => FACTS);

    expect(library.call("echo_echo", { a: 1 })).toEqual({ argument: { a: 1 }, context: FACTS });
  });

  it("sends only the facts a function declares", () => {
    const library = open(["home"], () => FACTS);

    expect(library.call("echo_echo", { a: 1 })).toEqual({ argument: { a: 1 }, context: { home: "/h" } });
  });

  it("leaves a function without context unwrapped", () => {
    const library = openLibrary(binaryPath, declaration, () => FACTS);
    opened.push(library);

    expect(library.call("echo_echo", { a: 1 })).toEqual({ a: 1 });
  });

  it("gathers the facts at each call", () => {
    let environment = { X: "1" };
    const library = open(["environment"], () => ({ ...FACTS, environment }));

    const first = library.call("echo_echo", {});
    environment = { X: "2" };
    const second = library.call("echo_echo", {});

    expect(first).toEqual({ argument: {}, context: { environment: { X: "1" } } });
    expect(second).toEqual({ argument: {}, context: { environment: { X: "2" } } });
  });

  it("defaults to the process's own facts", () => {
    const library = open(["home", "arguments"]);

    expect(library.call("echo_echo", null)).toEqual({ argument: null, context: { home: homedir(), arguments: process.argv } });
  });
});
