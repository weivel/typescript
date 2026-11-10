import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { repositoryRoot, sibling } from "../../../scripts/sibling.mjs";
import type { LibraryDeclaration } from "./declaration.js";
import { parseDeclaration } from "./declaration.js";
import { generateLibraryTypes } from "./generate-types.js";
import { CONTRACT_TYPES, MODEL_DEFINITIONS } from "./model-definitions.generated.js";

const root = repositoryRoot();
const publicEntry = join(root, "src", "index.ts");
const PLUGIN_SCHEMA = "https://weivel.github.io/model/plugin.schema.json";
const APP_DESCRIPTOR = `${PLUGIN_SCHEMA}#/definitions/appDescriptor`;
const APP_DECLARATION = `${PLUGIN_SCHEMA}#/definitions/appDeclaration`;
const NESTED_APP_DEFINITIONS = [
  "appHome",
  "appDetect",
  "appLoader",
  "appPathNames",
  "appUsage",
  "appNpmPlugins",
  "appStartupHook",
  "appDiscovery",
  "appProjects",
  "appModelCatalog",
];

function contractTypeOf(definition: string): string {
  return definition.charAt(0).toUpperCase() + definition.slice(1);
}

function echoDeclaration(): LibraryDeclaration {
  return parseDeclaration(readFileSync(join(sibling("model"), "test", "fixtures", "echo.library.json"), "utf8"));
}

function declarationWithResult(result: object | boolean, argument: object | boolean = { type: "object" }): LibraryDeclaration {
  return {
    importName: "fixture",
    version: "1.0.0",
    release: "fixture_release",
    services: [{ id: "app-registry", functions: [{ name: "get", symbol: "fixture_get", kind: "json", argument, result }] }],
  };
}

function compilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["node"],
    typeRoots: [join(root, "node_modules", "@types")],
    paths: { "@weivel/typescript": [publicEntry] },
  };
}

/** Every diagnostic of compiling the generated module beside a consumer, the way a plugin author would. */
function compileDiagnostics(generated: string, consumer: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "weivel-generated-types-"));
  const generatedPath = join(directory, "generated.ts");
  const consumerPath = join(directory, "consumer.ts");
  writeFileSync(generatedPath, generated);
  writeFileSync(consumerPath, consumer);
  const program = ts.createProgram([generatedPath, consumerPath], compilerOptions());
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

const contractDirectory = join(root, "src", "contract");

function isDeclaredInContract(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) => !relative(contractDirectory, declaration.getSourceFile().fileName).startsWith(".."));
}

function contractExports(): { checker: ts.TypeChecker; types: ts.Symbol[] } {
  const program = ts.createProgram([publicEntry], compilerOptions());
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(publicEntry);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`cannot read ${publicEntry}`);
  const types = checker
    .getExportsOfModule(module)
    .map((exported) => (exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported))
    .filter((symbol) => symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))
    .filter(isDeclaredInContract);
  return { checker, types };
}

function typeOnlyExportsOfPublicEntry(): string[] {
  return contractExports()
    .types.map((symbol) => symbol.name)
    .sort();
}

interface ObjectShape {
  properties: string[];
  required: string[];
}

function shapeOf(checker: ts.TypeChecker, symbol: ts.Symbol): ObjectShape {
  const members = checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol));
  return {
    properties: members.map((member) => member.name).sort(),
    required: members.filter((member) => !(member.flags & ts.SymbolFlags.Optional)).map((member) => member.name).sort(),
  };
}

type ShapeLookup = (typeName: string) => ObjectShape;

function shapeLookup(checker: ts.TypeChecker, types: ts.Symbol[], origin: string): ShapeLookup {
  return (typeName) => {
    const symbol = types.find((candidate) => candidate.name === typeName);
    if (!symbol) throw new Error(`${origin} declares no ${typeName}`);
    return shapeOf(checker, symbol);
  };
}

function contractShapes(): ShapeLookup {
  const { checker, types } = contractExports();
  return shapeLookup(checker, types, "the contract");
}

/** The shapes the Java contract declares, as its generated declarations publish them. */
function javaContractShapes(): ShapeLookup {
  const javaDeclarations = join(sibling("java"), "generated", "api.d.ts");
  const program = ts.createProgram([javaDeclarations], compilerOptions());
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(javaDeclarations);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`cannot read ${javaDeclarations}`);
  return shapeLookup(checker, checker.getExportsOfModule(module), javaDeclarations);
}

function schemaShape(definition: { properties?: Record<string, unknown>; required?: string[] }): ObjectShape {
  return { properties: Object.keys(definition.properties ?? {}).sort(), required: [...(definition.required ?? [])].sort() };
}

const ECHO_CONSUMER = `
import type { PluginContext } from "@weivel/typescript";
import { Echo } from "./generated.js";
import type { EchoService } from "./generated.js";

export function consume(ctx: PluginContext): void {
  const echo: EchoService = ctx.services.get(Echo)!;
  const echoed: unknown = echo.echo({});
  const failed: { [key: string]: unknown } = echo.fail({});
  const repeated: string = echo.repeat({ count: 2 });
  const garbage: string = echo.garbage({});
  // @ts-expect-error count is declared an integer
  echo.repeat({ count: "2" });
  // @ts-expect-error count is required
  echo.repeat({});
  // @ts-expect-error repeat answers a string
  const wrong: number = echo.repeat({ count: 1 });
  void [echoed, failed, repeated, garbage, wrong];
}
`;

describe("generateLibraryTypes", { timeout: 120_000 }, () => {
  it("emits the echo service's interface and typed key, which a consumer compiles against", () => {
    const generated = generateLibraryTypes(echoDeclaration());
    expect(generated).toContain("export interface EchoService {");
    expect(generated).toContain('export const Echo: ServiceType<EchoService> = { id: "echo" };');
    expect(compileDiagnostics(generated, ECHO_CONSUMER)).toEqual([]);
  });

  it("starts with a header naming the declaration it was generated from", () => {
    const [header] = generateLibraryTypes(echoDeclaration()).split("\n");
    expect(header).toMatch(/^\/\/ .*[Gg]enerated.*echo 0\.1\.1/);
  });

  it("imports only from the package's public entry", () => {
    const imports = [...generateLibraryTypes(echoDeclaration()).matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual(["@weivel/typescript"]);
  });

  it("maps a $ref to a model definition onto the contract's own type, imported and never declared", () => {
    const generated = generateLibraryTypes(declarationWithResult({ $ref: APP_DESCRIPTOR }));
    expect(generated).toContain('import type { AppDescriptor, ServiceType } from "@weivel/typescript";');
    expect(generated).not.toMatch(/(interface|type) AppDescriptor\b/);
    expect(generated).toContain("get(argument: { [key: string]: unknown }): AppDescriptor;");
    const consumer = `
import type { AppDescriptor, PluginContext } from "@weivel/typescript";
import { AppRegistry } from "./generated.js";
export function consume(ctx: PluginContext): AppDescriptor | undefined {
  return ctx.services.get(AppRegistry)?.get({});
}
`;
    expect(compileDiagnostics(generated, consumer)).toEqual([]);
  });

  it("refuses a $ref to appDeclaration, for which the contract declares no type", () => {
    expect(() => generateLibraryTypes(declarationWithResult({ $ref: APP_DECLARATION }))).toThrow(
      "result.$ref names appDeclaration in plugin.schema.json, for which the contract declares no type AppDeclaration",
    );
  });

  it("maps a $ref to a nested app definition onto the contract's own type", () => {
    const generated = generateLibraryTypes(declarationWithResult({ $ref: `${PLUGIN_SCHEMA}#/definitions/appHome` }));
    expect(generated).toContain('import type { AppHome, ServiceType } from "@weivel/typescript";');
    expect(generated).toContain("get(argument: { [key: string]: unknown }): AppHome;");
  });

  it("refuses a model $ref to a definition the model does not publish, naming it", () => {
    const unpublished = [
      { file: "plugin.schema.json", definition: "pluginContext" },
      { file: "plugin.schema.json", definition: "noSuchThing" },
      { file: "library.schema.json", definition: "appDescriptor" },
      { file: "other.schema.json", definition: "appDescriptor" },
    ];
    for (const { file, definition } of unpublished) {
      const declaration = declarationWithResult({ $ref: `https://weivel.github.io/model/${file}#/definitions/${definition}` });
      expect(() => generateLibraryTypes(declaration), `${file} ${definition}`).toThrow(`result.$ref names ${definition} in ${file}, which weivel/model does not publish`);
    }
  });

  it("refuses a type or a $ref file named like a member every object inherits, at its schema path", () => {
    for (const type of ["constructor", "toString", "__proto__"]) {
      expect(() => generateLibraryTypes(declarationWithResult({ type })), type).toThrow("services[0].functions[0].result.type");
    }
    for (const file of ["constructor", "__proto__", "toString"]) {
      const declaration = declarationWithResult({ $ref: `https://weivel.github.io/model/${file}#/definitions/appDescriptor` });
      expect(() => generateLibraryTypes(declaration), file).toThrow(`result.$ref names appDescriptor in ${file}, which weivel/model does not publish`);
    }
  });

  it("refuses a $ref outside the model", () => {
    expect(() => generateLibraryTypes(declarationWithResult({ $ref: "#/definitions/local" }))).toThrow(/services\[0\]\.functions\[0\]\.result\.\$ref/);
    expect(() => generateLibraryTypes(declarationWithResult({ $ref: "https://example.com/x.json#/definitions/appDescriptor" }))).toThrow(
      /services\[0\]\.functions\[0\]\.result\.\$ref/,
    );
  });

  it("refuses a schema form it does not support, naming the schema path", () => {
    expect(() => generateLibraryTypes(declarationWithResult({ allOf: [{ type: "string" }] }))).toThrow(/services\[0\]\.functions\[0\]\.result\.allOf/);
    expect(() => generateLibraryTypes(declarationWithResult({ type: ["string", "null"] }))).toThrow(/services\[0\]\.functions\[0\]\.result\.type/);
    expect(() =>
      generateLibraryTypes(declarationWithResult({ type: "object", properties: { nested: { type: "array", items: { anyOf: [] } } } })),
    ).toThrow(/services\[0\]\.functions\[0\]\.result\.properties\.nested\.items\.anyOf/);
    expect(() => generateLibraryTypes(declarationWithResult({ type: "string" }, { type: "object", additionalProperties: { not: {} } }))).toThrow(
      /services\[0\]\.functions\[0\]\.argument\.additionalProperties\.not/,
    );
  });

  it("maps additionalProperties false to a closed object, which refuses a key it does not declare", () => {
    const generated = generateLibraryTypes(
      declarationWithResult({ type: "string" }, { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }),
    );
    expect(generated).toContain("get(argument: { name: string }): string;");
    expect(generateLibraryTypes(declarationWithResult({ type: "object", additionalProperties: false }))).toContain("): { [key: string]: never };");
    const consumer = `
import type { PluginContext } from "@weivel/typescript";
import { AppRegistry } from "./generated.js";
export function consume(ctx: PluginContext): void {
  const registry = ctx.services.get(AppRegistry)!;
  registry.get({ name: "a" });
  // @ts-expect-error the object is closed
  registry.get({ name: "a", extra: 1 });
}
`;
    expect(compileDiagnostics(generated, consumer)).toEqual([]);
  });

  it("maps an additionalProperties schema to an index signature widened over every declared property", () => {
    const mapOnly = generateLibraryTypes(declarationWithResult({ type: "object", additionalProperties: { type: "string", minLength: 1 } }));
    expect(mapOnly).toContain("): { [key: string]: string };");
    const generated = generateLibraryTypes(
      declarationWithResult(
        { type: "string" },
        {
          type: "object",
          properties: { count: { type: "integer" }, label: { type: "string" }, flag: { type: "boolean" } },
          required: ["count", "flag"],
          additionalProperties: { type: "boolean" },
        },
      ),
    );
    expect(generated).toContain("get(argument: { count: number; label?: string; flag: boolean; [key: string]: boolean | number | string | undefined }): string;");
    const nested = generateLibraryTypes(declarationWithResult({ type: "object", additionalProperties: { type: "array", items: { type: "string" } } }));
    expect(nested).toContain("): { [key: string]: string[] };");
    const consumer = `
import type { PluginContext } from "@weivel/typescript";
import { AppRegistry } from "./generated.js";
export function consume(ctx: PluginContext): void {
  const registry = ctx.services.get(AppRegistry)!;
  registry.get({ count: 1, flag: true, extra: false });
  // @ts-expect-error an undeclared key carries the additionalProperties type
  registry.get({ count: 1, flag: true, extra: [] });
}
`;
    expect(compileDiagnostics(generated, consumer)).toEqual([]);
  });

  it("maps oneOf to the union of its branches, composing inside arrays and objects", () => {
    const local = { type: "object", properties: { kind: { const: "local" }, path: { type: "string" } }, required: ["kind", "path"], additionalProperties: false };
    const https = { type: "object", properties: { kind: { const: "https" }, url: { type: "string" } }, required: ["kind", "url"], additionalProperties: false };
    expect(generateLibraryTypes(declarationWithResult({ oneOf: [{ type: "string" }, { type: "integer" }, { type: "number" }] }))).toContain("): string | number;");
    const generated = generateLibraryTypes(
      declarationWithResult(
        { type: "object", properties: { sources: { type: "array", items: { oneOf: [local, https] } } }, required: ["sources"], additionalProperties: false },
        { oneOf: [local, https], description: "annotations beside oneOf are ignored" },
      ),
    );
    expect(generated).toContain(
      'get(argument: { kind: "local"; path: string } | { kind: "https"; url: string }): { sources: ({ kind: "local"; path: string } | { kind: "https"; url: string })[] };',
    );
    const consumer = `
import type { PluginContext } from "@weivel/typescript";
import { AppRegistry } from "./generated.js";
export function consume(ctx: PluginContext): string[] {
  const registry = ctx.services.get(AppRegistry)!;
  // @ts-expect-error a local source carries a path, not a url
  registry.get({ kind: "local", url: "x" });
  return registry.get({ kind: "https", url: "x" }).sources.map((source) => (source.kind === "local" ? source.path : source.url));
}
`;
    expect(compileDiagnostics(generated, consumer)).toEqual([]);
  });

  it("maps an array without items to unknown elements, and still refuses a tuple form", () => {
    expect(generateLibraryTypes(declarationWithResult({ type: "array" }))).toContain("): unknown[];");
    expect(() => generateLibraryTypes(declarationWithResult({ type: "array", items: [{ type: "string" }] }))).toThrow(/result\.items is not one schema for every element/);
  });

  it("refuses a oneOf that is not a non-empty list of schemas, or sits beside a structural keyword", () => {
    expect(() => generateLibraryTypes(declarationWithResult({ oneOf: [] }))).toThrow(/result\.oneOf is not a non-empty list of schemas/);
    expect(() => generateLibraryTypes(declarationWithResult({ oneOf: { type: "string" } }))).toThrow(/result\.oneOf is not a non-empty list of schemas/);
    expect(() => generateLibraryTypes(declarationWithResult({ oneOf: [{ type: "string" }, { allOf: [] }] }))).toThrow(/result\.oneOf\[1\]\.allOf/);
    expect(() => generateLibraryTypes(declarationWithResult({ type: "object", oneOf: [{ type: "object" }] }))).toThrow(/result\.type sits beside a oneOf/);
  });

  it("generates the runtime library's declaration exactly as committed, and the result compiles", () => {
    const fixtures = join(root, "src", "host", "__fixtures__", "library");
    const declaration = parseDeclaration(readFileSync(join(fixtures, "runtime.library.json"), "utf8"));
    const generated = generateLibraryTypes(declaration);
    const expected = readFileSync(join(fixtures, "runtime.types.expected"), "utf8").replace(/\r\n/g, "\n");
    expect(generated).toBe(expected);
    expect(compileDiagnostics(generated, "export {};\n")).toEqual([]);
  });

  it("maps every supported form", () => {
    const generated = generateLibraryTypes(
      declarationWithResult({
        type: "object",
        properties: {
          name: { type: "string", description: "annotations are ignored" },
          size: { type: "number" },
          count: { type: "integer", minimum: 0 },
          enabled: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
          mode: { enum: ["fast", "slow", 3, null] },
          "not-an-identifier": {},
          accepted: true,
          refused: false,
          anything: { type: "array", items: true },
        },
        required: ["name", "mode", "undeclared", "also-undeclared"],
        additionalProperties: false,
      }),
    );
    expect(generated).toContain(
      'get(argument: { [key: string]: unknown }): { name: string; size?: number; count?: number; enabled?: boolean; tags?: string[]; mode: "fast" | "slow" | 3 | null; "not-an-identifier"?: unknown; accepted?: unknown; refused?: never; anything?: unknown[]; undeclared: unknown; "also-undeclared": unknown };',
    );
  });

  it("maps a const to its literal type and refuses a const that is not a primitive", () => {
    const generated = generateLibraryTypes(declarationWithResult({ type: "object", properties: { kind: { const: "host" }, deleted: { const: true }, nothing: { const: null } }, required: ["kind"], additionalProperties: false }));
    expect(generated).toContain('get(argument: { [key: string]: unknown }): { kind: "host"; deleted?: true; nothing?: null };');
    expect(() => generateLibraryTypes(declarationWithResult({ const: { nested: 1 } }))).toThrow(/services\[0\]\.functions\[0\]\.result\.const/);
  });

  it("maps additionalProperties true like an absent one, and boolean schemas to unknown and never", () => {
    const generated = generateLibraryTypes(declarationWithResult(false, { type: "object", properties: { a: { type: "string" } }, additionalProperties: true }));
    expect(generated).toContain("get(argument: { a?: string; [key: string]: unknown }): never;");
    expect(generateLibraryTypes(declarationWithResult({ type: "string" }, true))).toContain("get(argument: unknown): string;");
  });

  it("refuses a service id that yields no TypeScript identifier, naming it", () => {
    for (const id of ["2fa", "1-password"]) {
      const declaration = declarationWithResult({ type: "string" });
      declaration.services[0].id = id;
      expect(() => generateLibraryTypes(declaration), id).toThrow("services[0].id");
    }
  });

  it("refuses a control character in the import name or version the header names", () => {
    for (const version of ["1.0.0\nexport const injected = 1;", "1.0.0 x", "1.0.0\r"]) {
      const declaration = { ...declarationWithResult({ type: "string" }), version };
      expect(() => generateLibraryTypes(declaration), JSON.stringify(version)).toThrow("cannot generate types: version");
    }
    const declaration = { ...declarationWithResult({ type: "string" }), importName: "fixture\n" };
    expect(() => generateLibraryTypes(declaration)).toThrow("cannot generate types: importName");
  });

  it("refuses two services whose names collide", () => {
    const declaration = declarationWithResult({ type: "string" });
    declaration.services.push({ ...declaration.services[0] });
    expect(() => generateLibraryTypes(declaration)).toThrow(/AppRegistry/);
  });
});

describe("MODEL_DEFINITIONS", { timeout: 120_000 }, () => {
  it("maps the resolved app descriptor and each nested definition onto the type the contract exports", () => {
    const exported = new Set(typeOnlyExportsOfPublicEntry());
    for (const definition of ["appDescriptor", ...NESTED_APP_DEFINITIONS]) {
      expect(MODEL_DEFINITIONS["plugin.schema.json"], definition).toContain(definition);
      expect(exported.has(contractTypeOf(definition)), definition).toBe(true);
    }
  });

  it("leaves appDeclaration the one published definition without a contract type", () => {
    const exported = new Set(typeOnlyExportsOfPublicEntry());
    const withoutType = Object.entries(MODEL_DEFINITIONS)
      .flatMap(([file, names]) => names.map((name) => ({ file, name })))
      .filter(({ name }) => !exported.has(contractTypeOf(name)));
    expect(withoutType).toEqual([{ file: "plugin.schema.json", name: "appDeclaration" }]);
  });

  it("holds each app definition with a contract type to that type's properties and required set", () => {
    const published = JSON.parse(readFileSync(join(sibling("model"), "plugin.schema.json"), "utf8")) as {
      definitions: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
    };
    const appDefinitions = Object.keys(published.definitions).filter((name) => name.startsWith("app") && name !== "appDeclaration");
    expect(appDefinitions.length).toBeGreaterThan(0);
    const contractShape = contractShapes();
    const javaContractShape = javaContractShapes();
    for (const name of appDefinitions) {
      expect(schemaShape(published.definitions[name]), name).toEqual(contractShape(contractTypeOf(name)));
      expect(schemaShape(published.definitions[name]), `${name} in the Java contract`).toEqual(javaContractShape(contractTypeOf(name)));
    }
  });

  it("is what the model sibling publishes", () => {
    const published = JSON.parse(readFileSync(join(sibling("model"), "plugin.schema.json"), "utf8")) as { definitions?: Record<string, unknown> };
    expect(MODEL_DEFINITIONS["plugin.schema.json"]).toEqual(Object.keys(published.definitions ?? {}).sort());
  });
});

describe("CONTRACT_TYPES", { timeout: 120_000 }, () => {
  it("is every type the public entry exports", () => {
    expect([...CONTRACT_TYPES]).toEqual(typeOnlyExportsOfPublicEntry());
  });
});
