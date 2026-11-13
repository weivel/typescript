import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Status } from "../../src/core/index.ts";
import { ContextFact, FunctionKind, IdentityKind, StandardRefusalCode } from "../../src/standard/index.ts";
import { directoryWith, realStandard } from "../real-standard.ts";

const standard = realStandard();

describe("the standard's service ids", () => {
  it("are the ones the standard library answers", () => {
    expect(standard.serviceIds).toEqual({ config: "weivel.config", secrets: "weivel.secrets", paths: "weivel.paths" });
  });
});

describe("identities", () => {
  it("are taken apart as the standard takes them", () => {
    expect(standard.parseIdentity("gitea@git.example.com:0123/a/b")).toEqual({
      status: Status.Ok,
      refusal: undefined,
      value: { kind: IdentityKind.Forge, name: null, forge: "gitea", host: "git.example.com", number: 123n, segments: ["a", "b"] },
    });
  });

  it("keep a local name by its length, a NUL and every UTF-8 byte included", () => {
    expect(standard.parseIdentity("local:Café\u0000x").value).toMatchObject({
      kind: IdentityKind.Local,
      name: "Café\u0000x",
      forge: null,
      number: 0n,
    });
  });

  it("answer the standard's refusal for a text that is not one, or a number past 64 bits", () => {
    expect(standard.parseIdentity("calendar")).toMatchObject({
      status: Status.Refused,
      value: undefined,
      refusal: { code: StandardRefusalCode.InvalidValue, path: "" },
    });
    expect(standard.parseIdentity("forge:18446744073709551616").refusal?.code).toBe(StandardRefusalCode.Unrepresentable);
    expect(standard.parseIdentity("forge:18446744073709551615").value?.number).toBe(18446744073709551615n);
  });

  it("are ordered by the standard: numbers as numbers, leading zeros ignored, local first", () => {
    expect(standard.compareIdentities("forge:9", "forge:10").value).toBeLessThan(0);
    expect(standard.compareIdentities("forge:007", "forge:7").value).toBe(0);
    expect(standard.compareIdentities("forge:1", "local:a").value).toBeGreaterThan(0);
  });

  it("refuse a comparison with either side not an identity, answering that side's refusal", () => {
    expect(standard.compareIdentities("forge:1", "Forge:1")).toMatchObject({
      status: Status.Refused,
      value: undefined,
      refusal: { code: StandardRefusalCode.InvalidValue },
    });
    expect(standard.compareIdentities("calendar", "forge:1").status).toBe(Status.Refused);
  });
});

describe("the mirror list", () => {
  const hash = "ab".repeat(32);

  it("is read in file order", () => {
    const read = standard.readMirrors(JSON.stringify({ mirrors: ["https://one/{sha256}", "https://two/{sha256}.bin"] }));

    expect(read).toEqual({ status: Status.Ok, refusal: undefined, value: ["https://one/{sha256}", "https://two/{sha256}.bin"] });
  });

  it("is refused at the template the standard names", () => {
    const read = standard.readMirrors(JSON.stringify({ mirrors: ["https://one/{sha256}", "https://two/"] }));

    expect(read).toMatchObject({ status: Status.Refused, value: undefined, refusal: { path: "mirrors[1]" } });
  });

  it("is loaded from a file, and a missing file is the standard's NOT_FOUND", () => {
    const directory = directoryWith({ "mirrors.json": JSON.stringify({ mirrors: ["https://one/{sha256}"] }) });

    expect(standard.loadMirrors(join(directory, "mirrors.json")).value).toEqual(["https://one/{sha256}"]);
    expect(standard.loadMirrors(join(directory, "absent.json")).refusal?.code).toBe(StandardRefusalCode.NotFound);
  });

  it("expands a template for a hash, and refuses a hash that is not one", () => {
    expect(standard.expandMirror("https://one/{sha256}.bin", hash)).toEqual({
      status: Status.Ok,
      refusal: undefined,
      value: `https://one/${hash}.bin`,
    });
    expect(standard.expandMirror("https://one/{sha256}", hash.toUpperCase())).toMatchObject({
      status: Status.Refused,
      value: undefined,
      refusal: { code: StandardRefusalCode.InvalidValue },
    });
  });
});

describe("SHA-256", () => {
  const abcHex = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const abc = new TextEncoder().encode("abc");

  it("is the standard's digest, as bytes and as hex", () => {
    expect(standard.sha256Hex(abc)).toBe(abcHex);
    expect(Buffer.from(standard.sha256(abc)).toString("hex")).toBe(abcHex);
    expect(standard.sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("recognises only lowercase hex of the right length", () => {
    expect(standard.isSha256Hex(abcHex)).toBe(true);
    expect(standard.isSha256Hex(abcHex.toUpperCase())).toBe(false);
    expect(standard.isSha256Hex(abcHex.slice(1))).toBe(false);
  });

  it("verifies a download, refusing one that does not match", () => {
    expect(standard.verifyDownload(abc, abcHex)).toEqual({ status: Status.Ok, value: undefined, refusal: undefined });
    expect(standard.verifyDownload(new TextEncoder().encode("abd"), abcHex)).toMatchObject({
      status: Status.Refused,
      refusal: { code: StandardRefusalCode.InvalidValue },
    });
  });
});

describe("a library declaration", () => {
  const declaration = {
    importName: "echo",
    version: "0.1.0",
    release: "echo_release",
    services: [
      { id: "echo", functions: [{ name: "repeat", symbol: "echo_repeat", kind: "bytes" }] },
      { id: "echo-twice", functions: [{ name: "twice", symbol: "echo_twice", kind: "bytes", context: ["home", "arguments"] }] },
    ],
  };

  it("is read by the standard into values", () => {
    expect(standard.readLibrary(JSON.stringify(declaration))).toEqual({
      status: Status.Ok,
      refusal: undefined,
      value: {
        importName: "echo",
        version: "0.1.0",
        release: "echo_release",
        services: [
          { id: "echo", functions: [{ name: "repeat", symbol: "echo_repeat", kind: FunctionKind.Bytes, context: 0 }] },
          {
            id: "echo-twice",
            functions: [
              { name: "twice", symbol: "echo_twice", kind: FunctionKind.Bytes, context: ContextFact.Home | ContextFact.Arguments },
            ],
          },
        ],
      },
    });
  });

  it("is refused at the field the standard names", () => {
    const broken = { ...declaration, services: [{ id: "echo", functions: [{ name: "repeat", symbol: "not a symbol", kind: "bytes" }] }] };

    expect(standard.readLibrary(JSON.stringify(broken))).toMatchObject({
      status: Status.Refused,
      value: undefined,
      refusal: { code: StandardRefusalCode.InvalidValue, path: "services[0].functions[0].symbol" },
    });
  });

  it("is refused by the standard for a json function, at the function's kind", () => {
    const withJson = { ...declaration, services: [declaration.services[0]!, { id: "echo-twice", functions: [{ name: "twice", symbol: "echo_twice", kind: "json" }] }] };

    expect(standard.readLibrary(JSON.stringify(withJson))).toMatchObject({
      status: Status.Refused,
      value: undefined,
      refusal: { code: StandardRefusalCode.InvalidValue, path: "services[1].functions[0].kind" },
    });
  });

  it("reads three functions in a row at the stride the standard lays them out", () => {
    const three = ["first", "second", "third"].map((name) => ({ name, symbol: `echo_${name}`, kind: "bytes" }));

    const read = standard.readLibrary(JSON.stringify({ ...declaration, services: [{ id: "echo", functions: three }] }));

    expect(read.value?.services[0]?.functions.map((declared) => [declared.name, declared.symbol, declared.kind])).toEqual([
      ["first", "echo_first", FunctionKind.Bytes],
      ["second", "echo_second", FunctionKind.Bytes],
      ["third", "echo_third", FunctionKind.Bytes],
    ]);
  });
});
