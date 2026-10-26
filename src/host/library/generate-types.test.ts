import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { repositoryRoot, sibling } from "../../../scripts/sibling.mjs";
import type { LibraryDeclaration } from "./declaration.js";
import { parseDeclaration } from "./declaration.js";
import { generateLibraryTypes } from "./generate-types.js";
import { MODEL_DEFINITIONS } from "./model-definitions.generated.js";

const root = repositoryRoot();
const publicEntry = join(root, "src", "index.ts");
const APP_DESCRIPTOR = "https://weivel.github.io/model/plugin.schema.json#/definitions/appDescriptor";

function echoDeclaration(): LibraryDeclaration {
  return parseDeclaration(readFileSync(join(sibling("model"), "test", "fixtures", "echo.library.json"), "utf8"));
}

function declarationWithResult(result: object | boolean, argument: object | boolean = { type: "object" }): LibraryDeclaration {
  return {
    id: "fixture",
    version: "1.0.0",
    binary: "fixture",
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

function typeOnlyExportsOfPublicEntry(): string[] {
  const program = ts.createProgram([publicEntry], compilerOptions());
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(publicEntry);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`cannot read ${publicEntry}`);
  return checker
    .getExportsOfModule(module)
    .map((exported) => (exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported))
    .filter((symbol) => symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))
    .map((symbol) => symbol.name)
    .sort();
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
    expect(() => generateLibraryTypes(declarationWithResult({ oneOf: [{ type: "string" }] }))).toThrow(/services\[0\]\.functions\[0\]\.result\.oneOf/);
    expect(() => generateLibraryTypes(declarationWithResult({ type: ["string", "null"] }))).toThrow(/services\[0\]\.functions\[0\]\.result\.type/);
    expect(() =>
      generateLibraryTypes(declarationWithResult({ type: "object", properties: { nested: { type: "array", items: { anyOf: [] } } } })),
    ).toThrow(/services\[0\]\.functions\[0\]\.result\.properties\.nested\.items\.anyOf/);
    expect(() => generateLibraryTypes(declarationWithResult({ type: "string" }, { type: "object", additionalProperties: { type: "string" } }))).toThrow(
      /services\[0\]\.functions\[0\]\.argument\.additionalProperties/,
    );
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

  it("refuses a control character in the id or version the header names", () => {
    for (const version of ["1.0.0\nexport const injected = 1;", "1.0.0 x", "1.0.0\r"]) {
      const declaration = { ...declarationWithResult({ type: "string" }), version };
      expect(() => generateLibraryTypes(declaration), JSON.stringify(version)).toThrow("cannot generate types: version");
    }
    const declaration = { ...declarationWithResult({ type: "string" }), id: "fixture\n" };
    expect(() => generateLibraryTypes(declaration)).toThrow("cannot generate types: id");
  });

  it("refuses two services whose names collide", () => {
    const declaration = declarationWithResult({ type: "string" });
    declaration.services.push({ ...declaration.services[0] });
    expect(() => generateLibraryTypes(declaration)).toThrow(/AppRegistry/);
  });
});

describe("MODEL_DEFINITIONS", { timeout: 120_000 }, () => {
  it("maps every definition the model publishes onto a type the contract exports", () => {
    const exported = new Set(typeOnlyExportsOfPublicEntry());
    const missing = Object.entries(MODEL_DEFINITIONS)
      .flatMap(([file, names]) => names.map((name) => ({ file, type: name.charAt(0).toUpperCase() + name.slice(1) })))
      .filter(({ type }) => !exported.has(type));
    expect(missing).toEqual([]);
  });

  it("is what the model sibling publishes", () => {
    const published = JSON.parse(readFileSync(join(sibling("model"), "plugin.schema.json"), "utf8")) as { definitions?: Record<string, unknown> };
    expect(MODEL_DEFINITIONS["plugin.schema.json"]).toEqual(Object.keys(published.definitions ?? {}).sort());
  });
});
