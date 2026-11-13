import { readFileSync } from "node:fs";
import { join } from "node:path";
import koffi from "koffi";
import { describe, expect, it } from "vitest";
import { coreFunctionNames, coreStructs, sizeOf, type CoreStructName } from "../../src/core/index.ts";

const headerPath = join(import.meta.dirname, "..", "..", "siblings", "core", "include", "weivel", "core.h");
const header = readFileSync(headerPath, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

function fieldName(declaration: string): string {
  const match = /(\w+)\s*(\[[^\]]*\])?\s*$/.exec(declaration);
  if (match === null) {
    throw new Error(`cannot read a field name from "${declaration}"`);
  }
  return match[1]!;
}

function headerStructFields(): Map<string, string[]> {
  const structs = new Map<string, string[]>();
  for (const match of header.matchAll(/typedef struct (\w+) \{([\s\S]*?)\} \1;/g)) {
    const body = match[2]!.replace(/union\s*\{[\s\S]*?\}\s*(\w+)\s*;/g, "union $1;");
    const declarations = body
      .split(";")
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration.length > 0);
    structs.set(match[1]!, declarations.map(fieldName));
  }
  return structs;
}

function headerFunctionNames(): string[] {
  return [...header.matchAll(/WEIVEL_API\s+weivel_status\s+(\w+)\s*\(/g)].map((match) => match[1]!);
}

function declaredFields(name: CoreStructName): string[] {
  return Object.keys(koffi.introspect(coreStructs[name]).members ?? {});
}

describe("the declarations of core.h", () => {
  const headerStructs = headerStructFields();

  it("declare every struct the header declares, and nothing else", () => {
    expect(headerStructs.size).toBeGreaterThan(30);
    expect(Object.keys(coreStructs).sort()).toEqual([...headerStructs.keys()].sort());
  });

  it.each([...headerStructFields().keys()])("lay %s out field for field as the header does", (name) => {
    expect(declaredFields(name as CoreStructName)).toEqual(headerStructs.get(name));
  });

  it("bind every function the header declares, and nothing else", () => {
    expect([...coreFunctionNames].sort()).toEqual(headerFunctionNames().sort());
  });

  it("give the event payload the header's sixteen words at least", () => {
    expect(sizeOf("weivel_event")).toBeGreaterThanOrEqual(koffi.offsetof(coreStructs.weivel_event, "data") + 16 * 8);
  });
});
