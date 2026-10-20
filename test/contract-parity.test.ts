import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { repositoryRoot, sibling } from "../scripts/sibling.mjs";

const root = repositoryRoot();
const javaDeclarations = join(sibling("java"), "generated", "api.d.ts");
const nativeEntry = join(root, "src", "index.ts");

interface JavaInterface {
  readonly name: string;
  readonly typeParameterCount: number;
}

function compilerOptions(): ts.CompilerOptions {
  const configPath = join(root, "tsconfig.test.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
}

function javaInterfaces(): JavaInterface[] {
  const program = ts.createProgram([javaDeclarations], compilerOptions());
  const source = program.getSourceFile(javaDeclarations);
  if (!source) throw new Error(`cannot read ${javaDeclarations}`);
  return source.statements.filter(ts.isInterfaceDeclaration).map((declaration) => ({
    name: declaration.name.text,
    typeParameterCount: declaration.typeParameters?.length ?? 0,
  }));
}

function nativeExportNames(): Set<string> {
  const program = ts.createProgram([nativeEntry], compilerOptions());
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(nativeEntry);
  const symbol = source && checker.getSymbolAtLocation(source);
  return new Set(symbol ? checker.getExportsOfModule(symbol).map((exported) => exported.name) : []);
}

function slashed(path: string): string {
  return path.replaceAll("\\", "/");
}

function probeSource(interfaces: JavaInterface[]): string {
  const lines = [
    `import type * as Native from "${slashed(join(root, "src", "index.js"))}";`,
    `import type * as Java from "${slashed(join(javaDeclarations, "..", "api.js"))}";`,
  ];
  for (const { name, typeParameterCount } of interfaces) {
    const arguments_ = typeParameterCount === 0 ? "" : `<${Array(typeParameterCount).fill("unknown").join(", ")}>`;
    const native = `Native.${name}${arguments_}`;
    const java = `Java.${name}${arguments_}`;
    lines.push(
      `type _${name} = [${native}] extends [${java}] ? ([${java}] extends [${native}] ? true : never) : never;`,
      `export const _${name.toLowerCase()}: _${name} = true;`,
      `type _${name}Keys = [keyof ${native}] extends [keyof ${java}] ? ([keyof ${java}] extends [keyof ${native}] ? true : never) : never;`,
      `export const _${name.toLowerCase()}keys: _${name}Keys = true;`,
    );
  }
  return lines.join("\n");
}

function describeDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (!diagnostic.file || diagnostic.start === undefined) return message;
  const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const subject = diagnostic.file.text.split("\n")[line]?.trim() ?? "";
  return subject + " :: " + message;
}

function parityDiagnostics(interfaces: JavaInterface[]): string[] {
  const directory = mkdtempSync(join(tmpdir(), "weivel-parity-"));
  try {
    const probePath = join(directory, "probe.mts");
    writeFileSync(probePath, probeSource(interfaces));
    const program = ts.createProgram([probePath], compilerOptions());
    return ts
      .getPreEmitDiagnostics(program)
      .map(describeDiagnostic);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("the native contract against java's generated declarations", { timeout: 120_000 }, () => {
  const interfaces = javaInterfaces();

  it("reads every interface java declares", () => {
    expect(interfaces.length).toBeGreaterThan(0);
  });

  it("exports every name java exports", () => {
    const exported = nativeExportNames();
    const missing = interfaces.map((entry) => entry.name).filter((name) => !exported.has(name));
    expect(missing).toEqual([]);
  });

  it("assigns both ways for every interface", () => {
    expect(parityDiagnostics(interfaces)).toEqual([]);
  });
});
