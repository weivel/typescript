import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import koffi from "koffi";
import { describe, expect, it } from "vitest";
import { defaultCoreLibraryPath, executableFileName } from "../../src/core/index.ts";
import { descriptionStructs } from "../../src/host/description/layout.ts";
import {
  defaultStandardLibraryPath,
  loadStandardLibrary,
  standardFunctionNames,
  standardStructs,
  unboundStandardFunctionNames,
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
  for (const match of headers.matchAll(/(?:typedef struct (\w+) \{([\s\S]*?)\} \1;|(?<!typedef )\bstruct (\w+) \{([\s\S]*?)\};)/g)) {
    const name = match[1] ?? match[3]!;
    const body = match[2] ?? match[4]!;
    const fields = body
      .split(";")
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration.length > 0)
      .map((declaration) => ({ name: fieldName(declaration), leadingWord: declaration.split(/\s+/)[0]! }));
    structs.set(name, fields);
  }
  return structs;
}

function headerFunctionNames(): string[] {
  return [...headers.matchAll(/WEIVEL_STANDARD_API\s+[^;(]*?(\w+)\s*\(/g)].map((match) => match[1]!);
}

/** Every struct the layer lays out by hand from the standard's headers: the standard module's and the description's. */
const declaredStructs: Readonly<Record<string, ReturnType<typeof koffi.opaque>>> = { ...standardStructs, ...descriptionStructs };

function declaredFields(name: string): string[] {
  return Object.keys(koffi.introspect(declaredStructs[name]!).members ?? {});
}

/** What the standard's layouts program prints, by struct: each field's offset and size, and the struct's sizeof. */
function compiledLayouts(): Map<string, { fields: [string, number, number][]; size: number }> {
  const program = join(import.meta.dirname, "..", "..", "native", "test", executableFileName("layouts"));
  const layouts = new Map<string, { fields: [string, number, number][]; size: number }>();
  for (const line of execFileSync(program, { encoding: "utf8" }).split("\n")) {
    const words = line.replace(/\r$/, "").split(" ");
    if (words.length < 3) {
      continue;
    }
    const layout = layouts.get(words[0]!) ?? { fields: [], size: -1 };
    if (words[1] === "sizeof") {
      layout.size = Number(words[2]);
    } else {
      layout.fields.push([words[1]!, Number(words[2]), Number(words[3])]);
    }
    layouts.set(words[0]!, layout);
  }
  return layouts;
}

/** The layout koffi computes for a declared struct, in the layouts program's shape. */
function koffiLayout(name: string): { fields: [string, number, number][]; size: number } {
  const type = declaredStructs[name]!;
  const members = Object.values(koffi.introspect(type).members ?? {});
  return { fields: members.map((member) => [member.name, member.offset, koffi.sizeof(member.type)]), size: koffi.sizeof(type) };
}

describe("the declarations of the standard's headers", () => {
  const structs = headerStructs();

  it("declare every struct the headers name, and nothing else", () => {
    expect(structs.size).toBe(40);
    expect(Object.keys(declaredStructs).sort()).toEqual([...structs.keys()].sort());
  });

  it.each([...headerStructs().keys()])("lay %s out field for field as the header does", (name) => {
    expect(declaredFields(name)).toEqual(structs.get(name)!.map((field) => field.name));
  });

  it("lay every struct out at the offsets and sizes the standard's layouts program prints, but the unbound JSON reader's", () => {
    const compiled = compiledLayouts();
    expect([...compiled.keys()].filter((name) => !(name in declaredStructs))).toEqual(["weivel_json_error"]);
    for (const name of Object.keys(declaredStructs)) {
      expect({ name, ...koffiLayout(name) }).toEqual({ name, ...compiled.get(name) });
    }
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
      const members = koffi.introspect(declaredStructs[name]!).members ?? {};
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
