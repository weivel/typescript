import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import koffi from "koffi";
import { describe, expect, it } from "vitest";
import { defaultCoreLibraryPath } from "../../src/core/index.ts";
import {
  defaultStandardLibraryPath,
  loadStandardLibrary,
  standardFunctionNames,
  standardStructs,
  unboundStandardFunctionNames,
  type StandardStructName,
} from "../../src/standard/index.ts";

const headerDirectory = join(import.meta.dirname, "..", "..", "siblings", "standard", "include", "weivel");
const headers = readdirSync(headerDirectory)
  .filter((name) => name.endsWith(".h"))
  .map((name) =>
    readFileSync(join(headerDirectory, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/^#.*$/gm, ""),
  )
  .join("\n");

function fieldName(declaration: string): string {
  const operation = /\(\s*\*\s*(\w+)\s*\)\s*\(/.exec(declaration);
  if (operation !== null) {
    return operation[1]!;
  }
  const match = /(\w+)\s*(\[[^\]]*\])?\s*$/.exec(declaration);
  if (match === null) {
    throw new Error(`cannot read a field name from "${declaration}"`);
  }
  return match[1]!;
}

interface HeaderField {
  readonly name: string;
  /** The declaration's first word, which is the whole type for every scalar field. */
  readonly leadingWord: string;
}

function headerStructs(): Map<string, HeaderField[]> {
  const structs = new Map<string, HeaderField[]>();
  for (const match of headers.matchAll(/typedef struct (\w+) \{([\s\S]*?)\} \1;/g)) {
    const fields = match[2]!
      .split(";")
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration.length > 0)
      .map((declaration) => ({ name: fieldName(declaration), leadingWord: declaration.split(/\s+/)[0]! }));
    structs.set(match[1]!, fields);
  }
  return structs;
}

function headerFunctionNames(): string[] {
  return [...headers.matchAll(/WEIVEL_STANDARD_API\s+[^;(]*?(\w+)\s*\(/g)].map((match) => match[1]!);
}

function declaredFields(name: StandardStructName): string[] {
  return Object.keys(koffi.introspect(standardStructs[name]).members ?? {});
}

describe("the declarations of the standard's headers", () => {
  const structs = headerStructs();

  it("declare every struct the headers name, and nothing else", () => {
    expect(structs.size).toBe(20);
    expect(Object.keys(standardStructs).sort()).toEqual([...structs.keys()].sort());
  });

  it.each([...headerStructs().keys()])("lay %s out field for field as the header does", (name) => {
    expect(declaredFields(name as StandardStructName)).toEqual(structs.get(name)!.map((field) => field.name));
  });

  it("bind every function the headers declare but the ones left unbound, and never the reader that skips validation", () => {
    expect([...standardFunctionNames, ...unboundStandardFunctionNames].sort()).toEqual(headerFunctionNames().sort());
    expect(standardFunctionNames).not.toContain("weivel_standard_read_manifest");
    expect(standardFunctionNames).toContain("weivel_standard_load_manifest");
    expect(standardFunctionNames).toContain("weivel_standard_discover");
  });

  it("model every size_t field at platform width and every uint32_t field at four bytes, as the headers type them", () => {
    const widths = { size_t: koffi.sizeof("size_t"), uint32_t: 4 } as const;
    expect(widths.size_t).toBe(koffi.sizeof("void *"));
    let checked = 0;
    for (const [name, fields] of structs) {
      const members = koffi.introspect(standardStructs[name as StandardStructName]).members ?? {};
      for (const { name: field, leadingWord: type } of fields) {
        if (type === "size_t" || type === "uint32_t") {
          expect(`${name}.${field}: ${koffi.sizeof(members[field]!.type)}`).toBe(`${name}.${field}: ${widths[type]}`);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
  });
});

describe("loading the standard", () => {
  it("finds it in native/, beside the core, by default", () => {
    expect(dirname(defaultStandardLibraryPath())).toBe(dirname(defaultCoreLibraryPath()));
  });

  it("refuses a path with no library, naming the path", () => {
    const missing = join(import.meta.dirname, "no-such-standard.dll");
    expect(() => loadStandardLibrary(missing)).toThrow(missing);
  });
});
