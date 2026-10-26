import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPluginError } from "../../engine/index.js";
import type { PluginRuntime } from "../../engine/index.js";
import type { Plugin, PluginContext, PluginError, PluginManifest } from "../../index.js";
import { ECHO_PIN } from "../__fixtures__/echo-pin.js";
import { startPlugins } from "../plugin-host.js";
import { acquireLibrary, openLibrary } from "./index.js";
import type { LibraryContext, LibraryDeclaration, LibraryPin, LoadedLibrary } from "./index.js";

type ContextualService = Record<string, (argument: unknown) => unknown>;

function refusalOf(work: () => unknown): PluginError {
  try {
    work();
  } catch (error) {
    if (isPluginError(error)) return error;
    throw error;
  }
  throw new Error("expected a refusal, and the call returned");
}

function stageRelease(cache: string, binaryPath: string, declaration: LibraryDeclaration): LibraryPin {
  const directory = join(cache, ...ECHO_PIN.repository.split("/"), ECHO_PIN.tag);
  mkdirSync(directory, { recursive: true });
  const declarationBytes = new TextEncoder().encode(JSON.stringify(declaration));
  writeFileSync(join(directory, "library.json"), declarationBytes);
  copyFileSync(binaryPath, join(directory, basename(binaryPath)));
  const declarationDigest = createHash("sha256").update(declarationBytes).digest("hex");
  return { ...ECHO_PIN, sha256: { ...ECHO_PIN.sha256, "library.json": declarationDigest } };
}

function hostRuntime(): PluginRuntime {
  return {
    config: { all: () => ({}), get: () => undefined, set: async () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    paths: { home: "/home", repos: "/home/repos", plugin: "/home/plugin", cache: "/home/cache", config: "/home/config" },
    events: { publish: () => {}, subscribe: () => () => {} },
  };
}

const CONSUMER_ENTRY = "/home/plugin/consumer.js";
const CONSUMER_MANIFEST: PluginManifest = {
  id: "consumer",
  api: 1,
  entry: "dist/index.js",
  capabilities: [],
  services: { consumes: [{ id: "echo", optional: false }] },
};

function consumerOf(seen: { echo?: ContextualService }): Plugin {
  return {
    activate: (ctx: PluginContext) => { seen.echo = ctx.services.get(ctx.service("echo")) as ContextualService; },
    deactivate: () => {},
  };
}

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
    const library = open(["environment", "home", "arguments"]);

    const answer = library.call("echo_echo", null) as { argument: null; context: LibraryContext };

    expect(answer.context.home).toBe(homedir());
    expect(answer.context.arguments).toEqual(process.argv);
    expect(answer.context.environment.PATH ?? answer.context.environment.Path).toBe(process.env.PATH ?? process.env.Path);
    expect(Object.values(answer.context.environment).every((value) => typeof value === "string")).toBe(true);
  });

  it("refuses a call naming the library and function when the provider throws", () => {
    const library = open(["home"], () => { throw new Error("no home today"); });

    const refusal = refusalOf(() => library.call("echo_echo", {}));

    expect(refusal.pluginId).toBe("echo");
    expect(refusal.detail).toContain("echo.contextual");
    expect(refusal.detail).toContain("no home today");
  });

  it("refuses a context whose fact is malformed, naming the fact", () => {
    const malformed: Array<[DeclaredFact, unknown]> = [
      ["environment", { X: 1 }],
      ["environment", { X: undefined }],
      ["environment", null],
      ["home", 7],
      ["arguments", ["node", 2]],
      ["arguments", "node"],
    ];
    for (const [fact, value] of malformed) {
      const library = open([fact], () => ({ ...FACTS, [fact]: value }) as LibraryContext);

      const refusal = refusalOf(() => library.call("echo_echo", {}));

      expect(refusal.detail, `${fact} ${String(value)}`).toContain(`${fact} is malformed`);
      expect(refusal.detail).toContain("echo.contextual");
    }
  });

  it("does not gather facts for a function that declares none", () => {
    const library = openLibrary(binaryPath, declaration, () => { throw new Error("must not be called"); });
    opened.push(library);

    expect(library.call("echo_echo", { a: 1 })).toEqual({ a: 1 });
  });

  it("reaches a library through the host's libraryContext option", async () => {
    const cache = mkdtempSync(join(tmpdir(), "weivel-context-host-"));
    const pin = stageRelease(cache, binaryPath, declaringContext(declaration, ["home"]));
    const seen: { echo?: ContextualService } = {};
    const module = { default: consumerOf(seen) };

    const loaded = await startPlugins({
      app: "test",
      pluginDir: "/home/plugin",
      runtimeFor: () => hostRuntime(),
      scan: {
        loaded: [{ manifest: CONSUMER_MANIFEST, manifestPath: "/home/plugin/consumer.json", entryPath: CONSUMER_ENTRY }],
        failed: [],
        modules: new Map([[CONSUMER_ENTRY, module]]),
      },
      importEntry: async () => module,
      libraries: [pin],
      libraryCache: cache,
      libraryContext: () => FACTS,
    });

    expect(loaded.started).toEqual(["consumer"]);
    expect(seen.echo?.contextual({ a: 1 })).toEqual({ argument: { a: 1 }, context: { home: "/h" } });
    await loaded.stop();
  }, NETWORK_TIMEOUT_MS);
});
